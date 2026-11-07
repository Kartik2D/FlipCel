import { hexToRgb } from "../color/spaces";
import { normalizeDocumentHex } from "../document/colors";

export type VtracerClustering = "watershed";
export type VtracerHierarchical = "cutout";
export type VtracerMode = "pixel" | "polygon" | "spline";
export type VtracerPreset = "cel" | "flat" | "ink";
export type VtracerOptimize = 0 | 1 | 2;

export type ImageImportOptions = {
  clustering: VtracerClustering;
  hierarchical: VtracerHierarchical;
  mode: VtracerMode;
  filterSpeckle: number;
  colorPrecision: number;
  layerDifference: number;
  cornerThreshold: number;
  lengthThreshold: number;
  maxIterations: number;
  spliceThreshold: number;
  simplify: number;
  pathPrecision: number;
  maxColors: number;
  optimize: VtracerOptimize;
  binaryThreshold: number;
  adaptive: boolean;
  adaptiveWindow: number;
  adaptiveT: number;
  watershedDetail: number;
  useDocPalette: boolean;
  snapToDocumentColors: boolean;
};

export const DEFAULT_IMAGE_IMPORT_OPTIONS: ImageImportOptions = {
  clustering: "watershed",
  hierarchical: "cutout",
  mode: "spline",
  filterSpeckle: 6,
  colorPrecision: 6,
  layerDifference: 24,
  cornerThreshold: 60,
  lengthThreshold: 4,
  maxIterations: 10,
  spliceThreshold: 45,
  simplify: 0.4,
  pathPrecision: 2,
  maxColors: 12,
  optimize: 1,
  binaryThreshold: 128,
  adaptive: false,
  adaptiveWindow: 0,
  adaptiveT: 15,
  watershedDetail: 128,
  useDocPalette: false,
  snapToDocumentColors: false,
};

const CEL_PRESET: ImageImportOptions = { ...DEFAULT_IMAGE_IMPORT_OPTIONS };

const FLAT_PRESET: ImageImportOptions = {
  ...DEFAULT_IMAGE_IMPORT_OPTIONS,
  filterSpeckle: 14,
  colorPrecision: 4,
  layerDifference: 48,
  cornerThreshold: 80,
  simplify: 1.2,
  maxColors: 6,
  watershedDetail: 72,
};

const INK_PRESET: ImageImportOptions = {
  ...DEFAULT_IMAGE_IMPORT_OPTIONS,
  filterSpeckle: 10,
  colorPrecision: 3,
  layerDifference: 64,
  simplify: 0.8,
  maxColors: 2,
  watershedDetail: 40,
};

export const VTRACER_PRESETS: Record<VtracerPreset, ImageImportOptions> = {
  cel: CEL_PRESET,
  flat: FLAT_PRESET,
  ink: INK_PRESET,
};

export const MAX_IMPORT_PIXELS = 4_000_000;

export function applyVtracerPreset(
  preset: VtracerPreset,
  keep: Pick<ImageImportOptions, "useDocPalette" | "snapToDocumentColors">,
): ImageImportOptions {
  return { ...VTRACER_PRESETS[preset], ...keep };
}

export function toVtracerWasmOptions(
  options: ImageImportOptions,
  docPalette: string[] = [],
): Record<string, unknown> {
  const wasm: Record<string, unknown> = {
    clustering: "watershed",
    hierarchical: "cutout",
    mode: options.mode,
    filterSpeckle: options.filterSpeckle,
    colorPrecision: options.colorPrecision,
    layerDifference: options.layerDifference,
    cornerThreshold: options.cornerThreshold,
    lengthThreshold: options.lengthThreshold,
    maxIterations: options.maxIterations,
    spliceThreshold: options.spliceThreshold,
    pathPrecision: options.pathPrecision,
    optimize: options.optimize,
    binaryThreshold: options.binaryThreshold,
    adaptive: options.adaptive,
    adaptiveWindow: options.adaptiveWindow,
    adaptiveT: options.adaptiveT,
    watershedDetail: options.watershedDetail,
  };
  if (options.simplify > 0) wasm.simplify = options.simplify;
  if (options.maxColors > 0) wasm.maxColors = options.maxColors;
  if (options.useDocPalette && docPalette.length > 0) wasm.palette = docPalette;
  return wasm;
}

export function isImageFile(file: File): boolean {
  // SVGs use the direct import path (no tracer).
  if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name)) return false;
  if (file.type.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name);
}

/** Native file picker for a single image. */
export function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
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

/** Decode an image file onto a canvas, downscaling if above the wasm-safe size. */
export async function fileToTraceCanvas(file: File): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  try {
    let { width, height } = bitmap;
    const pixels = width * height;
    if (pixels > MAX_IMPORT_PIXELS) {
      const scale = Math.sqrt(MAX_IMPORT_PIXELS / pixels);
      width = Math.max(1, Math.floor(width * scale));
      height = Math.max(1, Math.floor(height * scale));
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2D context");
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas;
  } finally {
    bitmap.close();
  }
}

export function canvasToImageData(canvas: HTMLCanvasElement): ImageData {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context");
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export function nearestDocumentColor(hex: string, palette: string[]): string {
  if (palette.length === 0) return normalizeDocumentHex(hex);
  const [r, g, b] = hexToRgb(normalizeDocumentHex(hex));
  let best = palette[0];
  let bestDist = Infinity;
  for (const candidate of palette) {
    const [cr, cg, cb] = hexToRgb(normalizeDocumentHex(candidate));
    const dist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return normalizeDocumentHex(best);
}

