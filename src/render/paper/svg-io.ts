import paper from "paper";
import type { CanvasConfig } from "../../geometry/types";
import type { Camera } from "../camera";

/**
 * Extract all paths from an item (handles Groups recursively).
 */
export function extractPaths(item: paper.Item): paper.PathItem[] {
  if (item instanceof paper.Path || item instanceof paper.CompoundPath) {
    return [item];
  }
  if (item instanceof paper.Group) {
    const paths: paper.PathItem[] = [];
    for (const child of item.children) {
      paths.push(...extractPaths(child));
    }
    return paths;
  }
  return [];
}

/**
 * Flatten active layer: ungroup all groups, move paths to layer root.
 * Returns true if any unwrapping actually happened.
 */
export function flattenGroups(): boolean {
  const layer = paper.project.activeLayer;
  let didFlatten = false;
  let hasGroups = true;
  while (hasGroups) {
    hasGroups = false;
    for (const child of [...layer.children]) {
      if (child instanceof paper.Group) {
        hasGroups = true;
        didFlatten = true;
        for (const gc of [...child.children]) {
          layer.insertChild(layer.children.indexOf(child), gc);
        }
        child.remove();
      }
    }
  }
  return didFlatten;
}

/**
 * Import and scale SVG, returning extracted paths (ungrouped).
 * When camera is active, positions paths in world space.
 *
 * The SVG from potrace represents what was drawn on the pixel canvas,
 * which maps to the full viewport (screen space). We need to:
 * 1. Scale SVG to viewport size
 * 2. Transform the result so screen coordinates become world coordinates
 */
export function importSVG(
  svg: string,
  config: CanvasConfig,
  camera: Camera | null,
): paper.PathItem[] {
  const item = paper.project.importSVG(svg) as paper.Item;
  if (!item) return [];

  // Get SVG dimensions
  const svgMatch = svg.match(/width="([^"]+)"\s+height="([^"]+)"/);
  let svgWidth = config.pixelWidth;
  let svgHeight = config.pixelHeight;

  if (svgMatch) {
    svgWidth = parseFloat(svgMatch[1]);
    svgHeight = parseFloat(svgMatch[2]);
  }

  // Scale SVG to viewport size
  // After this, the SVG content maps to screen coordinates (0,0 to viewportWidth,viewportHeight)
  if (svgWidth > 0 && svgHeight > 0) {
    const scale = Math.min(
      config.viewportWidth / svgWidth,
      config.viewportHeight / svgHeight,
    );
    item.scale(scale, new paper.Point(0, 0));
  }

  // Position at origin (top-left of viewport in screen space)
  item.bounds.topLeft = new paper.Point(0, 0);

  // Transform from screen space to world space
  if (camera) {
    // Get the inverse transform matrix (screen to world) from camera
    // This handles zoom, rotation, and pan correctly
    const [a, b, c, d, tx, ty] = camera.getInverseTransformMatrix();

    const screenToWorldMatrix = new paper.Matrix(a, b, c, d, tx, ty);

    item.transform(screenToWorldMatrix);
  } else {
    // No camera - position at view center (legacy behavior)
    item.position = paper.view.center;
  }

  // Extract paths and reparent them to the active layer BEFORE removing
  // any wrapper. Paper's importSVG can return Groups, Layers, Shapes, or
  // even nested Groups depending on the input — pulling paths out first
  // means a stray wrapper can never carry one of our paths into oblivion.
  const paths = extractPaths(item);
  const layer = paper.project.activeLayer;
  for (const p of paths) {
    if (p.parent !== layer) layer.addChild(p);
  }

  // Now remove the wrapper (and anything left inside it). We accept any
  // non-Path/CompoundPath wrapper here, not just Group, because Paper has
  // historically returned different container types for different SVG
  // shapes.
  if (
    item.parent &&
    item !== layer &&
    !(item instanceof paper.Path) &&
    !(item instanceof paper.CompoundPath)
  ) {
    item.remove();
  }

  // Final safety net: anything still wrapped in a Group on the active
  // layer (e.g. nested groups Paper didn't unwrap) gets dissolved here.
  flattenGroups();

  return paths;
}
