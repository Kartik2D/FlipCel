/**
 * Quick Shape — Procreate-style hold-to-snap.
 *
 * 1. Closed loop → circle / ellipse / rect
 * 2. Open stroke → sharp corners only; each span → line or half-ellipse
 *
 * One bias: curveStyle (0 = straight, 1 = curvy / aggressive semicircles).
 */
import type { Point } from "./types";

export type QuickShapeKind =
  | "line"
  | "polyline"
  | "circle"
  | "ellipse"
  | "square"
  | "rect"
  | "curves";

export interface QuickShapeResult {
  kind: QuickShapeKind;
  path: Point[];
  closed: boolean;
  center: Point;
  basePath: Point[];
  rotation: number;
  scale: number;
}

export interface RecognizeOptions {
  preferClosed?: boolean;
  /** 0 = straight segments, 1 = prefer half-ellipses on bulging spans. */
  curveStyle?: number;
}

const MIN_POINTS = 3;
const MIN_LENGTH = 6;
const STILL_SLOP_PX = 8;

export const QUICK_SHAPE_HOLD_MS_DEFAULT = 400;
export const QUICK_SHAPE_SLOP_PX = STILL_SLOP_PX;

// ============================================================
// Public API
// ============================================================

export function recognizeQuickShape(
  points: Point[],
  options: RecognizeOptions = {},
): QuickShapeResult | null {
  const pts = stripNearDuplicates(points);
  if (pts.length < MIN_POINTS) return null;
  const length = pathLength(pts);
  if (length < MIN_LENGTH) return null;

  const curveStyle = clamp01(options.curveStyle ?? 0.55);
  const preferClosed = options.preferClosed === true;

  const gap = dist(pts[0], pts[pts.length - 1]);
  const gapRatio = gap / Math.max(length, 1e-6);
  const closeThresh = preferClosed ? 0.38 : 0.28;
  const closed = gapRatio <= closeThresh;

  if (closed) {
    const loop = fitClosedPrimitive(pts, length);
    if (loop) return loop;
  }

  const curvy = curveStyle > 0.15;

  // Corners = sharp heading jumps only (never the crown of a smooth U).
  const cornerIdx = findSharpCornerIndices(pts, length);
  const endsOnly = cornerIdx.length <= 2;

  if (!closed && curvy && endsOnly) {
    const semi = fitHalfEllipse(pts, bulgeFracFor(curveStyle));
    if (semi) {
      return makeResult(
        "curves",
        sampleHalfEllipse(semi, stepsForSemi(semi)),
        false,
        { x: semi.cx, y: semi.cy },
      );
    }
  }

  const spans = sliceSpansByIndex(pts, cornerIdx, closed);
  const out: Point[] = [];
  let usedArc = false;

  for (const span of spans) {
    if (span.length < 2) continue;
    const piece = snapSpan(span, curvy, curveStyle);
    if (piece.kind === "arc") usedArc = true;
    appendPath(out, piece.points);
  }

  if (out.length < 2) return null;
  if (closed) sealClosed(out);

  const kind: QuickShapeKind = usedArc
    ? "curves"
    : cornerIdx.length <= 2
      ? "line"
      : "polyline";

  return makeResult(kind, out, closed, centroid(out));
}

export function adjustQuickShape(
  base: QuickShapeResult,
  pivot: Point,
  origin: Point,
  current: Point,
): QuickShapeResult {
  const px = pivot.x;
  const py = pivot.y;
  const ox = origin.x - px;
  const oy = origin.y - py;
  const nx = current.x - px;
  const ny = current.y - py;

  const oLen = Math.hypot(ox, oy);
  const nLen = Math.hypot(nx, ny);
  if (oLen < 1e-4 || nLen < 1e-4) {
    return {
      ...base,
      path: base.basePath.map((p) => ({ ...p })),
      rotation: 0,
      scale: 1,
    };
  }

  const scale = clamp(nLen / oLen, 0.15, 8);
  const rotation = Math.atan2(ny, nx) - Math.atan2(oy, ox);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  const path = base.basePath.map((p) => {
    const dx = (p.x - px) * scale;
    const dy = (p.y - py) * scale;
    return {
      x: px + dx * cos - dy * sin,
      y: py + dx * sin + dy * cos,
      pressure: p.pressure,
    };
  });

  return {
    ...base,
    path,
    center: {
      x: px + (base.center.x - px) * scale * cos - (base.center.y - py) * scale * sin,
      y: py + (base.center.x - px) * scale * sin + (base.center.y - py) * scale * cos,
    },
    rotation,
    scale,
  };
}

export function resampleWithPressure(
  original: Point[],
  path: Point[],
): Point[] {
  if (path.length === 0) return [];
  if (original.length === 0) {
    return path.map((p) => ({ ...p, pressure: p.pressure ?? 0.5 }));
  }
  const srcLens = cumulativeLengths(original);
  const srcTotal = srcLens[srcLens.length - 1] || 1;
  const dstLens = cumulativeLengths(path);
  const dstTotal = dstLens[dstLens.length - 1] || 1;
  return path.map((p, i) => ({
    x: p.x,
    y: p.y,
    pressure: samplePressureAt(original, srcLens, srcTotal, dstLens[i] / dstTotal),
  }));
}

export function centroidOf(points: Point[]): Point {
  return centroid(points);
}

// ============================================================
// Closed primitives
// ============================================================

function fitClosedPrimitive(
  pts: Point[],
  length: number,
): QuickShapeResult | null {
  const c = centroid(pts);
  const { rx, ry, angle } = pcaRadii(pts, c);
  if (rx < 3 || ry < 3) return null;

  const aspect = Math.min(rx, ry) / Math.max(rx, ry);
  const circ = fitCircleScore(pts, c);
  const ell = fitEllipseScore(pts, c, rx, ry, angle);
  const rect = fitRectScore(pts, c, angle, length);

  type Cand = { kind: QuickShapeKind; score: number; path: Point[] };
  const cands: Cand[] = [];

  if (circ.cv < 0.32 && circ.periRatio < 0.5) {
    cands.push({
      kind: "circle",
      score: circ.cv + circ.periRatio * 0.2,
      path: sampleEllipse(c, circ.r, circ.r, 0, 48, true),
    });
  }
  if (aspect < 0.9 && ell.rms < 0.28) {
    cands.push({
      kind: "ellipse",
      score: ell.rms + 0.02,
      path: sampleEllipse(c, rx, ry, angle, 48, true),
    });
  }
  if (rect.ok) {
    cands.push({
      kind: rect.square ? "square" : "rect",
      score: rect.score,
      path: densifyPolyline(rect.corners, true, 2),
    });
  }

  cands.sort((a, b) => a.score - b.score);
  const best = cands[0];
  if (!best || best.score > 0.4) return null;
  return makeResult(best.kind, best.path, true, c);
}

function fitCircleScore(pts: Point[], c: Point) {
  const radii = pts.map((p) => dist(p, c));
  const r = avg(radii);
  let v = 0;
  for (const x of radii) v += (x - r) ** 2;
  const cv = r > 1e-6 ? Math.sqrt(v / radii.length) / r : 1;
  const peri = pathLength(pts);
  const periRatio = Math.abs(peri - 2 * Math.PI * r) / Math.max(2 * Math.PI * r, 1);
  return { r, cv, periRatio };
}

function fitEllipseScore(
  pts: Point[],
  c: Point,
  rx: number,
  ry: number,
  angle: number,
) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let err = 0;
  for (const p of pts) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const lx = (dx * cos + dy * sin) / rx;
    const ly = (-dx * sin + dy * cos) / ry;
    const rad = Math.hypot(lx, ly);
    err += (rad - 1) ** 2;
  }
  return { rms: Math.sqrt(err / pts.length) };
}

function fitRectScore(
  pts: Point[],
  c: Point,
  angle: number,
  length: number,
) {
  const simplified = douglasPeucker(pts, Math.max(2, length * 0.03));
  let corners = keepBendCorners(simplified, 28);
  if (corners.length >= 3 && dist(corners[0], corners[corners.length - 1]) < 4) {
    corners = corners.slice(0, -1);
  }
  if (corners.length < 3 || corners.length > 5) {
    return { ok: false as const, score: 1, square: false, corners: [] as Point[] };
  }

  let right = 0;
  for (let i = 0; i < corners.length; i++) {
    const prev = corners[(i - 1 + corners.length) % corners.length];
    const cur = corners[i];
    const next = corners[(i + 1) % corners.length];
    if (Math.abs(interiorAngleDeg(prev, cur, next) - 90) <= 35) right++;
  }
  const rectTurn = right / corners.length;
  if (rectTurn < 0.5) {
    return { ok: false as const, score: 1, square: false, corners: [] as Point[] };
  }

  const edgeAngle = rectangleAngleFromCorners(corners) ?? angle;
  const obb = orientedBounds(pts, c, edgeAngle);
  if (!obb) {
    return { ok: false as const, score: 1, square: false, corners: [] as Point[] };
  }

  const size = Math.max(obb.w, obb.h, 1);
  const visited = countVisitedCorners(
    pts,
    rectCorners(c, obb.w, obb.h, edgeAngle),
    size * 0.18,
  );
  if (visited < 3) {
    return { ok: false as const, score: 1, square: false, corners: [] as Point[] };
  }

  const square = Math.min(obb.w, obb.h) / size > 0.85;
  let rw = obb.w;
  let rh = obb.h;
  if (square) {
    const s = (obb.w + obb.h) / 2;
    rw = s;
    rh = s;
  }
  return {
    ok: true as const,
    score: (1 - rectTurn) * 0.3 + (obb.rms / (size * 0.15)) * 0.4,
    square,
    corners: rectCorners(c, rw, rh, edgeAngle),
  };
}

// ============================================================
// Open spans: line vs half-ellipse
// ============================================================

function bulgeFracFor(curveStyle: number): number {
  // Curvier → accept shallower bowls.
  return lerp(0.1, 0.035, curveStyle);
}

function snapSpan(
  span: Point[],
  curvy: boolean,
  curveStyle: number,
): { kind: "line" | "arc"; points: Point[] } {
  const a = span[0];
  const b = span[span.length - 1];
  const chord = dist(a, b);
  const line = densifySegment(a, b, Math.max(4, Math.ceil(chord / 2)));

  if (!curvy) return { kind: "line", points: line };

  const semi = fitHalfEllipse(span, bulgeFracFor(curveStyle));
  if (!semi) return { kind: "line", points: line };

  // RMS-from-chord gate so nearly-straight spans stay lines.
  let err = 0;
  for (const p of span) err += distToSegmentSq(p, a, b);
  const bulge = Math.sqrt(err / span.length) / Math.max(pathLength(span), 1);
  const need = lerp(0.05, 0.015, curveStyle);
  if (bulge < need) return { kind: "line", points: line };

  return { kind: "arc", points: sampleHalfEllipse(semi, stepsForSemi(semi)) };
}

interface HalfEllipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  ux: number;
  uy: number;
  nx: number;
  ny: number;
}

function fitHalfEllipse(span: Point[], minBulgeFrac: number): HalfEllipse | null {
  if (span.length < 3) return null;
  const a = span[0];
  const b = span[span.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const chord = Math.hypot(dx, dy);
  if (chord < 2) return null;

  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const ux = dx / chord;
  const uy = dy / chord;
  const lx = -uy;
  const ly = ux;

  let side = 0;
  let maxH = 0;
  for (const p of span) {
    const h = (p.x - cx) * lx + (p.y - cy) * ly;
    side += h;
    maxH = Math.max(maxH, Math.abs(h));
  }
  if (maxH < Math.max(0.75, chord * minBulgeFrac)) return null;

  const sign = side >= 0 ? 1 : -1;
  return {
    cx,
    cy,
    rx: chord / 2,
    ry: maxH,
    ux,
    uy,
    nx: lx * sign,
    ny: ly * sign,
  };
}

function stepsForSemi(h: HalfEllipse): number {
  return Math.max(18, Math.ceil(h.rx + h.ry));
}

function sampleHalfEllipse(h: HalfEllipse, steps: number): Point[] {
  const n = Math.max(12, steps);
  const out: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = Math.PI * (1 - i / n);
    const px = Math.cos(t) * h.rx;
    const py = Math.sin(t) * h.ry;
    out.push({
      x: h.cx + px * h.ux + py * h.nx,
      y: h.cy + px * h.uy + py * h.ny,
    });
  }
  return out;
}

// ============================================================
// Corners / spans
// ============================================================

/**
 * Indices of sharp joints. Forward-only; never rewinds the scan index
 * (an earlier version could infinite-loop by jumping i backwards).
 */
function findSharpCornerIndices(pts: Point[], length: number): number[] {
  const n = pts.length;
  if (n < 5) return [0, n - 1];

  const win = Math.max(2, Math.round(n * 0.04));
  const bendMin = 40;
  const minSep = Math.max(4, length * 0.06);

  const bends = new Float64Array(n);
  for (let i = win; i < n - win; i++) {
    bends[i] = 180 - interiorAngleDeg(pts[i - win], pts[i], pts[i + win]);
  }

  const out: number[] = [0];
  let lastArc = 0; // path length along pts from 0 to last kept

  let i = win;
  while (i < n - win) {
    if (bends[i] < bendMin) {
      i++;
      continue;
    }

    // Local peak in [i, i+win]
    let peak = i;
    let peakBend = bends[i];
    const hi = Math.min(n - win - 1, i + win);
    for (let j = i + 1; j <= hi; j++) {
      if (bends[j] > peakBend) {
        peakBend = bends[j];
        peak = j;
      }
    }

    const arc = pathLength(pts.slice(0, peak + 1));
    if (arc - lastArc >= minSep || out.length === 1) {
      out.push(peak);
      lastArc = arc;
    }

    // Always advance past this peak's neighborhood.
    i = peak + win;
  }

  if (out[out.length - 1] !== n - 1) out.push(n - 1);
  return out;
}

function keepBendCorners(corners: Point[], minBendDeg: number): Point[] {
  if (corners.length < 3) return corners.map((p) => ({ ...p }));
  const out: Point[] = [{ ...corners[0] }];
  for (let i = 1; i < corners.length - 1; i++) {
    const bend = 180 - interiorAngleDeg(corners[i - 1], corners[i], corners[i + 1]);
    if (bend >= minBendDeg) out.push({ ...corners[i] });
  }
  out.push({ ...corners[corners.length - 1] });
  return out.length >= 2 ? out : corners.map((p) => ({ ...p }));
}

function sliceSpansByIndex(
  pts: Point[],
  idxs: number[],
  closed: boolean,
): Point[][] {
  const clean: number[] = [];
  for (const i of idxs) {
    const v = clamp(Math.round(i), 0, pts.length - 1);
    if (clean.length === 0 || v > clean[clean.length - 1]) clean.push(v);
  }
  if (clean.length < 2) {
    return pts.length >= 2 ? [pts] : [];
  }
  if (clean[0] !== 0) clean.unshift(0);
  if (clean[clean.length - 1] !== pts.length - 1) clean.push(pts.length - 1);

  const spans: Point[][] = [];
  for (let i = 0; i < clean.length - 1; i++) {
    const slice = pts.slice(clean[i], clean[i + 1] + 1);
    if (slice.length >= 2) spans.push(slice);
  }
  if (closed && clean.length >= 2) {
    const wrap = [
      ...pts.slice(clean[clean.length - 1]),
      ...pts.slice(0, clean[0] + 1),
    ];
    if (wrap.length >= 2) spans.push(wrap);
  }
  return spans;
}

function appendPath(out: Point[], piece: Point[]) {
  if (piece.length === 0) return;
  if (out.length === 0) {
    out.push(...piece);
    return;
  }
  out.push(...piece.slice(1));
}

function sealClosed(out: Point[]) {
  if (out.length < 2) return;
  if (dist(out[0], out[out.length - 1]) > 0.25) out.push({ ...out[0] });
}

// ============================================================
// Geometry helpers
// ============================================================

function makeResult(
  kind: QuickShapeKind,
  path: Point[],
  closed: boolean,
  center: Point,
): QuickShapeResult {
  let sealed = path.map((p) => ({ x: p.x, y: p.y, pressure: p.pressure }));
  if (closed && sealed.length >= 2 && dist(sealed[0], sealed[sealed.length - 1]) > 0.25) {
    sealed = [...sealed, { ...sealed[0] }];
  }
  const basePath = sealed.map((p) => ({ ...p }));
  return {
    kind,
    path: basePath.map((p) => ({ ...p })),
    closed,
    center: { ...center },
    basePath,
    rotation: 0,
    scale: 1,
  };
}

function stripNearDuplicates(points: Point[], eps = 0.5): Point[] {
  if (points.length === 0) return [];
  const out: Point[] = [{ ...points[0] }];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const prev = out[out.length - 1];
    if (dist(p, prev) >= eps) out.push({ ...p });
    else prev.pressure = p.pressure ?? prev.pressure;
  }
  return out;
}

function pathLength(points: Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += dist(points[i], points[i - 1]);
  return len;
}

function centroid(points: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  const n = Math.max(1, points.length);
  return { x: x / n, y: y / n };
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}

function pcaRadii(pts: Point[], c: Point) {
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const n = pts.length;
  sxx /= n;
  syy /= n;
  sxy /= n;
  const trace = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const tmp = Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
  const l1 = trace / 2 + tmp;
  const l2 = trace / 2 - tmp;
  let angle = 0;
  if (Math.abs(sxy) > 1e-9 || Math.abs(sxx - syy) > 1e-9) {
    angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  }
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let maxX = 0;
  let maxY = 0;
  for (const p of pts) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    maxX = Math.max(maxX, Math.abs(dx * cos + dy * sin));
    maxY = Math.max(maxY, Math.abs(-dx * sin + dy * cos));
  }
  return {
    rx: Math.max(maxX, Math.sqrt(Math.max(l1, 1e-6))),
    ry: Math.max(maxY, Math.sqrt(Math.max(l2, 1e-6))),
    angle,
  };
}

function interiorAngleDeg(a: Point, b: Point, c: Point): number {
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const n1 = Math.hypot(v1x, v1y);
  const n2 = Math.hypot(v2x, v2y);
  if (n1 < 1e-6 || n2 < 1e-6) return 180;
  const dot = clamp((v1x * v2x + v1y * v2y) / (n1 * n2), -1, 1);
  return (Math.acos(dot) * 180) / Math.PI;
}

function rectangleAngleFromCorners(corners: Point[]): number | null {
  if (corners.length < 3) return null;
  let sumSin = 0;
  let sumCos = 0;
  let w = 0;
  const n = corners.length;
  for (let i = 0; i < n; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    let ang = Math.atan2(dy, dx);
    ang = ((ang % Math.PI) + Math.PI) % Math.PI;
    if (ang >= Math.PI / 2) ang -= Math.PI / 2;
    sumSin += Math.sin(4 * ang) * len;
    sumCos += Math.cos(4 * ang) * len;
    w += len;
  }
  if (w < 1e-6) return null;
  return Math.atan2(sumSin, sumCos) / 4;
}

function orientedBounds(points: Point[], center: Point, angle: number) {
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    minX = Math.min(minX, lx);
    maxX = Math.max(maxX, lx);
    minY = Math.min(minY, ly);
    maxY = Math.max(maxY, ly);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (w < 1e-6 || h < 1e-6) return null;
  let err = 0;
  for (const p of points) {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    const d = Math.min(
      Math.abs(lx - minX),
      Math.abs(lx - maxX),
      Math.abs(ly - minY),
      Math.abs(ly - maxY),
    );
    err += d * d;
  }
  return { w, h, rms: Math.sqrt(err / points.length) };
}

function rectCorners(c: Point, w: number, h: number, angle: number): Point[] {
  const hw = w / 2;
  const hh = h / 2;
  const local = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return local.map((p) => ({
    x: c.x + p.x * cos - p.y * sin,
    y: c.y + p.x * sin + p.y * cos,
  }));
}

function countVisitedCorners(pts: Point[], corners: Point[], reach: number): number {
  let n = 0;
  for (const corner of corners) {
    let best = Infinity;
    for (const p of pts) best = Math.min(best, dist(p, corner));
    if (best <= reach) n++;
  }
  return n;
}

function distToSegmentSq(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) return (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = clamp(t, 0, 1);
  const qx = a.x + t * dx;
  const qy = a.y + t * dy;
  return (p.x - qx) ** 2 + (p.y - qy) ** 2;
}

function densifySegment(a: Point, b: Point, steps: number): Point[] {
  const n = Math.max(1, steps);
  const out: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

function densifyPolyline(poly: Point[], closed: boolean, stepPx: number): Point[] {
  if (poly.length === 0) return [];
  const out: Point[] = [];
  const n = poly.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const d = dist(a, b);
    const steps = Math.max(1, Math.ceil(d / Math.max(stepPx, 0.5)));
    const start = i === 0 ? 0 : 1;
    for (let s = start; s <= steps; s++) {
      const t = s / steps;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

function sampleEllipse(
  c: Point,
  rx: number,
  ry: number,
  angle: number,
  samples: number,
  closed: boolean,
): Point[] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const n = Math.max(8, samples);
  const out: Point[] = [];
  const last = closed ? n : n - 1;
  for (let i = 0; i <= last; i++) {
    const t = (i / n) * Math.PI * 2;
    const lx = Math.cos(t) * rx;
    const ly = Math.sin(t) * ry;
    out.push({
      x: c.x + lx * cos - ly * sin,
      y: c.y + lx * sin + ly * cos,
    });
  }
  return out;
}

function douglasPeucker(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points.map((p) => ({ ...p }));
  let maxDist = 0;
  let maxIndex = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = Math.sqrt(distToSegmentSq(points[i], first, last));
    if (d > maxDist) {
      maxDist = d;
      maxIndex = i;
    }
  }
  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, maxIndex + 1), epsilon);
    const right = douglasPeucker(points.slice(maxIndex), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [
    { x: first.x, y: first.y, pressure: first.pressure },
    { x: last.x, y: last.y, pressure: last.pressure },
  ];
}

function cumulativeLengths(points: Point[]): number[] {
  const lens = new Array(points.length);
  lens[0] = 0;
  for (let i = 1; i < points.length; i++) {
    lens[i] = lens[i - 1] + dist(points[i], points[i - 1]);
  }
  return lens;
}

function samplePressureAt(
  points: Point[],
  lens: number[],
  total: number,
  t: number,
): number {
  const target = clamp(t, 0, 1) * total;
  if (points.length === 1) return points[0].pressure ?? 0.5;
  let i = 1;
  while (i < lens.length - 1 && lens[i] < target) i++;
  const a = points[i - 1];
  const b = points[i];
  const seg = lens[i] - lens[i - 1];
  const u = seg > 1e-6 ? (target - lens[i - 1]) / seg : 0;
  const pa = a.pressure ?? 0.5;
  const pb = b.pressure ?? 0.5;
  return pa + (pb - pa) * u;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

// ============================================================
// Marquee (select lasso) still / snap / adjust session
// ============================================================

export class LassoQuickShapeSession {
  private stillTimer: ReturnType<typeof setTimeout> | null = null;
  private stillAnchor: Point | null = null;
  private lastPoint: Point | null = null;
  private getPoints: (() => Point[]) | null = null;
  private onSnapped: ((path: Point[]) => void) | null = null;
  private snapped: {
    base: QuickShapeResult;
    result: QuickShapeResult;
    pivot: Point;
    adjustOrigin: Point;
  } | null = null;
  private startPoint: Point | null = null;
  private enabled = true;
  private curveStyle = 0.55;
  private holdMs = QUICK_SHAPE_HOLD_MS_DEFAULT;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.reset();
  }

  setCurveStyle(curveStyle: number): void {
    this.curveStyle = clamp01(curveStyle);
  }

  setHoldMs(holdMs: number): void {
    this.holdMs = Math.max(50, Math.round(holdMs));
  }

  reset(): void {
    this.clearTimer();
    this.stillAnchor = null;
    this.lastPoint = null;
    this.startPoint = null;
    this.getPoints = null;
    this.onSnapped = null;
    this.snapped = null;
  }

  isSnapped(): boolean {
    return this.snapped !== null;
  }

  getPath(): Point[] | null {
    return this.snapped ? this.snapped.result.path : null;
  }

  begin(
    point: Point,
    getPoints: () => Point[],
    onSnapped: (path: Point[]) => void,
  ): void {
    this.reset();
    this.getPoints = getPoints;
    this.onSnapped = onSnapped;
    this.startPoint = { ...point };
    this.lastPoint = { ...point };
    this.stillAnchor = { ...point };
    this.armTimer();
  }

  noteMove(point: Point): "append" | "adjust" {
    this.lastPoint = { ...point };

    if (this.snapped) {
      this.snapped.result = adjustQuickShape(
        this.snapped.base,
        this.snapped.pivot,
        this.snapped.adjustOrigin,
        point,
      );
      return "adjust";
    }

    if (!this.enabled) return "append";

    const anchor = this.stillAnchor;
    if (!anchor) {
      this.stillAnchor = { ...point };
      this.armTimer();
      return "append";
    }

    const dx = point.x - anchor.x;
    const dy = point.y - anchor.y;
    if (dx * dx + dy * dy >= STILL_SLOP_PX * STILL_SLOP_PX) {
      this.stillAnchor = { ...point };
      this.armTimer();
    }
    return "append";
  }

  private armTimer(): void {
    this.clearTimer();
    if (!this.enabled || this.snapped) return;
    this.stillTimer = setTimeout(() => {
      this.stillTimer = null;
      const hold = this.lastPoint;
      const getPoints = this.getPoints;
      if (!hold || this.snapped || !getPoints) return;
      const points = getPoints();
      const withTip =
        points.length > 0 && dist(points[points.length - 1], hold) > 0.5
          ? [...points, hold]
          : points;
      const recognized = recognizeQuickShape(withTip, {
        preferClosed: true,
        curveStyle: this.curveStyle,
      });
      if (!recognized) return;
      const pivot =
        withTip.length > 0
          ? { ...withTip[0] }
          : this.startPoint
            ? { ...this.startPoint }
            : { ...hold };
      this.snapped = {
        base: recognized,
        result: recognized,
        pivot,
        adjustOrigin: { ...hold },
      };
      this.onSnapped?.(recognized.path);
      try {
        navigator.vibrate?.(10);
      } catch {
        /* ignore */
      }
    }, this.holdMs);
  }

  private clearTimer(): void {
    if (this.stillTimer !== null) {
      clearTimeout(this.stillTimer);
      this.stillTimer = null;
    }
  }
}
