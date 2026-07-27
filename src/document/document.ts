/**
 * Document Model — frame-by-frame animation + persistence
 *
 * This is the serializable source of truth for the artwork. Paper.js is a
 * renderer/editor for the *currently visible frame only*; everything else
 * lives here:
 *
 * - Each regular layer is a `LayerTrack`: a sorted list of keyframes.
 * - A keyframe owns artwork via a `contentId` into the content store and an
 *   explicit hold span (`holdUntil`, inclusive). Frames not covered by any
 *   keyframe's span render empty.
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
  documentColorsStore,
  viewOverlayStore,
  STAGE_LAYER_ID,
  type Layer,
  type LayerState,
} from "../state/index";
import { collectDocumentColors } from "./colors";
import type { PaperRenderer } from "../render/paper-renderer";

// ============================================================
// Types
// ============================================================

export interface Keyframe {
  frameIndex: number;
  contentId: string;
  /**
   * Last frame (inclusive) this keyframe stays visible. Always in
   * [frameIndex, nextKeyframe.frameIndex - 1]. A plain keyframe has
   * holdUntil === frameIndex (one frame); larger values are explicit holds.
   * Blank keyframes are always single-frame (holdUntil === frameIndex).
   * Frames not covered by any keyframe's span render empty.
   */
  holdUntil: number;
}

export interface LayerTrack {
  id: string;
  name: string;
  visible: boolean;
  /** Sorted by frameIndex ascending. May be empty (every frame empty). */
  keyframes: Keyframe[];
}

/** Shared id for "empty layer" content, so blank layers/keyframes dedupe. */
export const EMPTY_CONTENT_ID = "empty";

export const DEFAULT_FRAME_RATE = 12;
export const DEFAULT_DURATION = 24;

/** Onion-skin ghost tints (Flash convention: warm past, cool future). */
const ONION_PREV_COLOR = "#d84a4a";
const ONION_NEXT_COLOR = "#3f8f5f";
/** Ghost opacity. Outline-only ghosts read lighter, so this sits higher
 * than the old filled-ghost value. */
const ONION_OPACITY = 0.45;

/** Lightweight, immutable view of the timeline for UI panels. */
export interface TimelineState {
  /** Bottom → top (same convention as layerStore). */
  tracks: Array<{
    id: string;
    name: string;
    visible: boolean;
    keyframes: Array<{ frame: number; blank: boolean; holdUntil: number }>;
  }>;
  currentFrame: number;
  duration: number;
  frameRate: number;
  playing: boolean;
  onionSkin: boolean;
  autoHold: boolean;
  /** Flash-style Edit Multiple Frames: range contents editable on stage. */
  editMultipleFrames: boolean;
  emfRange: { layerIds: string[]; start: number; end: number } | null;
}

export const timelineStore = new Store<TimelineState>({
  tracks: [],
  currentFrame: 0,
  duration: DEFAULT_DURATION,
  frameRate: DEFAULT_FRAME_RATE,
  playing: false,
  onionSkin: true,
  autoHold: true,
  editMultipleFrames: false,
  emfRange: null,
});

/** Sentinel in loadedContent while an EMF composite overlay is on a layer. */
const EMF_LOADED_SENTINEL = "__emf__";

export type EmfRange = {
  layerIds: string[];
  start: number;
  end: number;
};

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
  private onionSkinEnabled = true;
  /**
   * When enabled, inserting a keyframe/blank keyframe extends the previous
   * keyframe's hold up to the new keyframe. Not persisted, not in history.
   */
  private autoHoldEnabled = true;

  /**
   * Edit Multiple Frames: show unique keyframe contents in a selected range
   * on stage so select/transform/recolor can edit them together. Not
   * persisted, not in history.
   */
  private editMultipleFrames = false;
  private emfRange: EmfRange | null = null;

  /** contentId currently loaded into each Paper layer. */
  private loadedContent = new Map<string, string>();
  private contentIdCounter = 1;

  constructor(renderer: PaperRenderer) {
    this.renderer = renderer;
    // Ghosts follow the active layer, and selection changes don't go
    // through publish() — refresh them here when the selection moves.
    let lastActive = layerStore.get().activeLayerId;
    layerStore.subscribe((s) => {
      if (s.activeLayerId === lastActive) return;
      lastActive = s.activeLayerId;
      if (this.editMultipleFrames && this.emfRange) {
        const { start, end } = this.emfRange;
        this.renderer.setEmfPlayheadFrame(
          this.currentFrame >= start && this.currentFrame <= end
            ? this.currentFrame
            : null,
        );
      }
      if (this.onionSkinEnabled) this.updateOnionSkin();
    });
    viewOverlayStore.subscribe(() => {
      if (this.onionSkinEnabled) this.updateOnionSkin();
    });
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

  /** Copy artwork into a fresh content entry (used when duplicating frames). */
  private cloneContentId(contentId: string): string {
    if (contentId === EMPTY_CONTENT_ID) return EMPTY_CONTENT_ID;
    const id = this.newContentId();
    this.content.set(id, this.content.get(contentId) ?? "");
    return id;
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

  /** Last keyframe with frameIndex <= frame, or null when none exists. */
  private previousKeyframe(track: LayerTrack, frame: number): Keyframe | null {
    let previous: Keyframe | null = null;
    for (const kf of track.keyframes) {
      if (kf.frameIndex > frame) break;
      previous = kf;
    }
    return previous;
  }

  /**
   * The keyframe whose span (frameIndex..holdUntil) covers this frame, or
   * null when the frame is empty (before the first keyframe or after a
   * span ended).
   */
  private coveringKeyframe(track: LayerTrack, frame: number): Keyframe | null {
    const kf = this.previousKeyframe(track, frame);
    return kf && kf.holdUntil >= frame ? kf : null;
  }

  /** Content visible at a frame (empty when no keyframe span covers it). */
  private contentIdAt(track: LayerTrack, frame: number): string {
    return this.coveringKeyframe(track, frame)?.contentId ?? EMPTY_CONTENT_ID;
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
          keyframes: [{ frameIndex: 0, contentId: EMPTY_CONTENT_ID, holdUntil: 0 }],
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
   *
   * During Edit Multiple Frames, partitions the layer by keyframe-frame tags and
   * writes each bucket back to its source keyframe (new strokes stay on the
   * playhead frame).
   */
  commitActiveLayerContent(): boolean {
    if (this.editMultipleFrames) {
      return this.commitEditMultipleFrames();
    }

    const layerId = this.renderer.getActiveLayerId();
    if (!layerId) return false;
    const track = this.getTrack(layerId);
    if (!track) return false;

    const json = this.renderer.isLayerEmpty(layerId)
      ? ""
      : this.renderer.exportLayerJSON(layerId) ?? "";

    const covering = this.coveringKeyframe(track, this.currentFrame);
    const visibleContentId = covering?.contentId ?? EMPTY_CONTENT_ID;
    const currentJson = this.content.get(visibleContentId) ?? "";

    if (json === currentJson) {
      this.loadedContent.set(layerId, visibleContentId);
      return false;
    }

    let contentId: string;
    if (json === "") {
      contentId = EMPTY_CONTENT_ID;
    } else {
      contentId = this.newContentId();
      this.content.set(contentId, json);
    }

    // Editing a hold or empty frame auto-creates a keyframe here (with the
    // same hold/auto-hold rules as an explicit insert).
    this.placeKeyframe(track, this.currentFrame, contentId);
    this.loadedContent.set(layerId, contentId);
    this.publish();
    return true;
  }

  /**
   * Write each EMF keyframe bucket back into the document. New strokes are
   * tagged with the playhead frame; select edits on other keyframes write
   * back to those keyframes only. Does not rebuild the overlay so the live
   * selection stays valid after transform/recolor.
   */
  private commitEditMultipleFrames(): boolean {
    const layerId = this.renderer.getActiveLayerId();
    if (!layerId || !this.emfRange) return false;
    if (!this.emfRange.layerIds.includes(layerId)) return false;
    const track = this.getTrack(layerId);
    if (!track) return false;

    const { start, end } = this.emfRange;
    const expectedFrames = this.keyframeFramesInRange(track, start, end);
    // Only treat the playhead as a write target when it sits inside the EMF
    // range. Scrubbing outside used to push currentFrame into this list with
    // an empty partition and wipe that frame via placeKeyframe(EMPTY).
    if (
      this.currentFrame >= start &&
      this.currentFrame <= end &&
      !expectedFrames.includes(this.currentFrame)
    ) {
      expectedFrames.push(this.currentFrame);
    }

    const partitions = this.renderer.exportLayerContentsByKeyframe(
      layerId,
      // Untagged strokes only belong to the playhead when it's in-range.
      this.currentFrame >= start && this.currentFrame <= end
        ? this.currentFrame
        : start,
    );
    let changed = false;

    const writeFrame = (frameIndex: number, json: string): boolean => {
      if (frameIndex < start || frameIndex > end) return false;
      const kf = track.keyframes.find((k) => k.frameIndex === frameIndex);
      const prev = kf ? (this.content.get(kf.contentId) ?? "") : "";
      if (json === prev) return false;

      let newId: string;
      if (json === "") {
        newId = EMPTY_CONTENT_ID;
      } else {
        newId = this.newContentId();
        this.content.set(newId, json);
      }
      this.placeKeyframe(track, frameIndex, newId);
      return true;
    };

    for (const frameIndex of expectedFrames) {
      if (writeFrame(frameIndex, partitions.get(frameIndex) ?? "")) {
        changed = true;
      }
    }

    for (const [frameIndex, json] of partitions) {
      if (expectedFrames.includes(frameIndex)) continue;
      if (!json) continue;
      if (writeFrame(frameIndex, json)) changed = true;
    }

    if (changed) {
      this.renderer.setEmfPlayheadFrame(
        this.currentFrame >= start && this.currentFrame <= end
          ? this.currentFrame
          : null,
      );
      this.publish();
    }
    return changed;
  }

  /** Keyframe start frames whose spans intersect [start, end]. */
  private keyframeFramesInRange(
    track: LayerTrack,
    start: number,
    end: number,
  ): number[] {
    const frames: number[] = [];
    for (const kf of track.keyframes) {
      if (kf.holdUntil < start || kf.frameIndex > end) continue;
      frames.push(kf.frameIndex);
    }
    return frames;
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

  /**
   * Put a keyframe with this content at a frame, applying the shared hold
   * rules (used by explicit +K/+B inserts and draw-triggered auto-key):
   * - A keyframe already at the frame just gets the new content.
   * - Otherwise a new keyframe is inserted. If it splits an existing hold,
   *   it takes over the remainder of the span.
   * - With auto-hold on, the previous keyframe is held up to the new one.
   * - Blank keyframes are always single-frame: they are never extended and
   *   never hold.
   */
  private placeKeyframe(track: LayerTrack, frame: number, contentId: string): void {
    const blank = contentId === EMPTY_CONTENT_ID;
    const previous = this.previousKeyframe(track, frame);

    if (previous?.frameIndex === frame) {
      previous.contentId = contentId;
      if (blank) previous.holdUntil = frame;
      return;
    }

    let holdUntil = frame;
    if (previous) {
      // Tail of a split hold carries over to the new keyframe (unless blank).
      if (!blank && previous.holdUntil > frame) holdUntil = previous.holdUntil;
      const prevBlank = previous.contentId === EMPTY_CONTENT_ID;
      previous.holdUntil =
        this.autoHoldEnabled && !prevBlank
          ? frame - 1
          : Math.min(previous.holdUntil, frame - 1);
    }
    this.insertKeyframe(track, { frameIndex: frame, contentId, holdUntil });
  }

  // ------------------------------------------------------------
  // Timeline operations
  // ------------------------------------------------------------

  /**
   * Insert a keyframe on a layer at a frame. Non-blank copies the previous
   * keyframe's content (Flash F6); blank starts empty (Flash F7). Hold and
   * auto-hold rules are in `placeKeyframe`. Returns true if changed.
   */
  addKeyframe(layerId: string, frame: number, blank: boolean): boolean {
    const track = this.getTrack(layerId);
    if (!track) return false;
    frame = this.clampFrame(frame);

    const previous = this.previousKeyframe(track, frame);
    const contentId = blank
      ? EMPTY_CONTENT_ID
      : previous?.contentId ?? EMPTY_CONTENT_ID;
    if (previous?.frameIndex === frame && previous.contentId === contentId) {
      return false;
    }
    this.placeKeyframe(track, frame, contentId);

    if (frame === this.currentFrame) this.reloadCurrentFrame();
    this.publish();
    return true;
  }

  /**
   * Toggle the hold on the keyframe whose span covers this frame (double-tap
   * gesture). Not held → extend up to the next keyframe or the end of the
   * animation; held → collapse back to a single frame. Blank keyframes never
   * hold. Returns true if changed.
   */
  toggleKeyframeHold(layerId: string, frame: number): boolean {
    const track = this.getTrack(layerId);
    if (!track) return false;
    const kf = this.coveringKeyframe(track, this.clampFrame(frame));
    if (!kf || kf.contentId === EMPTY_CONTENT_ID) return false;

    if (kf.holdUntil > kf.frameIndex) {
      kf.holdUntil = kf.frameIndex;
    } else {
      const at = track.keyframes.indexOf(kf);
      const next = track.keyframes[at + 1];
      const maxEnd = (next?.frameIndex ?? this.duration) - 1;
      if (maxEnd <= kf.frameIndex) return false;
      kf.holdUntil = maxEnd;
    }

    this.reloadCurrentFrame();
    this.publish();
    return true;
  }

  /**
   * Make frames start..end empty on this track, preserving everything
   * outside the range — deleting the middle of a hold punches a hole: the
   * head keeps its keyframe (hold snipped to start - 1) and the tail
   * re-materializes as a new keyframe at end + 1 with the leftover hold.
   * Mutates the track only; returns true when anything changed.
   */
  private cutFrameRange(track: LayerTrack, start: number, end: number): boolean {
    const kept: Keyframe[] = [];
    const tails: Keyframe[] = [];
    let changed = false;

    for (const kf of track.keyframes) {
      // Entirely outside the range (span ends before it or starts after it).
      if (kf.holdUntil < start || kf.frameIndex > end) {
        kept.push(kf);
        continue;
      }
      changed = true;
      const tailEnd = kf.holdUntil;
      if (kf.frameIndex < start) {
        // Head survives with a snipped hold.
        kf.holdUntil = start - 1;
        kept.push(kf);
      }
      if (tailEnd > end) {
        // Hold reached past the range: re-create the tail after it.
        tails.push({ frameIndex: end + 1, contentId: kf.contentId, holdUntil: tailEnd });
      }
    }

    if (!changed) return false;
    track.keyframes = [...kept, ...tails].sort(
      (a, b) => a.frameIndex - b.frameIndex,
    );
    return true;
  }

  /**
   * Delete a frame range (single frame or drag selection): exactly the
   * selected frames go empty, everything before and after survives (see
   * `cutFrameRange`). Returns true if changed.
   */
  removeFrameRange(layerId: string, start: number, end: number): boolean {
    const track = this.getTrack(layerId);
    if (!track) return false;
    [start, end] = this.normalizeRange(start, end);
    if (!this.cutFrameRange(track, start, end)) return false;

    this.reloadCurrentFrame();
    this.publish();
    return true;
  }

  /**
   * The visible content of frames start..end as standalone keyframes: spans
   * are clipped to the range, and a hold covering `start` is materialized
   * as a keyframe at `start`.
   */
  private extractFrameRange(track: LayerTrack, start: number, end: number): Keyframe[] {
    const segment: Keyframe[] = [];
    for (const kf of track.keyframes) {
      if (kf.holdUntil < start || kf.frameIndex > end) continue;
      segment.push({
        frameIndex: Math.max(kf.frameIndex, start),
        contentId: kf.contentId,
        holdUntil: Math.min(kf.holdUntil, end),
      });
    }
    return segment;
  }

  /**
   * Move the frames in start..end by `delta` frames. The source range goes
   * empty, the destination range is overwritten, and anything shifted past
   * either end of the timeline is dropped (spans crossing the edge keep
   * their in-bounds part). Returns true if changed.
   */
  moveFrameRange(layerId: string, start: number, end: number, delta: number): boolean {
    const track = this.getTrack(layerId);
    if (!track) return false;
    [start, end] = this.normalizeRange(start, end);
    delta = Math.round(delta);
    if (delta === 0) return false;

    const segment = this.extractFrameRange(track, start, end);
    if (segment.length === 0) return false;

    this.cutFrameRange(track, start, end);

    // Vacate the destination (overwrite semantics), clipped to the timeline.
    const destStart = Math.max(0, start + delta);
    const destEnd = Math.min(this.duration - 1, end + delta);
    if (destStart <= destEnd) this.cutFrameRange(track, destStart, destEnd);

    for (const kf of segment) {
      const from = kf.frameIndex + delta;
      const to = kf.holdUntil + delta;
      if (to < 0 || from > this.duration - 1) continue; // fully off the timeline
      this.insertKeyframe(track, {
        frameIndex: Math.max(0, from),
        contentId: kf.contentId,
        holdUntil: Math.min(this.duration - 1, to),
      });
    }

    this.reloadCurrentFrame();
    this.publish();
    return true;
  }

  /**
   * Copy the frames in start..end to a destination range. Artwork is cloned so
   * edits to either copy stay independent. When `destStart` is omitted, copies
   * land immediately after the source (tap-to-duplicate). Returns the
   * destination range, or null when there is no room or nothing to copy.
   */
  duplicateFrameRange(
    layerId: string,
    start: number,
    end: number,
    destStart?: number,
  ): { start: number; end: number } | null {
    const track = this.getTrack(layerId);
    if (!track) return null;
    [start, end] = this.normalizeRange(start, end);
    const len = end - start + 1;
    const dest = destStart ?? end + 1;
    const destEnd = dest + len - 1;
    if (dest < 0 || destEnd >= this.duration) return null;

    const segment = this.extractFrameRange(track, start, end);
    if (segment.length === 0) return null;

    this.cutDestinationForDuplicate(track, dest, destEnd, start, end);

    const offset = dest - start;
    for (const kf of segment) {
      const from = kf.frameIndex + offset;
      const to = kf.holdUntil + offset;
      if (to < 0 || from > this.duration - 1) continue;
      this.insertKeyframe(track, {
        frameIndex: Math.max(0, from),
        contentId: this.cloneContentId(kf.contentId),
        holdUntil: Math.min(this.duration - 1, to),
      });
    }

    this.reloadCurrentFrame();
    this.publish();
    return { start: dest, end: destEnd };
  }

  /** Clear destination frames that are not part of the source being duplicated. */
  private cutDestinationForDuplicate(
    track: LayerTrack,
    destStart: number,
    destEnd: number,
    sourceStart: number,
    sourceEnd: number,
  ): void {
    if (destEnd < sourceStart) {
      this.cutFrameRange(track, destStart, destEnd);
      return;
    }
    if (destStart > sourceEnd) {
      this.cutFrameRange(track, destStart, destEnd);
      return;
    }
    if (destStart < sourceStart) {
      this.cutFrameRange(track, destStart, sourceStart - 1);
    }
    if (destEnd > sourceEnd) {
      this.cutFrameRange(track, sourceEnd + 1, destEnd);
    }
  }

  /**
   * Reverse the visible artwork order across start..end (frame-by-frame).
   * Returns true when the range changed.
   */
  reverseFrameRange(layerId: string, start: number, end: number): boolean {
    const track = this.getTrack(layerId);
    if (!track) return false;
    [start, end] = this.normalizeRange(start, end);
    if (start >= end) return false;

    const frameContents: string[] = [];
    for (let frame = start; frame <= end; frame++) {
      frameContents.push(this.contentIdAt(track, frame));
    }
    frameContents.reverse();

    if (!this.cutFrameRange(track, start, end)) return false;

    for (let i = 0; i < frameContents.length; i++) {
      this.placeKeyframe(track, start + i, frameContents[i]!);
    }

    this.reloadCurrentFrame();
    this.publish();
    return true;
  }

  /** Clamp both ends to the timeline and put them in ascending order. */
  private normalizeRange(start: number, end: number): [number, number] {
    const a = this.clampFrame(start);
    const b = this.clampFrame(end);
    return a <= b ? [a, b] : [b, a];
  }

  setDuration(frames: number): boolean {
    const next = Math.max(1, Math.min(9999, Math.round(frames)));
    if (next === this.duration) return false;
    // Shrinking simply drops keyframes past the new end. The frame-0
    // keyframe always survives since next >= 1.
    for (const track of this.tracks) {
      track.keyframes = track.keyframes.filter((k) => k.frameIndex < next);
      for (const k of track.keyframes) {
        k.holdUntil = Math.min(k.holdUntil, next - 1);
      }
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
    if (playing && this.editMultipleFrames) {
      this.clearEditMultipleFramesState();
      this.reloadCurrentFrame();
    }
    this.playing = playing;
    this.publish();
  }

  isAutoHoldEnabled(): boolean {
    return this.autoHoldEnabled;
  }

  setAutoHold(enabled: boolean): void {
    if (this.autoHoldEnabled === enabled) return;
    this.autoHoldEnabled = enabled;
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

  isEditMultipleFrames(): boolean {
    return this.editMultipleFrames;
  }

  getEditMultipleFramesRange(): EmfRange | null {
    return this.emfRange ? { ...this.emfRange, layerIds: [...this.emfRange.layerIds] } : null;
  }

  /**
   * Enter or leave Flash-style Edit Multiple Frames. Caller must commit live
   * edits before enabling. While on, unique contents in the range are shown
   * together on stage for select/transform/recolor; new drawing still goes
   * to the playhead frame. Returns true when the document model changed
   * (playhead content was split for independent drawing).
   */
  setEditMultipleFrames(enabled: boolean, range?: EmfRange | null): boolean {
    if (enabled) {
      if (!range || range.layerIds.length === 0) return false;
      const [start, end] = this.normalizeRange(range.start, range.end);
      this.editMultipleFrames = true;
      this.emfRange = {
        layerIds: [...range.layerIds],
        start,
        end,
      };
      this.rebuildEditMultipleFramesOverlay();
      this.publish();
      return false;
    }

    if (!this.editMultipleFrames) return false;
    this.clearEditMultipleFramesState();
    this.reloadCurrentFrame();
    this.publish();
    return false;
  }

  /** Composite one editable copy per intersecting keyframe onto each EMF layer. */
  private rebuildEditMultipleFramesOverlay(): void {
    if (!this.emfRange) return;
    const { layerIds, start, end } = this.emfRange;
    const emfSet = new Set(layerIds);

    this.renderer.restoreLayersSnapshot(
      this.tracks.map((track) => {
        if (!emfSet.has(track.id)) {
          const contentId = this.contentIdAt(track, this.currentFrame);
          const changed = this.loadedContent.get(track.id) !== contentId;
          if (changed) this.loadedContent.set(track.id, contentId);
          return {
            id: track.id,
            name: track.name,
            visible: track.visible,
            json: changed ? this.content.get(contentId) ?? "" : undefined,
          };
        }
        this.loadedContent.set(track.id, EMF_LOADED_SENTINEL);
        return {
          id: track.id,
          name: track.name,
          visible: track.visible,
          json: "",
        };
      }),
      this.renderer.getActiveLayerId() ??
        this.tracks[this.tracks.length - 1]?.id ??
        STAGE_LAYER_ID,
    );

    for (const layerId of layerIds) {
      const track = this.getTrack(layerId);
      if (!track) continue;
      const contents: Array<{ keyframeFrame: number; json: string }> = [];
      for (const kf of track.keyframes) {
        if (kf.holdUntil < start || kf.frameIndex > end) continue;
        if (kf.contentId === EMPTY_CONTENT_ID) continue;
        const json = this.content.get(kf.contentId) ?? "";
        if (!json) continue;
        contents.push({ keyframeFrame: kf.frameIndex, json });
      }
      this.renderer.setLayerContentsByKeyframe(layerId, contents);
      this.loadedContent.set(layerId, EMF_LOADED_SENTINEL);
    }

    this.renderer.setEmfPlayheadFrame(
      this.currentFrame >= start && this.currentFrame <= end
        ? this.currentFrame
        : null,
    );
  }

  /**
   * Rebuild the onion-skin ghost layers for the current playhead position.
   * Shows exactly two ghosts for the *active* layer only: its nearest
   * previous and nearest next keyframe with real artwork, however far away
   * (blank keyframes and empty gaps are skipped). A keyframe whose content
   * matches what's on screen is skipped — it would just paint an invisible
   * copy under itself.
   */
  private updateOnionSkin(): void {
    if (!this.onionSkinEnabled || this.playing || this.editMultipleFrames) {
      this.renderer.clearOnionSkin();
      return;
    }

    // Nearest keyframe with drawable content in the given direction, ignoring
    // blanks and any keyframe whose span governs the current frame.
    const nearestKeyframe = (track: LayerTrack, direction: -1 | 1): Keyframe | null => {
      const kfs = track.keyframes;
      if (direction === -1) {
        for (let i = kfs.length - 1; i >= 0; i--) {
          const kf = kfs[i];
          if (kf.frameIndex >= this.currentFrame) continue;
          if (kf.holdUntil >= this.currentFrame) continue;
          if (kf.contentId === EMPTY_CONTENT_ID) continue;
          return kf;
        }
      } else {
        for (const kf of kfs) {
          if (kf.frameIndex <= this.currentFrame) continue;
          if (kf.contentId === EMPTY_CONTENT_ID) continue;
          return kf;
        }
      }
      return null;
    };

    // Only the active layer gets ghosts; other layers' motion is noise
    // while drawing on this one.
    const activeId = layerStore.get().activeLayerId;
    const track = this.tracks.find((t) => t.id === activeId);
    if (!track || !track.visible) {
      this.renderer.clearOnionSkin();
      return;
    }

    const collectGhost = (direction: -1 | 1, color: string) => {
      const kf = nearestKeyframe(track, direction);
      if (!kf) return;
      if (kf.contentId === this.contentIdAt(track, this.currentFrame)) return;
      const json = this.content.get(kf.contentId);
      if (json) {
        ghosts.push({ jsons: [json], opacity: ONION_OPACITY, color });
      }
    };

    const ghosts: Array<{ jsons: string[]; opacity: number; color: string }> = [];
    collectGhost(-1, ONION_PREV_COLOR);
    collectGhost(1, ONION_NEXT_COLOR);

    this.renderer.setOnionSkin(ghosts, viewOverlayStore.get().onionSkinOutline);
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

    // EMF overlay is keyed by the selected range, not the playhead. Moving the
    // playhead only retargets where new strokes go — keep the composite (and
    // any live selection) intact.
    if (this.editMultipleFrames && this.emfRange) {
      const emfSet = new Set(this.emfRange.layerIds);
      this.renderer.restoreLayersSnapshot(
        this.tracks.map((track) => {
          if (emfSet.has(track.id)) {
            return {
              id: track.id,
              name: track.name,
              visible: track.visible,
              json: undefined,
            };
          }
          const contentId = this.contentIdAt(track, this.currentFrame);
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
      const { start, end } = this.emfRange;
      this.renderer.setEmfPlayheadFrame(
        this.currentFrame >= start && this.currentFrame <= end
          ? this.currentFrame
          : null,
      );
      return;
    }

    this.renderer.restoreLayersSnapshot(
      this.tracks.map((track) => {
        const contentId = this.contentIdAt(track, this.currentFrame);
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
    this.clearEditMultipleFramesState();
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

  /** Drop EMF mode without reloading (caller reloads / publishes as needed). */
  private clearEditMultipleFramesState(): void {
    if (!this.editMultipleFrames && !this.emfRange) {
      this.renderer.setEmfPlayheadFrame(null);
      return;
    }
    this.editMultipleFrames = false;
    this.emfRange = null;
    this.renderer.setEmfPlayheadFrame(null);
    for (const [layerId, loaded] of [...this.loadedContent.entries()]) {
      if (loaded === EMF_LOADED_SENTINEL) this.loadedContent.delete(layerId);
    }
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
    this.duration = Math.max(1, Math.round(doc.duration));
    // Guarantee model invariants on untrusted input.
    for (const track of this.tracks) {
      track.keyframes.sort((a, b) => a.frameIndex - b.frameIndex);
      // Normalize hold spans. Old documents (pre-explicit-holds) have no
      // holdUntil: default to the implicit span (up to the next keyframe)
      // so they look the way they did when saved. Blank keyframes are
      // always single-frame.
      for (let i = 0; i < track.keyframes.length; i++) {
        const kf = track.keyframes[i];
        if (kf.contentId === EMPTY_CONTENT_ID) {
          kf.holdUntil = kf.frameIndex;
          continue;
        }
        const spanEnd =
          (track.keyframes[i + 1]?.frameIndex ?? this.duration) - 1;
        const hold = Number((kf as Partial<Keyframe>).holdUntil);
        kf.holdUntil = Number.isFinite(hold)
          ? Math.max(kf.frameIndex, Math.min(hold, spanEnd))
          : spanEnd;
      }
    }
    this.frameRate = Math.max(1, Math.min(60, Math.round(doc.frameRate)));
    this.currentFrame = 0;
    this.playing = false;
    this.clearEditMultipleFramesState();

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

  private refreshDocumentColors(): void {
    documentColorsStore.set(collectDocumentColors(this.tracks, this.content));
  }

  private publish(): void {
    // Every document mutation funnels through here, so the ghosts always
    // track the latest content, visibility, playhead, and playback state.
    this.updateOnionSkin();
    this.refreshDocumentColors();
    timelineStore.set({
      tracks: this.tracks.map((t) => ({
        id: t.id,
        name: t.name,
        visible: t.visible,
        keyframes: t.keyframes.map((k) => ({
          frame: k.frameIndex,
          blank: k.contentId === EMPTY_CONTENT_ID,
          holdUntil: k.holdUntil,
        })),
      })),
      currentFrame: this.currentFrame,
      duration: this.duration,
      frameRate: this.frameRate,
      playing: this.playing,
      onionSkin: this.onionSkinEnabled,
      autoHold: this.autoHoldEnabled,
      editMultipleFrames: this.editMultipleFrames,
      emfRange: this.emfRange
        ? { ...this.emfRange, layerIds: [...this.emfRange.layerIds] }
        : null,
    });
  }
}
