/**
 * Paint commits — the single path from tool output (rings) into the kernel.
 *
 * Handles coordinate mapping (pixel canvas → viewport → world), symmetry
 * expansion, palette lookup, and the three FlipCel paint modes.
 */
import type { CanvasConfig, Point } from "../geometry/types";
import type { Camera } from "../render/camera";
import type { StageRenderer } from "../render/stage-renderer";
import { getSymmetryGestureSource } from "../geometry/symmetry";
import { symmetryStore } from "../state/index";
import { PaintMode, mulAffine, transformRing, type Affine, type Px, type Ring } from "./kernel";
import { expandSymmetry, parseSvgRings, svgSize } from "./rings";

export type FlipPaintMode = "add" | "subtract" | "inside";

/** Pixel-canvas → world. */
export function pixelToWorldAffine(config: CanvasConfig, camera: Camera | null): Affine {
  const sx = config.viewportWidth / Math.max(1, config.pixelWidth);
  const sy = config.viewportHeight / Math.max(1, config.pixelHeight);
  const toViewport: Affine = [sx, 0, 0, sy, 0, 0];
  if (!camera) return toViewport;
  return mulAffine(camera.getInverseTransformMatrix(), toViewport);
}

/** Viewport (CSS px) → world. */
export function viewportToWorldAffine(camera: Camera | null): Affine {
  return camera ? camera.getInverseTransformMatrix() : [1, 0, 0, 1, 0, 0];
}

/** Rings from a potrace SVG (pixel-canvas space) mapped into world space. */
export function tracedSvgToWorldRings(svg: string, config: CanvasConfig, camera: Camera | null): Ring[] {
  const size = svgSize(svg);
  // The tracer restores canvas dimensions; fall back to config if missing.
  const pw = size?.width || config.pixelWidth;
  const ph = size?.height || config.pixelHeight;
  const toWorld = pixelToWorldAffine({ ...config, pixelWidth: pw, pixelHeight: ph }, camera);
  return parseSvgRings(svg, toWorld);
}

export function worldRings(rings: Ring[], xf: Affine): Ring[] {
  return rings.map((r) => transformRing(r, xf));
}

/** Apply the active symmetry setup to rings about to be committed. */
export function withSymmetry(rings: Ring[]): Ring[] {
  const s = symmetryStore.get();
  if (!s.enabled) return rings;
  return expandSymmetry(rings, s, getSymmetryGestureSource());
}

/**
 * Commit rings (world px) to the active layer.
 * - add: paint over.
 * - subtract: erase.
 * - inside: clip to the face under `insideAt` (or paint behind when none).
 */
export function commitPaint(
  renderer: StageRenderer,
  rings: Ring[],
  mode: FlipPaintMode,
  hex: string,
  insideAt: Px | null,
): boolean {
  const expanded = withSymmetry(rings);
  if (expanded.length === 0) return false;
  if (mode === "subtract") return renderer.erase(expanded);
  const fill = renderer.getPalette().fillFor(hex);
  if (mode === "inside") {
    if (!insideAt) return renderer.paintBehind(expanded, fill);
    return renderer.paintInside(expanded, fill, insideAt);
  }
  return renderer.paint(expanded, fill, PaintMode.Over);
}

export function worldPointOf(point: Point, config: CanvasConfig, camera: Camera): Px {
  const vx = (point.x / Math.max(1, config.pixelWidth)) * config.viewportWidth;
  const vy = (point.y / Math.max(1, config.pixelHeight)) * config.viewportHeight;
  return camera.screenToWorld(vx, vy);
}
