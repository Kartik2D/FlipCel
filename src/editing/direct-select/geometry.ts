import paper from "paper";
import type { Point } from "../../geometry/types";

/** Ray-cast point-in-polygon test for lasso marquee hits. */
export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x,
      yi = polygon[i].y;
    const xj = polygon[j].x,
      yj = polygon[j].y;
    const intersects =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi || 1e-6) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function getAdjacentSegments(
  path: paper.Path,
  segmentIndex: number,
): { prev: paper.Segment | null; next: paper.Segment | null } {
  const segments = path.segments;
  const lastIndex = segments.length - 1;
  const prev = path.closed
    ? segments[(segmentIndex - 1 + segments.length) % segments.length] ?? null
    : segmentIndex > 0
      ? segments[segmentIndex - 1]
      : null;
  const next = path.closed
    ? segments[(segmentIndex + 1) % segments.length] ?? null
    : segmentIndex < lastIndex
      ? segments[segmentIndex + 1]
      : null;
  return { prev, next };
}

export function getSegmentTangentDirection(
  seg: paper.Segment,
  prev: paper.Segment | null,
  next: paper.Segment | null,
): paper.Point | null {
  const epsilon = 1e-6;

  if (!seg.handleOut.isZero() && seg.handleOut.length > epsilon) {
    return seg.handleOut.normalize();
  }
  if (!seg.handleIn.isZero() && seg.handleIn.length > epsilon) {
    return seg.handleIn.multiply(-1).normalize();
  }
  if (prev && next) {
    const across = next.point.subtract(prev.point);
    if (across.length > epsilon) return across.normalize();
  }
  if (next) {
    const forward = next.point.subtract(seg.point);
    if (forward.length > epsilon) return forward.normalize();
  }
  if (prev) {
    const backward = seg.point.subtract(prev.point);
    if (backward.length > epsilon) return backward.normalize();
  }
  return null;
}

export function getDefaultHandleLength(
  seg: paper.Segment,
  prev: paper.Segment | null,
  next: paper.Segment | null,
): number {
  const neighborDistances = [
    prev ? seg.point.getDistance(prev.point) : Infinity,
    next ? seg.point.getDistance(next.point) : Infinity,
  ].filter((distance) => Number.isFinite(distance) && distance > 0);

  if (neighborDistances.length === 0) return 0;
  return Math.min(...neighborDistances) * 0.35;
}

/** Length-weighted average of handleIn/handleOut, as a unit "out" tangent. */
function getAveragedHandleTangent(seg: paper.Segment): paper.Point | null {
  const epsilon = 1e-6;
  const hasIn = !seg.handleIn.isZero() && seg.handleIn.length > epsilon;
  const hasOut = !seg.handleOut.isZero() && seg.handleOut.length > epsilon;
  if (!hasIn && !hasOut) return null;
  if (hasIn && hasOut) {
    // Flip handleIn into out-space, then average the vectors so longer
    // handles pull the mirrored axis more strongly.
    const avg = seg.handleOut.add(seg.handleIn.multiply(-1));
    if (avg.length > epsilon) return avg.normalize();
    // Handles cancel (e.g. nearly opposite corner); fall back to the longer one.
    return seg.handleIn.length > seg.handleOut.length
      ? seg.handleIn.multiply(-1).normalize()
      : seg.handleOut.normalize();
  }
  if (hasOut) return seg.handleOut.normalize();
  return seg.handleIn.multiply(-1).normalize();
}

export type AnchorHandleMode = "sharp" | "mirrored" | "detached";

export function applyHandleModeToSegment(
  path: paper.Path,
  segmentIndex: number,
  seg: paper.Segment,
  mode: AnchorHandleMode,
): void {
  const { prev, next } = getAdjacentSegments(path, segmentIndex);
  const hasPrev = prev !== null;
  const hasNext = next !== null;

  if (mode === "sharp") {
    seg.handleIn = new paper.Point(0, 0);
    seg.handleOut = new paper.Point(0, 0);
    return;
  }

  const defaultLength = getDefaultHandleLength(seg, prev, next);
  const currentInLength = seg.handleIn.length;
  const currentOutLength = seg.handleOut.length;
  const inLength = Math.max(currentInLength, defaultLength);
  const outLength = Math.max(currentOutLength, defaultLength);

  if (mode === "mirrored") {
    const tangent =
      getAveragedHandleTangent(seg) ??
      getSegmentTangentDirection(seg, prev, next);
    if (!tangent) return;

    const mirroredLength = Math.max(
      (currentInLength + currentOutLength) / 2,
      defaultLength,
    );
    seg.handleIn = hasPrev
      ? tangent.multiply(-mirroredLength)
      : new paper.Point(0, 0);
    seg.handleOut = hasNext
      ? tangent.multiply(mirroredLength)
      : new paper.Point(0, 0);
    return;
  }

  // Detached: independent handles. Prefer existing directions; fill missing
  // sides from the adjacent segment. Linkage during drag comes from the
  // popup mode map, not from handle angles.
  if (hasPrev) {
    if (currentInLength < 1e-4) {
      const dir = prev.point.subtract(seg.point);
      seg.handleIn =
        dir.length > 1e-4
          ? dir.normalize().multiply(inLength)
          : new paper.Point(0, 0);
    }
  } else {
    seg.handleIn = new paper.Point(0, 0);
  }
  if (hasNext) {
    if (currentOutLength < 1e-4) {
      const dir = next.point.subtract(seg.point);
      seg.handleOut =
        dir.length > 1e-4
          ? dir.normalize().multiply(outLength)
          : new paper.Point(0, 0);
    }
  } else {
    seg.handleOut = new paper.Point(0, 0);
  }
}
