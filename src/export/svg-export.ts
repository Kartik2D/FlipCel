/**
 * SVG document export with options (auto-crop, stage fill, split layers).
 */
import type { PaperRenderer } from "../render/paper/paper-renderer";
import type { StageSettings } from "../state/document-ui";
import {
  isLayerEffectivelyVisible,
  layerStore,
} from "../state/document-ui";
import { buildStoreZip, type ZipEntry } from "./zip-store";

export type SvgExportOptions = {
  /** Crop to artwork bounds instead of the full stage. */
  autoCrop: boolean;
  /** When false, fill the export bounds with the stage color. */
  transparentStage: boolean;
  /** One SVG file per visible layer (ZIP). */
  splitLayers: boolean;
};

export const DEFAULT_SVG_EXPORT_OPTIONS: SvgExportOptions = {
  autoCrop: true,
  transparentStage: true,
  splitLayers: false,
};

export type SvgExportResult = {
  /** Single SVG or a ZIP of per-layer SVGs. */
  bytes: Uint8Array;
  filename: string;
  mime: string;
};

function sanitizeFileBase(name: string): string {
  const trimmed = name.trim().replace(/\.json$/i, "");
  const s = trimmed.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return s || "flipcel";
}

function uniqueFileBases(names: string[]): string[] {
  const used = new Map<string, number>();
  return names.map((name) => {
    const base = sanitizeFileBase(name);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
}

function visibleLayers(): Array<{ id: string; name: string }> {
  const { layers, soloLayerId } = layerStore.get();
  return layers
    .filter(
      (l) =>
        l.kind !== "stage" && isLayerEffectivelyVisible(l, soloLayerId),
    )
    .map((l) => ({ id: l.id, name: l.name }));
}

function encodeSvg(svg: string): Uint8Array {
  return new TextEncoder().encode(svg);
}

/**
 * Export the current Paper document as SVG (or a ZIP of layer SVGs).
 */
export function exportDocumentSvg(opts: {
  paperRenderer: PaperRenderer;
  stage: StageSettings;
  documentName: string;
  options?: Partial<SvgExportOptions>;
}): SvgExportResult {
  const options: SvgExportOptions = {
    ...DEFAULT_SVG_EXPORT_OPTIONS,
    ...opts.options,
  };
  const baseName = sanitizeFileBase(opts.documentName);
  const stageBounds = {
    x: 0,
    y: 0,
    width: Math.max(1, Math.round(opts.stage.width)),
    height: Math.max(1, Math.round(opts.stage.height)),
  };
  const bounds = options.autoCrop ? ("content" as const) : stageBounds;
  const stageFill = options.transparentStage
    ? null
    : opts.stage.color || "#ffffff";

  const layers = visibleLayers();
  if (layers.length === 0) {
    throw new Error("No visible layers to export");
  }

  if (!options.splitLayers) {
    const svg = opts.paperRenderer.exportDocumentSvgString({
      bounds,
      stageFill,
    });
    return {
      bytes: encodeSvg(svg),
      filename: `${baseName}.svg`,
      mime: "image/svg+xml;charset=utf-8",
    };
  }

  const fileBases = uniqueFileBases(layers.map((l) => l.name));
  const entries: ZipEntry[] = [];
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!;
    const svg = opts.paperRenderer.exportDocumentSvgString({
      bounds,
      onlyLayerId: layer.id,
      stageFill,
    });
    entries.push({
      path: `${baseName}/${fileBases[i]}.svg`,
      data: encodeSvg(svg),
    });
  }

  return {
    bytes: buildStoreZip(entries),
    filename: `${baseName}-svg.zip`,
    mime: "application/zip",
  };
}
