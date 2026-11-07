/**
 * Temporary Paper.js bridge for Magic Move / Magic Morph.
 *
 * Those solvers still operate on Paper layer JSON (one `Path` /
 * `CompoundPath` per filled region). The kernel stays the source of truth:
 * content goes out through `facesToPaperPaths`, and whatever the solver
 * produces comes back in through `paperPathsToContent`, which repaints the
 * result into a fresh kernel map in painter's order.
 *
 * Paper runs on a private offscreen scope; nothing here touches the stage.
 */
import paper from "paper";
import { VectorLayer, type Affine, type Ring } from "./kernel";
import { parsePathData } from "./rings";
import { ringsToPathData } from "./svg";
import type { Palette } from "./palette";
import { cssToHex } from "./palette";
import { decodeContent, encodeLayerContent, type PlacedInstance } from "./content";

let scope: paper.PaperScope | null = null;

/** Activate (creating on first use) the private Paper scope. */
export function ensurePaperScope(): paper.PaperScope {
  if (!scope) {
    scope = new paper.PaperScope();
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    scope.setup(canvas);
    scope.settings.applyMatrix = true;
    scope.settings.insertItems = false;
  }
  scope.activate();
  return scope;
}

/** Build uninserted Paper path items for every filled region of a kernel layer. */
export function facesToPaperPaths(layer: VectorLayer, palette: Palette): paper.PathItem[] {
  ensurePaperScope();
  const out: paper.PathItem[] = [];
  for (const region of layer.regions()) {
    const color = palette.colorOf(region.fill);
    if (!color) continue;
    const d = ringsToPathData(region.rings);
    const item =
      region.rings.length === 1
        ? new paper.Path({ pathData: d, insert: false })
        : new paper.CompoundPath({ pathData: d, insert: false });
    item.fillColor = new paper.Color(color);
    item.fillRule = "evenodd";
    item.strokeColor = null;
    item.data = { fill: region.fill };
    out.push(item);
  }
  return out;
}

/** Leaf paths of a Paper item, in document order. */
export function leafPaths(item: paper.Item): paper.Path[] {
  if (item instanceof paper.Path) return [item];
  const out: paper.Path[] = [];
  for (const child of item.children ?? []) out.push(...leafPaths(child));
  return out;
}

/** Rings (world coordinates) for a Paper path item. */
export function paperItemRings(item: paper.PathItem): Ring[] {
  const paths = leafPaths(item);
  const rings: Ring[] = [];
  for (const p of paths) {
    const m = p.globalMatrix;
    const xf: Affine = [m.a, m.b, m.c, m.d, m.tx, m.ty];
    const d = (p as unknown as { pathData: string }).pathData;
    if (!d) continue;
    rings.push(...parsePathData(d, xf));
  }
  return rings;
}

function fillHexOf(item: paper.Item): string | null {
  const c = item.fillColor;
  if (!c) return null;
  const css = c.toCSS(true);
  return cssToHex(css);
}

/**
 * Repaint Paper items into a fresh kernel layer (painter's order).
 * Caller owns the returned layer.
 */
export function paperPathsToLayer(items: readonly paper.Item[], palette: Palette): VectorLayer {
  const layer = new VectorLayer();
  for (const item of items) {
    const hex = fillHexOf(item);
    if (!hex) continue;
    if (!(item instanceof paper.Path) && !(item instanceof paper.CompoundPath)) continue;
    const rings = paperItemRings(item);
    if (rings.length === 0) continue;
    layer.paint(rings, palette.fillFor(hex));
  }
  return layer;
}

/** Content string → Paper layer JSON (instances dropped; returned separately). */
export function contentToPaperLayerJson(
  json: string,
  palette: Palette,
): { layerJson: string; instances: PlacedInstance[] } {
  const content = decodeContent(json);
  const instances = content.instances;
  if (content.map.length === 0) return { layerJson: "", instances };
  ensurePaperScope();
  const art = VectorLayer.fromBytes(content.map);
  const layer = new paper.Layer({ insert: false });
  try {
    for (const p of facesToPaperPaths(art, palette)) layer.addChild(p);
    return { layerJson: layer.exportJSON({ asString: true }) as string, instances };
  } finally {
    layer.remove();
    art.free();
  }
}

/** Paper layer JSON → content string, carrying `instances` through. */
export function paperLayerJsonToContent(
  layerJson: string,
  palette: Palette,
  instances: readonly PlacedInstance[] = [],
): string {
  if (!layerJson) return encodeLayerContent(null, instances);
  ensurePaperScope();
  const layer = new paper.Layer({ insert: false });
  try {
    layer.importJSON(layerJson);
    const items: paper.Item[] = [];
    const walk = (it: paper.Item) => {
      if (it instanceof paper.Path || it instanceof paper.CompoundPath) items.push(it);
      else for (const c of it.children ?? []) walk(c);
    };
    for (const c of layer.children ?? []) walk(c);
    const art = paperPathsToLayer(items, palette);
    const out = encodeLayerContent(art, instances);
    art.free();
    return out;
  } finally {
    layer.remove();
  }
}

/** A point strictly inside `path`, or null. */
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
