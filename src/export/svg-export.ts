/**
 * SVG document export with options (auto-crop, stage fill, split layers, frame range).
 * Multi-frame export uses an offscreen PaperScope — does not seek the live playhead.
 */
import paper from "paper";
import { hydrateLayer } from "../render/paper/symbol-instances";
import type { DocumentManager } from "../document/document";
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
 * Build one SVG for a timeline frame from stored layer JSON (isolated PaperScope).
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

  const paperCanvas = document.createElement("canvas");
  paperCanvas.setAttribute("hidpi", "off");
  paperCanvas.width = w;
  paperCanvas.height = h;

  const mainScope = paper;
  const scope = new paper.PaperScope();
  try {
    scope.setup(paperCanvas);
    scope.view.viewSize = new scope.Size(w, h);
    scope.view.matrix.reset();
    scope.settings.applyMatrix = true;
    scope.project.clear();

    for (const layerId of opts.trackIds) {
      const json = opts.documentManager.getLayerContentAtFrame(
        layerId,
        opts.frame,
      );
      if (!json) continue;
      const layer = new scope.Layer();
      layer.importJSON(json);
      // Symbol instances are stored as empty groups: resolve their artwork.
      const start =
        opts.documentManager.getCoveringKeyframeFrame(layerId, opts.frame) ?? opts.frame;
      hydrateLayer(layer, opts.documentManager.symbolResolver, opts.frame - start, scope);
    }

    let bg: paper.Path | null = null;
    const stageBox = new scope.Rectangle(0, 0, w, h);
    let bounds: "content" | paper.Rectangle = opts.autoCrop
      ? "content"
      : stageBox;

    if (opts.stageFill) {
      let box: paper.Rectangle | null = opts.autoCrop ? null : stageBox;
      if (!box) {
        for (const layer of scope.project.layers) {
          if (!layer.visible) continue;
          const b = layer.bounds;
          if (!b || (b.width <= 0 && b.height <= 0)) continue;
          box = box ? box.unite(b) : b.clone();
        }
      }
      if (box && box.width > 0 && box.height > 0) {
        bg = new scope.Path.Rectangle(box);
        bg.fillColor = new scope.Color(opts.stageFill);
        bg.strokeColor = null;
        const host = scope.project.layers[0] ?? new scope.Layer();
        host.insertChild(0, bg);
      }
    }

    scope.view.update();
    return scope.project.exportSVG({
      bounds,
      matrix: new scope.Matrix(),
      asString: true,
      precision: 4,
    }) as string;
  } finally {
    scope.project.clear();
    mainScope.activate();
  }
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
