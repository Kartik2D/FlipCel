import paper from "paper";

export function getContainmentPoint(path: paper.Path): paper.Point | null {
  try {
    const interior = (path as { getInteriorPoint?: () => paper.Point | null }).getInteriorPoint?.();
    if (interior) return interior;
  } catch {}

  if (path.segments.length > 0) {
    let sx = 0;
    let sy = 0;
    for (const segment of path.segments) {
      sx += segment.point.x;
      sy += segment.point.y;
    }
    const centroid = new paper.Point(sx / path.segments.length, sy / path.segments.length);
    try {
      if (path.contains(centroid)) return centroid;
    } catch {}
  }

  const len = path.length;
  if (len > 0) {
    const minDim = Math.min(path.bounds.width, path.bounds.height);
    const eps = Math.max(0.05, minDim * 0.05);
    for (const t of [0.125, 0.375, 0.625, 0.875]) {
      const offset = len * t;
      const point = path.getPointAt(offset);
      const normal = path.getNormalAt(offset);
      if (!point || !normal) continue;
      for (const probe of [point.add(normal.multiply(eps)), point.subtract(normal.multiply(eps))]) {
        try {
          if (path.contains(probe)) return probe;
        } catch {}
      }
    }
  }

  try {
    if (path.contains(path.bounds.center)) return path.bounds.center;
  } catch {}

  return null;
}

/** A point strictly inside the filled region of `item` (not in a hole). */
function interiorPoint(item: paper.PathItem): paper.Point | null {
  if (item instanceof paper.Path) return getContainmentPoint(item);
  if (item instanceof paper.CompoundPath) {
    for (const child of item.children) {
      if (!(child instanceof paper.Path)) continue;
      const pt = getContainmentPoint(child);
      if (pt && pointIn(item, pt)) return pt;
    }
  }
  return null;
}

const AREA_EPS = 1e-4;
const BOOLEAN_INSERT = { insert: false as const };

/**
 * Filled area honoring the fill rule. `PathItem.area` is the signed sum of
 * children, which is wrong for imported evenodd compounds whose children share
 * an orientation; reorienting a clone fixes that.
 */
export function fillArea(item: paper.PathItem): number {
  try {
    if (item instanceof paper.Path) return Math.abs(item.area);
    if (!(item instanceof paper.CompoundPath)) return 0;
    const clone = item.clone({ insert: false }) as paper.CompoundPath;
    try {
      clone.reorient(item.fillRule === "nonzero", true);
      return Math.abs(clone.area);
    } finally {
      clone.remove();
    }
  } catch {
    return 0;
  }
}

const pathAbsArea = fillArea;

function eachTargetPath(target: paper.PathItem, visit: (path: paper.Path) => boolean): boolean {
  if (target instanceof paper.Path) return visit(target);
  if (target instanceof paper.CompoundPath) {
    for (const child of target.children) {
      if (child instanceof paper.Path && !visit(child)) return false;
    }
    return true;
  }
  return false;
}

function hasClosedFill(item: paper.PathItem): boolean {
  if (item instanceof paper.Path) return item.closed && item.segments.length >= 3;
  if (item instanceof paper.CompoundPath) {
    for (const child of item.children) {
      if (child instanceof paper.Path && child.closed && child.segments.length >= 3) {
        return true;
      }
    }
  }
  return false;
}

function isUsableFill(item: paper.PathItem): boolean {
  if (item.isEmpty()) return false;
  if (!hasClosedFill(item)) return false;
  return pathAbsArea(item) > AREA_EPS;
}

function pointIn(cutter: paper.PathItem, point: paper.Point): boolean {
  try {
    return cutter.contains(point);
  } catch {
    return false;
  }
}

function forceEvenOdd(item: paper.PathItem | null): void {
  if (item instanceof paper.CompoundPath) item.fillRule = "evenodd";
}

/**
 * After vertex edits (simplify/smooth): clip holes that extend outside
 * their containing outer path.
 */
export function sanitizePathItemTopology(item: paper.PathItem): void {
  if (!item.parent) return;
  if (!(item instanceof paper.CompoundPath)) return;

  const live = () =>
    item.children.filter(
      (child): child is paper.Path => child instanceof paper.Path && !!child.parent,
    );

  for (const hole of [...live()]) {
    if (!hole.parent) continue;

    const interior = getContainmentPoint(hole);
    if (!interior) continue;

    let outer: paper.Path | null = null;
    let bestArea = Infinity;
    const holeArea = Math.abs(hole.area);
    for (const candidate of live()) {
      if (candidate === hole || !candidate.parent) continue;
      try {
        if (!candidate.contains(interior)) continue;
      } catch {
        continue;
      }
      const area = Math.abs(candidate.area);
      if (area <= holeArea + 1e-6) continue;
      if (area < bestArea) {
        bestArea = area;
        outer = candidate;
      }
    }
    if (!outer) continue;

    if (holeFullyInside(hole, outer)) continue;

    const holeClone = hole.clone({ insert: false }) as paper.PathItem;
    const outerClone = outer.clone({ insert: false }) as paper.PathItem;
    const clipped = intersectOf(holeClone, outerClone);
    holeClone.remove();
    outerClone.remove();

    if (!clipped) continue;

    const replacement =
      clipped instanceof paper.Path
        ? clipped
        : clipped instanceof paper.CompoundPath
          ? largestChildPath(clipped)
          : null;

    if (!replacement) {
      clipped.remove();
      continue;
    }

    hole.removeSegments();
    for (const seg of replacement.segments) {
      hole.add(seg.clone());
    }
    hole.closed = true;
    clipped.remove();
  }

  forceEvenOdd(item);
}

function holeFullyInside(hole: paper.Path, outer: paper.Path): boolean {
  try {
    if (hole.intersects(outer)) return false;
  } catch {
    return false;
  }
  for (const seg of hole.segments) {
    if (!pointIn(outer, seg.point)) return false;
  }
  return true;
}

function largestChildPath(compound: paper.CompoundPath): paper.Path | null {
  let best: paper.Path | null = null;
  let bestArea = -1;
  for (const child of compound.children) {
    if (!(child instanceof paper.Path)) continue;
    const area = Math.abs(child.area);
    if (area > bestArea) {
      bestArea = area;
      best = child;
    }
  }
  return best;
}

/** True if any vertex of `item` lies inside `container` (holes honored). */
function anyVertexInside(container: paper.PathItem, item: paper.PathItem): boolean {
  let hit = false;
  eachTargetPath(item, (path) => {
    for (const s of path.segments) {
      if (pointIn(container, s.point)) {
        hit = true;
        return false;
      }
    }
    return true;
  });
  return hit;
}

/** Crossings, or one nested inside the other. Throws fail open. */
export function pathsCollide(a: paper.PathItem, b: paper.PathItem): boolean {
  // Rectangle.intersects is strict; edge-adjacent fills must still collide.
  if (!a.bounds.intersects(b.bounds, 1e-6)) return false;
  try {
    if (a.intersects(b)) return true;
  } catch {
    return true;
  }
  const pa = interiorPoint(a);
  const pb = interiorPoint(b);
  if ((!!pb && pointIn(a, pb)) || (!!pa && pointIn(b, pa))) return true;
  // Tuck hole inside a stroke: no crossings, interiors land in holes.
  return anyVertexInside(a, b) || anyVertexInside(b, a);
}

type Op = "unite" | "subtract" | "intersect";

const POLYLINE_FLATNESS = 0.5;

function cloneAsPolyline(item: paper.PathItem): paper.PathItem | null {
  const clone = item.clone({ insert: false }) as paper.PathItem;
  try {
    eachTargetPath(clone, (path) => {
      path.flatten(POLYLINE_FLATNESS);
      return true;
    });
  } catch {
    clone.remove();
    return null;
  }
  if (!isUsableFill(clone)) {
    clone.remove();
    return null;
  }
  return clone;
}

/** Area conservation: the only thing a boolean result must satisfy. */
function areaOk(op: Op, a: number, b: number, r: number): boolean {
  const eps = AREA_EPS + 1e-6 * (a + b);
  if (op === "subtract") return r >= a - b - eps && r <= a + eps;
  if (op === "unite") return r >= Math.max(a, b) - eps && r <= a + b + eps;
  return r <= Math.min(a, b) + eps;
}

/** One Paper boolean. "empty" is a legitimate result, null is a failure. */
function paperBoolean(
  target: paper.PathItem,
  other: paper.PathItem,
  op: Op,
): paper.PathItem | "empty" | null {
  let result: paper.PathItem | null = null;
  try {
    result =
      op === "unite"
        ? target.unite(other, BOOLEAN_INSERT)
        : op === "subtract"
          ? target.subtract(other, BOOLEAN_INSERT)
          : target.intersect(other, BOOLEAN_INSERT);
  } catch {
    result?.remove();
    return null;
  }
  if (!result) return null;
  forceEvenOdd(result);
  if (!isUsableFill(result)) {
    result.remove();
    return "empty";
  }
  if (!areaOk(op, pathAbsArea(target), pathAbsArea(other), pathAbsArea(result))) {
    result.remove();
    return null;
  }
  return result;
}

/** Cubic first, polyline retry, loud failure. */
export function booleanOp(
  target: paper.PathItem,
  other: paper.PathItem,
  op: Op,
): paper.PathItem | "empty" | null {
  const cubic = paperBoolean(target, other, op);
  if (cubic) return cubic;

  const left = cloneAsPolyline(target);
  const right = cloneAsPolyline(other);
  let result: paper.PathItem | "empty" | null = null;
  try {
    if (left && right) result = paperBoolean(left, right, op);
  } finally {
    left?.remove();
    right?.remove();
  }
  if (result === null && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    console.warn("[merge] boolean failed", op, target.pathData, other.pathData);
  }
  return result;
}

/** `booleanOp` for callers that only want a fill back. */
export function tryBooleanOp(
  target: paper.PathItem,
  other: paper.PathItem,
  op: Op,
): paper.PathItem | null {
  const result = booleanOp(target, other, op);
  return result === "empty" ? null : result;
}

/** `cutter` provably covers `target`: at least as large and holds an interior point. */
function covers(cutter: paper.PathItem, target: paper.PathItem): boolean {
  if (pathAbsArea(cutter) + AREA_EPS < pathAbsArea(target)) return false;
  const pt = interiorPoint(target);
  return !!pt && pointIn(cutter, pt);
}

/**
 * `item` sits entirely inside `container`. The container's bounding box is
 * not enough: a slash's box holds the whole drawing. Boolean subtract also
 * returns empty on a holed compound that is fully inside and has no cut edge.
 */
export function fullyInside(container: paper.PathItem, item: paper.PathItem): boolean {
  if (pathAbsArea(container) + AREA_EPS < pathAbsArea(item)) return false;
  try {
    if (item.intersects(container)) return false;
  } catch {
    return false;
  }
  let saw = false;
  let ok = true;
  eachTargetPath(item, (path) => {
    const pt = getContainmentPoint(path);
    if (!pt || !pointIn(container, pt)) {
      ok = false;
      return false;
    }
    saw = true;
    return true;
  });
  return saw && ok;
}

/** Result of `target − cutter`: new item | provably empty | disjoint | failed. */
export type Cut = paper.PathItem | "gone" | "unchanged" | null;

export function subtractOf(target: paper.PathItem, cutter: paper.PathItem): Cut {
  if (!pathsCollide(target, cutter)) return "unchanged";
  const result = booleanOp(target, cutter, "subtract");
  if (result === null) return null;
  if (result === "empty") return covers(cutter, target) ? "gone" : null;
  const before = pathAbsArea(target);
  if (Math.abs(pathAbsArea(result) - before) <= AREA_EPS + 1e-6 * before) {
    result.remove();
    return "unchanged";
  }
  return result;
}

/** `a ∪ b`, or null when they don't touch (or the boolean failed). */
export function uniteOf(a: paper.PathItem, b: paper.PathItem): paper.PathItem | null {
  if (!pathsCollide(a, b)) return null;
  const result = booleanOp(a, b, "unite");
  return result === "empty" ? null : result;
}

/** `target ∩ clip`, or null when nothing is inside (or the boolean failed). */
export function intersectOf(
  target: paper.PathItem,
  clip: paper.PathItem,
): paper.PathItem | null {
  if (!pathsCollide(target, clip)) return null;
  const result = booleanOp(target, clip, "intersect");
  return result === "empty" ? null : result;
}

/**
 * Unite without the collide gate (symmetry copies that only meet on the axis).
 * Failed unites stay as siblings.
 */
export function forceUniteFamily(items: paper.PathItem[]): paper.PathItem[] {
  const live = items.filter((it) => it && !it.isEmpty());
  if (live.length <= 1) return live;

  let acc = live[0]!;
  const leftovers: paper.PathItem[] = [];
  for (let i = 1; i < live.length; i++) {
    const next = live[i]!;
    const united = booleanOp(acc, next, "unite");
    if (united && united !== "empty") {
      acc.remove();
      next.remove();
      acc = united;
    } else {
      leftovers.push(next);
    }
  }
  return [acc, ...leftovers].filter(isUsableFill);
}
