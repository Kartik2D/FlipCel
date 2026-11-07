/**
 * Direct SVG import helpers (no tracer). Strokes are expanded to filled outlines.
 */
import { nearestDocumentColor } from "./image-import";
import type { StageRenderer } from "../render/stage-renderer";
import { PaintMode, ringBounds, transformRing, type Affine, type Bounds, type Ring } from "../vector/kernel";
import { parseSvgShapes } from "../vector/rings";
import { cssToHex } from "../vector/palette";

export type SvgImportOptions = {
  snapToDocumentColors: boolean;
};

export const DEFAULT_SVG_IMPORT_OPTIONS: SvgImportOptions = {
  snapToDocumentColors: false,
};

const PREVIEW_COLOR_ATTRS = ["fill", "stroke", "stop-color", "flood-color"] as const;

/**
 * Remap paint colors in an SVG string to the nearest document color (preview only).
 * Leaves `none` / `currentColor` / urls alone.
 */
export function remapSvgColorsForPreview(svgText: string, palette: string[]): string {
  if (palette.length === 0) return svgText;
  try {
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    if (doc.querySelector("parsererror")) return svgText;

    const snap = (value: string | null): string | null => {
      if (!value) return value;
      const v = value.trim();
      if (!v || v === "none" || v === "transparent" || v.startsWith("url(")) return value;
      if (v === "currentColor" || v === "inherit") return value;
      if (!v.startsWith("#") && !/^(rgb|hsl)/i.test(v)) return value;
      // Canvas can resolve named/rgb via a throwaway element.
      const hex = cssColorToHex(v);
      if (!hex) return value;
      return nearestDocumentColor(hex, palette);
    };

    for (const el of doc.querySelectorAll("*")) {
      for (const attr of PREVIEW_COLOR_ATTRS) {
        if (!el.hasAttribute(attr)) continue;
        const next = snap(el.getAttribute(attr));
        if (next != null) el.setAttribute(attr, next);
      }
      const style = el.getAttribute("style");
      if (style) {
        const nextStyle = style.replace(
          /(^|;)\s*(fill|stroke|stop-color|flood-color)\s*:\s*([^;]+)/gi,
          (_m, sep: string, prop: string, val: string) => {
            const snapped = snap(val);
            return `${sep}${prop}:${snapped ?? val}`;
          },
        );
        el.setAttribute("style", nextStyle);
      }
    }

    const root = doc.documentElement;
    return new XMLSerializer().serializeToString(root);
  } catch {
    return svgText;
  }
}

let cssColorCanvas: HTMLCanvasElement | null = null;

function cssColorToHex(value: string): string | null {
  const v = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(v)) {
    if (v.length === 4) {
      return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
    }
    if (v.length >= 7) return v.slice(0, 7).toLowerCase();
  }
  cssColorCanvas ??= document.createElement("canvas");
  const ctx = cssColorCanvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#000000";
  ctx.fillStyle = v;
  const resolved = ctx.fillStyle;
  if (typeof resolved !== "string" || !resolved.startsWith("#")) return null;
  return resolved.slice(0, 7).toLowerCase();
}

export function isSvgFile(file: File): boolean {
  if (file.type === "image/svg+xml") return true;
  return /\.svg$/i.test(file.name);
}

/** Native file picker for a single SVG. */
export function pickSvgFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".svg,image/svg+xml";
    input.style.display = "none";
    document.body.appendChild(input);

    const cleanup = () => input.remove();

    input.addEventListener("change", () => {
      const file = input.files?.[0] ?? null;
      cleanup();
      resolve(file);
    });
    input.addEventListener("cancel", () => {
      cleanup();
      resolve(null);
    });

    input.click();
  });
}

export function fileToSvgText(file: File): Promise<string> {
  return file.text();
}

/**
 * Import an SVG onto the renderer's active layer in stage/world space.
 * Shapes are painted bottom → top (painter's order) through the kernel;
 * strokes become filled outlines (FlipCel is fill-only). The artwork is
 * fitted and centered on the stage. Returns false when nothing was drawn.
 */
export function importSvgOntoActiveLayer(
  renderer: StageRenderer,
  svg: string,
  options: {
    stageWidth: number;
    stageHeight: number;
    snapColors?: string[];
    fillOverride?: string | null;
  },
): boolean {
  const palette = renderer.getPalette();
  const layerId = renderer.getActiveLayerId();
  if (!palette || !layerId) return false;

  // Fitted to the stage below, so the SVG's own viewBox / size do not matter.
  const shapes = parseSvgShapes(svg).filter((s) => s.fill != null);
  if (shapes.length === 0) return false;

  let bounds: Bounds | null = null;
  for (const s of shapes) bounds = unionBounds(bounds, ringBounds(s.rings));
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return false;

  const scale = Math.min(options.stageWidth / bounds.width, options.stageHeight / bounds.height);
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const tx = options.stageWidth / 2 - cx * scale;
  const ty = options.stageHeight / 2 - cy * scale;
  const fit: Affine = [scale, 0, 0, scale, tx, ty];

  let painted = false;
  for (const shape of shapes) {
    let hex = options.fillOverride ?? cssToHex(shape.fill!);
    if (!hex) continue;
    if (options.snapColors && options.snapColors.length > 0) {
      hex = nearestDocumentColor(hex, options.snapColors);
    }
    const rings: Ring[] = shape.rings.map((r) => transformRing(r, fit));
    renderer.paint(rings, palette.fillFor(hex), PaintMode.Over, 0, layerId);
    painted = true;
  }
  return painted;
}

function unionBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const r = Math.max(a.x + a.width, b.x + b.width);
  const bt = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: r - x, height: bt - y };
}
