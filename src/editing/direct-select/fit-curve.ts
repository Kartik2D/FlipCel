/**
 * Cubic Bézier fitting of a polyline (Schneider, "An Algorithm for
 * Automatically Fitting Digitized Curves", Graphics Gems 1990).
 *
 * Returns G1-continuous cubics through the points, within `tolerance`.
 * End tangents may be pinned so a fitted run blends into its neighbours.
 */
import type { Px, Ring, Seg } from "../../vector/kernel";

export interface CubicSeg {
  kind: "C";
  c1: Px;
  c2: Px;
  to: Px;
}

const sub = (a: Px, b: Px): Px => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Px, b: Px): Px => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Px, s: number): Px => ({ x: a.x * s, y: a.y * s });
const dot = (a: Px, b: Px): number => a.x * b.x + a.y * b.y;
const len = (a: Px): number => Math.hypot(a.x, a.y);
const norm = (a: Px): Px => {
  const l = len(a);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
};

/** Drop consecutive duplicates. */
function dedupe(points: readonly Px[]): Px[] {
  const out: Px[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-9) out.push(p);
  }
  return out;
}

/**
 * Fit `points` with cubics within `tolerance` (max point-to-curve distance).
 * `startTangent` / `endTangent` (unit, pointing along the travel direction)
 * pin the end tangents; when omitted they come from the data.
 */
export function fitCubics(
  points: readonly Px[],
  tolerance: number,
  startTangent?: Px | null,
  endTangent?: Px | null,
): CubicSeg[] {
  const pts = dedupe(points);
  if (pts.length < 2) return [];
  const t0 = startTangent ? norm(startTangent) : norm(sub(pts[1], pts[0]));
  // Schneider's convention: the end tangent points backwards (into the curve).
  const t1 = endTangent ? norm(scale(endTangent, -1)) : norm(sub(pts[pts.length - 2], pts[pts.length - 1]));
  const out: CubicSeg[] = [];
  fitRange(pts, 0, pts.length - 1, t0, t1, tolerance, out, 0);
  return out;
}

function fitRange(pts: Px[], first: number, last: number, t0: Px, t1: Px, tol: number, out: CubicSeg[], depth: number): void {
  const n = last - first + 1;
  if (n === 2) {
    const d = len(sub(pts[last], pts[first])) / 3;
    out.push({ kind: "C", c1: add(pts[first], scale(t0, d)), c2: add(pts[last], scale(t1, d)), to: pts[last] });
    return;
  }
  let u = chordLengths(pts, first, last);
  let bez = generate(pts, first, last, u, t0, t1);
  let { err, split } = maxError(pts, first, last, bez, u);
  if (err < tol) {
    out.push(bez);
    return;
  }
  // Try a few Newton-Raphson reparameterisations before splitting.
  if (err < tol * tol && depth < 32) {
    for (let i = 0; i < 4; i++) {
      u = reparameterize(pts, first, u, bez);
      bez = generate(pts, first, last, u, t0, t1);
      ({ err, split } = maxError(pts, first, last, bez, u));
      if (err < tol) {
        out.push(bez);
        return;
      }
    }
  }
  if (depth > 60) {
    out.push(bez);
    return;
  }
  const centre = centreTangent(pts, split);
  fitRange(pts, first, split, t0, centre, tol, out, depth + 1);
  fitRange(pts, split, last, scale(centre, -1), t1, tol, out, depth + 1);
}

function chordLengths(pts: Px[], first: number, last: number): number[] {
  const u = [0];
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + len(sub(pts[i], pts[i - 1])));
  const total = u[u.length - 1] || 1;
  return u.map((v) => v / total);
}

function centreTangent(pts: Px[], i: number): Px {
  const a = sub(pts[i - 1], pts[i]);
  const b = sub(pts[i], pts[i + 1]);
  const v = norm({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  return len(v) > 0 ? v : norm(a);
}

const B0 = (t: number) => (1 - t) ** 3;
const B1 = (t: number) => 3 * t * (1 - t) ** 2;
const B2 = (t: number) => 3 * t * t * (1 - t);
const B3 = (t: number) => t ** 3;

/** Least-squares cubic with pinned end tangents (Schneider's GenerateBezier). */
function generate(pts: Px[], first: number, last: number, u: number[], t0: Px, t1: Px): CubicSeg {
  const p0 = pts[first];
  const p3 = pts[last];
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let i = 0; i <= last - first; i++) {
    const t = u[i];
    const a0 = scale(t0, B1(t));
    const a1 = scale(t1, B2(t));
    c00 += dot(a0, a0);
    c01 += dot(a0, a1);
    c11 += dot(a1, a1);
    const tmp = sub(pts[first + i], add(scale(p0, B0(t) + B1(t)), scale(p3, B2(t) + B3(t))));
    x0 += dot(a0, tmp);
    x1 += dot(a1, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let alphaL: number;
  let alphaR: number;
  if (Math.abs(det) > 1e-12) {
    alphaL = (x0 * c11 - x1 * c01) / det;
    alphaR = (c00 * x1 - c01 * x0) / det;
  } else {
    alphaL = alphaR = 0;
  }
  const segLen = len(sub(p3, p0));
  const eps = 1e-6 * segLen;
  if (alphaL < eps || alphaR < eps) {
    // Degenerate: fall back to Wu/Barsky heuristic.
    alphaL = alphaR = segLen / 3;
  }
  return { kind: "C", c1: add(p0, scale(t0, alphaL)), c2: add(p3, scale(t1, alphaR)), to: p3 };
}

function evalCubic(p0: Px, b: CubicSeg, t: number): Px {
  return add(add(scale(p0, B0(t)), scale(b.c1, B1(t))), add(scale(b.c2, B2(t)), scale(b.to, B3(t))));
}

function maxError(pts: Px[], first: number, last: number, bez: CubicSeg, u: number[]): { err: number; split: number } {
  const p0 = pts[first];
  let err = 0;
  let split = (first + last) >> 1;
  for (let i = first + 1; i < last; i++) {
    const d = sub(evalCubic(p0, bez, u[i - first]), pts[i]);
    const e = dot(d, d);
    if (e >= err) {
      err = e;
      split = i;
    }
  }
  return { err: Math.sqrt(err), split };
}

function reparameterize(pts: Px[], first: number, u: number[], bez: CubicSeg): number[] {
  const p0 = pts[first];
  // Derivative control polygons.
  const d1 = [scale(sub(bez.c1, p0), 3), scale(sub(bez.c2, bez.c1), 3), scale(sub(bez.to, bez.c2), 3)];
  const d2 = [scale(sub(d1[1], d1[0]), 2), scale(sub(d1[2], d1[1]), 2)];
  return u.map((t, i) => {
    const p = pts[first + i];
    const q = evalCubic(p0, bez, t);
    const q1 = add(add(scale(d1[0], (1 - t) ** 2), scale(d1[1], 2 * t * (1 - t))), scale(d1[2], t * t));
    const q2 = add(scale(d2[0], 1 - t), scale(d2[1], t));
    const diff = sub(q, p);
    const num = dot(diff, q1);
    const den = dot(q1, q1) + dot(diff, q2);
    if (Math.abs(den) < 1e-12) return t;
    return Math.min(1, Math.max(0, t - num / den));
  });
}

/** Sample a cubic uniformly in `t` (excluding the start point). */
export function sampleCubic(p0: Px, c: CubicSeg, steps: number): Px[] {
  const out: Px[] = [];
  for (let i = 1; i <= steps; i++) out.push(evalCubic(p0, c, i / steps));
  return out;
}

/** Sample a quadratic uniformly in `t` (excluding the start point). */
export function sampleQuad(p0: Px, c: Px, p2: Px, steps: number): Px[] {
  const out: Px[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    out.push({
      x: mt * mt * p0.x + 2 * mt * t * c.x + t * t * p2.x,
      y: mt * mt * p0.y + 2 * mt * t * c.y + t * t * p2.y,
    });
  }
  return out;
}

/**
 * Refit each closed ring with as few cubics as stay within `tol` (world px)
 * of its outline. `tol <= 0` returns the rings unchanged. A fit that does not
 * reduce the edge count is discarded, so the slider only ever simplifies.
 */
export function simplifyRings(rings: readonly Ring[], tol: number): Ring[] {
  if (!(tol > 0)) return rings.slice();
  return rings.map((ring) => simplifyRing(ring, tol));
}

function simplifyRing(ring: Ring, tol: number): Ring {
  if (ring.segs.length === 0) return ring;
  const pts = flattenSegs(ring.start, ring.segs);
  const first = pts[0];
  const last = pts[pts.length - 1];
  const gap = Math.hypot(last.x - first.x, last.y - first.y);
  if (gap > 1e-6) pts.push(first);
  else pts[pts.length - 1] = first;
  if (pts.length < 4) return ring;
  const prev = pts[pts.length - 2];
  const next = pts[1];
  const t = norm(sub(next, prev));
  if (len(t) === 0) return ring;
  const cubics = fitCubics(pts, tol, t, t);
  const edges = ring.segs.length + (gap > 1e-6 ? 1 : 0);
  if (cubics.length === 0 || cubics.length >= edges) return ring;
  return { start: first, segs: cubics };
}

/** Flatten a run of kernel segments starting at `start` into a polyline (includes `start`). */
export function flattenSegs(start: Px, segs: readonly Seg[], stepsPerCurve = 8): Px[] {
  const out: Px[] = [start];
  let cur = start;
  for (const s of segs) {
    if (s.kind === "L") out.push(s.to);
    else if (s.kind === "Q") out.push(...sampleQuad(cur, s.c, s.to, stepsPerCurve));
    else out.push(...sampleCubic(cur, s, stepsPerCurve));
    cur = s.to;
  }
  return out;
}
