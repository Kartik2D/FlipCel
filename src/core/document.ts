/**
 * Document Model — frame-by-frame animation + persistence
 *
 * This is the serializable source of truth for the artwork. Paper.js is a
 * renderer/editor for the *currently visible frame only*; everything else
 * lives here:
 *
 * - Each regular layer is a `LayerTrack`: a sorted list of keyframes.
 * - A keyframe owns artwork via a `contentId` into the content store.
 *   Frames between keyframes are "holds" (they extend the previous keyframe).
 * - Content is stored by reference (content-addressed-ish): inserting a
 *   keyframe copies the previous keyframe's contentId, holds share content
 *   implicitly, and history entries share content strings by reference.
 *   Fifty undo entries or fifty hold frames cost one copy of the artwork.
 *
 * The DocumentManager reconciles this model with the live editing surfaces:
 * `layerStore` (layer list UI), Paper.js layers (via PaperRenderer), and
 * `timelineStore` (timeline panel UI).
 */
import {
  Store,
  layerStore,
  stageSelectedStore,
  STAGE_LAYER_ID,
  type Layer,
  type LayerState,
} from "./stores";
import type { PaperRenderer } from "./paper-renderer";

// ============================================================
// Types
// ============================================================

export interface Keyframe {
  frameIndex: number;
  contentId: string;
}

export interface LayerTrack {
  id: string;
  name: string;
  visible: boolean;
  /** Sorted by frameIndex ascending; keyframes[0] is always at frame 0. */
  keyframes: Keyframe[];
}

/** Shared id for "empty layer" content, so blank layers/keyframes dedupe. */
export const EMPTY_CONTENT_ID = "empty";

export const DEFAULT_FRAME_RATE = 12;
export const DEFAULT_DURATION = 24;

/** Onion-skin range and ghost tints (Flash convention: warm past, cool future). */
const ONION_FRAMES_BEFORE = 2;
const ONION_FRAMES_AFTER = 1;
const ONION_PREV_COLOR = "#d84a4a";
const ONION_NEXT_COLOR = "#3f8f5f";
/** Ghost opacity for the nearest neighbor; falls off with distance. */
const ONION_BASE_OPACITY = 0.28;

/** Lightweight, immutable view of the timeline for UI panels. */
export interface TimelineState {
  /** Bottom → top (same convention as layerStore). */
  tracks: Array<{
    id: string;
    name: string;
    visible: boolean;
    keyframes: Array<{ frame: number; blank: boolean }>;
  }>;
  currentFrame: number;
  duration: number;
  frameRate: number;
  playing: boolean;
  onionSkin: boolean;
}

export const timelineStore = new Store<TimelineState>({
  tracks: [],
  currentFrame: 0,
  duration: DEFAULT_DURATION,
  frameRate: DEFAULT_FRAME_RATE,
  playing: false,
  onionSkin: false,
});

/** Serialized `.inkwell` document (also the autosave payload). */
export interface SerializedDocument {
  version: 1;
  stage: { width: number; height: number; color: string };
  frameRate: number;
  duration: number;
  /** Bottom → top. */
  tracks: LayerTrack[];
  /** contentId → paper.js layer JSON ("" = empty layer). */
  content: Record<string, string>;
}

/** Snapshot of the document's mutable state, used by doc-level history. */
export interface DocumentState {
  tracks: LayerTrack[];
  currentFrame: number;
  duration: number;
  frameRate: number;
}

export function cloneTracks(tracks: LayerTrack[]): LayerTrack[] {
  return tracks.map((t) => ({
    ...t,
    keyframes: t.keyframes.map((k) => ({ ...k })),
  }));
}

// ============================================================
// DocumentManager
// ============================================================

export class DocumentManager {
  private renderer: PaperRenderer;

  private tracks: LayerTrack[] = [];
  /** contentId → paper layer JSON ("" means empty). */
  private content = new Map<string, string>([[EMPTY_CONTENT_ID, ""]]);
  private currentFrame = 0;
  private duration = DEFAULT_DURATION;
  private frameRate = DEFAULT_FRAME_RATE;
  private playing = false;
  /** View preference: show dimmed neighbor frames. Not persisted, not in history. */
  private onionSkinEnabled = false;

  /** contentId currently loaded into each Paper layer. */
  private loadedContent = new Map<string, string>();
  private contentIdCounter = 1;

  constructor(renderer: PaperRenderer) {
    this.renderer = renderer;
  }

  // ------------------------------------------------------------
  // Accessors
  // ------------------------------------------------------------

  getCurrentFrame(): number {
    return this.currentFrame;
  }

  getDuration(): number {
    return this.duration;
  }

  getFrameRate(): number {
    return this.frameRate;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  getContent(id: string): string {
    return this.content.get(id) ?? "";
  }

  // ------------------------------------------------------------
  // Content store
  // ------------------------------------------------------------

  private newContentId(): string {
    return `c${Date.now().toString(36)}-${this.contentIdCounter++}`;
  }

  /**
   * Drop content entries not referenced by the given id sets (called by the
   * history manager after trimming its stack, since history entries are the
   * only other holders of content references).
   */
  gcContent(referenced: Set<string>): void {
    referenced.add(EMPTY_CONTENT_ID);
    for (const track of this.tracks) {
      for (const kf of track.keyframes) referenced.add(kf.contentId);
    }
    for (const id of [...this.content.keys()]) {
      if (!referenced.has(id)) this.content.delete(id);
    }
  }

  // ------------------------------------------------------------
  // Keyframe helpers
  // ------------------------------------------------------------

  private getTrack(layerId: string): LayerTrack | null {
    return this.tracks.find((t) => t.id === layerId) ?? null;
  }

  /** Last keyframe with frameIndex <= frame (keyframes[0] is at 0). */
  private governingKeyframe(track: LayerTrack, frame: number): Keyframe {
    let governing = track.keyframes[0];
    for (const kf of track.keyframes) {
      if (kf.frameIndex > frame) break;
      governing = kf;
    }
    return governing;
  }

  private governingContentId(track: LayerTrack, frame: number): string {
    return this.governingKeyframe(track, frame).contentId;
  }

  // ------------------------------------------------------------
  // Reconciliation with layerStore (layer add/delete/rename/reorder)
  // ------------------------------------------------------------

  /**
   * Mirror layerStore's regular layers into tracks: create tracks for new
   * layers (blank at frame 0), drop tracks for deleted layers, sync
   * name/visibility, and match ordering. Called at every history snapshot,
   * so tracks can never drift from the layer panel.
   */
  syncFromLayerStore(state: LayerState): void {
    const byId = new Map(this.tracks.map((t) => [t.id, t]));
    const next: LayerTrack[] = [];
    for (const layer of state.layers) {
      if (layer.kind === "stage") continue;
      const existing = byId.get(layer.id);
      if (existing) {
        existing.name = layer.name;
        existing.visible = layer.visible;
        next.push(existing);
      } else {
        next.push({
          id: layer.id,
          name: layer.name,
          visible: layer.visible,
          keyframes: [{ frameIndex: 0, contentId: EMPTY_CONTENT_ID }],
        });
      }
    }
    this.tracks = next;

    for (const id of [...this.loadedContent.keys()]) {
      if (!this.tracks.some((t) => t.id === id)) this.loadedContent.delete(id);
    }
    this.publish();
  }

  /**
   * Capture the live Paper content of the active layer into the document.
   * If the content changed while the playhead sits on a hold frame, a new
   * keyframe is auto-created at the current frame (Flash-style auto-key).
   * Returns true when the document changed.
   */
  commitActiveLayerContent(): boolean {
    const layerId = this.renderer.getActiveLayerId();
    if (!layerId) return false;
    const track = this.getTrack(layerId);
    if (!track) return false;

    const json = this.renderer.isLayerEmpty(layerId)
      ? ""
      : this.renderer.exportLayerJSON(layerId) ?? "";

    const governing = this.governingKeyframe(track, this.currentFrame);
    const currentJson = this.content.get(governing.contentId) ?? "";

    if (json === currentJson) {
      this.loadedContent.set(layerId, governing.contentId);
      return false;
    }

    let contentId: string;
    if (json === "") {
      contentId = EMPTY_CONTENT_ID;
    } else {
      contentId = this.newContentId();
      this.content.set(contentId, json);
    }

    if (governing.frameIndex === this.currentFrame) {
      governing.contentId = contentId;
    } else {
      // Editing a hold frame: auto-create a keyframe here.
      this.insertKeyframe(track, {
        frameIndex: this.currentFrame,
        contentId,
      });
    }
    this.loadedContent.set(layerId, contentId);
    this.publish();
    return true;
  }

  private insertKeyframe(track: LayerTrack, keyframe: Keyframe): void {
    const at = track.keyframes.findIndex(
      (k) => k.frameIndex >= keyframe.frameIndex,
    );
    if (at === -1) {
      track.keyframes.push(keyframe);
    } else if (track.keyframes[at].frameIndex === keyframe.frameIndex) {
      track.keyframes[at] = keyframe;
    } else {
      track.keyframes.splice(at, 0, keyframe);
    }
  }

  // ------------------------------------------------------------
  // Timeline operations
  // ------------------------------------------------------------

  /**
   * Insert a keyframe on a layer at a frame. Non-blank copies the governing
   * keyframe's content (Flash F6); blank starts empty (Flash F7).
   * Returns true if the document changed.
   */
  addKeyframe(layerId: string, frame: number, blank: boolean): boolean {
    const track = this.getTrack(layerId);
    if (!track) return false;
    frame = this.clampFrame(frame);

    const governing = this.governingKeyframe(track, frame);
    const contentId = blank ? EMPTY_CONTENT_ID : governing.contentId;
    if (governing.frameIndex === frame) {
      if (governing.contentId === contentId) return false;
      governing.contentId = contentId;
    } else {
      this.insertKeyframe(track, { frameIndex: frame, contentId });
    }

    if (frame === this.currentFrame) this.reloadCurrentFrame();
    this.publish();
    return true;
  }

  /**
   * Remove the keyframe at exactly this frame (frame 0 cannot be removed —
   * every track needs governing content). Returns true if changed.
   */
  removeKeyframe(layerId: string, frame: number): boolean {
    const track = this.getTrack(layerId);
    if (!track) return false;
    const at = track.keyframes.findIndex((k) => k.frameIndex === frame);
    if (at <= 0 && frame === 0) return false; // frame 0 keyframe is mandatory
    if (at === -1) return false;
    track.keyframes.splice(at, 1);

    this.reloadCurrentFrame();
    this.publish();
    return true;
  }

  setDuration(frames: number): boolean {
    const next = Math.max(1, Math.min(9999, Math.round(frames)));
    if (next === this.duration) return false;
    // Shrinking simply drops keyframes past the new end. The frame-0
    // keyframe always survives since next >= 1.
    for (const track of this.tracks) {
      track.keyframes = track.keyframes.filter((k) => k.frameIndex < next);
    }
    this.duration = next;
    if (this.currentFrame >= next) this.gotoFrame(next - 1);
    this.publish();
    return true;
  }

  setFrameRate(fps: number): void {
    this.frameRate = Math.max(1, Math.min(60, Math.round(fps)));
    this.publish();
  }

  setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    this.publish();
  }

  isOnionSkinEnabled(): boolean {
    return this.onionSkinEnabled;
  }

  setOnionSkin(enabled: boolean): void {
    if (this.onionSkinEnabled === enabled) return;
    this.onionSkinEnabled = enabled;
    this.publish();
  }

  /**
   * Rebuild the onion-skin ghost layers for the current playhead position.
   * A neighbor frame contributes a ghost only for layers whose governing
   * content actually differs from the current frame — a layer holding the
   * same artwork would just paint an invisible tinted copy under itself.
   */
  private updateOnionSkin(): void {
    if (!this.onionSkinEnabled || this.playing) {
      this.renderer.clearOnionSkin();
      return;
    }

    const ghosts: Array<{ jsons: string[]; opacity: number; color: string }> = [];

    const addGhost = (frame: number, distance: number, color: string) => {
      if (frame < 0 || frame >= this.duration || frame === this.currentFrame) return;
      const jsons: string[] = [];
      for (const track of this.tracks) {
        if (!track.visible) continue;
        const contentId = this.governingContentId(track, frame);
        if (contentId === this.governingContentId(track, this.currentFrame)) continue;
        const json = this.content.get(contentId);
        if (json) jsons.push(json);
      }
      if (jsons.length > 0) {
        ghosts.push({ jsons, opacity: ONION_BASE_OPACITY / distance, color });
      }
    };

    // Farthest first so nearer ghosts render on top of them.
    for (let d = ONION_FRAMES_BEFORE; d >= 1; d--) {
      addGhost(this.currentFrame - d, d, ONION_PREV_COLOR);
    }
    for (let d = ONION_FRAMES_AFTER; d >= 1; d--) {
      addGhost(this.currentFrame + d, d, ONION_NEXT_COLOR);
    }

    this.renderer.setOnionSkin(ghosts);
  }

  private clampFrame(frame: number): number {
    return Math.max(0, Math.min(this.duration - 1, Math.round(frame)));
  }

  // ------------------------------------------------------------
  // Frame loading (document → Paper)
  // ------------------------------------------------------------

  /**
   * Move the playhead: load every layer's governing content at `frame` into
   * Paper. Layers whose content id didn't change are skipped entirely (holds
   * are free). Assumes pending edits were already committed (all edit paths
   * end in a history snapshot, which commits).
   */
  gotoFrame(frame: number): void {
    this.currentFrame = this.clampFrame(frame);
    this.reloadCurrentFrame();
    this.publish();
  }

  private reloadCurrentFrame(): void {
    const activeLayerId =
      this.renderer.getActiveLayerId() ?? this.tracks[this.tracks.length - 1]?.id;
    if (this.tracks.length === 0) return;

    this.renderer.restoreLayersSnapshot(
      this.tracks.map((track) => {
        const contentId = this.governingContentId(track, this.currentFrame);
        const changed = this.loadedContent.get(track.id) !== contentId;
        if (changed) this.loadedContent.set(track.id, contentId);
        return {
          id: track.id,
          name: track.name,
          visible: track.visible,
          json: changed ? this.content.get(contentId) ?? "" : undefined,
        };
      }),
      activeLayerId ?? STAGE_LAYER_ID,
    );
  }

  // ------------------------------------------------------------
  // Doc-level history support
  // ------------------------------------------------------------

  /** Deep-copied state for a history entry (content strings shared by ref). */
  captureState(): DocumentState {
    return {
      tracks: cloneTracks(this.tracks),
      currentFrame: this.currentFrame,
      duration: this.duration,
      frameRate: this.frameRate,
    };
  }

  /**
   * Restore a history entry: replaces tracks/frame/duration, updates
   * layerStore to match, and reloads Paper. `activeLayerId` may be the
   * stage id (stage row selected at snapshot time).
   */
  applyState(state: DocumentState, activeLayerId: string): void {
    this.tracks = cloneTracks(state.tracks);
    this.duration = state.duration;
    this.frameRate = state.frameRate;
    this.currentFrame = Math.max(
      0,
      Math.min(state.duration - 1, state.currentFrame),
    );

    this.updateLayerStoreFromTracks(activeLayerId);

    // Reload Paper. Compare against loadedContent so unchanged layers skip
    // the reimport; structure changes (added/removed layers) are handled by
    // restoreLayersSnapshot itself.
    this.reloadCurrentFrame();
    this.publish();
  }

  private updateLayerStoreFromTracks(activeLayerId: string): void {
    const prev = layerStore.get();
    const stageRow: Layer =
      prev.layers.find((l) => l.kind === "stage") ??
      ({ id: STAGE_LAYER_ID, name: "Stage", visible: true, kind: "stage" } as Layer);

    const layers: Layer[] = [
      stageRow,
      ...this.tracks.map((t) => ({
        id: t.id,
        name: t.name,
        visible: t.visible,
        kind: "regular" as const,
      })),
    ];

    const validActive =
      activeLayerId === STAGE_LAYER_ID ||
      this.tracks.some((t) => t.id === activeLayerId)
        ? activeLayerId
        : this.tracks[this.tracks.length - 1]?.id ?? STAGE_LAYER_ID;

    layerStore.set({ layers, activeLayerId: validActive });
    stageSelectedStore.set(validActive === STAGE_LAYER_ID);
  }

  // ------------------------------------------------------------
  // Serialization (save / load / new)
  // ------------------------------------------------------------

  serialize(stage: { width: number; height: number; color: string }): SerializedDocument {
    const content: Record<string, string> = {};
    for (const track of this.tracks) {
      for (const kf of track.keyframes) {
        content[kf.contentId] = this.content.get(kf.contentId) ?? "";
      }
    }
    return {
      version: 1,
      stage: { ...stage },
      frameRate: this.frameRate,
      duration: this.duration,
      tracks: cloneTracks(this.tracks),
      content,
    };
  }

  /**
   * Replace the whole document from a serialized payload. The caller is
   * responsible for resetting history and stage settings afterwards.
   */
  loadSerialized(doc: SerializedDocument): void {
    this.content = new Map(Object.entries(doc.content));
    this.content.set(EMPTY_CONTENT_ID, "");
    this.tracks = cloneTracks(doc.tracks);
    // Guarantee model invariants on untrusted input.
    for (const track of this.tracks) {
      track.keyframes.sort((a, b) => a.frameIndex - b.frameIndex);
      if (track.keyframes.length === 0 || track.keyframes[0].frameIndex !== 0) {
        track.keyframes.unshift({ frameIndex: 0, contentId: EMPTY_CONTENT_ID });
      }
    }
    this.duration = Math.max(1, Math.round(doc.duration));
    this.frameRate = Math.max(1, Math.min(60, Math.round(doc.frameRate)));
    this.currentFrame = 0;
    this.playing = false;

    // Force full reload of every layer.
    this.loadedContent.clear();
    const topLayerId = this.tracks[this.tracks.length - 1]?.id ?? STAGE_LAYER_ID;
    this.updateLayerStoreFromTracks(topLayerId);
    this.reloadCurrentFrame();
    this.publish();
  }

  // ------------------------------------------------------------
  // Timeline store publishing
  // ------------------------------------------------------------

  private publish(): void {
    // Every document mutation funnels through here, so the ghosts always
    // track the latest content, visibility, playhead, and playback state.
    this.updateOnionSkin();
    timelineStore.set({
      tracks: this.tracks.map((t) => ({
        id: t.id,
        name: t.name,
        visible: t.visible,
        keyframes: t.keyframes.map((k) => ({
          frame: k.frameIndex,
          blank: k.contentId === EMPTY_CONTENT_ID,
        })),
      })),
      currentFrame: this.currentFrame,
      duration: this.duration,
      frameRate: this.frameRate,
      playing: this.playing,
      onionSkin: this.onionSkinEnabled,
    });
  }
}
