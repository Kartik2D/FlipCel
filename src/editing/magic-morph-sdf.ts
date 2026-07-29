/**
 * SDF morph solver for Magic Morph.
 *
 * Supersampled raster → signed distance → downsample/smooth → lerp →
 * marching squares on the *smooth* field → Chaikin + simplify to vectors.
 *
 * The contour is a level-set of a blurred distance field, not a trace of
 * pixel edges.
 */
import paper from "paper";
import type { MorphOptions } from "./magic-morph-blend";

/** Working SDF resolution (after downsample). */
const GRID_MIN = 128;
const GRID_MAX = 256;
const BASE_GRID = 160;
/** Raster at this multiple of working grid, then average down into the SDF. */
const SUPER = 3;
/** Gaussian blur radius (in working-grid cells) applied to SDF before extract. */
const SDF_BLUR = 1.25;

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

function mixColor(
  a: paper.Color | null | undefined,
  b: paper.Color | null | undefined,
  t: number,
): paper.Color | null {
  if (!a && !b) return null;
  if (!a) return b!.clone();
  if (!b) return a.clone();
  const out = a.clone();
  out.red = a.red + (b.red - a.red) * t;
  out.green = a.green + (b.green - a.green) * t;
  out.blue = a.blue + (b.blue - a.blue) * t;
  out.alpha = a.alpha + (b.alpha - a.alpha) * t;
  return out;
}

function applyItemStyle(
  dest: paper.PathItem,
  a: paper.PathItem,
  b: paper.PathItem,
  t: number,
): void {
  dest.fillColor = mixColor(
    a.fillColor as paper.Color | null,
    b.fillColor as paper.Color | null,
    t,
  );
  dest.strokeColor = mixColor(
    a.strokeColor as paper.Color | null,
    b.strokeColor as paper.Color | null,
    t,
  );
  dest.strokeWidth =
    (a.strokeWidth ?? 0) + ((b.strokeWidth ?? 0) - (a.strokeWidth ?? 0)) * t;
}

// ---------------------------------------------------------------------------
// Eligibility / grid
// ---------------------------------------------------------------------------

function isClosedFillable(item: paper.PathItem): boolean {
  const hasFill = !!(item.fillColor && (item.fillColor as paper.Color).alpha > 0);
  if (!hasFill) return false;
  if (item instanceof paper.Path) return !!item.closed;
  if (item instanceof paper.CompoundPath) {
    if (item.children.length === 0) return false;
    return item.children.every(
      (c) => !(c instanceof paper.Path) || c.closed,
    );
  }
  return false;
}

function gridSize(density: number): number {
  const d = Math.max(1, Math.min(3, density));
  return Math.round(Math.min(GRID_MAX, Math.max(GRID_MIN, BASE_GRID * d)));
}

// ---------------------------------------------------------------------------
// Shared world domain
// ---------------------------------------------------------------------------

interface WorldFrame {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Working-grid cell size in world units. */
  cell: number;
  n: number;
}

function worldFrame(
  a: paper.PathItem,
  b: paper.PathItem,
  n: number,
): WorldFrame | null {
  const ba = a.bounds;
  const bb = b.bounds;
  if (ba.width < 1e-6 && ba.height < 1e-6) return null;
  if (bb.width < 1e-6 && bb.height < 1e-6) return null;

  let minX = Math.min(ba.left, bb.left);
  let minY = Math.min(ba.top, bb.top);
  let maxX = Math.max(ba.right, bb.right);
  let maxY = Math.max(ba.bottom, bb.bottom);
  const span = Math.max(maxX - minX, maxY - minY, 1e-3);
  const pad = span * 0.2 + 2;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  const w = maxX - minX;
  const h = maxY - minY;
  if (w > h) {
    const d = (w - h) / 2;
    minY -= d;
    maxY += d;
  } else if (h > w) {
    const d = (h - w) / 2;
    minX -= d;
    maxX += d;
  }
  const side = maxX - minX;
  return { minX, minY, maxX, maxY, cell: side / n, n };
}

// ---------------------------------------------------------------------------
// Supersampled AA raster → binary mask at high res
// ---------------------------------------------------------------------------

function rasterizeSuper(
  item: paper.PathItem,
  frame: WorldFrame,
): Uint8Array | null {
  const hi = frame.n * SUPER;
  const cell = frame.cell / SUPER;
  let pathData: string;
  try {
    pathData = item.pathData;
  } catch {
    return null;
  }
  if (!pathData) return null;

  const canvas = document.createElement("canvas");
  canvas.width = hi;
  canvas.height = hi;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  ctx.clearRect(0, 0, hi, hi);
  // AA coverage — we threshold after read, but AA still softens edges for
  // more stable inside/outside decisions under supersampling.
  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = "#fff";
  ctx.setTransform(
    1 / cell,
    0,
    0,
    1 / cell,
    -frame.minX / cell,
    -frame.minY / cell,
  );
  try {
    ctx.fill(new Path2D(pathData), "evenodd");
  } catch {
    return null;
  }

  const img = ctx.getImageData(0, 0, hi, hi);
  const mask = new Uint8Array(hi * hi);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    mask[i] = img.data[p + 3] > 127 ? 1 : 0;
  }
  return mask;
}

// ---------------------------------------------------------------------------
// Felzenszwalb–Huttenlocher squared EDT
// ---------------------------------------------------------------------------

const INF = 1e20;

function edt1d(f: Float64Array, n: number, d: Float64Array): void {
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s =
      (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dx = q - v[k];
    d[q] = dx * dx + f[v[k]];
  }
}

function squaredEdt(mask: Uint8Array, n: number): Float64Array {
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const grid = new Float64Array(n * n);

  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) f[y] = mask[y * n + x] ? 0 : INF;
    edt1d(f, n, d);
    for (let y = 0; y < n; y++) grid[y * n + x] = d[y];
  }

  const out = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) f[x] = grid[y * n + x];
    edt1d(f, n, d);
    for (let x = 0; x < n; x++) out[y * n + x] = d[x];
  }
  return out;
}

/** Signed distance in world units on a grid of size `n` with cell size `cell`. */
function signedDistance(
  mask: Uint8Array,
  n: number,
  cell: number,
): Float64Array {
  const inside = new Uint8Array(n * n);
  const outside = new Uint8Array(n * n);
  for (let i = 0; i < mask.length; i++) {
    inside[i] = mask[i] ? 1 : 0;
    outside[i] = mask[i] ? 0 : 1;
  }
  const dIn = squaredEdt(inside, n);
  const dOut = squaredEdt(outside, n);
  const sdf = new Float64Array(n * n);
  const cap = n * cell * 2;
  for (let i = 0; i < sdf.length; i++) {
    const out = Math.min(cap, Math.sqrt(Math.min(dOut[i], INF)) * cell);
    const inn = Math.min(cap, Math.sqrt(Math.min(dIn[i], INF)) * cell);
    sdf[i] = out - inn;
  }
  return sdf;
}

/**
 * Box-average a SUPER×SUPER high-res SDF down to working resolution.
 * This is what kills pixel stairsteps in the distance field.
 */
function downsampleSdf(hi: Float64Array, n: number): Float64Array {
  const out = new Float64Array(n * n);
  const hiN = n * SUPER;
  const inv = 1 / (SUPER * SUPER);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      const y0 = y * SUPER;
      const x0 = x * SUPER;
      for (let dy = 0; dy < SUPER; dy++) {
        const row = (y0 + dy) * hiN + x0;
        for (let dx = 0; dx < SUPER; dx++) sum += hi[row + dx];
      }
      out[y * n + x] = sum * inv;
    }
  }
  return out;
}

/** Separable Gaussian blur on an SDF grid (sigma in cells). */
function blurSdf(src: Float64Array, n: number, sigma: number): Float64Array {
  if (sigma < 0.15) return src;
  const radius = Math.max(1, Math.ceil(sigma * 2.5));
  const kernel = new Float64Array(radius * 2 + 1);
  let ksum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp((-0.5 * i * i) / (sigma * sigma));
    kernel[i + radius] = v;
    ksum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum;

  const tmp = new Float64Array(n * n);
  const out = new Float64Array(n * n);

  // Horizontal
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(n - 1, Math.max(0, x + k));
        s += src[y * n + xx] * kernel[k + radius];
      }
      tmp[y * n + x] = s;
    }
  }
  // Vertical
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(n - 1, Math.max(0, y + k));
        s += tmp[yy * n + x] * kernel[k + radius];
      }
      out[y * n + x] = s;
    }
  }
  return out;
}

function buildSdf(item: paper.PathItem, frame: WorldFrame): Float64Array | null {
  const mask = rasterizeSuper(item, frame);
  if (!mask) return null;
  const hiN = frame.n * SUPER;
  let filled = 0;
  for (let i = 0; i < mask.length; i++) filled += mask[i];
  if (filled < 4 * SUPER * SUPER) return null;

  const hiCell = frame.cell / SUPER;
  const hiSdf = signedDistance(mask, hiN, hiCell);
  const lo = downsampleSdf(hiSdf, frame.n);
  return blurSdf(lo, frame.n, SDF_BLUR);
}

function lerpSdf(a: Float64Array, b: Float64Array, t: number): Float64Array {
  const out = new Float64Array(a.length);
  const u = 1 - t;
  for (let i = 0; i < a.length; i++) out[i] = u * a[i] + t * b[i];
  return out;
}

// ---------------------------------------------------------------------------
// Marching squares on sample centers → world loops
// ---------------------------------------------------------------------------

type Pt = { x: number; y: number };

const MS_EDGES: Array<Array<[number, number]>> = [
  [],
  [[3, 0]],
  [[0, 1]],
  [[3, 1]],
  [[1, 2]],
  [
    [3, 0],
    [1, 2],
  ],
  [[0, 2]],
  [[3, 2]],
  [[2, 3]],
  [[0, 2]],
  [
    [0, 1],
    [2, 3],
  ],
  [[1, 2]],
  [[1, 3]],
  [[0, 1]],
  [[3, 0]],
  [],
];

function edgePoint(
  edge: number,
  x: number,
  y: number,
  v00: number,
  v10: number,
  v11: number,
  v01: number,
): Pt {
  const lerp = (a: number, b: number, va: number, vb: number): number => {
    const d = vb - va;
    if (Math.abs(d) < 1e-12) return (a + b) * 0.5;
    return a + ((0 - va) / d) * (b - a);
  };
  const x0 = x + 0.5;
  const y0 = y + 0.5;
  switch (edge) {
    case 0:
      return { x: lerp(x0, x0 + 1, v00, v10), y: y0 };
    case 1:
      return { x: x0 + 1, y: lerp(y0, y0 + 1, v10, v11) };
    case 2:
      return { x: lerp(x0, x0 + 1, v01, v11), y: y0 + 1 };
    default:
      return { x: x0, y: lerp(y0, y0 + 1, v00, v01) };
  }
}

function keyOf(p: Pt): string {
  return `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
}

function marchingSquares(sdf: Float64Array, frame: WorldFrame): Pt[][] {
  const { n, minX, minY, cell } = frame;
  const points = new Map<string, Pt>();
  const adj = new Map<string, string[]>();
  const canon = (p: Pt): string => {
    const k = keyOf(p);
    if (!points.has(k)) points.set(k, p);
    return k;
  };
  const addEdge = (a: Pt, b: Pt) => {
    const ka = canon(a);
    const kb = canon(b);
    if (ka === kb) return;
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka)!.push(kb);
    adj.get(kb)!.push(ka);
  };

  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const v00 = sdf[y * n + x];
      const v10 = sdf[y * n + x + 1];
      const v11 = sdf[(y + 1) * n + x + 1];
      const v01 = sdf[(y + 1) * n + x];
      let code = 0;
      if (v00 < 0) code |= 1;
      if (v10 < 0) code |= 2;
      if (v11 < 0) code |= 4;
      if (v01 < 0) code |= 8;
      for (const [e0, e1] of MS_EDGES[code]) {
        addEdge(
          edgePoint(e0, x, y, v00, v10, v11, v01),
          edgePoint(e1, x, y, v00, v10, v11, v01),
        );
      }
    }
  }

  const used = new Set<string>();
  const loops: Pt[][] = [];
  const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  for (const startKey of adj.keys()) {
    const startNeighbors = adj.get(startKey);
    if (!startNeighbors) continue;
    for (const firstKey of startNeighbors) {
      const ek0 = edgeKey(startKey, firstKey);
      if (used.has(ek0)) continue;

      const loopKeys: string[] = [startKey];
      let prevKey = startKey;
      let curKey = firstKey;
      used.add(ek0);
      let guard = 0;
      while (guard++ < n * n * 4) {
        loopKeys.push(curKey);
        if (curKey === startKey && loopKeys.length > 2) break;
        const neighbors = adj.get(curKey) ?? [];
        let nextKey: string | null = null;
        for (const cand of neighbors) {
          const ek = edgeKey(curKey, cand);
          if (used.has(ek)) continue;
          if (cand === prevKey && neighbors.length > 1) continue;
          nextKey = cand;
          used.add(ek);
          break;
        }
        if (!nextKey) break;
        prevKey = curKey;
        curKey = nextKey;
      }
      if (loopKeys.length >= 4 && loopKeys[loopKeys.length - 1] === startKey) {
        const world: Pt[] = [];
        for (let i = 0; i < loopKeys.length - 1; i++) {
          const p = points.get(loopKeys[i])!;
          world.push({
            x: minX + p.x * cell,
            y: minY + p.y * cell,
          });
        }
        // Keep denser samples — Chaikin + simplify will reshape them.
        const cleaned: Pt[] = [world[0]];
        const minDist = cell * 0.15;
        for (let i = 1; i < world.length; i++) {
          const p = world[i];
          const q = cleaned[cleaned.length - 1];
          if (Math.hypot(p.x - q.x, p.y - q.y) > minDist) cleaned.push(p);
        }
        if (cleaned.length >= 3) loops.push(cleaned);
      }
    }
  }

  return loops;
}

/** Two Chaikin passes — rounds polylines before bezier fit. */
function chaikin(loop: Pt[], passes = 2): Pt[] {
  let pts = loop;
  for (let p = 0; p < passes; p++) {
    const next: Pt[] = [];
    const m = pts.length;
    for (let i = 0; i < m; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % m];
      next.push({
        x: a.x * 0.75 + b.x * 0.25,
        y: a.y * 0.75 + b.y * 0.25,
      });
      next.push({
        x: a.x * 0.25 + b.x * 0.75,
        y: a.y * 0.25 + b.y * 0.75,
      });
    }
    pts = next;
  }
  return pts;
}

function loopsToPaths(
  loops: Pt[][],
  simplify: number,
  cell: number,
): paper.Path[] {
  // Fit tolerance in world units: always at least ~1.5 cells so residual
  // grid wiggles become smooth beziers; slider adds more.
  const tol = Math.max(cell * 1.5, simplify > 0 ? simplify : cell * 1.5);
  const paths: paper.Path[] = [];
  for (const loop of loops) {
    const smooth = chaikin(loop, 2);
    const path = new paper.Path({ insert: false });
    path.closed = true;
    for (const p of smooth) path.add(new paper.Point(p.x, p.y));
    path.closePath();
    try {
      path.simplify(tol);
    } catch {
      // keep chaikin polyline
    }
    path.fillColor = null;
    path.strokeColor = null;
    path.strokeWidth = 0;
    if (path.segments.length >= 3) paths.push(path);
  }
  paths.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
  return paths;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * SDF-blend two filled closed PathItems. Returns null when the pair cannot
 * be handled (open / stroke-only / raster failure) so the caller can fall
 * back to the vector solver.
 */
export function morphItemSdf(
  a: paper.PathItem,
  b: paper.PathItem,
  t: number,
  opts: MorphOptions,
): paper.PathItem | null {
  if (!isClosedFillable(a) || !isClosedFillable(b)) return null;

  const n = gridSize(opts.density);
  const frame = worldFrame(a, b, n);
  if (!frame) return null;

  const sdfA = buildSdf(a, frame);
  const sdfB = buildSdf(b, frame);
  if (!sdfA || !sdfB) return null;

  const sdf = blurSdf(lerpSdf(sdfA, sdfB, t), n, SDF_BLUR * 0.5);
  const loops = marchingSquares(sdf, frame);
  if (loops.length === 0) return null;

  const paths = loopsToPaths(loops, opts.simplify, frame.cell);
  if (paths.length === 0) return null;

  if (paths.length === 1) {
    applyItemStyle(paths[0], a, b, t);
    return paths[0];
  }

  const compound = new paper.CompoundPath({ children: paths });
  compound.fillRule = "evenodd";
  applyItemStyle(compound, a, b, t);
  return compound;
}
