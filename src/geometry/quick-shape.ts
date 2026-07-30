/**
 * Quick Shape — Procreate-style stroke recognition + adjust + pressure remap.
 *
 * Fits a freehand Point[] to line / polyline / ellipse / rect / cleaned curves,
 * then supports scale+rotate adjust while the pointer stays down.
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
  /** Dense sample path suitable for stamping / fill / marquee. */
  path: Point[];
  closed: boolean;
  center: Point;
  /** Canonical geometry used for adjust (pre-transform). */
  basePath: Point[];
  /** Cumulative adjust applied after recognition. */
  rotation: number;
  scale: number;
}

export interface RecognizeOptions {
  /** Prefer closed shapes (lasso). Brush leaves open unless stroke is near-closed. */
  preferClosed?: boolean;
  /**
   * Freehand cleanup continuum when no primitive wins.
   * 0 = Straight (sharp polyline), 1 = Bezier (smooth curves).
   */
  curveStyle?: number;
}

const MIN_POINTS = 3;
const MIN_LENGTH = 8;
const STILL_SLOP_PX = 8;

/** Default still-hold delay; runtime value comes from `quickShapeHoldMsStore`. */
export const QUICK_SHAPE_HOLD_MS_DEFAULT = 400;
export const QUICK_SHAPE_SLOP_PX = STILL_SLOP_PX;

// ============================================================
// Public API
// ============================================================

export function recognizeQuickShape(
  points: Point[],
  options: RecognizeOptions = {},
): QuickShapeResult | null {
  if (points.length < MIN_POINTS) return null;
  const cleaned = densifyIfNeeded(stripNearDuplicates(points));
  if (cleaned.length < MIN_POINTS) return null;

  const length = pathLength(cleaned);
  if (length < MIN_LENGTH) return null;

  const preferClosed = options.preferClosed === true;
  const curveStyle = clamp01(options.curveStyle ?? 0.45);
  const nearClosed = isNearClosed(cleaned, length);
  const closedBias = preferClosed || nearClosed;

  const candidates: Array<{ result: QuickShapeResult; score: number }> = [];
  const features = analyzeClosedShapeFeatures(cleaned, length, closedBias);

  const line = fitLine(cleaned, length);
  if (line) {
    // Straight end of the continuum prefers sharp segments.
    line.score *= lerp(0.72, 1.08, curveStyle);
    candidates.push(line);
  }

  // Closed primitives first — corner/smooth features decide circle vs rect
  // so a wobbly oval cannot beat a rect (and vice versa) on OBB edge stats alone.
  if (features.loopLikely) {
    const circle = fitNearCircle(cleaned, length, features);
    if (circle) candidates.push(circle);

    const ellipse = fitEllipse(cleaned, length, features);
    if (ellipse) candidates.push(ellipse);

    const rect = fitNearRect(cleaned, length, features);
    if (rect) candidates.push(rect);
  }

  const poly = fitPolyline(cleaned, length, closedBias, curveStyle, features);
  if (poly) {
    poly.score *= lerp(0.78, 1.12, curveStyle);
    candidates.push(poly);
  }

  const curves = fitCurves(cleaned, closedBias, curveStyle);
  // Bezier end prefers smooth cleanup over sharp polyline leftovers.
  curves.score *= lerp(1.18, 0.78, curveStyle);
  candidates.push(curves);

  candidates.sort((a, b) => a.score - b.score);
  return candidates[0]?.result ?? null;
}

/**
 * Scale + rotate about center based on drag from the hold origin to `current`.
 * `base` should be the result at snap time (identity transform).
 */
export function adjustQuickShape(
  base: QuickShapeResult,
  origin: Point,
  current: Point,
): QuickShapeResult {
  const cx = base.center.x;
  const cy = base.center.y;
  const ox = origin.x - cx;
  const oy = origin.y - cy;
  const nx = current.x - cx;
  const ny = current.y - cy;

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
    const dx = (p.x - cx) * scale;
    const dy = (p.y - cy) * scale;
    return {
      x: cx + dx * cos - dy * sin,
      y: cy + dx * sin + dy * cos,
      pressure: p.pressure,
    };
  });

  return {
    ...base,
    path,
    rotation,
    scale,
  };
}

/** Map arc-length pressure from `original` onto samples of `path`. */
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

  return path.map((p, i) => {
    const t = dstLens[i] / dstTotal;
    const pressure = samplePressureAt(original, srcLens, srcTotal, t);
    return { x: p.x, y: p.y, pressure };
  });
}

export function centroidOf(points: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  const n = Math.max(1, points.length);
  return { x: x / n, y: y / n };
}

// ============================================================
// Fitters
// ============================================================

function fitLine(
  points: Point[],
  length: number,
): { result: QuickShapeResult; score: number } | null {
  const a = points[0];
  const b = points[points.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const segLen = Math.hypot(dx, dy);
  if (segLen < MIN_LENGTH) return null;

  let errSum = 0;
  for (const p of points) {
    errSum += distToSegmentSq(p, a, b);
  }
  const rms = Math.sqrt(errSum / points.length);
  const score = rms / Math.max(segLen, 1);

  // Straightness: path length vs chord.
  const stretch = length / segLen;
  if (stretch > 1.35 && score > 0.04) return null;

  const path = densifySegment(a, b, Math.max(8, Math.ceil(segLen / 2)));
  const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return {
    score: score * 0.85 + (stretch - 1) * 0.15,
    result: makeResult("line", path, false, center),
  };
}

interface ClosedShapeFeatures {
  loopLikely: boolean;
  gapRatio: number;
  /** Significant turning corners (closed polyline simplification). */
  corners: Point[];
  /** Interior turn angles in degrees (0–180), one per corner. */
  turnDegrees: number[];
  /** How rectangular the turns are: 1 = all ~90°, 0 = not. */
  rectTurnScore: number;
  /** Mean absolute deviation of turns from 90°. */
  turnDevFrom90: number;
  circleCv: number;
  ellipseRms: number;
  ellipseRx: number;
  ellipseRy: number;
  ellipseAngle: number;
  aspect: number;
  rectRms: number;
  rectW: number;
  rectH: number;
  rectAngle: number;
  center: Point;
}

function analyzeClosedShapeFeatures(
  points: Point[],
  length: number,
  closedBias: boolean,
): ClosedShapeFeatures {
  const gap = Math.hypot(
    points[points.length - 1].x - points[0].x,
    points[points.length - 1].y - points[0].y,
  );
  const gapRatio = gap / Math.max(length, 1);
  const loopLikely = gapRatio <= (closedBias ? 0.42 : 0.3);

  const c = centroidOf(points);
  const radii = points.map((p) => Math.hypot(p.x - c.x, p.y - c.y));
  const meanR = radii.reduce((a, b) => a + b, 0) / Math.max(radii.length, 1);
  let rVar = 0;
  for (const r of radii) rVar += (r - meanR) ** 2;
  const circleCv =
    meanR > 1e-6 ? Math.sqrt(rVar / radii.length) / meanR : 1;

  const pca = orientedRadii(points);
  const ellipseRx = pca?.rx ?? 0;
  const ellipseRy = pca?.ry ?? 0;
  const ellipseAngle = pca?.angle ?? 0;

  // Refit ellipse radii from extents in the PCA frame (covariance alone
  // overshoots for boundary strokes). Then score radial error.
  let fitRx = ellipseRx;
  let fitRy = ellipseRy;
  let ellipseRms = 1;
  if (pca && ellipseRx >= 1 && ellipseRy >= 1) {
    const cos = Math.cos(ellipseAngle);
    const sin = Math.sin(ellipseAngle);
    let maxAx = 0;
    let maxAy = 0;
    const local: Point[] = [];
    for (const p of points) {
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      const lx = dx * cos + dy * sin;
      const ly = -dx * sin + dy * cos;
      local.push({ x: lx, y: ly });
      maxAx = Math.max(maxAx, Math.abs(lx));
      maxAy = Math.max(maxAy, Math.abs(ly));
    }
    fitRx = Math.max(maxAx, 1e-3);
    fitRy = Math.max(maxAy, 1e-3);
    let errSum = 0;
    for (const p of local) {
      const r = Math.hypot(p.x / fitRx, p.y / fitRy);
      errSum += (r - 1) * (r - 1);
    }
    ellipseRms = Math.sqrt(errSum / points.length);
  }

  // OBB in PCA frame for rect error.
  const cosR = Math.cos(-(pca?.angle ?? 0));
  const sinR = Math.sin(-(pca?.angle ?? 0));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const local: Point[] = [];
  for (const p of points) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const lx = dx * cosR - dy * sinR;
    const ly = dx * sinR + dy * cosR;
    local.push({ x: lx, y: ly });
    minX = Math.min(minX, lx);
    maxX = Math.max(maxX, lx);
    minY = Math.min(minY, ly);
    maxY = Math.max(maxY, ly);
  }
  const rectW = Math.max(0, maxX - minX);
  const rectH = Math.max(0, maxY - minY);
  let rectErr = 0;
  for (const p of local) {
    rectErr += distToObbBoundarySq(p.x, p.y, minX, maxX, minY, maxY);
  }
  const rectRms = Math.sqrt(rectErr / Math.max(points.length, 1));

  // Corners via DP — this is the main circle/oval vs rect discriminator.
  const cornerTol = Math.max(2.5, length * 0.028);
  let corners = douglasPeucker(points, cornerTol);
  if (corners.length >= 3) {
    const first = corners[0];
    const last = corners[corners.length - 1];
    if (Math.hypot(last.x - first.x, last.y - first.y) < cornerTol * 1.5) {
      corners = corners.slice(0, -1);
    }
  }
  // Merge near-colinear consecutive corners.
  corners = mergeColinearCorners(corners, 28);

  const turnDegrees: number[] = [];
  if (corners.length >= 3) {
    const n = corners.length;
    for (let i = 0; i < n; i++) {
      const prev = corners[(i - 1 + n) % n];
      const cur = corners[i];
      const next = corners[(i + 1) % n];
      turnDegrees.push(interiorTurnDegrees(prev, cur, next));
    }
  }

  let turnDevFrom90 = 180;
  let rectTurnScore = 0;
  if (turnDegrees.length >= 3) {
    let devSum = 0;
    let rightish = 0;
    for (const a of turnDegrees) {
      const dev = Math.abs(a - 90);
      devSum += dev;
      if (dev <= 32) rightish++;
    }
    turnDevFrom90 = devSum / turnDegrees.length;
    rectTurnScore = rightish / turnDegrees.length;
  }

  const aspect =
    Math.max(fitRx, fitRy) > 1e-6
      ? Math.min(fitRx, fitRy) / Math.max(fitRx, fitRy)
      : 0;

  return {
    loopLikely,
    gapRatio,
    corners,
    turnDegrees,
    rectTurnScore,
    turnDevFrom90,
    circleCv,
    ellipseRms,
    ellipseRx: fitRx,
    ellipseRy: fitRy,
    ellipseAngle,
    aspect,
    rectRms,
    rectW,
    rectH,
    rectAngle: pca?.angle ?? 0,
    center: c,
  };
}

function fitPolyline(
  points: Point[],
  length: number,
  closed: boolean,
  curveStyle = 0.45,
  features?: ClosedShapeFeatures,
): { result: QuickShapeResult; score: number } | null {
  // Straighter continuum → larger DP tolerance → fewer corners.
  const tol = Math.max(2, length * lerp(0.035, 0.014, curveStyle));
  let simplified = douglasPeucker(points, tol);
  if (closed && simplified.length >= 3) {
    // Drop duplicate close endpoint if present.
    const first = simplified[0];
    const last = simplified[simplified.length - 1];
    if (Math.hypot(last.x - first.x, last.y - first.y) < tol) {
      simplified = simplified.slice(0, -1);
    }
  }

  if (simplified.length < 2) return null;
  if (simplified.length === 2 && !closed) {
    // Pure line — let fitLine win.
    return null;
  }
  if (simplified.length > 8) return null;
  if (simplified.length < 3 && closed) return null;

  // Score: how well the original tracks the polyline + prefer fewer verts.
  let errSum = 0;
  for (const p of points) {
    errSum += distToPolylineSq(p, simplified, closed);
  }
  const rms = Math.sqrt(errSum / points.length);
  let score = rms / Math.max(length * 0.08, 1) + (simplified.length - 2) * 0.03;

  // Closed 3–5 corner paths that look rectangular should not beat a perfect rect.
  if (
    features?.loopLikely &&
    simplified.length >= 3 &&
    simplified.length <= 5 &&
    features.rectTurnScore >= 0.6
  ) {
    score += 0.22;
  }

  if (score > 0.55) return null;

  const path = densifyPolyline(simplified, closed, 2);
  const center = centroidOf(simplified);
  const kind: QuickShapeKind = simplified.length <= 2 ? "line" : "polyline";
  return {
    score,
    result: makeResult(kind, path, closed, center),
  };
}

function fitEllipse(
  _points: Point[],
  length: number,
  features: ClosedShapeFeatures,
): { result: QuickShapeResult; score: number } | null {
  if (!features.loopLikely) return null;
  if (features.ellipseRx < 3 || features.ellipseRy < 3) return null;

  // Sharp corner loops belong to rect, not oval.
  if (
    features.corners.length >= 3 &&
    features.corners.length <= 6 &&
    features.rectTurnScore >= 0.55
  ) {
    return null;
  }

  const { center: c, ellipseRx: rx, ellipseRy: ry, ellipseAngle: angle } =
    features;
  // Allow wobblier ovals than before — still reject clear boxes via corners.
  if (features.ellipseRms > 0.28) return null;

  const ratio = features.aspect;
  // Near-round → perfect circle fitter.
  if (ratio > 0.9) return null;
  // Ovals often sit near an OBB; only require beating rect when turns look boxy.
  if (
    features.rectTurnScore >= 0.4 &&
    features.ellipseRms > features.rectRms * 0.9
  ) {
    return null;
  }

  const path = sampleEllipse(c, rx, ry, angle, 72);
  const peri = approxEllipsePerimeter(rx, ry);
  const periRatio = Math.abs(length - peri) / Math.max(peri, 1);
  if (periRatio > 0.55) return null;

  return {
    // Prefer a good oval over freehand curves / soft polylines.
    score:
      features.ellipseRms * 0.7 +
      periRatio * 0.12 +
      features.gapRatio * 0.05 +
      (ratio > 0.75 ? 0.02 : 0),
    result: makeResult("ellipse", path, true, c),
  };
}

/**
 * Detect strokes that are *similar* to a circle and emit a perfect circle.
 * Rejects cornered / boxy loops (those belong to rect).
 */
function fitNearCircle(
  points: Point[],
  length: number,
  features: ClosedShapeFeatures,
): { result: QuickShapeResult; score: number } | null {
  if (!features.loopLikely) return null;

  // Cornered strokes are rectangles, not circles — even if CV is mediocre.
  if (
    features.corners.length >= 3 &&
    features.corners.length <= 6 &&
    features.rectTurnScore >= 0.5
  ) {
    return null;
  }

  // Elongated ovals belong to ellipse, not a forced perfect circle.
  if (features.aspect < 0.86) return null;

  const mean =
    points.reduce(
      (s, p) => s + Math.hypot(p.x - features.center.x, p.y - features.center.y),
      0,
    ) / points.length;
  if (mean < 4) return null;

  const circ = 2 * Math.PI * mean;
  const periRatio = Math.abs(length - circ) / Math.max(circ, 1);
  if (features.circleCv > 0.28 || periRatio > 0.45) return null;

  // Must actually look rounder than a box.
  const size = Math.max(features.rectW, features.rectH, 1);
  const rectNorm = features.rectRms / size;
  if (features.circleCv > rectNorm * 0.95 && features.rectTurnScore > 0.35) {
    return null;
  }

  const path = sampleEllipse(features.center, mean, mean, 0, 64);
  const score =
    features.circleCv * 0.8 + periRatio * 0.12 + features.gapRatio * 0.08;
  return {
    score,
    result: makeResult("circle", path, true, features.center),
  };
}

/**
 * Detect strokes that are *similar* to a rectangle/square and emit a perfect
 * oriented rect. Requires cornered turns — smooth ovals cannot win via OBB.
 */
function fitNearRect(
  points: Point[],
  length: number,
  features: ClosedShapeFeatures,
): { result: QuickShapeResult; score: number } | null {
  if (!features.loopLikely) return null;

  const cornerCount = features.corners.length;
  // Rectangles have about four corners. Allow 3–5 for incomplete / extra kink.
  if (cornerCount < 3 || cornerCount > 5) return null;
  if (features.rectTurnScore < 0.55) return null;
  if (features.turnDevFrom90 > 38) return null;

  // Prefer edge-based orientation from detected corners (PCA is unstable on squares).
  const edgeAngle = rectangleAngleFromCorners(features.corners);
  const angle = edgeAngle ?? features.rectAngle;
  const obb = orientedBounds(points, features.center, angle);
  if (!obb || obb.w < 4 || obb.h < 4) return null;

  const size = Math.max(obb.w, obb.h, 1);
  const rectNorm = obb.rms / (size * 0.12);
  const peri = 2 * (obb.w + obb.h);
  const periRatio = Math.abs(length - peri) / Math.max(peri, 1);
  if (rectNorm > 0.85 || periRatio > 0.5) return null;

  // Must beat ellipse when turns aren't strongly rectangular.
  if (
    features.ellipseRms < obb.rms * 0.75 &&
    features.rectTurnScore < 0.75
  ) {
    return null;
  }

  const ratio = Math.min(obb.w, obb.h) / size;
  const kind: QuickShapeKind = ratio > 0.85 ? "square" : "rect";
  let rw = obb.w;
  let rh = obb.h;
  if (kind === "square") {
    const s = (obb.w + obb.h) / 2;
    rw = s;
    rh = s;
  }

  const corners = rectCorners(features.center, rw, rh, angle);
  // Circles/ovals DP'd into a diamond leave OBB corners empty; real rects visit them.
  const cornerReach = size * 0.16;
  let visitedCorners = 0;
  for (const corner of corners) {
    let best = Infinity;
    for (const p of points) {
      const d = Math.hypot(p.x - corner.x, p.y - corner.y);
      if (d < best) best = d;
    }
    if (best <= cornerReach) visitedCorners++;
  }
  if (visitedCorners < 3) return null;

  // Round loops that only graze mid-sides: radial CV stays low.
  if (features.circleCv < 0.16 && features.aspect > 0.82 && visitedCorners < 4) {
    return null;
  }

  const path = densifyPolyline(corners, true, 2);
  // Keep scores competitive vs polyline for closed 4-corner doodles.
  const score =
    rectNorm * 0.35 +
    (1 - features.rectTurnScore) * 0.2 +
    features.turnDevFrom90 / 220 +
    periRatio * 0.08 +
    features.gapRatio * 0.05 +
    (4 - visitedCorners) * 0.03;

  return {
    score,
    result: makeResult(kind, path, true, features.center),
  };
}

function fitCurves(
  points: Point[],
  closed: boolean,
  curveStyle = 0.45,
): { result: QuickShapeResult; score: number } {
  const length = pathLength(points);
  // Straight → coarser simplify; Bezier → keep more inflection then smooth.
  const tol = Math.max(1.2, length * lerp(0.03, 0.01, curveStyle));
  let simplified = douglasPeucker(points, tol);
  if (closed && simplified.length >= 3) {
    const first = simplified[0];
    const last = simplified[simplified.length - 1];
    if (Math.hypot(last.x - first.x, last.y - first.y) < tol) {
      simplified = simplified.slice(0, -1);
    }
  }
  if (simplified.length < 2) simplified = [points[0], points[points.length - 1]];

  const chaikinPasses = Math.round(lerp(0, 3, curveStyle));
  const smooth =
    chaikinPasses === 0
      ? simplified
      : closed
        ? chaikinClosed(simplified, chaikinPasses)
        : chaikinOpen(simplified, chaikinPasses);
  const path = densifyPolyline(smooth, closed, lerp(2.5, 1.2, curveStyle));
  const center = centroidOf(path);
  const kind: QuickShapeKind = curveStyle < 0.35 ? "polyline" : "curves";

  return {
    score: 0.28,
    result: makeResult(kind, path, closed, center),
  };
}

function distToObbBoundarySq(
  x: number,
  y: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): number {
  const insideX = x >= minX && x <= maxX;
  const insideY = y >= minY && y <= maxY;
  if (insideX && insideY) {
    const d = Math.min(
      Math.abs(x - minX),
      Math.abs(x - maxX),
      Math.abs(y - minY),
      Math.abs(y - maxY),
    );
    return d * d;
  }
  if (insideX) {
    const d = y < minY ? minY - y : y - maxY;
    return d * d;
  }
  if (insideY) {
    const d = x < minX ? minX - x : x - maxX;
    return d * d;
  }
  const ex = x < minX ? minX - x : x - maxX;
  const ey = y < minY ? minY - y : y - maxY;
  return ex * ex + ey * ey;
}

/** Interior turning angle at `b` in degrees (0–180). 90 ≈ square corner. */
function interiorTurnDegrees(a: Point, b: Point, c: Point): number {
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

function mergeColinearCorners(corners: Point[], minTurnDeg: number): Point[] {
  if (corners.length < 3) return corners.map((p) => ({ ...p }));
  const out: Point[] = [];
  const n = corners.length;
  for (let i = 0; i < n; i++) {
    const prev = corners[(i - 1 + n) % n];
    const cur = corners[i];
    const next = corners[(i + 1) % n];
    const turn = interiorTurnDegrees(prev, cur, next);
    // Keep only real bends (not nearly straight).
    if (180 - turn >= minTurnDeg) {
      out.push({ ...cur });
    }
  }
  return out.length >= 3 ? out : corners.map((p) => ({ ...p }));
}

function approxEllipsePerimeter(rx: number, ry: number): number {
  // Ramanujan approximation.
  const a = Math.max(rx, ry);
  const b = Math.min(rx, ry);
  const h = ((a - b) * (a - b)) / Math.max((a + b) * (a + b), 1e-9);
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(Math.max(0, 4 - 3 * h))));
}

/** Dominant edge angle in [0, π/2) from corner polyline. */
function rectangleAngleFromCorners(corners: Point[]): number | null {
  if (corners.length < 3) return null;
  const n = corners.length;
  let sumSin = 0;
  let sumCos = 0;
  let weight = 0;
  for (let i = 0; i < n; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    // Fold into [0, π/2) so opposite / perpendicular sides reinforce.
    let ang = Math.atan2(dy, dx);
    ang = ((ang % Math.PI) + Math.PI) % Math.PI;
    if (ang >= Math.PI / 2) ang -= Math.PI / 2;
    // Double-angle average on [0, π/2).
    sumSin += Math.sin(4 * ang) * len;
    sumCos += Math.cos(4 * ang) * len;
    weight += len;
  }
  if (weight < 1e-6) return null;
  const mean = Math.atan2(sumSin, sumCos) / 4;
  return mean;
}

function orientedBounds(
  points: Point[],
  center: Point,
  angle: number,
): { w: number; h: number; rms: number } | null {
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const local: Point[] = [];
  for (const p of points) {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    local.push({ x: lx, y: ly });
    minX = Math.min(minX, lx);
    maxX = Math.max(maxX, lx);
    minY = Math.min(minY, ly);
    maxY = Math.max(maxY, ly);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (w < 1e-6 || h < 1e-6) return null;
  let err = 0;
  for (const p of local) {
    err += distToObbBoundarySq(p.x, p.y, minX, maxX, minY, maxY);
  }
  return { w, h, rms: Math.sqrt(err / local.length) };
}

function orientedRadii(points: Point[]): {
  c: Point;
  rx: number;
  ry: number;
  angle: number;
} | null {
  const c = centroidOf(points);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const n = points.length;
  sxx /= n;
  syy /= n;
  sxy /= n;

  const trace = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const tmp = Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
  const l1 = trace / 2 + tmp;
  const l2 = trace / 2 - tmp;
  const rx = Math.sqrt(Math.max(l1, 1e-6)) * 2;
  const ry = Math.sqrt(Math.max(l2, 1e-6)) * 2;
  let angle = 0;
  if (Math.abs(sxy) > 1e-9 || Math.abs(sxx - syy) > 1e-9) {
    angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  }
  return { c, rx, ry, angle };
}

// ============================================================
// Result helpers
// ============================================================

function makeResult(
  kind: QuickShapeKind,
  path: Point[],
  closed: boolean,
  center: Point,
): QuickShapeResult {
  let sealed = path.map((p) => ({ x: p.x, y: p.y, pressure: p.pressure }));
  // Guarantee closed paths reconnect for brush stamping (last → first).
  if (closed && sealed.length >= 2) {
    const first = sealed[0];
    const last = sealed[sealed.length - 1];
    if (Math.hypot(last.x - first.x, last.y - first.y) > 0.25) {
      sealed = [...sealed, { ...first }];
    }
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

// ============================================================
// Geometry utils
// ============================================================

function stripNearDuplicates(points: Point[], eps = 0.5): Point[] {
  if (points.length === 0) return [];
  const out: Point[] = [{ ...points[0] }];
  for (let i = 1; i < points.length; i++) {
    const prev = out[out.length - 1];
    const p = points[i];
    if (Math.hypot(p.x - prev.x, p.y - prev.y) >= eps) {
      out.push({ ...p });
    } else {
      // Keep latest pressure on coincident samples.
      prev.pressure = p.pressure ?? prev.pressure;
    }
  }
  return out;
}

function densifyIfNeeded(points: Point[]): Point[] {
  return points.length >= 2 ? points : points;
}

function pathLength(points: Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return len;
}

function isNearClosed(points: Point[], length: number): boolean {
  if (points.length < 4) return false;
  const gap = Math.hypot(
    points[points.length - 1].x - points[0].x,
    points[points.length - 1].y - points[0].y,
  );
  return gap / Math.max(length, 1) < 0.32;
}

function cumulativeLengths(points: Point[]): number[] {
  const lens = new Array(points.length);
  lens[0] = 0;
  for (let i = 1; i < points.length; i++) {
    lens[i] =
      lens[i - 1] +
      Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
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

function distToSegmentSq(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) {
    const ex = p.x - a.x;
    const ey = p.y - a.y;
    return ex * ex + ey * ey;
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = clamp(t, 0, 1);
  const qx = a.x + t * dx;
  const qy = a.y + t * dy;
  const ex = p.x - qx;
  const ey = p.y - qy;
  return ex * ex + ey * ey;
}

function distToPolylineSq(p: Point, poly: Point[], closed: boolean): number {
  let best = Infinity;
  const n = poly.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    best = Math.min(best, distToSegmentSq(p, a, b));
  }
  return best;
}

function densifySegment(a: Point, b: Point, steps: number): Point[] {
  const out: Point[] = [];
  const n = Math.max(1, steps);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      pressure: (a.pressure ?? 0.5) + ((b.pressure ?? 0.5) - (a.pressure ?? 0.5)) * t,
    });
  }
  return out;
}

function densifyPolyline(
  poly: Point[],
  closed: boolean,
  stepPx: number,
): Point[] {
  if (poly.length === 0) return [];
  const out: Point[] = [];
  const n = poly.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(dist / Math.max(stepPx, 0.5)));
    const start = i === 0 ? 0 : 1;
    for (let s = start; s <= steps; s++) {
      const t = s / steps;
      out.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
      });
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
): Point[] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const out: Point[] = [];
  // Include t=0 twice (start + end) so open consumers (brush stamping) seal the loop.
  const n = Math.max(8, samples);
  for (let i = 0; i <= n; i++) {
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

function chaikinOpen(points: Point[], passes: number): Point[] {
  let pts = points.map((p) => ({ ...p }));
  for (let p = 0; p < passes; p++) {
    if (pts.length < 3) break;
    const next: Point[] = [{ ...pts[0] }];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      next.push({
        x: 0.75 * a.x + 0.25 * b.x,
        y: 0.75 * a.y + 0.25 * b.y,
      });
      next.push({
        x: 0.25 * a.x + 0.75 * b.x,
        y: 0.25 * a.y + 0.75 * b.y,
      });
    }
    next.push({ ...pts[pts.length - 1] });
    pts = next;
  }
  return pts;
}

function chaikinClosed(points: Point[], passes: number): Point[] {
  let pts = points.map((p) => ({ ...p }));
  for (let p = 0; p < passes; p++) {
    if (pts.length < 3) break;
    const next: Point[] = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      next.push({
        x: 0.75 * a.x + 0.25 * b.x,
        y: 0.75 * a.y + 0.25 * b.y,
      });
      next.push({
        x: 0.25 * a.x + 0.75 * b.x,
        y: 0.25 * a.y + 0.75 * b.y,
      });
    }
    pts = next;
  }
  return pts;
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

/**
 * Tracks hold-still → snap → drag-adjust for viewport-space lasso marquees.
 * Controllers call {@link noteMove} each move; when it returns `"adjust"`,
 * apply {@link getPath} to the marquee instead of appending freehand.
 */
export class LassoQuickShapeSession {
  private stillTimer: ReturnType<typeof setTimeout> | null = null;
  private stillAnchor: Point | null = null;
  private lastPoint: Point | null = null;
  private getPoints: (() => Point[]) | null = null;
  private onSnapped: ((path: Point[]) => void) | null = null;
  private snapped: {
    base: QuickShapeResult;
    result: QuickShapeResult;
    adjustOrigin: Point;
  } | null = null;
  private enabled = true;
  private curveStyle = 0.45;
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

  /**
   * Call when a lasso marquee begins.
   * @param getPoints live marquee points accessor
   * @param onSnapped called once when recognition succeeds (apply path + redraw)
   */
  begin(
    point: Point,
    getPoints: () => Point[],
    onSnapped: (path: Point[]) => void,
  ): void {
    this.reset();
    this.getPoints = getPoints;
    this.onSnapped = onSnapped;
    this.lastPoint = { ...point };
    this.stillAnchor = { ...point };
    this.armTimer();
  }

  /**
   * @returns `"append"` to keep freehand sampling, `"adjust"` when snapped
   */
  noteMove(point: Point): "append" | "adjust" {
    this.lastPoint = { ...point };

    if (this.snapped) {
      this.snapped.result = adjustQuickShape(
        this.snapped.base,
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
        points.length > 0 &&
        Math.hypot(
          points[points.length - 1].x - hold.x,
          points[points.length - 1].y - hold.y,
        ) > 0.5
          ? [...points, hold]
          : points;
      const recognized = recognizeQuickShape(withTip, {
        preferClosed: true,
        curveStyle: this.curveStyle,
      });
      if (!recognized) return;
      this.snapped = {
        base: recognized,
        result: recognized,
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
