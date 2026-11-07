/**
 * SVG document export with options (auto-crop, stage fill, split layers, frame range).
 * Builds SVG straight from stored kernel content — does not seek the live playhead.
 */
import type { DocumentManager } from "../document/document";
import { contentToSvgPaths, wrapSvg } from "../vector/svg";
import { isImageContent } from "../vector/content";
import type { StageSettings } from "../state/document-ui";
import {
  isLayerEffectivelyVisible,
  layerStore,
} from "../state/document-ui";
import { buildStoreZip, type ZipEntry } from "./zip-store";
import {
  flattenExportFilename,
  type ExportBundle,
  type ExportFile,
} from "./download";

export type SvgExportOptions = {
  /** Crop to artwork bounds instead of the full stage. */
  autoCrop: boolean;
  /** When false, fill the export bounds with the stage color. */
  transparentStage: boolean;
  /** One SVG file per visible layer. */
  splitLayers: boolean;
  /** Inclusive 1-based start frame. */
  frameFrom: number;
  /** Inclusive 1-based end frame. */
  frameTo: number;
  /** Package multiple outputs as a ZIP, or download each file. */
  bundle: ExportBundle;
};

export const DEFAULT_SVG_EXPORT_OPTIONS: SvgExportOptions = {
  autoCrop: false,
  transparentStage: true,
  splitLayers: false,
  frameFrom: 1,
  frameTo: 1,
  bundle: "zip",
};

export type SvgExportResult = {
  files: ExportFile[];
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

function clampFrameRange(
  from1: number,
  to1: number,
  duration: number,
): { from0: number; to0: number } {
  const max1 = Math.max(1, duration);
  let a = Math.round(Number.isFinite(from1) ? from1 : 1);
  let b = Math.round(Number.isFinite(to1) ? to1 : a);
  a = Math.min(max1, Math.max(1, a));
  b = Math.min(max1, Math.max(1, b));
  if (b < a) [a, b] = [b, a];
  return { from0: a - 1, to0: b - 1 };
}

function frameFileLabel(frame0: number, duration: number): string {
  const digits = String(Math.max(1, duration)).length;
  return String(frame0 + 1).padStart(Math.max(2, digits), "0");
}

/**
 * Build one SVG for a timeline frame from stored layer content.
 */
function exportFrameSvgString(opts: {
  documentManager: DocumentManager;
  stage: StageSettings;
  frame: number;
  trackIds: string[];
  autoCrop: boolean;
  stageFill: string | null;
}): string {
  const w = Math.max(1, Math.round(opts.stage.width));
  const h = Math.max(1, Math.round(opts.stage.height));
  const dm = opts.documentManager;
  const palette = dm.palette;
  const resolver = dm.symbolResolver;
  const renderer = dm.getRenderer();

  const body: string[] = [];
  const jsons: string[] = [];
  for (const layerId of opts.trackIds) {
    const json = dm.getLayerContentAtFrame(layerId, opts.frame);
    if (!json || isImageContent(json)) continue;
    const start = dm.getCoveringKeyframeFrame(layerId, opts.frame) ?? opts.frame;
    body.push(contentToSvgPaths(json, palette, resolver, null, opts.frame - start));
    jsons.push(json);
  }

  let viewBox: [number, number, number, number] = [0, 0, w, h];
  if (opts.autoCrop) {
    const b = renderer.contentBounds(jsons);
    if (b && b.width > 0 && b.height > 0) viewBox = [b.x, b.y, b.width, b.height];
  }
  return wrapSvg(body.join(""), viewBox[2], viewBox[3], { background: opts.stageFill, viewBox });
}

/**
 * Export document frames as SVG (or a ZIP of layer / frame SVGs).
 */
export function exportDocumentSvg(opts: {
  documentManager: DocumentManager;
  stage: StageSettings;
  documentName: string;
  options?: Partial<SvgExportOptions>;
}): SvgExportResult {
  const options: SvgExportOptions = {
    ...DEFAULT_SVG_EXPORT_OPTIONS,
    ...opts.options,
  };
  const duration = Math.max(1, opts.documentManager.getDuration());
  const { from0, to0 } = clampFrameRange(
    options.frameFrom,
    options.frameTo,
    duration,
  );
  const frames: number[] = [];
  for (let f = from0; f <= to0; f++) frames.push(f);

  const baseName = sanitizeFileBase(opts.documentName);
  const stageFill = options.transparentStage
    ? null
    : opts.stage.color || "#ffffff";

  const layers = visibleLayers();
  if (layers.length === 0) {
    throw new Error("No visible layers to export");
  }

  const multiFrame = frames.length > 1;
  const fileBases = uniqueFileBases(layers.map((l) => l.name));
  const entries: ZipEntry[] = [];

  if (!multiFrame && !options.splitLayers) {
    const svg = exportFrameSvgString({
      documentManager: opts.documentManager,
      stage: opts.stage,
      frame: frames[0]!,
      trackIds: layers.map((l) => l.id),
      autoCrop: options.autoCrop,
      stageFill,
    });
    entries.push({
      path: `${baseName}.svg`,
      data: encodeSvg(svg),
    });
  } else {
    for (const frame of frames) {
      const label = frameFileLabel(frame, duration);
      if (!options.splitLayers) {
        const svg = exportFrameSvgString({
          documentManager: opts.documentManager,
          stage: opts.stage,
          frame,
          trackIds: layers.map((l) => l.id),
          autoCrop: options.autoCrop,
          stageFill,
        });
        entries.push({
          path: `${baseName}/${label}.svg`,
          data: encodeSvg(svg),
        });
        continue;
      }

      for (let i = 0; i < layers.length; i++) {
        const layer = layers[i]!;
        const svg = exportFrameSvgString({
          documentManager: opts.documentManager,
          stage: opts.stage,
          frame,
          trackIds: [layer.id],
          autoCrop: options.autoCrop,
          stageFill,
        });
        const path = multiFrame
          ? `${baseName}/${fileBases[i]}/${label}.svg`
          : `${baseName}/${fileBases[i]}.svg`;
        entries.push({ path, data: encodeSvg(svg) });
      }
    }
  }

  if (entries.length === 1) {
    const only = entries[0]!;
    return {
      files: [
        {
          filename: flattenExportFilename(only.path),
          bytes: only.data,
          mime: "image/svg+xml;charset=utf-8",
        },
      ],
    };
  }

  if (options.bundle === "files") {
    return {
      files: entries.map((entry) => ({
        filename: flattenExportFilename(entry.path),
        bytes: entry.data,
        mime: "image/svg+xml;charset=utf-8",
      })),
    };
  }

  return {
    files: [
      {
        filename: `${baseName}-svg.zip`,
        bytes: buildStoreZip(entries),
        mime: "application/zip",
      },
    ],
  };
}
