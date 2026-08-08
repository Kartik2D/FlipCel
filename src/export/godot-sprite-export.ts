/**
 * Godot 4 spritesheet + AnimatedSprite2D scene export.
 *
 * Builds stage- (or crop-) sized cell grid PNGs and a .tscn with SpriteFrames
 * (one animation per frame tag). Offscreen PaperScope — does not seek the
 * live playhead.
 */
import paper from "paper";
import type { DocumentManager, FrameTag } from "../document/document";
import type { StageSettings } from "../state/document-ui";
import {
  isLayerEffectivelyVisible,
  layerStore,
} from "../state/document-ui";
import { buildStoreZip, type ZipEntry } from "./zip-store";

export type GodotExportScale = 1 | 2 | 4 | 8;

export type GodotExportOptions = {
  /** One spritesheet + AnimatedSprite2D per visible layer. */
  splitLayers: boolean;
  /** Crop cells to the smallest axis-aligned rect covering all opaque pixels. */
  autoCrop: boolean;
  /** Skip stage color fill (PNG alpha). */
  transparentStage: boolean;
  /** Upscale factor applied after crop (nearest-neighbor). */
  scale: GodotExportScale;
};

export const DEFAULT_GODOT_EXPORT_OPTIONS: GodotExportOptions = {
  splitLayers: false,
  autoCrop: true,
  transparentStage: true,
  scale: 1,
};

export type GodotExportResult = {
  zipBytes: Uint8Array;
  zipFilename: string;
};

type AnimSpec = {
  name: string;
  frameIndices: number[];
};

type Rect = { x: number; y: number; w: number; h: number };

type LayerSheet = {
  id: string;
  name: string;
  fileBase: string;
  cells: HTMLCanvasElement[];
  cellW: number;
  cellH: number;
  frameToCell: Map<number, number>;
};

function sanitizeFileBase(name: string): string {
  const trimmed = name.trim().replace(/\.json$/i, "");
  const s = trimmed.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return s || "flipcel";
}

function sanitizeAnimName(name: string): string {
  let s = name.trim().replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!s) s = "anim";
  if (/^\d/.test(s)) s = `anim_${s}`;
  return s;
}

function uniqueAnimNames(tags: FrameTag[]): string[] {
  const used = new Map<string, number>();
  return tags.map((tag) => {
    const base = sanitizeAnimName(tag.name);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
}

function collectAnimations(
  tags: FrameTag[],
  duration: number,
): AnimSpec[] {
  if (tags.length === 0) {
    const frameIndices = Array.from({ length: Math.max(1, duration) }, (_, i) => i);
    return [{ name: "default", frameIndices }];
  }
  const names = uniqueAnimNames(tags);
  return tags.map((tag, i) => {
    const start = Math.max(0, Math.min(duration - 1, Math.min(tag.start, tag.end)));
    const end = Math.max(0, Math.min(duration - 1, Math.max(tag.start, tag.end)));
    const frameIndices: number[] = [];
    for (let f = start; f <= end; f++) frameIndices.push(f);
    return { name: names[i]!, frameIndices };
  });
}

function uniqueFrameIndices(anims: AnimSpec[]): number[] {
  const set = new Set<number>();
  for (const a of anims) for (const f of a.frameIndices) set.add(f);
  return [...set].sort((a, b) => a - b);
}

function sheetColumns(count: number): number {
  if (count <= 0) return 1;
  return Math.min(count, Math.ceil(Math.sqrt(count)));
}

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Failed to encode spritesheet PNG"));
          return;
        }
        void blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
      },
      "image/png",
    );
  });
}

/** Visible regular layers, bottom → top (id + display name). */
function visibleLayers(): Array<{ id: string; name: string }> {
  const { layers, soloLayerId } = layerStore.get();
  return layers
    .filter(
      (l) =>
        l.kind !== "stage" && isLayerEffectivelyVisible(l, soloLayerId),
    )
    .map((l) => ({ id: l.id, name: l.name }));
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

/**
 * Rasterize one timeline frame into a stage-sized canvas.
 * Uses an isolated PaperScope so the live project is untouched.
 */
function rasterizeFrame(
  documentManager: DocumentManager,
  stage: StageSettings,
  frame: number,
  trackIds: string[],
  transparentStage: boolean,
): HTMLCanvasElement {
  const w = Math.max(1, Math.round(stage.width));
  const h = Math.max(1, Math.round(stage.height));

  const paperCanvas = document.createElement("canvas");
  // Paper.js HiDPI multiplies backing-store size by devicePixelRatio unless
  // hidpi is off. Without this, copying w×h pixels crops to the top-left of
  // the stage (centered art lands on cell edges / looks "sliced").
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
    for (const layerId of trackIds) {
      const json = documentManager.getLayerContentAtFrame(layerId, frame);
      if (!json) continue;
      const layer = new scope.Layer();
      layer.importJSON(json);
    }
    scope.view.update();
  } finally {
    mainScope.activate();
  }

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Could not create export canvas");
  if (!transparentStage) {
    ctx.fillStyle = stage.color || "#ffffff";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(paperCanvas, 0, 0, w, h);

  scope.activate();
  scope.project.clear();
  mainScope.activate();

  return out;
}

/** Smallest axis-aligned rect covering any non-transparent pixel, or null if empty. */
function alphaBounds(canvas: HTMLCanvasElement): Rect | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const r = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: r - x, h: bottom - y };
}

function cropCanvas(src: HTMLCanvasElement, rect: Rect): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = Math.max(1, rect.w);
  out.height = Math.max(1, rect.h);
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Could not crop export canvas");
  ctx.drawImage(
    src,
    rect.x,
    rect.y,
    rect.w,
    rect.h,
    0,
    0,
    rect.w,
    rect.h,
  );
  return out;
}

function scaleCanvas(
  src: HTMLCanvasElement,
  scale: number,
): HTMLCanvasElement {
  if (scale === 1) return src;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(src.width * scale));
  out.height = Math.max(1, Math.round(src.height * scale));
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Could not scale export canvas");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

async function packSheet(
  cells: HTMLCanvasElement[],
  cellW: number,
  cellH: number,
  fill: string | null,
): Promise<{ png: Uint8Array; cols: number }> {
  const cols = sheetColumns(cells.length);
  const rows = Math.ceil(cells.length / cols);
  const sheet = document.createElement("canvas");
  sheet.width = cols * cellW;
  sheet.height = rows * cellH;
  const sheetCtx = sheet.getContext("2d");
  if (!sheetCtx) throw new Error("Could not create spritesheet canvas");
  if (fill) {
    sheetCtx.fillStyle = fill;
    sheetCtx.fillRect(0, 0, sheet.width, sheet.height);
  }
  for (let i = 0; i < cells.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    sheetCtx.drawImage(cells[i]!, col * cellW, row * cellH);
  }
  return { png: await canvasToPngBytes(sheet), cols };
}

function buildSpriteFramesBlock(opts: {
  texExtId: string;
  atlasPrefix: string;
  spriteFramesId: string;
  cellW: number;
  cellH: number;
  cols: number;
  fps: number;
  uniqueFrames: number[];
  frameToCell: Map<number, number>;
  anims: AnimSpec[];
}): { atlasResources: string; spriteFrames: string; atlasCount: number } {
  const {
    texExtId,
    atlasPrefix,
    spriteFramesId,
    cellW,
    cellH,
    cols,
    fps,
    uniqueFrames,
    frameToCell,
    anims,
  } = opts;
  const atlasCount = uniqueFrames.length;
  const atlasLines: string[] = [];
  for (let i = 0; i < atlasCount; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * cellW;
    const y = row * cellH;
    atlasLines.push(`[sub_resource type="AtlasTexture" id="${atlasPrefix}${i}"]`);
    atlasLines.push(`atlas = ExtResource("${texExtId}")`);
    atlasLines.push(`region = Rect2(${x}, ${y}, ${cellW}, ${cellH})`);
    atlasLines.push("");
  }

  const animBlocks = anims.map((anim) => {
    const frames = anim.frameIndices.map((fi) => {
      const cell = frameToCell.get(fi) ?? 0;
      return `{\n"duration": 1.0,\n"texture": SubResource("${atlasPrefix}${cell}")\n}`;
    });
    return `{\n"frames": [${frames.join(", ")}],\n"loop": true,\n"name": &"${anim.name}",\n"speed": ${fps}\n}`;
  });

  const spriteFrames =
    `[sub_resource type="SpriteFrames" id="${spriteFramesId}"]\n` +
    `animations = [${animBlocks.join(", ")}]\n`;

  return {
    atlasResources: atlasLines.join("\n"),
    spriteFrames,
    atlasCount,
  };
}

function buildFlatTscn(opts: {
  baseName: string;
  folder: string;
  pngName: string;
  cellW: number;
  cellH: number;
  cols: number;
  fps: number;
  uniqueFrames: number[];
  frameToCell: Map<number, number>;
  anims: AnimSpec[];
}): string {
  const texPath = `res://${opts.folder}/${opts.pngName}`;
  const built = buildSpriteFramesBlock({
    texExtId: "1_tex",
    atlasPrefix: "AtlasTexture_",
    spriteFramesId: "SpriteFrames_1",
    cellW: opts.cellW,
    cellH: opts.cellH,
    cols: opts.cols,
    fps: opts.fps,
    uniqueFrames: opts.uniqueFrames,
    frameToCell: opts.frameToCell,
    anims: opts.anims,
  });
  const loadSteps = 1 + built.atlasCount + 1;
  const defaultAnim = opts.anims[0]?.name ?? "default";
  return [
    `[gd_scene load_steps=${loadSteps} format=3]`,
    "",
    `[ext_resource type="Texture2D" path="${texPath}" id="1_tex"]`,
    "",
    built.atlasResources,
    built.spriteFrames,
    "",
    `[node name="${opts.baseName}" type="AnimatedSprite2D"]`,
    `sprite_frames = SubResource("SpriteFrames_1")`,
    `animation = &"${defaultAnim}"`,
    "",
  ].join("\n");
}

function buildSplitTscn(opts: {
  baseName: string;
  folder: string;
  layers: LayerSheet[];
  colsByLayer: number[];
  fps: number;
  uniqueFrames: number[];
  anims: AnimSpec[];
}): string {
  const { baseName, folder, layers, colsByLayer, fps, uniqueFrames, anims } =
    opts;
  const defaultAnim = anims[0]?.name ?? "default";

  // ext resources: one texture per layer
  const extLines: string[] = [];
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!;
    extLines.push(
      `[ext_resource type="Texture2D" path="res://${folder}/${layer.fileBase}.png" id="${i + 1}_tex"]`,
    );
  }

  let atlasTotal = 0;
  const subBlocks: string[] = [];
  const nodeLines: string[] = [
    `[node name="${baseName}" type="Node2D"]`,
    "",
  ];

  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li]!;
    const prefix = `L${li}_`;
    const framesId = `${prefix}SpriteFrames`;
    const built = buildSpriteFramesBlock({
      texExtId: `${li + 1}_tex`,
      atlasPrefix: `${prefix}Atlas_`,
      spriteFramesId: framesId,
      cellW: layer.cellW,
      cellH: layer.cellH,
      cols: colsByLayer[li]!,
      fps,
      uniqueFrames,
      frameToCell: layer.frameToCell,
      anims,
    });
    atlasTotal += built.atlasCount;
    subBlocks.push(built.atlasResources);
    subBlocks.push(built.spriteFrames);
    subBlocks.push("");
    nodeLines.push(
      `[node name="${layer.fileBase}" type="AnimatedSprite2D" parent="."]`,
    );
    nodeLines.push(`sprite_frames = SubResource("${framesId}")`);
    nodeLines.push(`animation = &"${defaultAnim}"`);
    nodeLines.push("");
  }

  // load_steps = ext + atlases + spriteframes(per layer)
  const loadSteps = layers.length + atlasTotal + layers.length;
  return [
    `[gd_scene load_steps=${loadSteps} format=3]`,
    "",
    ...extLines,
    "",
    ...subBlocks,
    ...nodeLines,
  ].join("\n");
}

function processCells(
  raw: HTMLCanvasElement[],
  options: GodotExportOptions,
  stage: StageSettings,
): { cells: HTMLCanvasElement[]; cellW: number; cellH: number } {
  let crop: Rect | null = null;
  if (options.autoCrop) {
    for (const c of raw) crop = unionRect(crop, alphaBounds(c));
  }
  if (!crop) {
    crop = {
      x: 0,
      y: 0,
      w: Math.max(1, Math.round(stage.width)),
      h: Math.max(1, Math.round(stage.height)),
    };
  }

  const cropped = options.autoCrop
    ? raw.map((c) => cropCanvas(c, crop!))
    : raw;
  const scaled = cropped.map((c) => scaleCanvas(c, options.scale));
  const cellW = scaled[0]?.width ?? 1;
  const cellH = scaled[0]?.height ?? 1;
  return { cells: scaled, cellW, cellH };
}

/**
 * Build a Godot 4 ZIP from the current document and export options.
 */
export async function exportGodotSpriteZip(opts: {
  documentManager: DocumentManager;
  stage: StageSettings;
  documentName: string;
  options?: Partial<GodotExportOptions>;
}): Promise<GodotExportResult> {
  const options: GodotExportOptions = {
    ...DEFAULT_GODOT_EXPORT_OPTIONS,
    ...opts.options,
  };
  const { documentManager, stage } = opts;
  const duration = Math.max(1, documentManager.getDuration());
  const fps = Math.max(1, documentManager.getFrameRate());
  const tags = documentManager.getFrameTags();
  const anims = collectAnimations(tags, duration);
  const uniqueFrames = uniqueFrameIndices(anims);
  if (uniqueFrames.length === 0) {
    throw new Error("Nothing to export");
  }

  const layers = visibleLayers();
  if (layers.length === 0) {
    throw new Error("No visible layers to export");
  }

  const baseName = sanitizeFileBase(opts.documentName);
  const folder = baseName;
  const sheetFill = options.transparentStage ? null : stage.color || "#ffffff";
  const zipEntries: ZipEntry[] = [];

  if (!options.splitLayers) {
    const trackIds = layers.map((l) => l.id);
    const raw = uniqueFrames.map((frame) =>
      rasterizeFrame(
        documentManager,
        stage,
        frame,
        trackIds,
        options.transparentStage,
      ),
    );
    const { cells, cellW, cellH } = processCells(raw, options, stage);
    const frameToCell = new Map<number, number>();
    uniqueFrames.forEach((f, i) => frameToCell.set(f, i));
    const { png, cols } = await packSheet(cells, cellW, cellH, sheetFill);
    const pngName = `${baseName}.png`;
    zipEntries.push({ path: `${folder}/${pngName}`, data: png });
    zipEntries.push({
      path: `${folder}/${baseName}.tscn`,
      data: new TextEncoder().encode(
        buildFlatTscn({
          baseName,
          folder,
          pngName,
          cellW,
          cellH,
          cols,
          fps,
          uniqueFrames,
          frameToCell,
          anims,
        }),
      ),
    });
  } else {
    const fileBases = uniqueFileBases(layers.map((l) => l.name));
    const layerSheets: LayerSheet[] = [];
    const colsByLayer: number[] = [];

    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li]!;
      const raw = uniqueFrames.map((frame) =>
        rasterizeFrame(
          documentManager,
          stage,
          frame,
          [layer.id],
          options.transparentStage,
        ),
      );
      const { cells, cellW, cellH } = processCells(raw, options, stage);
      const frameToCell = new Map<number, number>();
      uniqueFrames.forEach((f, i) => frameToCell.set(f, i));
      const { png, cols } = await packSheet(cells, cellW, cellH, sheetFill);
      const fileBase = fileBases[li]!;
      zipEntries.push({ path: `${folder}/${fileBase}.png`, data: png });
      layerSheets.push({
        id: layer.id,
        name: layer.name,
        fileBase,
        cells,
        cellW,
        cellH,
        frameToCell,
      });
      colsByLayer.push(cols);
    }

    zipEntries.push({
      path: `${folder}/${baseName}.tscn`,
      data: new TextEncoder().encode(
        buildSplitTscn({
          baseName,
          folder,
          layers: layerSheets,
          colsByLayer,
          fps,
          uniqueFrames,
          anims,
        }),
      ),
    });
  }

  return {
    zipBytes: buildStoreZip(zipEntries),
    zipFilename: `${baseName}-godot.zip`,
  };
}
