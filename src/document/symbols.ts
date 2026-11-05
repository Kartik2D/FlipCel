/**
 * Flash-style symbols — model types and pure resolution helpers.
 *
 * A symbol is a reusable nested timeline. Instances live on vector layers as
 * empty `paper.Group`s (applyMatrix=false) whose `data` is a
 * `SymbolInstanceData`; the group's `matrix` and `pivot` hold the transform.
 * Artwork is hydrated into the group for display and stripped before export,
 * so stored layer JSON stays small and deterministic.
 *
 * Paper-specific code lives in `render/paper/symbol-instances.ts`.
 */
import {
  coveringKeyframeOf,
  EMPTY_CONTENT_ID,
  type Keyframe,
} from "./keyframes";

export type SymbolPlayMode = "loop" | "once" | "single";

export const SYMBOL_PLAY_MODES: readonly SymbolPlayMode[] = ["loop", "once", "single"];

/** Minimal track shape a symbol needs (mirrors LayerTrack, vector only). */
export interface SymbolTrack {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  kind?: "vector" | "image" | "audio";
  keyframes: Keyframe[];
}

export interface SymbolTag {
  id: string;
  name: string;
  start: number;
  end: number;
}

export interface SymbolDefinition {
  id: string;
  name: string;
  /** Bottom → top. Vector only in v1. */
  tracks: SymbolTrack[];
  duration: number;
  tags: SymbolTag[];
}

/**
 * Stored in an instance group's `data`. Flat primitives only: Paper's
 * `Item.clone()` shallow-copies `data`.
 */
export interface SymbolInstanceData {
  symbol: string;
  /** Stable instance identity across frames, merge rebuilds, and undo. */
  iid: string;
  mode: SymbolPlayMode;
  /** 0-based child frame shown at the covering keyframe's start. */
  firstFrame: number;
}

export interface SymbolResolver {
  getSymbol(id: string): SymbolDefinition | null;
  getContent(contentId: string): string;
}

let iidCounter = 1;
export function newInstanceId(): string {
  return `i${Date.now().toString(36)}-${(iidCounter++).toString(36)}`;
}

export function isSymbolPlayMode(value: unknown): value is SymbolPlayMode {
  return value === "loop" || value === "once" || value === "single";
}

export function normalizeInstanceData(raw: unknown): SymbolInstanceData | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Partial<Record<keyof SymbolInstanceData, unknown>>;
  if (typeof d.symbol !== "string" || !d.symbol) return null;
  const firstFrame = Math.round(Number(d.firstFrame));
  return {
    symbol: d.symbol,
    iid: typeof d.iid === "string" && d.iid ? d.iid : newInstanceId(),
    mode: isSymbolPlayMode(d.mode) ? d.mode : "loop",
    firstFrame: Number.isFinite(firstFrame) ? Math.max(0, firstFrame) : 0,
  };
}

/**
 * Which symbol frame an instance shows.
 *
 *   elapsed = parentFrame − coveringKeyframe.frameIndex   (≥ 0)
 *   single  → clamp(firstFrame)
 *   loop    → (firstFrame + elapsed) mod D
 *   once    → min(firstFrame + elapsed, D − 1)
 */
export function childFrameFor(
  data: Pick<SymbolInstanceData, "mode" | "firstFrame">,
  elapsed: number,
  duration: number,
): number {
  const d = Math.max(1, Math.round(duration));
  const first = Math.max(0, Math.min(d - 1, Math.round(data.firstFrame) || 0));
  const e = Math.max(0, Math.round(elapsed) || 0);
  switch (data.mode) {
    case "single":
      return first;
    case "once":
      return Math.min(first + e, d - 1);
    case "loop":
    default:
      return (((first + e) % d) + d) % d;
  }
}

/** True when scrubbing within a hold changes what this instance shows. */
export function instanceAnimates(
  data: Pick<SymbolInstanceData, "mode">,
  duration: number,
): boolean {
  return data.mode !== "single" && duration > 1;
}

export type ResolvedSymbolLayer = {
  contentId: string;
  json: string;
  /** Start of the covering keyframe (for nested elapsed). */
  keyframeFrame: number;
};

/** Visible symbol layers at `childFrame`, bottom → top. */
export function resolveSymbolFrame(
  symbol: SymbolDefinition,
  childFrame: number,
  resolver: Pick<SymbolResolver, "getContent">,
): ResolvedSymbolLayer[] {
  const out: ResolvedSymbolLayer[] = [];
  const frame = Math.max(0, Math.min(symbol.duration - 1, Math.round(childFrame)));
  for (const track of symbol.tracks) {
    if (!track.visible) continue;
    if (track.kind === "image" || track.kind === "audio") continue;
    const kf = coveringKeyframeOf(track, frame);
    if (!kf || kf.contentId === EMPTY_CONTENT_ID) continue;
    const json = resolver.getContent(kf.contentId);
    if (!json) continue;
    out.push({ contentId: kf.contentId, json, keyframeFrame: kf.frameIndex });
  }
  return out;
}

const SYMBOL_REF_RE = /"symbol":"([^"\\]+)"/g;

/** Symbol ids referenced by instance groups inside layer JSON (string scan). */
export function scanInstanceSymbolIds(json: string): string[] {
  if (!json || json.indexOf('"symbol":"') === -1) return [];
  const ids = new Set<string>();
  for (const m of json.matchAll(SYMBOL_REF_RE)) ids.add(m[1]!);
  return [...ids];
}

export function cloneSymbol(symbol: SymbolDefinition): SymbolDefinition {
  return {
    id: symbol.id,
    name: symbol.name,
    duration: symbol.duration,
    tracks: symbol.tracks.map((t) => ({
      ...t,
      keyframes: t.keyframes.map((k) => ({ ...k })),
    })),
    tags: symbol.tags.map((t) => ({ ...t })),
  };
}

export function cloneSymbols(
  symbols: Record<string, SymbolDefinition> | Map<string, SymbolDefinition>,
): Record<string, SymbolDefinition> {
  const out: Record<string, SymbolDefinition> = {};
  const entries = symbols instanceof Map ? symbols.entries() : Object.entries(symbols);
  for (const [id, sym] of entries) out[id] = cloneSymbol(sym);
  return out;
}

/** Normalize an untrusted symbol record; null when unusable. */
export function normalizeSymbol(raw: unknown, fallbackId: string): SymbolDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<SymbolDefinition>;
  const id = typeof s.id === "string" && s.id ? s.id : fallbackId;
  const name =
    typeof s.name === "string" && s.name.trim() ? s.name.trim().slice(0, 64) : "Symbol";
  const duration = Math.max(1, Math.min(9999, Math.round(Number(s.duration)) || 1));
  const tracks: SymbolTrack[] = [];
  for (const t of Array.isArray(s.tracks) ? s.tracks : []) {
    if (!t || typeof t.id !== "string" || !Array.isArray(t.keyframes)) continue;
    const keyframes: Keyframe[] = [];
    for (const k of t.keyframes) {
      const frameIndex = Math.round(Number(k?.frameIndex));
      if (!Number.isFinite(frameIndex) || frameIndex < 0 || frameIndex >= duration) continue;
      const contentId =
        typeof k.contentId === "string" && k.contentId ? k.contentId : EMPTY_CONTENT_ID;
      keyframes.push({ frameIndex, contentId, holdUntil: Number(k.holdUntil) });
    }
    keyframes.sort((a, b) => a.frameIndex - b.frameIndex);
    for (let i = 0; i < keyframes.length; i++) {
      const kf = keyframes[i]!;
      if (kf.contentId === EMPTY_CONTENT_ID) {
        kf.holdUntil = kf.frameIndex;
        continue;
      }
      const spanEnd = (keyframes[i + 1]?.frameIndex ?? duration) - 1;
      kf.holdUntil = Number.isFinite(kf.holdUntil)
        ? Math.max(kf.frameIndex, Math.min(kf.holdUntil, spanEnd))
        : spanEnd;
    }
    if (keyframes.length === 0) {
      keyframes.push({ frameIndex: 0, contentId: EMPTY_CONTENT_ID, holdUntil: 0 });
    }
    tracks.push({
      id: t.id,
      name: typeof t.name === "string" ? t.name : "Layer",
      visible: t.visible !== false,
      locked: !!t.locked,
      kind: "vector",
      keyframes,
    });
  }
  const tags: SymbolTag[] = [];
  for (const t of Array.isArray(s.tags) ? s.tags : []) {
    if (!t || typeof t !== "object") continue;
    let start = Math.round(Number(t.start));
    let end = Math.round(Number(t.end));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start > end) [start, end] = [end, start];
    start = Math.max(0, Math.min(duration - 1, start));
    end = Math.max(0, Math.min(duration - 1, end));
    if (start > end) continue;
    tags.push({
      id: typeof t.id === "string" && t.id ? t.id : `tag-${tags.length + 1}`,
      name: typeof t.name === "string" && t.name.trim() ? t.name.trim().slice(0, 64) : "Tag",
      start,
      end,
    });
  }
  return { id, name, duration, tracks, tags };
}
