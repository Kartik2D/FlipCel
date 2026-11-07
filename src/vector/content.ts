/**
 * Keyframe content (v4) — a kernel map snapshot plus placed symbol instances.
 *
 *   {"v":4,"map":"<base64 FCV1 bytes>","instances":[{...}]}
 *
 * Image keyframes keep `{"asset":"…"}`. The empty string is the empty frame.
 */
import { VectorLayer, type Affine, type Px } from "./kernel";
import type { SymbolInstanceData, SymbolPlayMode } from "../document/symbols";

export interface PlacedInstance extends SymbolInstanceData {
  /** World matrix `[a, b, c, d, tx, ty]` (pixels). */
  matrix: Affine;
  /** Transform origin in symbol-local pixels. */
  pivot: Px;
}

export interface VectorContent {
  /** Kernel bytes (`FCV1`); empty array = no shapes. */
  map: Uint8Array;
  instances: PlacedInstance[];
}

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = new Uint8Array(128);
for (let i = 0; i < B64_CHARS.length; i++) B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i;

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    parts.push(
      B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63] + B64_CHARS[n & 63],
    );
  }
  if (i < bytes.length) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const n = (a << 16) | (b << 8);
    parts.push(
      B64_CHARS[(n >> 18) & 63] +
        B64_CHARS[(n >> 12) & 63] +
        (i + 1 < bytes.length ? B64_CHARS[(n >> 6) & 63] : "=") +
        "=",
    );
  }
  return parts.join("");
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const a = B64_LOOKUP[clean.charCodeAt(i)];
    const b = B64_LOOKUP[clean.charCodeAt(i + 1)];
    const c = i + 2 < clean.length ? B64_LOOKUP[clean.charCodeAt(i + 2)] : 0;
    const d = i + 3 < clean.length ? B64_LOOKUP[clean.charCodeAt(i + 3)] : 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (i + 2 < clean.length && o < out.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < clean.length && o < out.length) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

function isPlayMode(v: unknown): v is SymbolPlayMode {
  return v === "loop" || v === "once" || v === "single";
}

export function normalizePlacedInstance(raw: unknown): PlacedInstance | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.symbol !== "string" || !d.symbol) return null;
  const m = Array.isArray(d.matrix) && d.matrix.length === 6 ? d.matrix.map(Number) : [1, 0, 0, 1, 0, 0];
  if (m.some((v) => !Number.isFinite(v))) return null;
  const pv = Array.isArray(d.pivot) && d.pivot.length === 2 ? d.pivot.map(Number) : [0, 0];
  const firstFrame = Math.round(Number(d.firstFrame));
  return {
    symbol: d.symbol,
    iid: typeof d.iid === "string" && d.iid ? d.iid : `i${Math.random().toString(36).slice(2, 10)}`,
    mode: isPlayMode(d.mode) ? d.mode : "loop",
    firstFrame: Number.isFinite(firstFrame) ? Math.max(0, firstFrame) : 0,
    matrix: [m[0], m[1], m[2], m[3], m[4], m[5]],
    pivot: { x: Number.isFinite(pv[0]) ? pv[0] : 0, y: Number.isFinite(pv[1]) ? pv[1] : 0 },
  };
}

export function cloneInstance(inst: PlacedInstance): PlacedInstance {
  return { ...inst, matrix: [...inst.matrix] as Affine, pivot: { ...inst.pivot } };
}

export function isVectorContent(json: string): boolean {
  return json.startsWith('{"v":4');
}

export function isImageContent(json: string): boolean {
  return json.startsWith('{"asset"');
}

/** Serialize. Returns "" when there is nothing to store. */
export function encodeContent(map: Uint8Array | null, instances: readonly PlacedInstance[]): string {
  const hasMap = !!map && map.length > 0;
  if (!hasMap && instances.length === 0) return "";
  const inst = instances.map((i) => ({
    symbol: i.symbol,
    iid: i.iid,
    mode: i.mode,
    firstFrame: i.firstFrame,
    matrix: i.matrix.map((v) => Math.round(v * 1e4) / 1e4),
    pivot: [Math.round(i.pivot.x * 100) / 100, Math.round(i.pivot.y * 100) / 100],
  }));
  return JSON.stringify({ v: 4, map: hasMap ? bytesToBase64(map) : "", instances: inst });
}

export function encodeLayerContent(layer: VectorLayer | null, instances: readonly PlacedInstance[]): string {
  const bytes = layer && !layer.isEmpty() ? layer.toBytes() : null;
  return encodeContent(bytes, instances);
}

export function decodeContent(json: string): VectorContent {
  if (!json || !isVectorContent(json)) return { map: new Uint8Array(0), instances: [] };
  try {
    const parsed = JSON.parse(json) as { map?: unknown; instances?: unknown };
    const map = typeof parsed.map === "string" && parsed.map ? base64ToBytes(parsed.map) : new Uint8Array(0);
    const instances: PlacedInstance[] = [];
    if (Array.isArray(parsed.instances)) {
      for (const raw of parsed.instances) {
        const inst = normalizePlacedInstance(raw);
        if (inst) instances.push(inst);
      }
    }
    return { map, instances };
  } catch {
    return { map: new Uint8Array(0), instances: [] };
  }
}

/** Symbol ids referenced by instances in a content string (cheap scan). */
export function scanContentSymbolIds(json: string): string[] {
  if (!json || json.indexOf('"symbol":"') === -1) return [];
  const ids = new Set<string>();
  for (const m of json.matchAll(/"symbol":"([^"\\]+)"/g)) ids.add(m[1]);
  return [...ids];
}

/** Rewrite instance ids inside a content string (clone/paste). */
export function withFreshInstanceIds(json: string, next: () => string): string {
  const c = decodeContent(json);
  if (c.instances.length === 0) return json;
  return encodeContent(c.map, c.instances.map((i) => ({ ...i, iid: next() })));
}

/** Translate every shape and instance in a content string. */
export function translateContent(json: string, dx: number, dy: number): string {
  const c = decodeContent(json);
  if (c.map.length === 0 && c.instances.length === 0) return json;
  let bytes: Uint8Array | null = null;
  if (c.map.length > 0) {
    const layer = VectorLayer.fromBytes(c.map);
    layer.transform([1, 0, 0, 1, dx, dy]);
    bytes = layer.isEmpty() ? null : layer.toBytes();
    layer.free();
  }
  return encodeContent(
    bytes,
    c.instances.map((i) => ({
      ...i,
      matrix: [i.matrix[0], i.matrix[1], i.matrix[2], i.matrix[3], i.matrix[4] + dx, i.matrix[5] + dy],
    })),
  );
}

/** Stamp `above` onto `below` (merge layer down). */
export function mergeContents(below: string, above: string): string {
  if (!above) return below;
  if (!below) return above;
  const a = decodeContent(below);
  const b = decodeContent(above);
  const layer = a.map.length > 0 ? VectorLayer.fromBytes(a.map) : new VectorLayer();
  if (b.map.length > 0) {
    const top = VectorLayer.fromBytes(b.map);
    layer.stamp(top);
    top.free();
  }
  const json = encodeLayerContent(layer, [...a.instances, ...b.instances]);
  layer.free();
  return json;
}

/** Content holding a single instance placed at `origin`. */
export function instanceContent(data: SymbolInstanceData, origin: Px): string {
  return encodeContent(null, [{ ...data, matrix: [1, 0, 0, 1, origin.x, origin.y], pivot: { x: 0, y: 0 } }]);
}

/** Fill ids used by a content string's shapes (instances excluded). */
export function contentFills(json: string): number[] {
  const { layer } = contentCache.get(json);
  return layer ? layer.fills() : [];
}

/** Remap fill ids across a content string; null when unchanged. */
export function remapContentFills(json: string, pairs: ReadonlyArray<readonly [number, number]>): string | null {
  const c = decodeContent(json);
  if (c.map.length === 0) return null;
  const layer = VectorLayer.fromBytes(c.map);
  const used = new Set(layer.fills());
  const relevant = pairs.filter(([from]) => used.has(from));
  if (relevant.length === 0) {
    layer.free();
    return null;
  }
  layer.remapFills(relevant);
  const out = encodeLayerContent(layer, c.instances);
  layer.free();
  return out;
}

// ------------------------------------------------------------
// Parsed-content cache (read-only maps for onion / symbols / thumbnails)
// ------------------------------------------------------------

export class ContentCache {
  private layers = new Map<string, { layer: VectorLayer | null; content: VectorContent }>();
  private readonly max: number;

  constructor(max = 192) {
    this.max = max;
  }

  get(json: string): { layer: VectorLayer | null; content: VectorContent } {
    const hit = this.layers.get(json);
    if (hit) {
      // LRU bump.
      this.layers.delete(json);
      this.layers.set(json, hit);
      return hit;
    }
    const content = decodeContent(json);
    let layer: VectorLayer | null = null;
    if (content.map.length > 0) {
      try {
        layer = VectorLayer.fromBytes(content.map);
      } catch {
        layer = null;
      }
    }
    const entry = { layer, content };
    if (this.layers.size >= this.max) {
      const oldest = this.layers.keys().next().value;
      if (oldest !== undefined) {
        this.layers.get(oldest)?.layer?.free();
        this.layers.delete(oldest);
      }
    }
    this.layers.set(json, entry);
    return entry;
  }

  clear(): void {
    for (const e of this.layers.values()) e.layer?.free();
    this.layers.clear();
  }
}

export const contentCache = new ContentCache();
