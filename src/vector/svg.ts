/**
 * SVG output from kernel regions (fills only, even-odd).
 */
import { applyAffine, mulAffine, type Affine, type Ring } from "./kernel";
import type { VectorLayer } from "./kernel";
import type { Palette } from "./palette";
import { contentCache } from "./content";
import { childFrameFor, resolveSymbolFrame, type SymbolResolver } from "../document/symbols";

const MAX_DEPTH = 8;

const fmt = (v: number): string => {
  const r = Math.round(v * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r);
};

export function ringsToPathData(rings: readonly Ring[], xf: Affine | null = null): string {
  const t = (p: { x: number; y: number }) => (xf ? applyAffine(xf, p) : p);
  const parts: string[] = [];
  for (const r of rings) {
    const s = t(r.start);
    parts.push(`M${fmt(s.x)} ${fmt(s.y)}`);
    for (const seg of r.segs) {
      const to = t(seg.to);
      if (seg.kind === "L") parts.push(`L${fmt(to.x)} ${fmt(to.y)}`);
      else if (seg.kind === "Q") {
        const c = t(seg.c);
        parts.push(`Q${fmt(c.x)} ${fmt(c.y)} ${fmt(to.x)} ${fmt(to.y)}`);
      } else {
        const c1 = t(seg.c1);
        const c2 = t(seg.c2);
        parts.push(`C${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(to.x)} ${fmt(to.y)}`);
      }
    }
    parts.push("Z");
  }
  return parts.join("");
}

/** `<path>` elements for every filled region of a layer. */
export function layerToSvgPaths(layer: VectorLayer, palette: Palette, xf: Affine | null = null): string {
  const out: string[] = [];
  for (const region of layer.regions()) {
    const color = palette.colorOf(region.fill);
    if (!color) continue;
    out.push(`<path d="${ringsToPathData(region.rings, xf)}" fill="${color}" fill-rule="evenodd"/>`);
  }
  return out.join("");
}

/**
 * `<path>` elements for a content string, recursing into symbol instances.
 * `elapsed` is the frames since the owning keyframe (drives instance playback).
 */
export function contentToSvgPaths(
  json: string,
  palette: Palette,
  resolver: SymbolResolver,
  xf: Affine | null = null,
  elapsed = 0,
  depth = 0,
): string {
  if (depth >= MAX_DEPTH) return "";
  const { layer, content } = contentCache.get(json);
  const out: string[] = [];
  if (layer) out.push(layerToSvgPaths(layer, palette, xf));
  for (const inst of content.instances) {
    const symbol = resolver.getSymbol(inst.symbol);
    if (!symbol) continue;
    const frame = childFrameFor(inst, elapsed, symbol.duration);
    const m = xf ? mulAffine(xf, inst.matrix) : inst.matrix;
    for (const l of resolveSymbolFrame(symbol, frame, resolver)) {
      out.push(contentToSvgPaths(l.json, palette, resolver, m, frame - l.keyframeFrame, depth + 1));
    }
  }
  return out.join("");
}

export function wrapSvg(
  body: string,
  width: number,
  height: number,
  opts: { background?: string | null; viewBox?: [number, number, number, number] } = {},
): string {
  const vb = opts.viewBox ?? [0, 0, width, height];
  const bg = opts.background
    ? `<rect x="${fmt(vb[0])}" y="${fmt(vb[1])}" width="${fmt(vb[2])}" height="${fmt(vb[3])}" fill="${opts.background}"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}" viewBox="${vb.map(fmt).join(" ")}">${bg}${body}</svg>`;
}
