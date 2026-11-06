/**
 * Curvature-aware outline simplify.
 *
 * Densely sampled polylines are fit with cubic Béziers (Schneider least
 * squares, tangents fixed at the ends, Newton reparameterization). Splits
 * land on inflections and curvature extrema, and sharp corners detected on
 * the dense outline stay zero-handle breaks. Handle length is capped so a
 * fit can't loop back on itself.
 */

export type Vec = { x: number; y: number };

export type CubicSpan = {
  p0: Vec;
  /** Relative to p0 (paper handleOut). */
  handleOut: Vec;
  /** Relative to p3 (paper handleIn). */
  handleIn: Vec;
  p3: Vec;
};

export type FittedAnchor = {
  x: number;
  y: number;
  handleIn: Vec;
  handleOut: Vec;
};

export type FitOptions = {
  /** Max distance from the polyline to the fitted curves, in world units. */
  tolerance: number;
  closed: boolean;
  /** Turn, in degrees, that becomes a sharp corner. Default 35. */
  cornerAngleDeg?: number;
  /** Corner indices into `points`. Omit to detect them. */
  corners?: number[];
  /** Unit-ish tangent at the first point, pointing into the curve. Open paths only. */
  tangentStart?: Vec | null;
  /** Tangent at the last point, pointing back into the curve. Open paths only. */
  tangentEnd?: Vec | null;
  sharpStart?: boolean;
  sharpEnd?: boolean;
};

const HANDLE_RATIO = 0.45;
const CORNER_DEG = 35;

export function simplifyPolyline(points: Vec[], opts: FitOptions): FittedAnchor[] {
  return cubicsToAnchors(simplifyCubics(points, opts), opts.closed);
}

/** Resample, keep corners, fit. Returns one cubic per output segment. */
export function simplifyCubics(points: Vec[], opts: FitOptions): CubicSpan[] {
  if (points.length < 2) return [];
  const closed = opts.closed;
  let src = points;
  if (closed && dist(src[0], src[src.length - 1]) <= 1e-6) src = src.slice(0, -1);
  if (src.length < 2) return [];

  const spacing = Math.max(0.75, Math.min(2, Math.max(opts.tolerance, 0.05) * 0.5));
  const angle = opts.cornerAngleDeg ?? CORNER_DEG;
  const seed = [...findSharpCornerIndicesFromPoints(src, closed, angle)];
  const samples = resamplePolyline(src, spacing, closed, seed);
  if (samples.length < 2) return [];

  // Corner indices referred to the pre-resample polyline. Detect again on samples.
  const cubics = fitCubics(samples, { ...opts, closed, corners: undefined });
  if (!closed && cubics.length === 0) {
    return [lineSpan(samples[0], samples[samples.length - 1])];
  }
  return cubics;
}

export function fitOutline(points: Vec[], opts: FitOptions): FittedAnchor[] {
  return cubicsToAnchors(fitCubics(points, opts), opts.closed);
}

export function fitCubics(points: Vec[], opts: FitOptions): CubicSpan[] {
  const closed = opts.closed;
  let pts = points;
  if (closed && pts.length > 1 && dist(pts[0], pts[pts.length - 1]) <= 1e-6) {
    pts = pts.slice(0, -1);
  }
  if (pts.length < 2) return [];

  const tol = Math.max(1e-4, opts.tolerance);
  const angle = opts.cornerAngleDeg ?? CORNER_DEG;

  if (!closed) {
    const corners = opts.corners ?? [...findSharpCornerIndicesFromPoints(pts, false, angle)];
    return fitOpen(pts, corners, tol, opts);
  }

  const corners = opts.corners ?? [...findSharpCornerIndicesFromPoints(pts, true, angle)];
  const cuts = uniqueSorted(corners, pts.length);
  if (cuts.length === 0) {
    return fitClosedRing(
      pts,
      tol,
      opts.tangentStart ?? null,
      opts.tangentEnd ?? null,
      !!opts.sharpStart,
      !!opts.sharpEnd,
      0,
    );
  }

  const cubics: CubicSpan[] = [];
  for (let s = 0; s < cuts.length; s++) {
    const span = sliceRing(pts, cuts[s], cuts[(s + 1) % cuts.length]);
    cubics.push(...fitSpan(span, tol, null, null, true, true, 0));
  }
  return cubics;
}

export function cubicsToAnchors(cubics: CubicSpan[], closed: boolean): FittedAnchor[] {
  if (cubics.length === 0) return [];
  const anchors: FittedAnchor[] = [];
  for (let i = 0; i < cubics.length; i++) {
    const c = cubics[i];
    if (i === 0) {
      anchors.push({
        x: c.p0.x,
        y: c.p0.y,
        handleIn: zero(),
        handleOut: { ...c.handleOut },
      });
    }
    anchors.push({
      x: c.p3.x,
      y: c.p3.y,
      handleIn: { ...c.handleIn },
      handleOut: zero(),
    });
  }
  for (let i = 0; i < cubics.length; i++) {
    anchors[i].handleOut = { ...cubics[i].handleOut };
  }
  if (closed) {
    const last = anchors.pop();
    if (last && anchors.length > 0) anchors[0].handleIn = last.handleIn;
  }
  return anchors;
}

/**
 * Even arc-length samples. `keepIndices` (corners) are preserved so a corner
 * isn't chamfered off by the spacing grid.
 */
export function resamplePolyline(
  points: Vec[],
  spacing: number,
  closed: boolean,
  keepIndices: number[] = [],
): Vec[] {
  const n = points.length;
  if (n === 0) return [];
  if (n === 1 || spacing <= 1e-6) return points.map((p) => ({ ...p }));

  const segCount = closed ? n : n - 1;
  const cum: number[] = [0];
  for (let i = 0; i < segCount; i++) {
    cum.push(cum[i] + dist(points[i], points[(i + 1) % n]));
  }
  const total = cum[segCount];
  if (total < 1e-9) return [{ ...points[0] }];

  const marks: number[] = [0];
  const keep = new Set<number>([0]);
  for (const idx of keepIndices) {
    if (idx <= 0 || idx >= n) continue;
    if (!closed && idx === n - 1) continue;
    marks.push(cum[idx]);
    keep.add(cum[idx]);
  }
  for (let d = spacing; d < total - spacing * 0.25; d += spacing) marks.push(d);
  if (!closed) {
    marks.push(total);
    keep.add(total);
  }
  marks.sort((a, b) => a - b);

  const minSep = spacing * 0.3;
  const filtered: number[] = [];
  for (const d of marks) {
    if (filtered.length === 0) {
      filtered.push(d);
      continue;
    }
    const prev = filtered[filtered.length - 1];
    if (d - prev < minSep) {
      if (keep.has(d) && !keep.has(prev)) filtered[filtered.length - 1] = d;
      continue;
    }
    filtered.push(d);
  }

  const out = filtered.map((d) => pointAtDistance(points, cum, d, closed));
  out[0] = { ...points[0] };
  if (!closed) out[out.length - 1] = { ...points[n - 1] };
  if (closed && out.length > 1 && dist(out[out.length - 1], out[0]) < minSep) {
    out.pop();
  }
  return out;
}

/**
 * Sharp corners on a dense outline. Adjacent turn catches clean polygons;
 * a distance window catches hand-drawn corners smeared across many verts.
 * Local maxima so a dense bend yields one apex.
 */
export function findSharpCornerIndicesFromPoints(
  points: Vec[],
  closed: boolean,
  minTurnDeg: number,
): Set<number> {
  const n = points.length;
  const corners = new Set<number>();
  if (n < 3) return corners;

  let perimeter = 0;
  for (let i = 1; i < n; i++) perimeter += dist(points[i], points[i - 1]);
  if (closed) perimeter += dist(points[0], points[n - 1]);
  if (perimeter < 1e-9) return corners;

  const avgEdge = perimeter / n;
  const windowDist = Math.min(
    Math.max(perimeter * 0.02, avgEdge * 2),
    perimeter * 0.08,
  );

  const turns = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) continue;
    const adjacent = turnDegreesAt(
      points[(i - 1 + n) % n],
      points[i],
      points[(i + 1) % n],
    );
    const prev = points[vertexAtArcWalk(points, closed, i, -windowDist)];
    const next = points[vertexAtArcWalk(points, closed, i, windowDist)];
    turns[i] = Math.max(adjacent, turnDegreesAt(prev, points[i], next));
  }

  const neighborDist = Math.max(windowDist * 0.5, avgEdge);
  for (let i = 0; i < n; i++) {
    if (turns[i] < minTurnDeg) continue;
    let isMax = true;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      if (arcSeparation(points, closed, i, j) > neighborDist) continue;
      if (turns[j] > turns[i] + 1e-6) {
        isMax = false;
        break;
      }
    }
    if (isMax) corners.add(i);
  }
  return corners;
}

/** Absolute turn at `curr`, in degrees. 0 is straight, 180 is a reversal. */
export function turnDegreesAt(prev: Vec, curr: Vec, next: Vec): number {
  const ax = curr.x - prev.x;
  const ay = curr.y - prev.y;
  const bx = next.x - curr.x;
  const by = next.y - curr.y;
  const al = Math.hypot(ax, ay);
  const bl = Math.hypot(bx, by);
  if (al < 1e-9 || bl < 1e-9) return 0;
  const dot = (ax / al) * (bx / bl) + (ay / al) * (by / bl);
  const cross = (ax / al) * (by / bl) - (ay / al) * (bx / bl);
  return Math.abs(Math.atan2(cross, dot) * (180 / Math.PI));
}

function fitOpen(pts: Vec[], interiorCorners: number[], tol: number, opts: FitOptions): CubicSpan[] {
  const cuts = uniqueSorted([0, ...interiorCorners, pts.length - 1], pts.length);
  const cubics: CubicSpan[] = [];
  for (let s = 0; s < cuts.length - 1; s++) {
    const i0 = cuts[s];
    const i1 = cuts[s + 1];
    if (i1 <= i0) continue;
    const atHead = i0 === 0;
    const atTail = i1 === pts.length - 1;
    cubics.push(
      ...fitSpan(
        pts.slice(i0, i1 + 1),
        tol,
        atHead ? (opts.tangentStart ?? null) : null,
        atTail ? (opts.tangentEnd ?? null) : null,
        atHead ? !!opts.sharpStart : true,
        atTail ? !!opts.sharpEnd : true,
        0,
      ),
    );
  }
  return cubics;
}

function fitClosedRing(
  ring: Vec[],
  tol: number,
  tStart: Vec | null,
  tEnd: Vec | null,
  sharpStart: boolean,
  sharpEnd: boolean,
  depth: number,
): CubicSpan[] {
  const n = ring.length;
  if (n < 4) return [];
  let far = Math.floor(n / 2);
  let bestD = -1;
  const lo = Math.max(2, Math.floor(n * 0.2));
  const hi = Math.min(n - 3, Math.ceil(n * 0.8));
  for (let i = lo; i <= hi; i++) {
    const d = dist(ring[i], ring[0]);
    if (d > bestD) {
      bestD = d;
      far = i;
    }
  }
  if (bestD < 1e-4) return [];

  const travel0 = sharpStart ? null : (unit(tStart) ?? estimateForwardTangent(ring, 0, true));
  const back0 = sharpEnd ? null : (unit(tEnd) ?? (travel0 ? neg(travel0) : null));
  const travelFar = estimateForwardTangent(ring, far, true);

  const left: Vec[] = [];
  for (let i = 0; i <= far; i++) left.push(ring[i]);
  const right: Vec[] = [];
  for (let i = far; i < n; i++) right.push(ring[i]);
  right.push(ring[0]);

  return [
    ...fitSpan(left, tol, travel0, neg(travelFar), sharpStart, false, depth + 1),
    ...fitSpan(right, tol, travelFar, back0, false, sharpEnd, depth + 1),
  ];
}

function fitSpan(
  raw: Vec[],
  tol: number,
  tStart: Vec | null,
  tEnd: Vec | null,
  sharpStart: boolean,
  sharpEnd: boolean,
  depth: number,
): CubicSpan[] {
  if (raw.length >= 4 && dist(raw[0], raw[raw.length - 1]) <= 1e-4) {
    const ring = compress(raw.slice(0, -1));
    if (ring.length >= 4) {
      return fitClosedRing(ring, tol, tStart, tEnd, sharpStart, sharpEnd, depth);
    }
  }

  const pts = compress(raw);
  if (pts.length < 2) return [];
  const p0 = pts[0];
  const p3 = pts[pts.length - 1];
  if (pts.length < 3 || dist(p0, p3) < 1e-6) return [lineSpan(p0, p3)];

  const chord = maxChordError(pts);
  const locked = (!sharpStart && tStart != null) || (!sharpEnd && tEnd != null);

  if (sharpStart && sharpEnd && (chord.error <= tol || pts.length < 6 || depth >= 12)) {
    return [lineSpan(p0, p3)];
  }
  if (!locked && !sharpStart && !sharpEnd && chord.error <= tol) {
    return [lineSpan(p0, p3)];
  }
  // A sharp end has a zero handle. If the other end isn't asking for a
  // curve either, a within-tolerance chord is the whole span.
  if ((sharpStart || sharpEnd) && !locked && chord.error <= tol) {
    return [lineSpan(p0, p3)];
  }

  const t1 = sharpStart ? null : (unit(tStart) ?? estimateStartTangent(pts));
  const t2 = sharpEnd ? null : (unit(tEnd) ?? estimateEndTangent(pts));

  let u = chordParams(pts);
  let best: { span: CubicSpan; error: number; worst: number } | null = null;
  for (let iter = 0; iter < 4; iter++) {
    const attempt = tryCubic(pts, u, t1, t2);
    if (!attempt) break;
    if (!best || attempt.error < best.error) best = attempt;
    if (attempt.error <= tol) return [attempt.span];
    if (best && attempt !== best && attempt.error > best.error * 1.02) break;
    const next = reparameterize(pts, u, attempt.span);
    if (!next) break;
    u = next;
  }

  if (best && best.error <= tol) return [best.span];
  if (chord.error <= tol) return [lineSpan(p0, p3)];

  // ponytail: depth cap accepts the closer of the cubic and the chord even
  // when both miss tolerance. Upgrade path: emit the leftover polyline.
  if (pts.length < 6 || depth >= 12) {
    if (best && best.error <= chord.error) return [best.span];
    return [lineSpan(p0, p3)];
  }

  const worst = best?.worst ?? chord.index;
  const split = chooseSplit(pts, worst);
  if (split <= 0 || split >= pts.length - 1) {
    if (best && best.error <= chord.error) return [best.span];
    return [lineSpan(p0, p3)];
  }

  const travel = estimateTravelTangent(pts, split);
  return [
    ...fitSpan(pts.slice(0, split + 1), tol, t1, neg(travel), sharpStart, false, depth + 1),
    ...fitSpan(pts.slice(split), tol, travel, t2, false, sharpEnd, depth + 1),
  ];
}

function tryCubic(
  pts: Vec[],
  u: number[],
  t1: Vec | null,
  t2: Vec | null,
): { span: CubicSpan; error: number; worst: number } | null {
  let solved = solveAlphas(pts, u, t1, t2);
  if (!solved || solved.a1 < -1e-4 || solved.a2 < -1e-4) solved = heuristicAlphas(pts, t1, t2);
  if (!solved || solved.a1 < -1e-4 || solved.a2 < -1e-4) return null;

  const p0 = pts[0];
  const p3 = pts[pts.length - 1];
  const chordLen = dist(p0, p3);
  const maxH = HANDLE_RATIO * chordLen;
  let a1 = Math.max(0, solved.a1);
  let a2 = Math.max(0, solved.a2);
  if (a1 > maxH) a1 = maxH;
  if (a2 > maxH) a2 = maxH;
  if (!t1) a1 = 0;
  if (!t2) a2 = 0;

  const span: CubicSpan = {
    p0,
    handleOut: t1 ? scale(t1, a1) : zero(),
    handleIn: t2 ? scale(t2, a2) : zero(),
    p3,
  };
  if (cubicLoops(span)) return null;
  const err = measureError(pts, span, u);
  return { span, error: err.error, worst: err.index };
}

/** Least squares for handle lengths with end tangents held fixed. */
function solveAlphas(
  pts: Vec[],
  u: number[],
  t1: Vec | null,
  t2: Vec | null,
): { a1: number; a2: number } | null {
  if (!t1 && !t2) return { a1: 0, a2: 0 };
  const p0 = pts[0];
  const p3 = pts[pts.length - 1];
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const ui = u[i];
    const b0 = bernstein0(ui);
    const b1 = bernstein1(ui);
    const b2 = bernstein2(ui);
    const b3 = bernstein3(ui);
    const cx = pts[i].x - (p0.x * (b0 + b1) + p3.x * (b2 + b3));
    const cy = pts[i].y - (p0.y * (b0 + b1) + p3.y * (b2 + b3));
    const a1x = t1 ? t1.x * b1 : 0;
    const a1y = t1 ? t1.y * b1 : 0;
    const a2x = t2 ? t2.x * b2 : 0;
    const a2y = t2 ? t2.y * b2 : 0;
    c00 += a1x * a1x + a1y * a1y;
    c01 += a1x * a2x + a1y * a2y;
    c11 += a2x * a2x + a2y * a2y;
    x0 += a1x * cx + a1y * cy;
    x1 += a2x * cx + a2y * cy;
  }

  if (t1 && t2) {
    const det = c00 * c11 - c01 * c01;
    if (Math.abs(det) < 1e-9) return null;
    return {
      a1: (x0 * c11 - x1 * c01) / det,
      a2: (c00 * x1 - c01 * x0) / det,
    };
  }
  if (t1) {
    if (c00 < 1e-9) return null;
    return { a1: x0 / c00, a2: 0 };
  }
  if (c11 < 1e-9) return null;
  return { a1: 0, a2: x1 / c11 };
}

function heuristicAlphas(
  pts: Vec[],
  t1: Vec | null,
  t2: Vec | null,
): { a1: number; a2: number } | null {
  const chord = sub(pts[pts.length - 1], pts[0]);
  const chordLen = Math.hypot(chord.x, chord.y);
  if (chordLen < 1e-6) return null;
  const a = chordLen / 3;
  let a1 = 0;
  let a2 = 0;
  if (t1) {
    if (dot(t1, chord) <= 0) return null;
    a1 = a;
  }
  if (t2) {
    if (dot(t2, chord) >= 0) return null;
    a2 = a;
  }
  return { a1, a2 };
}

function reparameterize(pts: Vec[], u: number[], span: CubicSpan): number[] | null {
  const p1 = add(span.p0, span.handleOut);
  const p2 = add(span.p3, span.handleIn);
  const next = u.slice();
  for (let i = 1; i < pts.length - 1; i++) {
    const t = u[i];
    const bt = cubicAt(span.p0, p1, p2, span.p3, t);
    const d1 = cubicDeriv(span.p0, p1, p2, span.p3, t);
    const d2 = cubicDeriv2(span.p0, p1, p2, span.p3, t);
    const dx = bt.x - pts[i].x;
    const dy = bt.y - pts[i].y;
    const num = dx * d1.x + dy * d1.y;
    const den = d1.x * d1.x + d1.y * d1.y + dx * d2.x + dy * d2.y;
    if (Math.abs(den) < 1e-9) continue;
    next[i] = Math.max(0, Math.min(1, t - num / den));
  }
  next[0] = 0;
  next[next.length - 1] = 1;
  for (let i = 1; i < next.length; i++) {
    if (!(next[i] > next[i - 1] + 1e-9)) return null;
  }
  return next;
}

function measureError(
  pts: Vec[],
  span: CubicSpan,
  u: number[],
): { error: number; index: number } {
  const p1 = add(span.p0, span.handleOut);
  const p2 = add(span.p3, span.handleIn);
  let error = 0;
  let index = Math.max(1, Math.floor((pts.length - 1) / 2));
  for (let i = 1; i < pts.length - 1; i++) {
    const d = dist(cubicAt(span.p0, p1, p2, span.p3, u[i]), pts[i]);
    if (d > error) {
      error = d;
      index = i;
    }
  }
  const steps = 8;
  for (let s = 1; s < steps; s++) {
    const b = cubicAt(span.p0, p1, p2, span.p3, s / steps);
    let best = Infinity;
    let bestI = index;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = pointToSegment(b, pts[i], pts[i + 1]);
      if (d < best) {
        best = d;
        bestI = i;
      }
    }
    if (best > error) {
      error = best;
      index = Math.max(1, Math.min(pts.length - 2, bestI));
    }
  }
  return { error, index };
}

function maxChordError(pts: Vec[]): { error: number; index: number } {
  const a = pts[0];
  const b = pts[pts.length - 1];
  let error = 0;
  let index = Math.max(1, Math.floor((pts.length - 1) / 2));
  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointToSegment(pts[i], a, b);
    if (d > error) {
      error = d;
      index = i;
    }
  }
  return { error, index };
}

/**
 * Inflection nearest the worst sample, else a curvature extremum near it,
 * else the worst sample itself.
 */
function chooseSplit(pts: Vec[], worst: number): number {
  const n = pts.length;
  const margin = Math.max(2, Math.min(Math.floor(n * 0.08), Math.floor((n - 1) / 3)));
  const lo = margin;
  const hi = n - 1 - margin;
  const fallback = Math.max(1, Math.min(n - 2, Math.max(lo, Math.min(hi <= lo ? n - 2 : hi, worst))));
  if (n < 8 || hi <= lo) return fallback;

  const k = curvatureProfile(pts);
  let maxAbs = 0;
  for (let i = 0; i < n; i++) maxAbs = Math.max(maxAbs, Math.abs(k[i]));
  if (!(maxAbs > 1e-8)) return fallback;
  const floor = maxAbs * 0.18;

  const inflections: number[] = [];
  const extrema: number[] = [];
  for (let i = lo; i <= hi; i++) {
    const prev = k[i - 1];
    const curr = k[i];
    const next = k[Math.min(n - 1, i + 1)];
    // The sample on the crossing is near zero, so look outward until
    // curvature is actually significant. That keeps a real inflection and
    // drops a wiggle that never amounts to anything.
    if (prev * curr < 0) {
      let left = i - 1;
      while (left > 0 && Math.abs(k[left]) < floor) left--;
      let right = i;
      while (right < n - 1 && Math.abs(k[right]) < floor) right++;
      if (Math.abs(k[left]) >= floor && Math.abs(k[right]) >= floor && k[left] * k[right] < 0) {
        inflections.push(i);
      }
    }
    if (
      Math.abs(curr) > floor &&
      Math.abs(curr) >= Math.abs(prev) &&
      Math.abs(curr) >= Math.abs(next) &&
      (Math.abs(curr) > Math.abs(prev) || Math.abs(curr) > Math.abs(next))
    ) {
      extrema.push(i);
    }
  }

  const nearest = (xs: number[], maxDist: number): number => {
    let best = -1;
    let bestD = Infinity;
    for (const i of xs) {
      const d = Math.abs(i - worst);
      if (d <= maxDist && d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  const infl = nearest(inflections, Math.floor(n * 0.45));
  if (infl >= 0) return infl;
  const ext = nearest(extrema, Math.floor(n * 0.35));
  if (ext >= 0) return ext;
  return fallback;
}

function curvatureProfile(pts: Vec[]): Float64Array {
  const n = pts.length;
  const k = new Float64Array(n);
  const w = n >= 30 ? 3 : 2;
  if (n < w * 2 + 1) return k;
  for (let i = w; i < n - w; i++) k[i] = menger(pts[i - w], pts[i], pts[i + w]);
  for (let i = 0; i < w; i++) {
    k[i] = k[w];
    k[n - 1 - i] = k[n - 1 - w];
  }
  const smooth = new Float64Array(n);
  for (let pass = 0; pass < 2; pass++) {
    smooth[0] = k[0];
    smooth[n - 1] = k[n - 1];
    for (let i = 1; i < n - 1; i++) smooth[i] = (k[i - 1] + 2 * k[i] + k[i + 1]) * 0.25;
    k.set(smooth);
  }
  return k;
}

/** Signed Menger curvature (circumcircle). */
function menger(a: Vec, b: Vec, c: Vec): number {
  const ab = dist(a, b);
  const bc = dist(b, c);
  const ca = dist(c, a);
  const den = ab * bc * ca;
  if (den < 1e-12) return 0;
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return (2 * cross) / den;
}

function cubicLoops(span: CubicSpan): boolean {
  const p0 = span.p0;
  const p1 = add(p0, span.handleOut);
  const p3 = span.p3;
  const p2 = add(p3, span.handleIn);
  if (segmentsProperlyIntersect(p0, p1, p2, p3)) return true;
  const samples: Vec[] = [];
  for (let i = 0; i <= 12; i++) samples.push(cubicAt(p0, p1, p2, p3, i / 12));
  for (let i = 0; i < samples.length - 1; i++) {
    for (let j = i + 2; j < samples.length - 1; j++) {
      if (segmentsProperlyIntersect(samples[i], samples[i + 1], samples[j], samples[j + 1])) {
        return true;
      }
    }
  }
  return false;
}

function segmentsProperlyIntersect(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const c1 = abx * (c.y - a.y) - aby * (c.x - a.x);
  const c2 = abx * (d.y - a.y) - aby * (d.x - a.x);
  const cdx = d.x - c.x;
  const cdy = d.y - c.y;
  const c3 = cdx * (a.y - c.y) - cdy * (a.x - c.x);
  const c4 = cdx * (b.y - c.y) - cdy * (b.x - c.x);
  return c1 * c2 < 0 && c3 * c4 < 0;
}

function chordParams(pts: Vec[]): number[] {
  const u = new Array<number>(pts.length);
  u[0] = 0;
  let total = 0;
  const step = new Array<number>(pts.length).fill(0);
  for (let i = 1; i < pts.length; i++) {
    step[i] = dist(pts[i], pts[i - 1]);
    total += step[i];
  }
  if (total < 1e-9) {
    for (let i = 0; i < pts.length; i++) u[i] = i / (pts.length - 1);
    return u;
  }
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += step[i];
    u[i] = acc / total;
  }
  u[pts.length - 1] = 1;
  return u;
}

function estimateStartTangent(pts: Vec[]): Vec {
  const n = Math.min(pts.length - 1, 4);
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    const w = n - i;
    x += (pts[i + 1].x - pts[i].x) * w;
    y += (pts[i + 1].y - pts[i].y) * w;
  }
  return unit({ x, y }) ?? { x: 1, y: 0 };
}

function estimateEndTangent(pts: Vec[]): Vec {
  const n = pts.length;
  const k = Math.min(n - 1, 4);
  let x = 0;
  let y = 0;
  for (let i = 0; i < k; i++) {
    const w = k - i;
    const i1 = n - 1 - i;
    const i0 = n - 2 - i;
    x += (pts[i0].x - pts[i1].x) * w;
    y += (pts[i0].y - pts[i1].y) * w;
  }
  return unit({ x, y }) ?? { x: -1, y: 0 };
}

function estimateTravelTangent(pts: Vec[], index: number): Vec {
  const reach = Math.max(1, Math.min(3, Math.floor(pts.length / 10)));
  const i0 = Math.max(0, index - reach);
  const i1 = Math.min(pts.length - 1, index + reach);
  return unit(sub(pts[i1], pts[i0])) ?? estimateStartTangent(pts);
}

function estimateForwardTangent(pts: Vec[], index: number, closed: boolean): Vec {
  const n = pts.length;
  const reach = Math.max(1, Math.min(4, Math.floor(n / 8)));
  const i0 = closed ? (index - reach + n) % n : Math.max(0, index - reach);
  const i1 = closed ? (index + reach) % n : Math.min(n - 1, index + reach);
  return unit(sub(pts[i1], pts[i0])) ?? { x: 1, y: 0 };
}

function lineSpan(a: Vec, b: Vec): CubicSpan {
  return { p0: { ...a }, handleOut: zero(), handleIn: zero(), p3: { ...b } };
}

function zero(): Vec {
  return { x: 0, y: 0 };
}

function compress(pts: Vec[]): Vec[] {
  if (pts.length === 0) return [];
  const out: Vec[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (dist(pts[i], out[out.length - 1]) > 1e-6) out.push(pts[i]);
  }
  return out;
}

function sliceRing(pts: Vec[], i0: number, i1: number): Vec[] {
  const n = pts.length;
  const out: Vec[] = [pts[i0]];
  if (i0 === i1) {
    for (let k = 1; k < n; k++) out.push(pts[(i0 + k) % n]);
    out.push(pts[i0]);
    return out;
  }
  let i = i0;
  for (let g = 0; g < n; g++) {
    i = (i + 1) % n;
    out.push(pts[i]);
    if (i === i1) break;
  }
  return out;
}

function uniqueSorted(ids: number[], length: number): number[] {
  return [...new Set(ids.filter((i) => i >= 0 && i < length))].sort((a, b) => a - b);
}

function pointAtDistance(points: Vec[], cum: number[], distance: number, closed: boolean): Vec {
  const n = points.length;
  const segCount = closed ? n : n - 1;
  let i = 0;
  while (i < segCount - 1 && cum[i + 1] < distance) i++;
  if (Math.abs(distance - cum[i]) <= 1e-6) return { ...points[i % n] };
  if (Math.abs(distance - cum[i + 1]) <= 1e-6) return { ...points[(i + 1) % n] };
  const segLen = cum[i + 1] - cum[i];
  const a = points[i];
  const b = points[(i + 1) % n];
  if (segLen < 1e-12) return { ...a };
  const t = (distance - cum[i]) / segLen;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function vertexAtArcWalk(points: Vec[], closed: boolean, fromIdx: number, signedDist: number): number {
  const n = points.length;
  if (n === 0) return fromIdx;
  const dir = signedDist >= 0 ? 1 : -1;
  let budget = Math.abs(signedDist);
  let i = fromIdx;
  for (let step = 0; step < n; step++) {
    const j = closed ? (i + dir + n) % n : i + dir;
    if (!closed && (j < 0 || j >= n)) return i;
    const d = dist(points[j], points[i]);
    if (d >= budget - 1e-12) return j;
    budget -= d;
    i = j;
    if (!closed && (i === 0 || i === n - 1)) return i;
  }
  return i;
}

function arcSeparation(points: Vec[], closed: boolean, a: number, b: number): number {
  if (a === b) return 0;
  const n = points.length;
  const walk = (from: number, to: number, dir: 1 | -1): number => {
    let d = 0;
    let i = from;
    for (let step = 0; step < n; step++) {
      const j = closed ? (i + dir + n) % n : i + dir;
      if (!closed && (j < 0 || j >= n)) return Infinity;
      d += dist(points[j], points[i]);
      i = j;
      if (i === to) return d;
    }
    return Infinity;
  };
  return Math.min(walk(a, b, 1), walk(a, b, -1));
}

function pointToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function bernstein0(t: number): number {
  const m = 1 - t;
  return m * m * m;
}
function bernstein1(t: number): number {
  const m = 1 - t;
  return 3 * m * m * t;
}
function bernstein2(t: number): number {
  const m = 1 - t;
  return 3 * m * t * t;
}
function bernstein3(t: number): number {
  return t * t * t;
}

function cubicAt(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const b0 = bernstein0(t);
  const b1 = bernstein1(t);
  const b2 = bernstein2(t);
  const b3 = bernstein3(t);
  return {
    x: b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
    y: b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y,
  };
}

function cubicDeriv(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const mt = 1 - t;
  const c0 = 3 * mt * mt;
  const c1 = 6 * mt * t;
  const c2 = 3 * t * t;
  return {
    x: c0 * (p1.x - p0.x) + c1 * (p2.x - p1.x) + c2 * (p3.x - p2.x),
    y: c0 * (p1.y - p0.y) + c1 * (p2.y - p1.y) + c2 * (p3.y - p2.y),
  };
}

function cubicDeriv2(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const c0 = 6 * (1 - t);
  const c1 = 6 * t;
  return {
    x: c0 * (p2.x - 2 * p1.x + p0.x) + c1 * (p3.x - 2 * p2.x + p1.x),
    y: c0 * (p2.y - 2 * p1.y + p0.y) + c1 * (p3.y - 2 * p2.y + p1.y),
  };
}

function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function add(a: Vec, b: Vec): Vec {
  return { x: a.x + b.x, y: a.y + b.y };
}
function sub(a: Vec, b: Vec): Vec {
  return { x: a.x - b.x, y: a.y - b.y };
}
function scale(a: Vec, s: number): Vec {
  return { x: a.x * s, y: a.y * s };
}
function dot(a: Vec, b: Vec): number {
  return a.x * b.x + a.y * b.y;
}
function neg(a: Vec): Vec {
  return { x: -a.x, y: -a.y };
}
function unit(v: Vec | null | undefined): Vec | null {
  if (!v) return null;
  const l = Math.hypot(v.x, v.y);
  if (l < 1e-9) return null;
  return { x: v.x / l, y: v.y / l };
}
