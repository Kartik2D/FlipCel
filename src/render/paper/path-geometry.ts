import paper from "paper";

/**
 * Sample a handful of points likely inside the path to make robust containment checks.
 */
export function samplePoints(path: paper.Path): paper.Point[] {
  const pts: paper.Point[] = [];

  // Best case: use a guaranteed interior point if Paper provides it.
  try {
    const ip = (path as any).getInteriorPoint?.();
    if (ip) pts.push(ip);
  } catch {}

  // Try to find interior points by offsetting along normals from the boundary.
  const len = path.length;
  // Adaptive eps based on contour size (avoid stepping outside on tiny loops).
  const minDim = Math.min(path.bounds.width, path.bounds.height);
  const epsBase = Math.max(0.05, minDim * 0.05);
  const epsList = [epsBase, epsBase * 0.5, epsBase * 2];
  if (len > 0) {
    const samples = [0.1, 0.3, 0.5, 0.7, 0.9];
    for (const t of samples) {
      const off = len * t;
      const p = path.getPointAt(off);
      if (!p) continue;
      let n: paper.Point | null = null;
      try {
        n = path.getNormalAt(off) as any;
      } catch {
        n = null;
      }
      if (n) {
        for (const eps of epsList) {
          const c1 = p.add(n.multiply(eps));
          const c2 = p.subtract(n.multiply(eps));
          try {
            if (path.contains(c1)) pts.push(c1);
          } catch {}
          try {
            if (path.contains(c2)) pts.push(c2);
          } catch {}
        }
      }
    }
  }

  // Fallbacks (may be empty on donut-like shapes, but better than nothing)
  pts.push(path.bounds.center);
  if (path.segments.length) pts.push(path.segments[0].point);

  return pts.slice(0, 25);
}

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

/**
 * Sample points for any PathItem (Path or CompoundPath) for robust containment checks.
 */
export function samplePointsItem(item: paper.PathItem): paper.Point[] {
  if (item instanceof paper.Path) return samplePoints(item);
  if (item instanceof paper.CompoundPath) {
    const pts: paper.Point[] = [item.bounds.center];
    for (const child of item.children) {
      if (child instanceof paper.Path) pts.push(...samplePoints(child));
      if (pts.length > 20) break;
    }
    return pts;
  }
  return [item.bounds.center];
}

/**
 * Determine whether a cutter very likely fully covers a target (used as a guard when Paper booleans return empty).
 */
export function likelyFullyCovered(cutter: paper.PathItem, target: paper.PathItem): boolean {
  // Cheap reject first
  try {
    if (!cutter.bounds.contains(target.bounds)) return false;
  } catch {
    return false;
  }

  const pts = samplePointsItem(target);
  for (const p of pts) {
    try {
      if (!cutter.contains(p)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function forceEvenOdd(item: paper.PathItem | null): void {
  if (item instanceof paper.CompoundPath) item.fillRule = "evenodd";
}

/**
 * Normalize boolean-op results to keep winding/holes intact.
 */
export function normalizeBooleanResult<T extends paper.PathItem | null>(
  result: T,
): T {
  if (!result) return result;
  try {
    // Resolve self-intersections for robust winding
    if (typeof (result as any).resolveCrossings === "function") {
      (result as any).resolveCrossings();
    }
  } catch {}
  try {
    // Ensure proper winding for holes
    if (typeof (result as any).reorient === "function") {
      (result as any).reorient(true);
    }
  } catch {}
  return result;
}

export function flattenForBoolean(item: paper.PathItem, flatness: number): paper.PathItem {
  const clone = item.clone({ insert: false }) as paper.PathItem;
  if (clone instanceof paper.Path) {
    clone.flatten(flatness);
  } else if (clone instanceof paper.CompoundPath) {
    for (const child of clone.children) {
      if (child instanceof paper.Path) child.flatten(flatness);
    }
  }
  return clone;
}

/**
 * Check if two shapes genuinely overlap.
 */
export function pathsCollide(a: paper.PathItem, b: paper.PathItem): boolean {
  if (!a.bounds.intersects(b.bounds)) return false;
  try {
    if (a.intersects(b)) return true;
  } catch {}
  try {
    if (a.contains(b.bounds.center)) return true;
  } catch {}
  try {
    if (b.contains(a.bounds.center)) return true;
  } catch {}
  for (const p of samplePointsItem(a)) {
    try {
      if (b.contains(p)) return true;
    } catch {}
  }
  for (const p of samplePointsItem(b)) {
    try {
      if (a.contains(p)) return true;
    } catch {}
  }
  return false;
}

export function tryBooleanOp(
  target: paper.PathItem,
  other: paper.PathItem,
  op: "unite" | "subtract" | "intersect",
): paper.PathItem | null {
  const run = (
    left: paper.PathItem,
    right: paper.PathItem,
  ): paper.PathItem | null => {
    try {
      const result = normalizeBooleanResult(
        left[op](right) as paper.PathItem | null,
      );
      if (result && !result.isEmpty()) {
        forceEvenOdd(result);
        return result;
      }
      result?.remove();
    } catch {}
    return null;
  };

  const direct = run(target, other);
  if (direct) return direct;

  for (const flatness of [1, 0.5]) {
    const flatTarget = flattenForBoolean(target, flatness);
    const flatOther = flattenForBoolean(other, flatness);
    const flattened = run(flatTarget, flatOther);
    flatTarget.remove();
    flatOther.remove();
    if (flattened) return flattened;
  }

  return null;
}

export function tryUnite(a: paper.PathItem, b: paper.PathItem): paper.PathItem | null {
  if (!pathsCollide(a, b)) return null;
  return tryBooleanOp(a, b, "unite");
}

export function trySubtract(
  target: paper.PathItem,
  cutter: paper.PathItem,
): paper.PathItem | null {
  if (!pathsCollide(target, cutter)) return null;
  return tryBooleanOp(target, cutter, "subtract");
}

export function tryIntersect(
  target: paper.PathItem,
  clip: paper.PathItem,
): paper.PathItem | null {
  if (!pathsCollide(target, clip)) return null;
  const intersected = tryBooleanOp(target, clip, "intersect");
  if (intersected) return intersected;

  if (likelyFullyCovered(clip, target)) {
    const clone = target.clone({ insert: false }) as paper.PathItem;
    normalizeBooleanResult(clone);
    forceEvenOdd(clone);
    return clone;
  }
  if (likelyFullyCovered(target, clip)) {
    const clone = clip.clone({ insert: false }) as paper.PathItem;
    normalizeBooleanResult(clone);
    forceEvenOdd(clone);
    return clone;
  }
  return null;
}
