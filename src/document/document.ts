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
  onionSkinStore,
  autoHoldStore,
  realTimeLockStore,
  selectionStore,
  STAGE_LAYER_ID,
  generateLayerId,
  isLayerEffectivelyVisible,
  type Layer,
  type LayerState,
} from "../state/index";
import { symbolLibraryStore, editContextStore } from "../state/document-ui";
import {
  collectDocumentColors,
  colorsFromPaperJson,
  normalizeDocumentHex,
  replaceColorInPaperJson,
} from "./colors";
import type { PaperRenderer } from "../render/paper-renderer";
import {
  EMPTY_CONTENT_ID,
  contentIdAtFrame,
  coveringKeyframeOf,
  previousKeyframeOf,
  type Keyframe,
} from "./keyframes";
import {
  cloneSymbol,
  cloneSymbols,
  newInstanceId,
  normalizeSymbol,
  scanInstanceSymbolIds,
  type SymbolDefinition,
  type SymbolResolver,
} from "./symbols";
import { clearSymbolTemplateCache } from "../render/paper/symbol-instances";
import {
  clearSymbolThumbnailCache,
  symbolThumbnailUrl,
} from "../render/paper/symbol-thumbnail";

export { EMPTY_CONTENT_ID, type Keyframe } from "./keyframes";
export type {
  SymbolDefinition,
  SymbolInstanceData,
  SymbolPlayMode,
} from "./symbols";

// ============================================================
// Types
// ============================================================

export type TrackKind = "vector" | "image" | "audio";

export interface AudioClip {
  assetId: string;
  startFrame: number;
}

export interface AssetMeta {
  name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface LayerTrack {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /** Missing/unknown treated as vector. */
  kind?: TrackKind;
  /** Present on audio tracks. */
  audio?: AudioClip;
  /** Sorted by frameIndex ascending. May be empty (every frame empty). */
  keyframes: Keyframe[];
}

export function trackKind(track: Pick<LayerTrack, "kind">): TrackKind {
  return track.kind === "image" || track.kind === "audio" ? track.kind : "vector";
}

export function isVectorTrack(track: Pick<LayerTrack, "kind">): boolean {
  return trackKind(track) === "vector";
}

export function trackKindFromLayer(
  kind: Layer["kind"],
): TrackKind {
  if (kind === "image") return "image";
  if (kind === "audio") return "audio";
  return "vector";
}

export function layerKindFromTrack(kind?: TrackKind): Layer["kind"] {
  if (kind === "image") return "image";
  if (kind === "audio") return "audio";
  return "regular";
}

/** Image keyframe payload in the content map. */
export function imageContent(assetId: string): string {
  return JSON.stringify({ asset: assetId });
}

export function parseImageContent(json: string): string | null {
  if (!json || json[0] !== "{") return null;
  try {
    const parsed = JSON.parse(json) as { asset?: unknown };
    return typeof parsed.asset === "string" && parsed.asset ? parsed.asset : null;
  } catch {
    return null;
  }
}

/** Named frame range (Aseprite-style tag), document-level. */
export type FrameTag = {
  id: string;
  name: string;
  start: number; // inclusive
  end: number; // inclusive
};

/**
 * Resize one tag and carve that range out of every other tag (trim, split,
 * or drop). Returns a new array, or null if `id` is missing.
 */
export function applyFrameTagResize(
  tags: FrameTag[],
  id: string,
  start: number,
  end: number,
  newId: () => string,
): FrameTag[] | null {
  const target = tags.find((t) => t.id === id);
  if (!target) return null;
  const a = Math.min(start, end);
  const b = Math.max(start, end);
  const out: FrameTag[] = [];
  for (const t of tags) {
    if (t.id === id) continue;
    if (t.end < a || t.start > b) {
      out.push({ ...t });
      continue;
    }
    if (t.start < a) {
      out.push({ ...t, end: a - 1 });
    }
    if (t.end > b) {
      const keptLeft = t.start < a;
      out.push({
        ...t,
        id: keptLeft ? newId() : t.id,
        start: b + 1,
      });
    }
  }
  // Resized tag last so it paints above siblings in the strip.
  out.push({ ...target, start: a, end: b });
  return out;
}

export const DEFAULT_FRAME_RATE = 12;
export const DEFAULT_DURATION = 24;

/** Lightweight, immutable view of the timeline for UI panels. */
export interface TimelineState {
  /** Bottom → top (same convention as layerStore). */
  tracks: Array<{
    id: string;
    name: string;
    visible: boolean;
    locked: boolean;
    kind: TrackKind;
    keyframes: Array<{ frame: number; blank: boolean; holdUntil: number }>;
    audio?: { assetId: string; startFrame: number; durationFrames: number };
    assetIds?: string[];
  }>;
  currentFrame: number;
  duration: number;
  frameRate: number;
  playing: boolean;
  /** Client pref (onionSkinStore), mirrored for timeline UI. */
  onionSkin: boolean;
  /** Client pref (autoHoldStore), mirrored for timeline UI. */
  autoHold: boolean;
  /** Client pref (realTimeLockStore). Changing fps rescales keyframes. */
  realTimeLock: boolean;
  /** Flash-style Edit Multiple Frames: range contents editable on stage. */
  editMultipleFrames: boolean;
  emfRange: { layerIds: string[]; start: number; end: number } | null;
  /** Named frame ranges (Aseprite-style tags). */
  tags: FrameTag[];
}

export const timelineStore = new Store<TimelineState>({
  tracks: [],
  currentFrame: 0,
  duration: DEFAULT_DURATION,
  frameRate: DEFAULT_FRAME_RATE,
  playing: false,
  onionSkin: true,
  autoHold: true,
  realTimeLock: false,
  editMultipleFrames: false,
  emfRange: null,
  tags: [],
});

/** Sentinel in loadedContent while an EMF composite overlay is on a layer. */
const EMF_LOADED_SENTINEL = "__emf__";

export type EmfRange = {
  layerIds: string[];
  start: number;
  end: number;
};

/** Serialized document JSON (also the autosave payload). */
export interface SerializedDocument {
  version: 1 | 2 | 3;
  /** Display / download name. Optional on older saves. */
  name?: string;
  stage: { width: number; height: number; color: string };
  frameRate: number;
  duration: number;
  /** Bottom → top. */
  tracks: LayerTrack[];
  /** contentId → paper.js layer JSON or image `{asset}` ("" = empty). */
  content: Record<string, string>;
  /** Optional for older saves. */
  tags?: FrameTag[];
  /** Asset id → metadata. Bytes live in IndexedDB, not this JSON. */
  assets?: Record<string, AssetMeta>;
  /** Symbol id → nested timeline (v3). Content ids point into `content`. */
  symbols?: Record<string, SymbolDefinition>;
}

/** One timeline's mutable state (the scene or a symbol). */
export interface TimelineSnapshot {
  tracks: LayerTrack[];
  duration: number;
  tags: FrameTag[];
  currentFrame: number;
}

/** One level of "edit symbol": which symbol, and (in place) via which instance. */
export interface EditContextRef {
  symbolId: string;
  /** Instance entered through (null = isolated edit from the Library). */
  instanceIid: string | null;
  layerId: string | null;
  /** Parent playhead when entered. */
  parentFrame: number;
  /** Instance world matrix `[a, b, c, d, tx, ty]` for the in-place backdrop. */
  worldMatrix: [number, number, number, number, number, number] | null;
}

/** Snapshot of the document's mutable state, used by doc-level history. */
export interface DocumentState {
  /** The scene timeline. */
  root: TimelineSnapshot;
  symbols: Record<string, SymbolDefinition>;
  /** Edit-symbol stack (outermost first). Empty = editing the scene. */
  context: EditContextRef[];
  /** Playhead of the timeline being edited (root or innermost symbol). */
  activeFrame: number;
  frameRate: number;
}

export type { EditContextState, SymbolLibraryEntry } from "../state/document-ui";
export { editContextStore, symbolLibraryStore } from "../state/document-ui";

export function cloneTracks(tracks: LayerTrack[]): LayerTrack[] {
  return tracks.map((t) => ({
    ...t,
    keyframes: t.keyframes.map((k) => ({ ...k })),
  }));
}

export function cloneTags(tags: FrameTag[]): FrameTag[] {
  return tags.map((t) => ({ ...t }));
}

/** Rescale tag spans by `ratio` into a timeline of `newDuration` frames. */
function retimeTagList<T extends { start: number; end: number }>(
  tags: T[],
  ratio: number,
  newDuration: number,
): T[] {
  const last = newDuration - 1;
  return tags
    .map((t) => {
      const start = Math.max(0, Math.min(last, Math.round(t.start * ratio)));
      const end = Math.max(start, Math.min(last, Math.round((t.end + 1) * ratio) - 1));
      return { ...t, start, end };
    })
    .filter((t) => t.start <= t.end);
}

/** Parse a Paper layer JSON payload into `[tag, props, ...]`, or null. */
function parseLayerPayload(
  json: string,
): [string, Record<string, unknown>, ...unknown[]] | null {
  if (!json.startsWith('["Layer"')) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed[0] === "Layer" &&
      parsed[1] &&
      typeof parsed[1] === "object"
    ) {
      return parsed as [string, Record<string, unknown>, ...unknown[]];
    }
  } catch {
    // Not parseable.
  }
  return null;
}

/** Layer JSON with the top-level layer `name` removed. */
function stripLayerName(json: string): string {
  const parsed = parseLayerPayload(json);
  if (!parsed) return json;
  delete parsed[1].name;
  return JSON.stringify(parsed);
}

/**
 * Stamp the track's current name into layer artwork JSON.
 *
 * Paper.js embeds `layer.name` in `exportJSON`. That name is track metadata,
 * not artwork — it must stay in sync with the layer panel or commit sees a
 * false dirty and auto-keys phantom pose copies on holds.
 */
export function withLayerName(json: string, name: string): string {
  if (!json) return json;
  const parsed = parseLayerPayload(json);
  if (!parsed) return json;
  if (parsed[1].name === name) return json;
  parsed[1].name = name;
  return JSON.stringify(parsed);
}

/**
 * Compare layer artwork JSON ignoring the layer's name.
 *
 * Defense in depth for rename / import drift: even if a stored keyframe
 * still carries a stale name, it must not count as an artwork edit.
 */
export function layerJsonEquals(a: string, b: string): boolean {
  if (a === b) return true;
  return stripLayerName(a) === stripLayerName(b);
}

// ============================================================
// DocumentManager
// ============================================================

export class DocumentManager {
  private renderer: PaperRenderer;

  private tracks: LayerTrack[] = [];
  /** contentId → paper layer JSON or image `{asset}` ("" means empty). */
  private content = new Map<string, string>([[EMPTY_CONTENT_ID, ""]]);
  private assets = new Map<string, AssetMeta>();
  private currentFrame = 0;
  private duration = DEFAULT_DURATION;
  private frameRate = DEFAULT_FRAME_RATE;
  private playing = false;
  private tags: FrameTag[] = [];
  private tagIdCounter = 1;
  /**
   * Edit Multiple Frames: show unique keyframe contents in a selected range
   * on stage so select/transform/recolor can edit them together. Not
   * persisted, not in history.
   */
  private editMultipleFrames = false;
  private emfRange: EmfRange | null = null;

  /** Symbol library. The symbol being edited is synced via `flushActiveTimeline`. */
  private symbols = new Map<string, SymbolDefinition>();
  private symbolIdCounter = 1;
  /**
   * Edit-symbol stack. `saved` is the timeline that was live before entering
   * `ref.symbolId` (stack[0].saved is the scene).
   */
  private contextStack: Array<{ ref: EditContextRef; saved: TimelineSnapshot }> = [];
  /** contentId → symbol ids referenced by instances in that content. */
  private symbolRefCache = new Map<string, string[]>();
  readonly symbolResolver: SymbolResolver = {
    getSymbol: (id) => {
      this.flushActiveTimeline();
      return this.symbols.get(id) ?? null;
    },
    getContent: (id) => this.content.get(id) ?? "",
  };

  /** contentId currently loaded into each Paper layer. */
  private loadedContent = new Map<string, string>();
  private contentIdCounter = 1;

  constructor(renderer: PaperRenderer) {
    this.renderer = renderer;
    this.renderer.setSymbolResolver(this.symbolResolver);
    // Ghosts follow layer selection / visibility / lock; those can change
    // without a document publish(), so refresh here too.
    let lastActive = layerStore.get().activeLayerId;
    layerStore.subscribe((s) => {
      if (s.activeLayerId !== lastActive) {
        lastActive = s.activeLayerId;
        if (this.editMultipleFrames && this.emfRange) {
          const { start, end } = this.emfRange;
          this.renderer.setEmfPlayheadFrame(
            this.currentFrame >= start && this.currentFrame <= end
              ? this.currentFrame
              : null,
          );
        }
      }
      if (onionSkinStore.get()) this.updateOnionSkin();
    });
    viewOverlayStore.subscribe(() => {
      if (onionSkinStore.get()) this.updateOnionSkin();
    });
    onionSkinStore.subscribe(() => {
      this.updateOnionSkin();
      this.publish();
    });
    autoHoldStore.subscribe(() => this.publish());
    realTimeLockStore.subscribe(() => this.publish());
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

  registerAsset(id: string, meta: AssetMeta): void {
    const prev = this.assets.get(id);
    this.assets.set(id, prev ? { ...prev, ...meta } : { ...meta });
    this.publish();
  }

  getAssetMeta(id: string): AssetMeta | undefined {
    return this.assets.get(id);
  }

  getReferencedAssetIds(): string[] {
    return this.collectReferencedAssetIds();
  }

  getAudioClips(): Array<{
    layerId: string;
    assetId: string;
    startFrame: number;
    muted: boolean;
  }> {
    const clips: Array<{
      layerId: string;
      assetId: string;
      startFrame: number;
      muted: boolean;
    }> = [];
    for (const track of this.tracks) {
      if (trackKind(track) !== "audio" || !track.audio?.assetId) continue;
      clips.push({
        layerId: track.id,
        assetId: track.audio.assetId,
        startFrame: track.audio.startFrame,
        muted: !this.isTrackEffectivelyVisible(track),
      });
    }
    return clips;
  }

  setImageAtFrame(layerId: string, frame: number, assetId: string): boolean {
    const track = this.getTrack(layerId);
    if (!track || trackKind(track) !== "image") return false;
    const ok = this.writeLayerContentAtFrame(layerId, frame, imageContent(assetId));
    if (ok && this.clampFrame(frame) === this.currentFrame) {
      this.loadedContent.delete(layerId);
      this.reloadCurrentFrame();
    }
    return ok;
  }

  setAudioClip(
    layerId: string,
    patch: { assetId?: string; startFrame?: number },
  ): boolean {
    const track = this.getTrack(layerId);
    if (!track || trackKind(track) !== "audio") return false;
    const prev = track.audio ?? { assetId: "", startFrame: 0 };
    const assetId = patch.assetId ?? prev.assetId;
    if (!assetId) return false;
    // The clip may start before frame 0 or run past the end, but must keep at
    // least one frame overlapping the timeline so it stays reachable.
    const len = this.audioDurationFrames(assetId);
    const startFrame = Math.max(
      -(len - 1),
      Math.min(
        this.duration - 1,
        Math.round(patch.startFrame ?? prev.startFrame),
      ),
    );
    const next = { assetId, startFrame };
    if (prev.assetId === next.assetId && prev.startFrame === next.startFrame) {
      return false;
    }
    track.audio = next;
    this.publish();
    return true;
  }

  relinkAsset(oldId: string, newId: string): boolean {
    if (!oldId || !newId || oldId === newId) return false;
    let changed = false;
    for (const [cid, json] of this.content) {
      if (parseImageContent(json) === oldId) {
        this.content.set(cid, imageContent(newId));
        changed = true;
      }
    }
    for (const track of this.tracks) {
      if (track.audio?.assetId === oldId) {
        track.audio = { ...track.audio, assetId: newId };
        changed = true;
      }
    }
    if (!changed) return false;
    this.loadedContent.clear();
    this.reloadCurrentFrame();
    this.publish();
    return true;
  }

  invalidateLayersUsingAsset(assetId: string): void {
    for (const track of this.tracks) {
      if (trackKind(track) !== "image") continue;
      const current = this.content.get(this.contentIdAt(track, this.currentFrame)) ?? "";
      if (parseImageContent(current) === assetId) {
        this.loadedContent.delete(track.id);
      }
    }
    this.publish();
  }

  private collectReferencedAssetIds(): string[] {
    const ids = new Set<string>();
    for (const track of this.tracks) {
      for (const id of this.trackAssetIds(track)) ids.add(id);
    }
    return [...ids];
  }

  private trackAssetIds(track: LayerTrack): string[] {
    if (trackKind(track) === "audio") {
      return track.audio?.assetId ? [track.audio.assetId] : [];
    }
    if (trackKind(track) !== "image") return [];
    const ids = new Set<string>();
    for (const kf of track.keyframes) {
      const asset = parseImageContent(this.content.get(kf.contentId) ?? "");
      if (asset) ids.add(asset);
    }
    return [...ids];
  }

  private audioDurationFrames(assetId: string): number {
    const ms = this.assets.get(assetId)?.durationMs;
    if (!ms || !Number.isFinite(ms)) return 1;
    return Math.max(1, Math.round((ms / 1000) * this.frameRate));
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
    for (const track of this.allTracks()) {
      for (const kf of track.keyframes) referenced.add(kf.contentId);
    }
    for (const entry of this.contextStack) {
      for (const track of entry.saved.tracks) {
        for (const kf of track.keyframes) referenced.add(kf.contentId);
      }
    }
    for (const id of [...this.content.keys()]) {
      if (!referenced.has(id)) {
        this.content.delete(id);
        this.symbolRefCache.delete(id);
      }
    }
  }

  // ------------------------------------------------------------
  // Keyframe helpers
  // ------------------------------------------------------------

  private getTrack(layerId: string): LayerTrack | null {
    return this.tracks.find((t) => t.id === layerId) ?? null;
  }

  getTrackKind(layerId: string): TrackKind | null {
    const track = this.getTrack(layerId);
    return track ? trackKind(track) : null;
  }

  /** Keyframe ops apply to vector and image tracks, not audio. */
  private requireKeyframeTrack(layerId: string): LayerTrack | null {
    const track = this.getTrack(layerId);
    if (!track || trackKind(track) === "audio") return null;
    return track;
  }

  /** Last keyframe with frameIndex <= frame, or null when none exists. */
  private previousKeyframe(track: LayerTrack, frame: number): Keyframe | null {
    return previousKeyframeOf(track, frame);
  }

  /**
   * The keyframe whose span (frameIndex..holdUntil) covers this frame, or
   * null when the frame is empty (before the first keyframe or after a
   * span ended).
   */
  private coveringKeyframe(track: LayerTrack, frame: number): Keyframe | null {
    return coveringKeyframeOf(track, frame);
  }

  /**
   * Start frame of the keyframe covering `frame` on a layer, or null when
   * empty. Used by Magic Move to treat held playhead content as “active frame”.
   */
  getCoveringKeyframeFrame(layerId: string, frame?: number): number | null {
    const track = this.getTrack(layerId);
    if (!track) return null;
    const at = this.clampFrame(frame ?? this.currentFrame);
    return this.coveringKeyframe(track, at)?.frameIndex ?? null;
  }

  /** Content visible at a frame (empty when no keyframe span covers it). */
  private contentIdAt(track: LayerTrack, frame: number): string {
    return contentIdAtFrame(track, frame);
  }

  // ------------------------------------------------------------
  // Symbols — library, edit context, usage
  // ------------------------------------------------------------

  private newSymbolId(): string {
    return `sym${Date.now().toString(36)}-${this.symbolIdCounter++}`;
  }

  private nextDefaultSymbolName(): string {
    let n = 1;
    const used = new Set([...this.symbols.values()].map((s) => s.name));
    while (used.has(`Symbol ${n}`)) n++;
    return `Symbol ${n}`;
  }

  /** Symbol currently being edited (innermost context), or null at the scene. */
  getEditingSymbolId(): string | null {
    return this.contextStack[this.contextStack.length - 1]?.ref.symbolId ?? null;
  }

  isEditingSymbol(): boolean {
    return this.contextStack.length > 0;
  }

  getEditContext(): EditContextRef[] {
    return this.contextStack.map((e) => ({ ...e.ref }));
  }

  /**
   * Write the live timeline (tracks/duration/tags) back into the symbol
   * record being edited. Cheap; called before every read of the library so
   * hydration, history, and saves always see live edits.
   */
  private flushActiveTimeline(): void {
    const top = this.contextStack[this.contextStack.length - 1];
    if (!top) return;
    const sym = this.symbols.get(top.ref.symbolId);
    if (!sym) return;
    sym.tracks = this.tracks as SymbolDefinition["tracks"];
    sym.duration = this.duration;
    sym.tags = this.tags;
  }

  /** Scene timeline (live when at the root, else the saved root snapshot). */
  private rootTimeline(): TimelineSnapshot {
    const root = this.contextStack[0]?.saved;
    return root ?? {
      tracks: this.tracks,
      duration: this.duration,
      tags: this.tags,
      currentFrame: this.currentFrame,
    };
  }

  /** Every track in the document: scene + all symbols (after flush). */
  private allTracks(): LayerTrack[] {
    this.flushActiveTimeline();
    const out: LayerTrack[] = [...this.rootTimeline().tracks];
    // Intermediate contexts (depth ≥ 2) are flushed on enter, so the symbol
    // map already has them; only the innermost needed a flush above.
    for (const sym of this.symbols.values()) out.push(...(sym.tracks as LayerTrack[]));
    return out;
  }

  getSymbol(id: string): SymbolDefinition | null {
    this.flushActiveTimeline();
    const sym = this.symbols.get(id);
    return sym ? cloneSymbol(sym) : null;
  }

  listSymbols(): SymbolDefinition[] {
    this.flushActiveTimeline();
    return [...this.symbols.values()].map(cloneSymbol);
  }

  /**
   * Register a new symbol whose content ids already exist in the content
   * store. Returns the stored definition (name auto-assigned when omitted).
   */
  createSymbol(
    def: Omit<SymbolDefinition, "id" | "name"> & { name?: string },
  ): SymbolDefinition {
    const symbol: SymbolDefinition = {
      id: this.newSymbolId(),
      name: (def.name?.trim() || this.nextDefaultSymbolName()).slice(0, 64),
      duration: Math.max(1, Math.round(def.duration)),
      tracks: def.tracks.map((t) => ({
        ...t,
        kind: "vector",
        keyframes: t.keyframes.map((k) => ({ ...k })),
      })),
      tags: def.tags.map((t) => ({ ...t })),
    };
    this.symbols.set(symbol.id, symbol);
    this.publish();
    return cloneSymbol(symbol);
  }

  /** Store a content blob for symbol artwork; returns its id. */
  addContent(json: string): string {
    if (!json) return EMPTY_CONTENT_ID;
    const id = this.newContentId();
    this.content.set(id, json);
    return id;
  }

  renameSymbol(id: string, name: string): boolean {
    const sym = this.symbols.get(id);
    if (!sym) return false;
    const next = name.trim().slice(0, 64);
    if (!next || next === sym.name) return false;
    sym.name = next;
    this.publish();
    return true;
  }

  /** Deep-copy a symbol (shared content ids; artwork is copy-on-write). */
  duplicateSymbol(id: string): SymbolDefinition | null {
    this.flushActiveTimeline();
    const src = this.symbols.get(id);
    if (!src) return null;
    const copy = cloneSymbol(src);
    copy.id = this.newSymbolId();
    let base = src.name.replace(/\s+\d+$/, "");
    if (!base) base = "Symbol";
    let n = 2;
    const used = new Set([...this.symbols.values()].map((s) => s.name));
    while (used.has(`${base} ${n}`)) n++;
    copy.name = `${base} ${n}`;
    for (const t of copy.tracks) t.id = generateLayerId();
    this.symbols.set(copy.id, copy);
    this.publish();
    return cloneSymbol(copy);
  }

  /** Remove an unused symbol. Returns false when missing or still placed. */
  deleteSymbol(id: string): boolean {
    if (!this.symbols.has(id)) return false;
    if (this.symbolUsageCounts().get(id)) return false;
    if (this.contextStack.some((e) => e.ref.symbolId === id)) return false;
    this.symbols.delete(id);
    this.publish();
    return true;
  }

  private symbolRefsIn(contentId: string): string[] {
    if (contentId === EMPTY_CONTENT_ID) return [];
    const cached = this.symbolRefCache.get(contentId);
    if (cached) return cached;
    const refs = scanInstanceSymbolIds(this.content.get(contentId) ?? "");
    this.symbolRefCache.set(contentId, refs);
    return refs;
  }

  /** Keyframes (scene + symbols) referencing each symbol. */
  private symbolUsageCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const track of this.allTracks()) {
      for (const kf of track.keyframes) {
        for (const id of this.symbolRefsIn(kf.contentId)) {
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
      }
    }
    return counts;
  }

  /** Symbol ids an instance of `symbolId` may NOT contain (itself + ancestors). */
  symbolWouldCycle(containerSymbolId: string, placedSymbolId: string): boolean {
    if (containerSymbolId === placedSymbolId) return true;
    this.flushActiveTimeline();
    const visited = new Set<string>();
    const stack = [placedSymbolId];
    while (stack.length) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const sym = this.symbols.get(id);
      if (!sym) continue;
      for (const t of sym.tracks) {
        for (const kf of t.keyframes) {
          for (const ref of this.symbolRefsIn(kf.contentId)) {
            if (ref === containerSymbolId) return true;
            stack.push(ref);
          }
        }
      }
    }
    return false;
  }

  private publishSymbolLibrary(): void {
    this.flushActiveTimeline();
    const counts = this.symbolUsageCounts();
    const editing = this.getEditingSymbolId();
    symbolLibraryStore.set({
      symbols: [...this.symbols.values()].map((s) => ({
        id: s.id,
        name: s.name,
        duration: s.duration,
        usageCount: counts.get(s.id) ?? 0,
        thumbnail: symbolThumbnailUrl(s, this.symbolResolver),
        placeable: !editing || !this.symbolWouldCycle(editing, s.id),
      })),
    });
    const path = this.contextStack.map((e) => ({
      symbolId: e.ref.symbolId,
      name: this.symbols.get(e.ref.symbolId)?.name ?? "Symbol",
    }));
    const prev = editContextStore.get();
    const inPlace = this.contextStack[this.contextStack.length - 1]?.ref.instanceIid != null;
    if (
      prev.inPlace !== inPlace ||
      prev.path.length !== path.length ||
      prev.path.some((p, i) => p.symbolId !== path[i].symbolId || p.name !== path[i].name)
    ) {
      editContextStore.set({ path, inPlace });
    }
  }

  /** Fired after the edit-symbol context changes (enter / exit / history). */
  onContextChanged: (() => void) | null = null;

  /** Replace the live timeline fields from a snapshot (clones tracks/tags). */
  private loadTimeline(snap: TimelineSnapshot): void {
    this.tracks = cloneTracks(snap.tracks);
    for (const track of this.tracks) track.locked = !!track.locked;
    this.duration = Math.max(1, Math.round(snap.duration));
    this.tags = cloneTags(snap.tags ?? []);
    this.clampTagsToDuration();
    this.currentFrame = Math.max(0, Math.min(this.duration - 1, snap.currentFrame));
    this.loadedContent.clear();
  }

  /** Save the live timeline and load `ref.symbolId` for editing. */
  private pushContext(ref: EditContextRef): void {
    const sym = this.symbols.get(ref.symbolId);
    if (!sym) return;
    this.flushActiveTimeline();
    this.contextStack.push({
      ref,
      saved: {
        tracks: this.tracks,
        duration: this.duration,
        tags: this.tags,
        currentFrame: this.currentFrame,
      },
    });
    this.loadTimeline({
      tracks: sym.tracks as LayerTrack[],
      duration: sym.duration,
      tags: sym.tags,
      currentFrame: 0,
    });
  }

  /** Flush the symbol being edited and restore the parent timeline. */
  private popContext(): EditContextRef | null {
    const top = this.contextStack.pop();
    if (!top) return null;
    // Flush into the symbol *before* swapping the live timeline out.
    const sym = this.symbols.get(top.ref.symbolId);
    if (sym) {
      sym.tracks = this.tracks as SymbolDefinition["tracks"];
      sym.duration = this.duration;
      sym.tags = this.tags;
    }
    this.tracks = top.saved.tracks;
    this.duration = top.saved.duration;
    this.tags = top.saved.tags;
    this.currentFrame = Math.max(0, Math.min(this.duration - 1, top.saved.currentFrame));
    this.loadedContent.clear();
    return top.ref;
  }

  /**
   * Enter a symbol for editing. `via` (layer + instance iid + elapsed child
   * frame + world matrix) makes it an in-place edit; omitted = isolated edit
   * from the Library. Caller commits live edits first and snapshots history
   * afterwards only if it wants the entry (entering is not an edit).
   */
  enterSymbol(
    symbolId: string,
    via?: {
      layerId: string;
      instanceIid: string;
      childFrame: number;
      worldMatrix: [number, number, number, number, number, number];
    },
  ): boolean {
    if (!this.symbols.has(symbolId)) return false;
    if (this.contextStack.some((e) => e.ref.symbolId === symbolId)) return false;
    if (this.playing) this.setPlaying(false);
    if (this.editMultipleFrames) {
      this.commitEditMultipleFrames();
      this.clearEditMultipleFramesState();
    } else {
      this.commitDirtyLayerContent();
    }
    this.pushContext({
      symbolId,
      instanceIid: via?.instanceIid ?? null,
      layerId: via?.layerId ?? null,
      parentFrame: this.currentFrame,
      worldMatrix: via?.worldMatrix ?? null,
    });
    if (via) {
      this.currentFrame = Math.max(0, Math.min(this.duration - 1, Math.round(via.childFrame)));
    }
    const top = this.tracks[this.tracks.length - 1]?.id ?? STAGE_LAYER_ID;
    this.updateLayerStoreFromTracks(top);
    this.reloadCurrentFrame();
    this.syncContextBackdrop();
    this.onContextChanged?.();
    this.publish();
    return true;
  }

  /** Leave the innermost symbol. Returns the context left, or null at root. */
  exitSymbol(): EditContextRef | null {
    if (this.contextStack.length === 0) return null;
    if (this.playing) this.setPlaying(false);
    if (this.editMultipleFrames) {
      this.commitEditMultipleFrames();
      this.clearEditMultipleFramesState();
    } else {
      this.commitDirtyLayerContent();
    }
    const ref = this.popContext();
    const active = ref?.layerId ?? this.tracks[this.tracks.length - 1]?.id ?? STAGE_LAYER_ID;
    this.updateLayerStoreFromTracks(active);
    this.reloadCurrentFrame();
    this.syncContextBackdrop();
    this.onContextChanged?.();
    this.publish();
    return ref;
  }

  /** Pop contexts until `depth` levels remain (0 = scene). */
  exitSymbolTo(depth: number): void {
    while (this.contextStack.length > Math.max(0, depth)) {
      if (!this.exitSymbol()) break;
    }
  }

  /**
   * Parent-context data for the in-place backdrop: the saved timeline one
   * level up plus the context ref. Null when editing the scene.
   */
  getBackdropSource(): {
    ref: EditContextRef;
    timeline: TimelineSnapshot;
  } | null {
    const top = this.contextStack[this.contextStack.length - 1];
    if (!top) return null;
    return { ref: top.ref, timeline: top.saved };
  }

  /** Rebuild (or clear) the renderer's in-place backdrop from the context stack. */
  private syncContextBackdrop(): void {
    if (this.contextStack.length === 0) {
      this.renderer.clearContextBackdrop();
      return;
    }
    this.renderer.setContextBackdrop(
      this.contextStack.map((e) => ({
        tracks: e.saved.tracks,
        frame: e.ref.parentFrame,
        instanceIid: e.ref.instanceIid,
        layerId: e.ref.layerId,
        matrix: e.ref.worldMatrix,
      })),
    );
  }

  /**
   * Camera compensation for edit-in-place: the sum of the entered instances'
   * translations (each in the space that was current when it was entered).
   * The camera subtracts this so a symbol's local origin stays on screen
   * where the instance's origin was. Isolated levels contribute nothing.
   */
  getContextOriginOffset(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    for (const e of this.contextStack) {
      if (!e.ref.worldMatrix) continue;
      x += e.ref.worldMatrix[4];
      y += e.ref.worldMatrix[5];
    }
    return { x, y };
  }

  /** Elapsed frames into each layer's covering keyframe at the playhead. */
  private layerElapsedMap(): Map<string, number> {
    const out = new Map<string, number>();
    for (const track of this.tracks) {
      const kf = this.coveringKeyframe(track, this.currentFrame);
      out.set(track.id, kf ? this.currentFrame - kf.frameIndex : 0);
    }
    return out;
  }

  // ------------------------------------------------------------
  // Reconciliation with layerStore (layer add/delete/rename/reorder)
  // ------------------------------------------------------------

  /**
   * Merge `sourceLayerId` down into the track beneath it across every frame,
   * using the draw-merge flatten pipeline. Removes the source track from the
   * document model. Returns the surviving (below) layer id, or null when the
   * source is missing / already bottommost.
   *
   * Caller is responsible for updating layerStore, deleting the Paper layer,
   * reloading the playhead, and taking a history snapshot.
   */
  mergeLayerDown(sourceLayerId: string): string | null {
    if (this.playing) this.setPlaying(false);

    if (this.editMultipleFrames) {
      this.commitEditMultipleFrames();
      this.clearEditMultipleFramesState();
    } else {
      this.commitDirtyLayerContent();
    }

    const sourceIndex = this.tracks.findIndex((t) => t.id === sourceLayerId);
    if (sourceIndex <= 0) return null;

    const sourceTrack = this.tracks[sourceIndex];
    const targetTrack = this.tracks[sourceIndex - 1];
    if (!isVectorTrack(sourceTrack) || !isVectorTrack(targetTrack)) return null;

    const mergeCache = new Map<string, string>();
    const resolveMergedContentId = (srcId: string, tgtId: string): string => {
      const key = `${srcId}\0${tgtId}`;
      const cached = mergeCache.get(key);
      if (cached !== undefined) return cached;

      if (srcId === EMPTY_CONTENT_ID) {
        mergeCache.set(key, tgtId);
        return tgtId;
      }

      if (tgtId === EMPTY_CONTENT_ID) {
        const json = withLayerName(this.content.get(srcId) ?? "", targetTrack.name);
        if (!json) {
          mergeCache.set(key, EMPTY_CONTENT_ID);
          return EMPTY_CONTENT_ID;
        }
        const id = this.newContentId();
        this.content.set(id, json);
        mergeCache.set(key, id);
        return id;
      }

      const merged = this.renderer.mergeLayerJsons(
        this.content.get(tgtId) ?? "",
        this.content.get(srcId) ?? "",
      );
      const stamped = merged ? withLayerName(merged, targetTrack.name) : "";
      if (!stamped) {
        mergeCache.set(key, EMPTY_CONTENT_ID);
        return EMPTY_CONTENT_ID;
      }
      const id = this.newContentId();
      this.content.set(id, stamped);
      mergeCache.set(key, id);
      return id;
    };

    const newKeyframes: Keyframe[] = [];
    let runStart = 0;
    let runContentId = resolveMergedContentId(
      this.contentIdAt(sourceTrack, 0),
      this.contentIdAt(targetTrack, 0),
    );

    for (let frame = 1; frame < this.duration; frame++) {
      const contentId = resolveMergedContentId(
        this.contentIdAt(sourceTrack, frame),
        this.contentIdAt(targetTrack, frame),
      );
      if (contentId === runContentId) continue;

      if (runContentId !== EMPTY_CONTENT_ID) {
        newKeyframes.push({
          frameIndex: runStart,
          contentId: runContentId,
          holdUntil: frame - 1,
        });
      }
      runStart = frame;
      runContentId = contentId;
    }

    if (runContentId !== EMPTY_CONTENT_ID) {
      newKeyframes.push({
        frameIndex: runStart,
        contentId: runContentId,
        holdUntil: this.duration - 1,
      });
    } else if (newKeyframes.length === 0) {
      newKeyframes.push({
        frameIndex: 0,
        contentId: EMPTY_CONTENT_ID,
        holdUntil: 0,
      });
    }

    targetTrack.keyframes = newKeyframes;
    this.tracks = this.tracks.filter((t) => t.id !== sourceLayerId);
    this.loadedContent.delete(sourceLayerId);
    this.loadedContent.delete(targetTrack.id);

    // Drop the source layer from any EMF range still held by the UI.
    if (this.emfRange) {
      this.emfRange = {
        ...this.emfRange,
        layerIds: this.emfRange.layerIds.filter((id) => id !== sourceLayerId),
      };
      if (this.emfRange.layerIds.length === 0) {
        this.clearEditMultipleFramesState();
      }
    }

    this.publish();
    return targetTrack.id;
  }

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
        const renamed = existing.name !== layer.name;
        existing.name = layer.name;
        existing.visible = layer.visible;
        existing.locked = layer.locked;
        if (renamed) this.rewriteTrackContentNames(existing);
        next.push(existing);
      } else {
        next.push({
          id: layer.id,
          name: layer.name,
          visible: layer.visible,
          locked: layer.locked,
          kind: trackKindFromLayer(layer.kind),
          keyframes: [{ frameIndex: 0, contentId: EMPTY_CONTENT_ID, holdUntil: 0 }],
        });
      }
    }
    this.tracks = next;

    for (const id of [...this.loadedContent.keys()]) {
      if (!this.tracks.some((t) => t.id === id)) this.loadedContent.delete(id);
    }
    this.applyEffectiveVisibility(state.soloLayerId);
    this.publish();
  }

  /**
   * Rewrite every unique content blob on a track so its embedded Paper layer
   * `name` matches `track.name`. Content shared with other tracks is cloned
   * first so a rename cannot bleed across layers.
   */
  private rewriteTrackContentNames(track: LayerTrack): void {
    const seen = new Set<string>();
    for (const kf of track.keyframes) {
      const id = kf.contentId;
      if (id === EMPTY_CONTENT_ID || seen.has(id)) continue;
      seen.add(id);
      const json = this.content.get(id) ?? "";
      if (!json) continue;

      const shared = this.tracks.some(
        (t) =>
          t.id !== track.id &&
          t.keyframes.some((k) => k.contentId === id),
      );
      const next = withLayerName(json, track.name);
      if (next === json && !shared) continue;

      if (shared) {
        const cloned = this.newContentId();
        this.content.set(cloned, withLayerName(json, track.name));
        for (const k of track.keyframes) {
          if (k.contentId === id) k.contentId = cloned;
        }
      } else if (next !== json) {
        this.content.set(id, next);
      }
    }
  }

  /**
   * Apply solo + per-layer visibility to Paper without mutating stored
   * `visible` flags. Exclusive solo shows only that regular layer.
   * Reads visibility from layerStore so toggles take effect before the
   * next history sync copies them onto tracks.
   */
  applyEffectiveVisibility(soloLayerId: string | null = layerStore.get().soloLayerId): void {
    const byId = new Map(layerStore.get().layers.map((l) => [l.id, l]));
    for (const track of this.tracks) {
      const layer = byId.get(track.id);
      const effective = isLayerEffectivelyVisible(
        {
          id: track.id,
          visible: layer?.visible ?? track.visible,
          kind: "regular",
        },
        soloLayerId,
      );
      this.renderer.setLayerVisibility(track.id, effective);
    }
    if (onionSkinStore.get()) this.updateOnionSkin();
  }

  /** True when a track should participate in select hit-testing. */
  isTrackSelectable(layerId: string): boolean {
    const track = this.getTrack(layerId);
    if (!track || track.locked || !isVectorTrack(track)) return false;
    return this.isTrackEffectivelyVisible(track);
  }

  private isTrackEffectivelyVisible(track: LayerTrack): boolean {
    return isLayerEffectivelyVisible(
      { id: track.id, visible: track.visible, kind: "regular" },
      layerStore.get().soloLayerId,
    );
  }

  /** Layer ids currently selectable (effectively visible + unlocked). */
  getSelectableLayerIds(): string[] {
    return this.tracks.filter((t) => this.isTrackSelectable(t.id)).map((t) => t.id);
  }

  /**
   * Capture the live Paper content of the active layer into the document.
   * Drawing tools use this; select edits across layers use
   * `commitDirtyLayerContent` / `commitLayersContent`.
   */
  commitActiveLayerContent(): boolean {
    if (this.editMultipleFrames) {
      return this.commitEditMultipleFrames();
    }
    const layerId = this.renderer.getActiveLayerId();
    if (!layerId) return false;
    return this.commitLayerContent(layerId);
  }

  /**
   * Commit live Paper content for dirty layers and any layer that owns a
   * selected item. Timeline snapshots with nothing dirty skip exportJSON.
   */
  commitDirtyLayerContent(): boolean {
    if (this.editMultipleFrames) {
      return this.commitEditMultipleFrames();
    }
    const ids = new Set(this.renderer.consumeDirtyLayerIds());
    for (const item of selectionStore.get().items) {
      const layerId = this.renderer.getLayerIdForPathItem(item);
      if (layerId) ids.add(layerId);
    }
    if (ids.size === 0) return false;
    return this.commitLayersContent(ids);
  }

  commitLayersContent(layerIds: Iterable<string>): boolean {
    if (this.editMultipleFrames) {
      return this.commitEditMultipleFrames();
    }
    let changed = false;
    for (const layerId of layerIds) {
      if (this.commitLayerContent(layerId, { publish: false })) changed = true;
    }
    if (changed) this.publish();
    return changed;
  }

  /**
   * Capture one Paper layer into the document. If content changed while the
   * playhead sits on a hold frame, auto-keys at the current frame.
   */
  commitLayerContent(
    layerId: string,
    options: { publish?: boolean } = {},
  ): boolean {
    const publish = options.publish !== false;
    const track = this.getTrack(layerId);
    if (!track || !isVectorTrack(track)) return false;

    const raw = this.renderer.isLayerEmpty(layerId)
      ? ""
      : this.renderer.exportLayerJSON(layerId) ?? "";
    const paperName = this.renderer.getLayerName(layerId);
    const json =
      raw && paperName !== track.name ? withLayerName(raw, track.name) : raw;

    const covering = this.coveringKeyframe(track, this.currentFrame);
    const visibleContentId = covering?.contentId ?? EMPTY_CONTENT_ID;
    const currentJson = this.content.get(visibleContentId) ?? "";

    const unchanged =
      json === currentJson ||
      (paperName !== track.name && layerJsonEquals(json, currentJson));
    if (unchanged) {
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

    this.placeKeyframe(track, this.currentFrame, contentId);
    this.loadedContent.set(layerId, contentId);
    if (publish) this.publish();
    return true;
  }

  /**
   * Write each EMF keyframe bucket back for every layer in the EMF range.
   * Does not rebuild the overlay so the live selection stays valid.
   */
  private commitEditMultipleFrames(): boolean {
    if (!this.emfRange) return false;
    let changed = false;
    for (const layerId of this.emfRange.layerIds) {
      if (this.commitEditMultipleFramesForLayer(layerId)) changed = true;
    }
    if (changed) {
      const { start, end } = this.emfRange;
      this.renderer.setEmfPlayheadFrame(
        this.currentFrame >= start && this.currentFrame <= end
          ? this.currentFrame
          : null,
      );
      this.publish();
    }
    return changed;
  }

  private commitEditMultipleFramesForLayer(layerId: string): boolean {
    if (!this.emfRange) return false;
    const track = this.getTrack(layerId);
    if (!track) return false;

    const { start, end } = this.emfRange;
    const expectedFrames = this.keyframeFramesInRange(track, start, end);

    const partitions = this.renderer.exportLayerContentsByKeyframe(
      layerId,
      this.currentFrame >= start && this.currentFrame <= end
        ? this.currentFrame
        : start,
    );

    // Only auto-key the playhead when it sits on a hold/empty frame AND the
    // overlay actually has playhead-bucket artwork (e.g. user drew there).
    // Scrubbing alone must not turn Magic Move holds into keyframes.
    if (
      this.currentFrame >= start &&
      this.currentFrame <= end &&
      !expectedFrames.includes(this.currentFrame)
    ) {
      const playheadJson = partitions.get(this.currentFrame) ?? "";
      if (playheadJson) expectedFrames.push(this.currentFrame);
    }

    let changed = false;

    const writeFrame = (frameIndex: number, json: string): boolean => {
      if (frameIndex < start || frameIndex > end) return false;
      const stamped = json ? withLayerName(json, track.name) : "";
      const kf = track.keyframes.find((k) => k.frameIndex === frameIndex);
      const prev = kf ? (this.content.get(kf.contentId) ?? "") : "";
      if (layerJsonEquals(stamped, prev)) return false;

      let newId: string;
      if (stamped === "") {
        newId = EMPTY_CONTENT_ID;
      } else {
        newId = this.newContentId();
        this.content.set(newId, stamped);
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

  /**
   * Non-blank keyframe start frames that fall inside [start, end] (inclusive).
   */
  getKeyframeFramesInRange(
    layerId: string,
    start: number,
    end: number,
  ): number[] {
    const track = this.getTrack(layerId);
    if (!track) return [];
    [start, end] = this.normalizeRange(start, end);
    const frames: number[] = [];
    for (const kf of track.keyframes) {
      if (kf.frameIndex < start || kf.frameIndex > end) continue;
      if (kf.contentId === EMPTY_CONTENT_ID) continue;
      frames.push(kf.frameIndex);
    }
    return frames;
  }

  /** Layer artwork JSON visible at `frame` (empty string when blank). */
  getLayerContentAtFrame(layerId: string, frame: number): string {
    const track = this.getTrack(layerId);
    if (!track || !isVectorTrack(track)) return "";
    const contentId = this.contentIdAt(track, this.clampFrame(frame));
    if (contentId === EMPTY_CONTENT_ID) return "";
    return this.content.get(contentId) ?? "";
  }

  /**
   * Artwork JSON for a keyframe that starts exactly at `frame`, or null when
   * there is no keyframe / blank keyframe at that index.
   */
  getExactKeyframeContentAtFrame(
    layerId: string,
    frame: number,
  ): string | null {
    const track = this.getTrack(layerId);
    if (!track || !isVectorTrack(track)) return null;
    frame = this.clampFrame(Math.max(0, Math.round(frame)));
    const kf = track.keyframes.find((k) => k.frameIndex === frame);
    if (!kf || kf.contentId === EMPTY_CONTENT_ID) return null;
    return this.content.get(kf.contentId) ?? "";
  }

  /**
   * Magic Morph span: covering hold at `frame` → next non-blank keyframe.
   * Requires an explicit hold and at least one free frame between poses
   * (`endFrame - startFrame >= 2`).
   */
  getMagicMorphSpan(
    layerId: string,
    frame?: number,
  ): {
    startFrame: number;
    endFrame: number;
    startJson: string;
    endJson: string;
  } | null {
    const track = this.getTrack(layerId);
    if (!track || !isVectorTrack(track)) return null;
    const at = this.clampFrame(frame ?? this.currentFrame);
    const covering = this.coveringKeyframe(track, at);
    if (!covering || covering.contentId === EMPTY_CONTENT_ID) return null;
    if (covering.holdUntil <= covering.frameIndex) return null;

    const next = track.keyframes.find(
      (k) =>
        k.frameIndex > covering.frameIndex &&
        k.contentId !== EMPTY_CONTENT_ID,
    );
    if (!next) return null;
    if (next.frameIndex - covering.frameIndex < 2) return null;

    const startJson = this.content.get(covering.contentId) ?? "";
    const endJson = this.content.get(next.contentId) ?? "";
    if (!startJson || !endJson) return null;

    return {
      startFrame: covering.frameIndex,
      endFrame: next.frameIndex,
      startJson,
      endJson,
    };
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
        autoHoldStore.get() && !prevBlank
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
    const track = this.requireKeyframeTrack(layerId);
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
   * Write arbitrary layer JSON as a keyframe at `frame` without requiring the
   * playhead to be there (used by Magic Move bake). Extends duration if needed.
   * Does not reload Paper.
   */
  writeLayerContentAtFrame(
    layerId: string,
    frame: number,
    json: string,
    options: { publish?: boolean } = {},
  ): boolean {
    const track = this.requireKeyframeTrack(layerId);
    if (!track) return false;

    frame = Math.max(0, Math.round(frame));
    if (frame >= this.duration) {
      this.setDuration(frame + 1);
    }
    frame = this.clampFrame(frame);

    let contentId: string;
    if (json === "") {
      contentId = EMPTY_CONTENT_ID;
    } else {
      contentId = this.newContentId();
      this.content.set(contentId, withLayerName(json, track.name));
    }
    this.placeKeyframe(track, frame, contentId);
    if (frame === this.currentFrame) {
      this.loadedContent.set(layerId, contentId);
    }
    if (options.publish !== false) this.publish();
    return true;
  }

  /**
   * Extend each keyframe at `frames[i]` to hold through `frames[i+1] - 1`,
   * never past the next keyframe on the track. Used by Magic Move so steps
   * stay visible between samples even when auto-hold is off. Blank keyframes
   * are skipped. When `holdLast` is set (or auto-hold is on), the final
   * sample also holds through the next keyframe / end of the timeline.
   */
  bridgeKeyframeHolds(
    layerId: string,
    frames: number[],
    options: { publish?: boolean; holdLast?: boolean } = {},
  ): void {
    const track = this.requireKeyframeTrack(layerId);
    if (!track || frames.length === 0) return;

    const sorted = [
      ...new Set(frames.map((f) => this.clampFrame(Math.max(0, Math.round(f))))),
    ].sort((a, b) => a - b);

    for (let i = 0; i < sorted.length - 1; i++) {
      const kf = track.keyframes.find((k) => k.frameIndex === sorted[i]);
      if (!kf || kf.contentId === EMPTY_CONTENT_ID) continue;

      // Never hold over a later keyframe — that draws overlapping pills/dots.
      const nextOnTrack = track.keyframes.find((k) => k.frameIndex > sorted[i]);
      const maxUntil = nextOnTrack
        ? nextOnTrack.frameIndex - 1
        : this.duration - 1;
      const until = Math.min(sorted[i + 1] - 1, maxUntil);
      if (until > kf.holdUntil) kf.holdUntil = until;
    }

    const holdLast = options.holdLast === true || autoHoldStore.get();
    if (holdLast) {
      const last = sorted[sorted.length - 1];
      const kf = track.keyframes.find((k) => k.frameIndex === last);
      if (kf && kf.contentId !== EMPTY_CONTENT_ID) {
        const nextOnTrack = track.keyframes.find((k) => k.frameIndex > last);
        const until = nextOnTrack
          ? nextOnTrack.frameIndex - 1
          : this.duration - 1;
        if (until > kf.holdUntil) kf.holdUntil = until;
      }
    }

    if (options.publish !== false) this.publish();
  }

  /**
   * Extend the keyframe at `frame` so it holds through `throughFrame`
   * (inclusive), never past the next keyframe on the track or the timeline end.
   */
  extendKeyframeHoldThrough(
    layerId: string,
    frame: number,
    throughFrame: number,
    options: { publish?: boolean } = {},
  ): void {
    const track = this.requireKeyframeTrack(layerId);
    if (!track) return;
    frame = this.clampFrame(Math.max(0, Math.round(frame)));
    throughFrame = Math.max(0, Math.round(throughFrame));
    if (throughFrame >= this.duration) {
      this.setDuration(throughFrame + 1);
    }
    throughFrame = this.clampFrame(throughFrame);

    const kf = track.keyframes.find((k) => k.frameIndex === frame);
    if (!kf || kf.contentId === EMPTY_CONTENT_ID) return;

    const nextOnTrack = track.keyframes.find((k) => k.frameIndex > frame);
    const maxUntil = nextOnTrack
      ? nextOnTrack.frameIndex - 1
      : this.duration - 1;
    const until = Math.min(throughFrame, maxUntil);
    if (until > kf.holdUntil) kf.holdUntil = until;

    if (options.publish !== false) this.publish();
  }

  /**
   * Empty frames `start..end` on a layer (same semantics as removeFrameRange)
   * without reloading Paper. Used to clear a Magic Move bake range before
   * writing new keys. Extends duration when `end` is past the timeline.
   */
  clearFrameRange(
    layerId: string,
    start: number,
    end: number,
    options: { publish?: boolean } = {},
  ): boolean {
    const track = this.requireKeyframeTrack(layerId);
    if (!track) return false;

    start = Math.max(0, Math.round(start));
    end = Math.max(0, Math.round(end));
    if (end < start) return false;
    if (end >= this.duration) {
      this.setDuration(end + 1);
    }
    [start, end] = this.normalizeRange(start, end);
    if (!this.cutFrameRange(track, start, end)) {
      if (options.publish !== false) this.publish();
      return false;
    }
    if (options.publish !== false) this.publish();
    return true;
  }

  /**
   * Toggle the hold on the keyframe whose span covers this frame (double-tap
   * gesture). Not held → extend up to the next keyframe or the end of the
   * animation; held → collapse back to a single frame. Blank keyframes never
   * hold. Returns true if changed.
   */
  toggleKeyframeHold(layerId: string, frame: number): boolean {
    const track = this.requireKeyframeTrack(layerId);
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
    const track = this.requireKeyframeTrack(layerId);
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
  /**
   * Move frames `start..end` on `layerIds` into a new looping symbol and
   * replace the range on `anchorLayerId` with one instance. Instances
   * already in the range become nested symbols. Refuses a cycle with the
   * symbol currently being edited. Returns the new symbol id, or null.
   */
  convertFrameRangeToSymbol(
    layerIds: string[],
    start: number,
    end: number,
    anchorLayerId: string,
  ): string | null {
    if (this.playing) this.setPlaying(false);
    if (this.editMultipleFrames) {
      this.commitEditMultipleFrames();
      this.clearEditMultipleFramesState();
    } else {
      this.commitDirtyLayerContent();
    }

    [start, end] = this.normalizeRange(start, end);
    const duration = end - start + 1;
    const tracks: SymbolDefinition["tracks"] = [];
    const seen = new Map<string, string>();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let anyBounds = false;

    for (const layerId of layerIds) {
      const track = this.requireKeyframeTrack(layerId);
      if (!track || !isVectorTrack(track)) continue;
      const segment = this.extractFrameRange(track, start, end);
      const usable = segment.filter((k) => k.contentId !== EMPTY_CONTENT_ID);
      if (usable.length === 0) continue;
      const editing = this.getEditingSymbolId();
      for (const kf of usable) {
        if (editing) {
          for (const ref of this.symbolRefsIn(kf.contentId)) {
            if (this.symbolWouldCycle(editing, ref)) return null;
          }
        }
        if (seen.has(kf.contentId)) continue;
        const json = this.content.get(kf.contentId) ?? "";
        const bounds = json ? this.renderer.measureLayerJsonBounds(json) : null;
        seen.set(kf.contentId, json);
        if (!bounds) continue;
        minX = Math.min(minX, bounds.x);
        minY = Math.min(minY, bounds.y);
        maxX = Math.max(maxX, bounds.x + bounds.width);
        maxY = Math.max(maxY, bounds.y + bounds.height);
        anyBounds = true;
      }
      tracks.push({
        id: generateLayerId(),
        name: track.name,
        visible: true,
        locked: false,
        kind: "vector",
        keyframes: usable.map((k) => ({
          frameIndex: k.frameIndex - start,
          contentId: k.contentId,
          holdUntil: k.holdUntil - start,
        })),
      });
    }
    if (tracks.length === 0) return null;

    const origin = anyBounds
      ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
      : { x: 0, y: 0 };
    const remapped = new Map<string, string>();
    for (const [oldId, json] of seen) {
      if (!json) {
        remapped.set(oldId, EMPTY_CONTENT_ID);
        continue;
      }
      const shifted = this.renderer.translateLayerJson(json, {
        x: -origin.x,
        y: -origin.y,
      });
      remapped.set(oldId, this.addContent(shifted));
    }
    for (const track of tracks) {
      for (const kf of track.keyframes) {
        kf.contentId = remapped.get(kf.contentId) ?? EMPTY_CONTENT_ID;
      }
    }

    const tags = this.tags
      .filter((t) => t.start >= start && t.end <= end)
      .map((t) => ({
        ...t,
        id: this.newTagId(),
        start: t.start - start,
        end: t.end - start,
      }));

    const symbol = this.createSymbol({ tracks, duration, tags });

    for (const layerId of layerIds) {
      const track = this.requireKeyframeTrack(layerId);
      if (track) this.cutFrameRange(track, start, end);
    }

    const anchor = this.requireKeyframeTrack(anchorLayerId);
    if (anchor && isVectorTrack(anchor)) {
      const json = this.renderer.exportInstanceLayerJSON(
        { symbol: symbol.id, iid: newInstanceId(), mode: "loop", firstFrame: 0 },
        origin,
        anchor.name,
      );
      this.writeLayerContentAtFrame(anchor.id, start, json, { publish: false });
      this.extendKeyframeHoldThrough(anchor.id, start, end, { publish: false });
    }

    this.reloadCurrentFrame();
    this.publish();
    return symbol.id;
  }

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
    const track = this.requireKeyframeTrack(layerId);
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
    const track = this.requireKeyframeTrack(layerId);
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
   * Reverse the artwork order across start..end, preserving hold spans
   * (a hold covering [from, to] lands at the mirrored [start+end-to, start+end-from]).
   * Returns true when the range changed.
   */
  reverseFrameRange(layerId: string, start: number, end: number): boolean {
    const track = this.requireKeyframeTrack(layerId);
    if (!track) return false;
    [start, end] = this.normalizeRange(start, end);
    if (start >= end) return false;

    const segment = this.extractFrameRange(track, start, end);
    if (segment.length === 0) return false;

    this.cutFrameRange(track, start, end);

    for (const kf of segment) {
      const from = kf.frameIndex;
      const to = kf.holdUntil;
      this.insertKeyframe(track, {
        frameIndex: start + end - to,
        contentId: kf.contentId,
        holdUntil: start + end - from,
      });
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
    this.clampTagsToDuration();
    if (this.currentFrame >= next) this.gotoFrame(next - 1);
    this.publish();
    return true;
  }

  // ------------------------------------------------------------
  // Frame tags
  // ------------------------------------------------------------

  getFrameTags(): FrameTag[] {
    return cloneTags(this.tags);
  }

  /** Create a tag over [start, end]. Returns the new tag, or null if invalid. */
  addFrameTag(start: number, end: number, name?: string): FrameTag | null {
    const [a, b] = this.normalizeRange(start, end);
    const tag: FrameTag = {
      id: this.newTagId(),
      name: (name?.trim() || this.nextDefaultTagName()).slice(0, 64),
      start: a,
      end: b,
    };
    this.tags = [...this.tags, tag];
    this.publish();
    return tag;
  }

  renameFrameTag(id: string, name: string): boolean {
    const tag = this.tags.find((t) => t.id === id);
    if (!tag) return false;
    const next = name.trim().slice(0, 64);
    if (!next || next === tag.name) return false;
    tag.name = next;
    this.tags = cloneTags(this.tags);
    this.publish();
    return true;
  }

  removeFrameTag(id: string): boolean {
    const next = this.tags.filter((t) => t.id !== id);
    if (next.length === this.tags.length) return false;
    this.tags = next;
    this.publish();
    return true;
  }

  /**
   * Resize a tag to [start, end] and carve overlapping frames out of other
   * tags (trim / split / delete).
   */
  resizeFrameTag(id: string, start: number, end: number): boolean {
    const tag = this.tags.find((t) => t.id === id);
    if (!tag) return false;
    const [a, b] = this.normalizeRange(start, end);
    if (tag.start === a && tag.end === b) return false;
    const next = applyFrameTagResize(this.tags, id, a, b, () => this.newTagId());
    if (!next) return false;
    this.tags = next;
    this.publish();
    return true;
  }

  private newTagId(): string {
    return `tag${Date.now().toString(36)}-${this.tagIdCounter++}`;
  }

  private nextDefaultTagName(): string {
    let n = 1;
    const used = new Set(this.tags.map((t) => t.name));
    while (used.has(`Tag ${n}`)) n++;
    return `Tag ${n}`;
  }

  /** Drop or clamp tags that fall outside the current duration. */
  private clampTagsToDuration(): void {
    const last = this.duration - 1;
    this.tags = this.tags
      .map((t) => {
        const start = Math.max(0, Math.min(last, Math.min(t.start, t.end)));
        const end = Math.max(0, Math.min(last, Math.max(t.start, t.end)));
        return { ...t, start, end };
      })
      .filter((t) => t.start <= t.end);
  }

  private retimeTags(ratio: number, newDuration: number): void {
    this.tags = retimeTagList(this.tags, ratio, newDuration);
  }

  /**
   * Set the playback rate. With real-time lock enabled, also rescales all
   * keyframes/duration/playhead so the animation keeps its wall-clock
   * timing. Returns true when keyframes were retimed (callers should
   * snapshot history).
   */
  setFrameRate(fps: number): boolean {
    const next = Math.max(1, Math.min(60, Math.round(fps)));
    if (next === this.frameRate) {
      this.publish();
      return false;
    }
    const prev = this.frameRate;
    this.frameRate = next;

    if (realTimeLockStore.get()) {
      const ratio = next / prev;
      const newDuration = Math.max(
        1,
        Math.min(9999, Math.round(this.duration * ratio)),
      );
      this.retimeTracks(ratio, newDuration);
      this.retimeTags(ratio, newDuration);
      this.duration = newDuration;
      this.currentFrame = Math.max(
        0,
        Math.min(newDuration - 1, Math.round(this.currentFrame * ratio)),
      );
      this.retimeOtherTimelines(ratio);
      this.loadedContent.clear();
      this.reloadCurrentFrame();
      this.publish();
      return true;
    }

    this.publish();
    return false;
  }

  /**
   * Rescale every keyframe span by `ratio`, mapping span *boundaries*
   * (start, end + 1) so holds stay contiguous and gaps keep their relative
   * size. When shrinking, keyframes that land on the same frame collapse
   * and the later one wins.
   */
  private retimeTracks(
    ratio: number,
    newDuration: number,
    tracks: LayerTrack[] = this.tracks,
  ): void {
    for (const track of tracks) {
      const remapped: Keyframe[] = [];
      for (const kf of track.keyframes) {
        const start = Math.max(
          0,
          Math.min(newDuration - 1, Math.round(kf.frameIndex * ratio)),
        );
        // Blank keyframes stay single-frame (model invariant); uncovered
        // frames render empty anyway, so timing is preserved.
        const end =
          kf.contentId === EMPTY_CONTENT_ID
            ? start
            : Math.min(
                newDuration - 1,
                Math.max(start, Math.round((kf.holdUntil + 1) * ratio) - 1),
              );
        // Collisions from downscaling: the later keyframe wins.
        while (
          remapped.length > 0 &&
          remapped[remapped.length - 1].frameIndex >= start
        ) {
          remapped.pop();
        }
        const prev = remapped[remapped.length - 1];
        if (prev && prev.holdUntil >= start) prev.holdUntil = start - 1;
        remapped.push({
          frameIndex: start,
          contentId: kf.contentId,
          holdUntil: end,
        });
      }
      track.keyframes = remapped;
    }
  }

  /** Real-time lock: symbols and saved parent timelines keep wall-clock timing too. */
  private retimeOtherTimelines(ratio: number): void {
    const scaled = (d: number) => Math.max(1, Math.min(9999, Math.round(d * ratio)));
    const editing = this.getEditingSymbolId();
    for (const sym of this.symbols.values()) {
      if (sym.id === editing) continue; // live timeline already retimed
      const d = scaled(sym.duration);
      this.retimeTracks(ratio, d, sym.tracks as LayerTrack[]);
      sym.tags = retimeTagList(sym.tags, ratio, d);
      sym.duration = d;
    }
    for (const entry of this.contextStack) {
      const d = scaled(entry.saved.duration);
      this.retimeTracks(ratio, d, entry.saved.tracks);
      entry.saved.tags = retimeTagList(entry.saved.tags, ratio, d);
      entry.saved.duration = d;
      entry.saved.currentFrame = Math.max(
        0,
        Math.min(d - 1, Math.round(entry.saved.currentFrame * ratio)),
      );
      entry.ref.parentFrame = entry.saved.currentFrame;
    }
    this.flushActiveTimeline();
  }

  isRealTimeLockEnabled(): boolean {
    return realTimeLockStore.get();
  }

  setRealTimeLock(enabled: boolean): void {
    if (realTimeLockStore.get() === enabled) return;
    realTimeLockStore.set(enabled);
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
    return autoHoldStore.get();
  }

  setAutoHold(enabled: boolean): void {
    if (autoHoldStore.get() === enabled) return;
    autoHoldStore.set(enabled);
  }

  isOnionSkinEnabled(): boolean {
    return onionSkinStore.get();
  }

  setOnionSkin(enabled: boolean): void {
    if (onionSkinStore.get() === enabled) return;
    onionSkinStore.set(enabled);
  }

  /** Rebuild onion-skin ghosts (e.g. when live art diverges before commit). */
  refreshOnionSkin(): void {
    this.updateOnionSkin();
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
      const layerIds = range.layerIds.filter((id) => {
        const t = this.getTrack(id);
        return t != null && isVectorTrack(t);
      });
      if (layerIds.length === 0) return false;
      const [start, end] = this.normalizeRange(range.start, range.end);
      this.editMultipleFrames = true;
      this.emfRange = {
        layerIds,
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

    const solo = layerStore.get().soloLayerId;
    this.renderer.restoreLayersSnapshot(
      this.tracks.map((track) => {
        const effective = isLayerEffectivelyVisible(
          { id: track.id, visible: track.visible, kind: "regular" },
          solo,
        );
        if (!emfSet.has(track.id)) {
          const contentId = this.contentIdAt(track, this.currentFrame);
          const changed = this.loadedContent.get(track.id) !== contentId;
          if (changed) this.loadedContent.set(track.id, contentId);
          return {
            id: track.id,
            name: track.name,
            visible: effective,
            json: changed ? this.content.get(contentId) ?? "" : undefined,
          };
        }
        this.loadedContent.set(track.id, EMF_LOADED_SENTINEL);
        return {
          id: track.id,
          name: track.name,
          visible: effective,
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
   * Shows up to two ghosts (nearest previous / next keyframe with real
   * artwork). Scope is the active layer or every unlocked + effectively
   * visible layer, per `viewOverlayStore.onionSkinLayers`.
   *
   * Ghosts whose stored artwork matches the current frame are skipped while
   * live Paper still matches the store (including brand-new keyframes that
   * share content via copy-on-write). Once live art diverges — e.g. mid-move —
   * that shared stored content is shown as the onion reference.
   */
  private updateOnionSkin(): void {
    if (!onionSkinStore.get() || this.playing || this.editMultipleFrames) {
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

    const overlay = viewOverlayStore.get();
    const tracks = this.onionSkinTracks(overlay.onionSkinLayers);

    if (tracks.length === 0) {
      this.renderer.clearOnionSkin();
      return;
    }

    const collectGhost = (direction: -1 | 1, color: string) => {
      // tracks are bottom→top; keep that order for composite ghosts.
      const jsons: string[] = [];
      for (const track of tracks) {
        const kf = nearestKeyframe(track, direction);
        if (!kf) continue;
        const ghostJson = this.content.get(kf.contentId);
        if (!ghostJson) continue;
        const currentJson =
          this.content.get(this.contentIdAt(track, this.currentFrame)) ?? "";
        // Identical stored art is useless as onion while the layer still
        // matches the store; once live Paper diverges, show it as reference.
        if (ghostJson === currentJson && !this.renderer.isLayerDirty(track.id)) {
          continue;
        }
        jsons.push(ghostJson);
      }
      if (jsons.length > 0) {
        ghosts.push({ jsons, opacity: overlay.onionSkinOpacity, color });
      }
    };

    const ghosts: Array<{ jsons: string[]; opacity: number; color: string }> = [];
    collectGhost(-1, overlay.onionSkinPrevColor);
    collectGhost(1, overlay.onionSkinNextColor);

    this.renderer.setOnionSkin(
      ghosts,
      overlay.onionSkinOutline,
      overlay.onionSkinOutlineWidth,
    );
  }

  /**
   * Layers that may contribute onion ghosts: unlocked and effectively
   * visible (honors hide + solo). Reads lock/visibility from layerStore so
   * toggles apply before tracks are synced.
   */
  private onionSkinTracks(mode: "active" | "all"): LayerTrack[] {
    const { layers, activeLayerId, soloLayerId } = layerStore.get();
    const eligible = new Set(
      layers
        .filter(
          (l) =>
            l.kind !== "stage" &&
            l.kind !== "image" &&
            l.kind !== "audio" &&
            !l.locked &&
            isLayerEffectivelyVisible(l, soloLayerId),
        )
        .map((l) => l.id),
    );
    if (mode === "active") {
      const track = this.tracks.find((t) => t.id === activeLayerId);
      return track && eligible.has(track.id) ? [track] : [];
    }
    return this.tracks.filter((t) => eligible.has(t.id));
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
    // Playhead-only: keep canvas + onion + timeline UI in sync without a
    // full document color rescan or tracks clone (scrub/playback hot path).
    this.publishPlayhead();
  }

  /** Drop the loaded-content cache for a layer so the next reload reimports. */
  invalidateLoadedLayer(layerId: string): void {
    this.loadedContent.delete(layerId);
  }

  /** Reimport the current frame into Paper (e.g. after un-hiding a layer). */
  reloadVisibleFrame(): void {
    this.reloadCurrentFrame();
  }

  private reloadCurrentFrame(): void {
    const activeLayerId =
      this.renderer.getActiveLayerId() ?? this.tracks[this.tracks.length - 1]?.id;
    if (this.tracks.length === 0) return;

    // Symbol instances resolve their frame from how far the playhead is into
    // the covering keyframe. Must be set before any (re)import below.
    this.renderer.setLayerElapsed(this.layerElapsedMap());
    const changedIds = new Set<string>();

    // EMF overlay is keyed by the selected range, not the playhead. Moving the
    // playhead only retargets where new strokes go — keep the composite (and
    // any live selection) intact.
    const solo = layerStore.get().soloLayerId;
    const layerById = new Map(layerStore.get().layers.map((l) => [l.id, l]));
    const withEffective = (track: LayerTrack, json: string | undefined) => ({
      id: track.id,
      name: track.name,
      visible: isLayerEffectivelyVisible(
        {
          id: track.id,
          visible: layerById.get(track.id)?.visible ?? track.visible,
          kind: "regular",
        },
        solo,
      ),
      json,
    });

    if (this.editMultipleFrames && this.emfRange) {
      const emfSet = new Set(this.emfRange.layerIds);
      // Magic Move / range edits invalidate loadedContent. Rebuild the
      // composite from the document so scrub commits don't write a stale
      // overlay (and invent keyframes on hold frames).
      const needsRebuild = this.emfRange.layerIds.some(
        (id) => this.loadedContent.get(id) !== EMF_LOADED_SENTINEL,
      );
      if (needsRebuild) {
        this.rebuildEditMultipleFramesOverlay();
        return;
      }

      this.renderer.restoreLayersSnapshot(
        this.tracks.map((track) => {
          if (emfSet.has(track.id)) {
            return withEffective(track, undefined);
          }
          const contentId = this.contentIdAt(track, this.currentFrame);
          const changed = this.loadedContent.get(track.id) !== contentId;
          if (changed) {
            this.loadedContent.set(track.id, contentId);
            changedIds.add(track.id);
          }
          return withEffective(
            track,
            changed ? this.content.get(contentId) ?? "" : undefined,
          );
        }),
        activeLayerId ?? STAGE_LAYER_ID,
      );
      this.rehydrateHeldInstances(changedIds, emfSet);
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
        if (changed) {
          this.loadedContent.set(track.id, contentId);
          changedIds.add(track.id);
        }
        return withEffective(
          track,
          changed ? this.content.get(contentId) ?? "" : undefined,
        );
      }),
      activeLayerId ?? STAGE_LAYER_ID,
    );
    this.rehydrateHeldInstances(changedIds);
  }

  /**
   * Layers whose content id didn't change (holds) but which carry looping /
   * play-once instances still need their instances re-resolved for the new
   * playhead. Layers that were just reimported are already hydrated.
   */
  private rehydrateHeldInstances(
    reimported: Set<string>,
    skip: Set<string> = new Set(),
  ): void {
    for (const id of this.renderer.getAnimatedInstanceLayerIds()) {
      if (reimported.has(id) || skip.has(id)) continue;
      this.renderer.rehydrateLayerInstances(id);
    }
  }

  /** Symbol artwork changed (edit / swap): re-resolve every placed instance. */
  rehydrateInstances(): void {
    this.renderer.setLayerElapsed(this.layerElapsedMap());
    this.renderer.rehydrateAllInstances();
  }

  // ------------------------------------------------------------
  // Doc-level history support
  // ------------------------------------------------------------

  /** Deep-copied state for a history entry (content strings shared by ref). */
  captureState(): DocumentState {
    this.flushActiveTimeline();
    const root = this.rootTimeline();
    return {
      root: {
        tracks: cloneTracks(root.tracks),
        duration: root.duration,
        tags: cloneTags(root.tags),
        currentFrame: root.currentFrame,
      },
      symbols: cloneSymbols(this.symbols),
      context: this.contextStack.map((e) => ({ ...e.ref })),
      activeFrame: this.currentFrame,
      frameRate: this.frameRate,
    };
  }

  /**
   * Restore a history entry: replaces tracks/frame/duration, symbols and the
   * edit-symbol context, updates layerStore to match, and reloads Paper.
   * `activeLayerId` may be the stage id (stage row selected at snapshot time).
   */
  applyState(
    state: DocumentState,
    activeLayerId: string,
    soloLayerId: string | null = null,
  ): void {
    this.clearEditMultipleFramesState();
    this.frameRate = state.frameRate;
    this.symbols = new Map(
      Object.values(cloneSymbols(state.symbols ?? {})).map((s) => [s.id, s]),
    );
    this.contextStack = [];
    this.loadTimeline(state.root);

    // Re-enter the symbol chain the entry was taken in.
    for (const ref of state.context ?? []) {
      const sym = this.symbols.get(ref.symbolId);
      if (!sym) break;
      this.pushContext({ ...ref });
    }
    if (this.contextStack.length > 0) {
      this.currentFrame = Math.max(0, Math.min(this.duration - 1, state.activeFrame));
    }
    this.updateLayerStoreFromTracks(activeLayerId, soloLayerId);

    // Reload Paper. Compare against loadedContent so unchanged layers skip
    // the reimport; structure changes (added/removed layers) are handled by
    // restoreLayersSnapshot itself.
    this.reloadCurrentFrame();
    this.syncContextBackdrop();
    this.onContextChanged?.();
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

  private updateLayerStoreFromTracks(
    activeLayerId: string,
    soloLayerId: string | null = layerStore.get().soloLayerId,
  ): void {
    const prev = layerStore.get();
    const stageRow: Layer =
      prev.layers.find((l) => l.kind === "stage") ??
      ({
        id: STAGE_LAYER_ID,
        name: "Stage",
        visible: true,
        locked: false,
        kind: "stage",
      } as Layer);

    const layers: Layer[] = [
      { ...stageRow, locked: false },
      ...this.tracks.map((t) => ({
        id: t.id,
        name: t.name,
        visible: t.visible,
        locked: t.locked,
        kind: layerKindFromTrack(t.kind),
      })),
    ];

    let validActive =
      activeLayerId === STAGE_LAYER_ID ||
      this.tracks.some((t) => t.id === activeLayerId)
        ? activeLayerId
        : this.tracks[this.tracks.length - 1]?.id ?? STAGE_LAYER_ID;

    // Prefer an unlocked regular layer when restoring.
    if (validActive !== STAGE_LAYER_ID) {
      const activeTrack = this.tracks.find((t) => t.id === validActive);
      if (activeTrack?.locked) {
        const unlocked =
          [...this.tracks].reverse().find((t) => !t.locked) ?? null;
        validActive = unlocked?.id ?? STAGE_LAYER_ID;
      }
    }

    const validSolo =
      soloLayerId && this.tracks.some((t) => t.id === soloLayerId)
        ? soloLayerId
        : null;

    layerStore.set({
      layers,
      activeLayerId: validActive,
      soloLayerId: validSolo,
    });
    stageSelectedStore.set(validActive === STAGE_LAYER_ID);
    this.applyEffectiveVisibility(validSolo);
  }

  // ------------------------------------------------------------
  // Serialization (save / load / new)
  // ------------------------------------------------------------

  serialize(stage: { width: number; height: number; color: string }): SerializedDocument {
    this.flushActiveTimeline();
    const root = this.rootTimeline();
    const content: Record<string, string> = {};
    for (const track of this.allTracks()) {
      for (const kf of track.keyframes) {
        content[kf.contentId] = this.content.get(kf.contentId) ?? "";
      }
    }
    const assets: Record<string, AssetMeta> = {};
    for (const id of this.collectReferencedAssetIds()) {
      const meta = this.assets.get(id);
      if (meta) assets[id] = { ...meta };
    }
    const symbols = cloneSymbols(this.symbols);
    return {
      version: 3,
      stage: { ...stage },
      frameRate: this.frameRate,
      duration: root.duration,
      tracks: cloneTracks(root.tracks),
      content,
      tags: cloneTags(root.tags),
      ...(Object.keys(assets).length > 0 ? { assets } : {}),
      ...(Object.keys(symbols).length > 0 ? { symbols } : {}),
    };
  }

  /**
   * Replace the whole document from a serialized payload. The caller is
   * responsible for resetting history and stage settings afterwards.
   */
  loadSerialized(doc: SerializedDocument): void {
    this.content = new Map(Object.entries(doc.content));
    this.content.set(EMPTY_CONTENT_ID, "");
    this.symbolRefCache.clear();
    clearSymbolTemplateCache();
    clearSymbolThumbnailCache();
    this.contextStack = [];
    this.symbols = new Map();
    for (const [key, raw] of Object.entries(doc.symbols ?? {})) {
      const sym = normalizeSymbol(raw, key);
      if (sym) this.symbols.set(sym.id, sym);
    }
    this.assets = new Map(
      Object.entries(doc.assets ?? {}).filter(
        (entry): entry is [string, AssetMeta] =>
          typeof entry[1]?.name === "string" && typeof entry[1]?.mime === "string",
      ),
    );
    this.tracks = cloneTracks(doc.tracks);
    this.duration = Math.max(1, Math.round(doc.duration));
    this.tags = this.normalizeLoadedTags(doc.tags);
    // Guarantee model invariants on untrusted input.
    for (const track of this.tracks) {
      track.kind = trackKind(track);
      if (track.kind !== "audio") {
        delete track.audio;
      } else if (track.audio) {
        track.audio = {
          assetId: String(track.audio.assetId ?? ""),
          startFrame: Math.round(Number(track.audio.startFrame) || 0),
        };
      }
      track.locked = !!track.locked;
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
    this.syncContextBackdrop();
    this.onContextChanged?.();
    this.publish();
  }

  // ------------------------------------------------------------
  // Document-wide recolor
  // ------------------------------------------------------------

  /**
   * Live recolor session: originals are captured once per source hex so
   * continuous picker drags always remap from the starting artwork.
   */
  private recolorSession: {
    fromHex: string;
    originals: Map<string, string>;
  } | null = null;

  /**
   * Replace `fromHex` with `toHex` across every keyframe content blob.
   * During a drag, pass the same `fromHex` each time; call
   * `endDocumentRecolor()` when the gesture finishes.
   */
  recolorDocument(fromHex: string, toHex: string): boolean {
    const from = normalizeDocumentHex(fromHex);
    const to = normalizeDocumentHex(toHex);
    if (from === to) return false;

    if (!this.recolorSession || this.recolorSession.fromHex !== from) {
      this.commitDirtyLayerContent();
      const originals = new Map<string, string>();
      const seen = new Set<string>();
      for (const track of this.allTracks()) {
        if (!isVectorTrack(track)) continue;
        for (const kf of track.keyframes) {
          const id = kf.contentId;
          if (id === EMPTY_CONTENT_ID || seen.has(id)) continue;
          seen.add(id);
          const json = this.content.get(id) ?? "";
          if (!json) continue;
          if (colorsFromPaperJson(json).includes(from)) {
            originals.set(id, json);
          }
        }
      }
      this.recolorSession = { fromHex: from, originals };
    }

    let changed = false;
    for (const [id, original] of this.recolorSession.originals) {
      const next = replaceColorInPaperJson(original, from, to);
      if (next == null) continue;
      this.content.set(id, next);
      changed = true;
    }
    if (!changed) return false;

    // Symbol content may have changed: drop parsed templates.
    clearSymbolTemplateCache();
    clearSymbolThumbnailCache();
    this.loadedContent.clear();
    this.reloadCurrentFrame();
    this.publish();
    return true;
  }

  /** Clear a live recolor drag session (after history snapshot). */
  endDocumentRecolor(): void {
    this.recolorSession = null;
  }

  // ------------------------------------------------------------
  // Timeline store publishing
  // ------------------------------------------------------------

  private refreshDocumentColors(): void {
    documentColorsStore.set(collectDocumentColors(this.allTracks(), this.content));
  }

  /** Snapshot tracks/flags into the store (content may have changed). */
  private normalizeLoadedTags(raw: FrameTag[] | undefined): FrameTag[] {
    if (!Array.isArray(raw)) return [];
    const out: FrameTag[] = [];
    const last = this.duration - 1;
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const id = typeof item.id === "string" && item.id ? item.id : this.newTagId();
      const name =
        typeof item.name === "string" && item.name.trim()
          ? item.name.trim().slice(0, 64)
          : this.nextDefaultTagName();
      let start = Math.round(Number(item.start));
      let end = Math.round(Number(item.end));
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (start > end) [start, end] = [end, start];
      start = Math.max(0, Math.min(last, start));
      end = Math.max(0, Math.min(last, end));
      if (start > end) continue;
      out.push({ id, name, start, end });
    }
    return out;
  }

  private timelineSnapshot(): TimelineState {
    return {
      tracks: this.tracks.map((t) => ({
        id: t.id,
        name: t.name,
        visible: t.visible,
        locked: t.locked,
        kind: trackKind(t),
        keyframes: t.keyframes.map((k) => ({
          frame: k.frameIndex,
          blank: k.contentId === EMPTY_CONTENT_ID,
          holdUntil: k.holdUntil,
        })),
        ...(trackKind(t) === "audio" && t.audio
          ? {
              audio: {
                assetId: t.audio.assetId,
                startFrame: t.audio.startFrame,
                durationFrames: this.audioDurationFrames(t.audio.assetId),
              },
            }
          : {}),
        assetIds: this.trackAssetIds(t),
      })),
      currentFrame: this.currentFrame,
      duration: this.duration,
      frameRate: this.frameRate,
      playing: this.playing,
      onionSkin: onionSkinStore.get(),
      autoHold: autoHoldStore.get(),
      realTimeLock: realTimeLockStore.get(),
      editMultipleFrames: this.editMultipleFrames,
      emfRange: this.emfRange
        ? { ...this.emfRange, layerIds: [...this.emfRange.layerIds] }
        : null,
      tags: cloneTags(this.tags),
    };
  }

  /**
   * Playhead moved (scrub / playback): refresh onion + currentFrame only.
   * Reuses the previous tracks reference so UI can skip grid rebuilds.
   */
  private publishPlayhead(): void {
    this.updateOnionSkin();
    const prev = timelineStore.get();
    timelineStore.set({
      ...prev,
      currentFrame: this.currentFrame,
    });
  }

  private publish(): void {
    // Every document mutation funnels through here, so the ghosts always
    // track the latest content, visibility, playhead, and playback state.
    this.updateOnionSkin();
    this.refreshDocumentColors();
    this.publishSymbolLibrary();
    timelineStore.set(this.timelineSnapshot());
  }
}
