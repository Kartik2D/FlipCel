/**
 * Symmetry mode — world-space axis / radial center, source-side classification,
 * and clip-region / transform helpers used when expanding tool commit results.
 */
import paper from "paper";
import type { SymmetrySettings } from "./stores";

/** Half-plane side (±1) or radial sector index (0..n-1). */
export type SymmetrySide = number;

const CLIP_EXTENT = 1e5;
const HANDLE_HIT_RADIUS_PX = 10;

/** Active gesture source side — set on pointer-down, used at commit. */
let gestureSourceSide: SymmetrySide | null = null;

export function getSymmetryGestureSource(): SymmetrySide | null {
  return gestureSourceSide;
}

export function setSymmetryGestureSource(
  worldX: number,
  worldY: number,
  settings: SymmetrySettings,
): void {
  if (!settings.enabled) {
    gestureSourceSide = null;
    return;
  }
  gestureSourceSide = classifySymmetrySide(worldX, worldY, settings);
}

export function clearSymmetryGestureSource(): void {
  gestureSourceSide = null;
}

export function classifySymmetrySide(
  worldX: number,
  worldY: number,
  settings: SymmetrySettings,
): SymmetrySide {
  const { originX, originY, mode, radialCount } = settings;

  if (mode === "vertical") {
    const dx = worldX - originX;
    if (dx === 0) return 1;
    return dx > 0 ? 1 : -1;
  }

  if (mode === "horizontal") {
    const dy = worldY - originY;
    if (dy === 0) return 1;
    return dy > 0 ? 1 : -1;
  }

  // Radial: sector 0 starts at +X and proceeds CCW (paper / screen y-down still uses atan2).
  const count = Math.max(2, radialCount);
  let angle = Math.atan2(worldY - originY, worldX - originX);
  if (angle < 0) angle += Math.PI * 2;
  const sector = Math.floor((angle / (Math.PI * 2)) * count);
  return Math.min(count - 1, Math.max(0, sector));
}

/**
 * Build an uninserted clip path covering the source region in world space.
 * Caller must remove() when done.
 */
export function buildSourceClipRegion(
  settings: SymmetrySettings,
  sourceSide: SymmetrySide,
): paper.Path {
  const { originX, originY, mode, radialCount } = settings;
  const ox = originX;
  const oy = originY;
  const R = CLIP_EXTENT;

  if (mode === "vertical") {
    // +1 = right of axis, -1 = left
    const rect =
      sourceSide >= 0
        ? new paper.Rectangle(ox, oy - R, R, R * 2)
        : new paper.Rectangle(ox - R, oy - R, R, R * 2);
    return new paper.Path.Rectangle({ rectangle: rect, insert: false });
  }

  if (mode === "horizontal") {
    // +1 = below axis (+y), -1 = above
    const rect =
      sourceSide >= 0
        ? new paper.Rectangle(ox - R, oy, R * 2, R)
        : new paper.Rectangle(ox - R, oy - R, R * 2, R);
    return new paper.Path.Rectangle({ rectangle: rect, insert: false });
  }

  const count = Math.max(2, radialCount);
  const sector = ((sourceSide % count) + count) % count;
  const a0 = (sector / count) * Math.PI * 2;
  const a1 = ((sector + 1) / count) * Math.PI * 2;
  const path = new paper.Path({ insert: false });
  path.add(new paper.Point(ox, oy));
  path.add(new paper.Point(ox + Math.cos(a0) * R, oy + Math.sin(a0) * R));
  path.add(new paper.Point(ox + Math.cos(a1) * R, oy + Math.sin(a1) * R));
  path.closePath();
  return path;
}

/**
 * Transforms that map the source piece onto every other symmetry region.
 * Empty when symmetry is off or only one copy exists.
 */
export function buildMirrorTransforms(
  settings: SymmetrySettings,
): paper.Matrix[] {
  const { originX, originY, mode, radialCount } = settings;
  const origin = new paper.Point(originX, originY);

  if (mode === "vertical") {
    // x' = 2*ox - x, y' = y
    return [new paper.Matrix(-1, 0, 0, 1, 2 * originX, 0)];
  }

  if (mode === "horizontal") {
    // x' = x, y' = 2*oy - y
    return [new paper.Matrix(1, 0, 0, -1, 0, 2 * originY)];
  }

  const count = Math.max(2, radialCount);
  const transforms: paper.Matrix[] = [];
  for (let k = 1; k < count; k++) {
    const degrees = (k * 360) / count;
    transforms.push(new paper.Matrix().rotate(degrees, origin));
  }
  return transforms;
}

export function hitTestSymmetryHandle(
  screenX: number,
  screenY: number,
  settings: SymmetrySettings,
  worldToScreen: (x: number, y: number) => { x: number; y: number },
): boolean {
  if (!settings.enabled) return false;
  const p = worldToScreen(settings.originX, settings.originY);
  const dx = screenX - p.x;
  const dy = screenY - p.y;
  return dx * dx + dy * dy <= HANDLE_HIT_RADIUS_PX * HANDLE_HIT_RADIUS_PX;
}
