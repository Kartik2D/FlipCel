/**
 * Kernel wrapper — the DCEL planar map is the source of truth for vector art.
 *
 * `VectorLayer` owns one wasm `VectorMap` (integer twips, 20 per CSS px) and
 * exposes it in pixel coordinates. Every mutation goes through the kernel;
 * this file only packs/unpacks arguments and caches `Path2D`s for drawing.
 */
import __wbg_init, {
  initSync,
  regionOp as wasmRegionOp,
  VectorMap,
} from "./pkg/kernel.js";

export { VectorMap };

export const TWIPS_PER_PX = 20;
export const EMPTY_FILL = 0;

export const PaintMode = {
  Over: 0,
  Erase: 1,
  Inside: 2,
  Behind: 3,
} as const;
export type PaintMode = (typeof PaintMode)[keyof typeof PaintMode];

export const BoolOp = {
  Union: 0,
  Intersect: 1,
  Subtract: 2,
  Xor: 3,
} as const;
export type BoolOp = (typeof BoolOp)[keyof typeof BoolOp];

export interface Px {
  x: number;
  y: number;
}

export type Seg =
  | { kind: "L"; to: Px }
  | { kind: "Q"; c: Px; to: Px }
  | { kind: "C"; c1: Px; c2: Px; to: Px };

/** Closed ring in pixel coordinates (implicitly closed back to `start`). */
export interface Ring {
  start: Px;
  segs: Seg[];
}

export interface Region {
  fill: number;
  rings: Ring[];
}

/** `[a, b, c, d, e, f]`: x' = a·x + c·y + e, y' = b·x + d·y + f (pixels). */
export type Affine = [number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

export function mulAffine(m: Affine, n: Affine): Affine {
  // m ∘ n : apply n first, then m.
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function invertAffine(m: Affine): Affine {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return IDENTITY;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function applyAffine(m: Affine, p: Px): Px {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function translation(dx: number, dy: number): Affine {
  return [1, 0, 0, 1, dx, dy];
}

export function scaleAbout(sx: number, sy: number, anchor: Px): Affine {
  return [sx, 0, 0, sy, anchor.x - sx * anchor.x, anchor.y - sy * anchor.y];
}

export function rotateAbout(degrees: number, pivot: Px): Affine {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [
    cos,
    sin,
    -sin,
    cos,
    pivot.x - cos * pivot.x + sin * pivot.y,
    pivot.y - sin * pivot.x - cos * pivot.y,
  ];
}

// ------------------------------------------------------------
// Init
// ------------------------------------------------------------

let ready = false;
let pending: Promise<void> | null = null;

/** Browser: fetch + instantiate `kernel_bg.wasm` next to the glue module. */
export function initKernel(): Promise<void> {
  if (ready) return Promise.resolve();
  if (!pending) {
    pending = __wbg_init().then(() => {
      ready = true;
    });
  }
  return pending;
}

/** Node checks: instantiate from bytes synchronously. */
export function initKernelSync(bytes: BufferSource | WebAssembly.Module): void {
  if (ready) return;
  initSync({ module: bytes });
  ready = true;
}

export function kernelReady(): boolean {
  return ready;
}

// ------------------------------------------------------------
// Packing
// ------------------------------------------------------------

const tw = (v: number): number => Math.round(v * TWIPS_PER_PX);
const px = (v: number): number => v / TWIPS_PER_PX;

/** Pack rings (pixels) into the kernel's flat twip layout. */
export function packRings(rings: readonly Ring[]): Int32Array {
  let n = 1;
  for (const r of rings) n += 3 + r.segs.length * 7;
  const out = new Int32Array(n);
  let i = 0;
  out[i++] = rings.length;
  for (const r of rings) {
    out[i++] = r.segs.length;
    out[i++] = tw(r.start.x);
    out[i++] = tw(r.start.y);
    for (const s of r.segs) {
      if (s.kind === "L") {
        out[i++] = 0;
        out[i++] = 0;
        out[i++] = 0;
        out[i++] = 0;
        out[i++] = 0;
      } else if (s.kind === "Q") {
        out[i++] = 1;
        out[i++] = tw(s.c.x);
        out[i++] = tw(s.c.y);
        out[i++] = 0;
        out[i++] = 0;
      } else {
        out[i++] = 2;
        out[i++] = tw(s.c1.x);
        out[i++] = tw(s.c1.y);
        out[i++] = tw(s.c2.x);
        out[i++] = tw(s.c2.y);
      }
      out[i++] = tw(s.to.x);
      out[i++] = tw(s.to.y);
    }
  }
  return out;
}

/** Unpack a packed ring set (input layout, 7 ints per segment) starting at `i`. */
function unpackRingSet(data: Int32Array, i: number): { rings: Ring[]; next: number } {
  const ringCount = data[i++];
  const rings: Ring[] = [];
  for (let r = 0; r < ringCount; r++) {
    const segCount = data[i++];
    const start = { x: px(data[i++]), y: px(data[i++]) };
    const segs: Seg[] = [];
    for (let s = 0; s < segCount; s++) {
      const tag = data[i++];
      const c1 = { x: px(data[i++]), y: px(data[i++]) };
      const c2 = { x: px(data[i++]), y: px(data[i++]) };
      const to = { x: px(data[i++]), y: px(data[i++]) };
      segs.push(tag === 1 ? { kind: "Q", c: c1, to } : tag === 2 ? { kind: "C", c1, c2, to } : { kind: "L", to });
    }
    rings.push({ start, segs });
  }
  return { rings, next: i };
}

/** Unpack the kernel's `regions()` output (`fill` + packed rings, repeated). */
export function unpackRegions(data: Int32Array): Region[] {
  const out: Region[] = [];
  let i = 0;
  while (i < data.length) {
    const fill = data[i++];
    const { rings, next } = unpackRingSet(data, i);
    i = next;
    out.push({ fill, rings });
  }
  return out;
}

/** Pack a ring set for `regionOp` output: rings only (fill is ignored). */
export function regionOpRings(a: readonly Ring[], b: readonly Ring[], op: BoolOp): Ring[] {
  const out = wasmRegionOp(packRings(a), packRings(b), op);
  return out.length === 0 ? [] : unpackRingSet(out, 0).rings;
}

export function ringsToPath2D(rings: readonly Ring[], into = new Path2D()): Path2D {
  for (const r of rings) {
    into.moveTo(r.start.x, r.start.y);
    for (const s of r.segs) {
      if (s.kind === "L") into.lineTo(s.to.x, s.to.y);
      else if (s.kind === "Q") into.quadraticCurveTo(s.c.x, s.c.y, s.to.x, s.to.y);
      else into.bezierCurveTo(s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.to.x, s.to.y);
    }
    into.closePath();
  }
  return into;
}

export function transformRing(ring: Ring, m: Affine): Ring {
  const t = (p: Px) => applyAffine(m, p);
  return {
    start: t(ring.start),
    segs: ring.segs.map((s) =>
      s.kind === "L"
        ? { kind: "L", to: t(s.to) }
        : s.kind === "Q"
          ? { kind: "Q", c: t(s.c), to: t(s.to) }
          : { kind: "C", c1: t(s.c1), c2: t(s.c2), to: t(s.to) },
    ),
  };
}

export function ringBounds(rings: readonly Ring[]): Bounds | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (p: Px) => {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  };
  for (const r of rings) {
    add(r.start);
    for (const s of r.segs) {
      add(s.to);
      if (s.kind === "Q") add(s.c);
      if (s.kind === "C") {
        add(s.c1);
        add(s.c2);
      }
    }
  }
  if (x0 === Infinity) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function rectRing(x: number, y: number, w: number, h: number): Ring {
  return {
    start: { x, y },
    segs: [
      { kind: "L", to: { x: x + w, y } },
      { kind: "L", to: { x: x + w, y: y + h } },
      { kind: "L", to: { x, y: y + h } },
    ],
  };
}

export function polygonRing(points: readonly Px[]): Ring | null {
  if (points.length < 3) return null;
  return {
    start: points[0],
    segs: points.slice(1).map((p) => ({ kind: "L", to: p })),
  };
}

// ------------------------------------------------------------
// VectorLayer
// ------------------------------------------------------------

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Face {
  fill: number;
  path: Path2D;
}

export interface KernelEdge {
  a: Px;
  b: Px;
  ctrl: Px | null;
}

export function twipsToPx(p: Px): Px {
  return { x: px(p.x), y: px(p.y) };
}

export function pxToTwips(p: Px): Px {
  return { x: tw(p.x), y: tw(p.y) };
}

/**
 * One layer's committed vector art, backed by a kernel map in pixel units.
 * Callers must `free()` layers they drop (wasm memory is not GC'd).
 */
export class VectorLayer {
  map: VectorMap;
  private facesCache: Face[] | null = null;
  private facesDigest: bigint | null = null;

  constructor(map: VectorMap = new VectorMap()) {
    this.map = map;
  }

  static fromBytes(bytes: Uint8Array): VectorLayer {
    return new VectorLayer(VectorMap.fromBytes(bytes));
  }

  free(): void {
    this.map.free();
    this.facesCache = null;
  }

  clone(): VectorLayer {
    return new VectorLayer(this.map.clone());
  }

  isEmpty(): boolean {
    return this.map.isEmpty();
  }

  digest(): bigint {
    return this.map.digest();
  }

  toBytes(): Uint8Array {
    return this.map.toBytes();
  }

  /** Replace this layer's map with a decoded snapshot (undo-style restore). */
  restoreBytes(bytes: Uint8Array): void {
    this.map.free();
    this.map = VectorMap.fromBytes(bytes);
    this.invalidate();
  }

  invalidate(): void {
    this.facesCache = null;
  }

  paint(rings: readonly Ring[], fill: number, mode: PaintMode = PaintMode.Over, target = 0): void {
    if (rings.length === 0) return;
    this.map.paint(packRings(rings), fill, mode, target);
    this.invalidate();
  }

  erase(rings: readonly Ring[]): void {
    this.paint(rings, EMPTY_FILL, PaintMode.Erase);
  }

  /** Flood-fill the face containing `p`. */
  fillAt(p: Px, fill: number): boolean {
    const ok = this.map.fillAt(tw(p.x), tw(p.y), fill);
    if (ok) this.invalidate();
    return ok;
  }

  faceAt(p: Px): number {
    return this.map.faceAt(tw(p.x), tw(p.y));
  }

  fills(): number[] {
    return Array.from(this.map.fills());
  }

  bounds(): Bounds | null {
    const b = this.map.bounds();
    if (b.length < 4) return null;
    return { x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1] };
  }

  remapFills(pairs: ReadonlyArray<readonly [number, number]>): void {
    if (pairs.length === 0) return;
    const flat = new Uint32Array(pairs.length * 2);
    pairs.forEach(([from, to], i) => {
      flat[i * 2] = from;
      flat[i * 2 + 1] = to;
    });
    this.map.remapFills(flat);
    this.invalidate();
  }

  transform(m: Affine): void {
    this.map.transform([m[0], m[1], m[2], m[3], tw(m[4]), tw(m[5])]);
    this.invalidate();
  }

  /** Stamp `other` (transformed by `m`) on top of this layer. */
  stamp(other: VectorLayer, m: Affine = IDENTITY): void {
    if (other.isEmpty()) return;
    this.map.stamp(other.map, [m[0], m[1], m[2], m[3], tw(m[4]), tw(m[5])]);
    this.invalidate();
  }

  splitOff(rings: readonly Ring[]): VectorLayer {
    const lifted = new VectorLayer(this.map.splitOff(packRings(rings)));
    this.invalidate();
    return lifted;
  }

  splitOffFace(p: Px): VectorLayer {
    const lifted = new VectorLayer(this.map.splitOffFace(tw(p.x), tw(p.y)));
    this.invalidate();
    return lifted;
  }

  splitOffFills(fills: readonly number[]): VectorLayer {
    const lifted = new VectorLayer(this.map.splitOffFills(Uint32Array.from(fills)));
    this.invalidate();
    return lifted;
  }

  nearestVertex(p: Px, tolPx: number): Px | null {
    const r = this.map.nearestVertex(tw(p.x), tw(p.y), Math.max(1, tw(tolPx)));
    return r.length === 2 ? { x: px(r[0]), y: px(r[1]) } : null;
  }

  nearestEdge(p: Px, tolPx: number): KernelEdge | null {
    const r = this.map.nearestEdge(tw(p.x), tw(p.y), Math.max(1, tw(tolPx)));
    if (r.length < 7) return null;
    return {
      a: { x: px(r[0]), y: px(r[1]) },
      b: { x: px(r[2]), y: px(r[3]) },
      ctrl: r[4] ? { x: px(r[5]), y: px(r[6]) } : null,
    };
  }

  moveVertex(from: Px, to: Px): boolean {
    const ok = this.map.moveVertex(tw(from.x), tw(from.y), tw(to.x), tw(to.y));
    if (ok) this.invalidate();
    return ok;
  }

  /**
   * Move several vertices in one rebuild. Curve controls follow their
   * endpoints. Returns false (nothing changes) if any `from` is not a vertex.
   */
  moveVertices(moves: ReadonlyArray<{ from: Px; to: Px }>): boolean {
    if (moves.length === 0) return true;
    const flat = new Int32Array(moves.length * 4);
    moves.forEach((m, i) => {
      flat[i * 4] = tw(m.from.x);
      flat[i * 4 + 1] = tw(m.from.y);
      flat[i * 4 + 2] = tw(m.to.x);
      flat[i * 4 + 3] = tw(m.to.y);
    });
    const ok = this.map.moveVertices(flat);
    if (ok) this.invalidate();
    return ok;
  }

  /** Replace an edge's control point (`null` straightens it). */
  curveEdge(edge: KernelEdge, ctrl: Px | null): boolean {
    const ok = this.map.curveEdge(
      tw(edge.a.x),
      tw(edge.a.y),
      tw(edge.b.x),
      tw(edge.b.y),
      edge.ctrl != null,
      edge.ctrl ? tw(edge.ctrl.x) : 0,
      edge.ctrl ? tw(edge.ctrl.y) : 0,
      ctrl ? tw(ctrl.x) : 0,
      ctrl ? tw(ctrl.y) : 0,
    );
    if (ok) this.invalidate();
    return ok;
  }

  /**
   * Replace the edges along `chain` (consecutive vertices; interior ones of
   * degree 2) with `segs` running from the first vertex to the last. Fills on
   * either side carry over. Returns false (and changes nothing) if the chain
   * is not a run of existing edges.
   */
  replaceChain(chain: readonly Px[], segs: readonly Seg[]): boolean {
    if (chain.length < 2 || segs.length === 0) return false;
    const flat = new Int32Array(chain.length * 2);
    chain.forEach((p, i) => {
      flat[i * 2] = tw(p.x);
      flat[i * 2 + 1] = tw(p.y);
    });
    const ok = this.map.replaceChain(flat, packRings([{ start: chain[0], segs: [...segs] }]));
    if (ok) this.invalidate();
    return ok;
  }

  removeEdge(edge: KernelEdge): boolean {
    const ok = this.map.removeEdge(
      tw(edge.a.x),
      tw(edge.a.y),
      tw(edge.b.x),
      tw(edge.b.y),
      edge.ctrl != null,
      edge.ctrl ? tw(edge.ctrl.x) : 0,
      edge.ctrl ? tw(edge.ctrl.y) : 0,
    );
    if (ok) this.invalidate();
    return ok;
  }

  vertices(): Px[] {
    const v = this.map.verts();
    const out: Px[] = [];
    for (let i = 0; i + 1 < v.length; i += 2) out.push({ x: v[i], y: v[i + 1] });
    return out;
  }

  edges(): KernelEdge[] {
    const e = this.map.edges();
    const out: KernelEdge[] = [];
    for (let i = 0; i + 6 < e.length; i += 7) {
      out.push({
        a: { x: e[i], y: e[i + 1] },
        b: { x: e[i + 2], y: e[i + 3] },
        ctrl: e[i + 4] ? { x: e[i + 5], y: e[i + 6] } : null,
      });
    }
    return out;
  }

  /** Filled regions with ring geometry in pixels (for export / booleans). */
  regions(): Region[] {
    return unpackRegions(this.map.regions());
  }

  /** Filled faces as `Path2D` (even-odd), cached until the next mutation. */
  faces(): Face[] {
    const d = this.map.digest();
    if (this.facesCache && this.facesDigest === d) return this.facesCache;
    const data = this.map.contours();
    const faces: Face[] = [];
    let i = 0;
    while (i < data.length) {
      const fill = data[i++];
      const ringCount = data[i++];
      const path = new Path2D();
      for (let r = 0; r < ringCount; r++) {
        const segCount = data[i++];
        path.moveTo(data[i++], data[i++]);
        for (let s = 0; s < segCount; s++) {
          const tag = data[i++];
          const cx = data[i++];
          const cy = data[i++];
          const x = data[i++];
          const y = data[i++];
          if (tag === 1) path.quadraticCurveTo(cx, cy, x, y);
          else path.lineTo(x, y);
        }
        path.closePath();
      }
      faces.push({ fill, path });
    }
    this.facesCache = faces;
    this.facesDigest = d;
    return faces;
  }
}
