/**
 * Symmetry mode — world-space axis / radial center, source-side classification,
 * and clip-region / transform helpers used when expanding tool commit results.
 */
import type { SymmetrySettings } from "../state/index";

/** Half-plane side (±1) or radial sector index (0..n-1). */
export type SymmetrySide = number;

const HANDLE_HIT_RADIUS_PX = 18;

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
