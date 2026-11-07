/**
 * StageRenderer — Canvas2D view of kernel-backed layers.
 *
 * Every visible vector layer owns one or more *cells* (normally one; Edit
 * Multiple Frames composites one cell per keyframe). A cell is a kernel
 * `VectorLayer` plus placed symbol instances. Drawing tools paint into the
 * active layer's playhead cell; the select tools *lift* faces/instances out
 * of a cell into a floating `Selection`, transform it as an affine, and
 * *stamp* it back on release. Nothing here holds vector geometry outside the
 * kernel except that floating selection's transform.
 */
import type { CanvasConfig } from "../geometry/types";
import type { Camera } from "./camera";
import { stageStore } from "../state/document-ui";
import { coveringKeyframeOf, EMPTY_CONTENT_ID, type Keyframe } from "../document/keyframes";
import {
  childFrameFor,
  newInstanceId,
  resolveSymbolFrame,
  type SymbolInstanceData,
  type SymbolResolver,
} from "../document/symbols";
import { parseImageContent } from "../document/image-content";
import {
  VectorLayer,
  IDENTITY,
  PaintMode,
  applyAffine,
  invertAffine,
  mulAffine,
  polygonRing,
  rectRing,
  ringsToPath2D,
  translation,
  type Affine,
  type Bounds,
  type KernelEdge,
  type Px,
  type Ring,
} from "../vector/kernel";
import {
  cloneInstance,
  contentCache,
  decodeContent,
  encodeLayerContent,
  type PlacedInstance,
} from "../vector/content";
import { Palette } from "../vector/palette";
import { drawTransformChrome } from "./selection-chrome";
import type { SelectionHandle } from "./selection-types";

export type { SelectionHandle, SelectionHandleId } from "./selection-types";

export type SelectLayerScope = "all" | "active";

export const MAX_SYMBOL_DEPTH = 8;

const NULL_RESOLVER: SymbolResolver = { getSymbol: () => null, getContent: () => "" };

/** One editable bucket of artwork on a layer. */
export interface Cell {
  /** Keyframe start frame (EMF) or null for the single normal cell. */
  frame: number | null;
  art: VectorLayer;
  instances: PlacedInstance[];
}

interface StageLayer {
  id: string;
  name: string;
  visible: boolean;
  cells: Cell[];
  /** Image track payload. */
  imageAsset: string | null;
  dirty: boolean;
}

export interface SelectionPart {
  layerId: string;
  cellFrame: number | null;
  /** Lifted geometry in world space at lift time. */
  base: VectorLayer;
  instances: PlacedInstance[];
  /** Live transform applied on top of `base` / `instances`. */
  xf: Affine;
}

export interface Hit {
  layerId: string;
  cellFrame: number | null;
  kind: "face" | "instance";
  /** Fill id for faces. */
  fill: number;
  instance: PlacedInstance | null;
  world: Px;
}

export interface BackdropTrack {
  id: string;
  visible: boolean;
  kind?: string;
  keyframes: Keyframe[];
}

export interface BackdropLevel {
  tracks: BackdropTrack[];
  frame: number;
  instanceIid: string | null;
  layerId: string | null;
  matrix: Affine | null;
}

export interface OnionGhost {
  jsons: string[];
  opacity: number;
  color: string;
}

export function composeContextToLocal(
  levels: ReadonlyArray<Pick<BackdropLevel, "instanceIid" | "matrix">>,
): Affine | null {
  const innermost = levels[levels.length - 1];
  if (!innermost || !innermost.instanceIid || !innermost.matrix) return null;
  let acc: Affine = IDENTITY;
  for (let i = levels.length - 1; i >= 0; i--) {
    const level = levels[i];
    if (!level.instanceIid || !level.matrix) break;
    acc = mulAffine(acc, invertAffine(level.matrix));
  }
  return acc;
}

function boundsUnion(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (!a) return b;
  if (!b) return a;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width);
  const y1 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function transformBounds(b: Bounds | null, m: Affine): Bounds | null {
  if (!b) return null;
  const pts = [
    applyAffine(m, { x: b.x, y: b.y }),
    applyAffine(m, { x: b.x + b.width, y: b.y }),
    applyAffine(m, { x: b.x, y: b.y + b.height }),
    applyAffine(m, { x: b.x + b.width, y: b.y + b.height }),
  ];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 };
}

function pointInPolygon(p: Px, poly: readonly Px[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export class StageRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: CanvasConfig;
  private camera: Camera | null = null;
  private palette = new Palette();

  private layers = new Map<string, StageLayer>();
  private order: string[] = [];
  private activeLayerId: string | null = null;
  private emfPlayheadFrame: number | null = null;

  private imageResolver: (assetId: string) => HTMLImageElement | null = () => null;
  private resolver: SymbolResolver = NULL_RESOLVER;
  private layerElapsed = new Map<string, number>();

  private selection: SelectionPart[] = [];
  private ghosts: OnionGhost[] = [];
  private ghostOutline = true;
  private ghostOutlineWidth = 6;
  private backdrop: { below: Array<{ json: string; xf: Affine; elapsed: number }>; above: Array<{ json: string; xf: Affine; elapsed: number }> } | null = null;
  private aliasFix = true;
  private renderQueued = false;
  private onAfterRender: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, config: CanvasConfig) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    this.ctx = ctx;
    this.config = config;
    this.syncResolution();
  }

  // ------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------

  setPalette(palette: Palette): void {
    this.palette = palette;
    this.requestRender();
  }

  getPalette(): Palette {
    return this.palette;
  }

  setImageResolver(resolver: (assetId: string) => HTMLImageElement | null): void {
    this.imageResolver = resolver;
  }

  setSymbolResolver(resolver: SymbolResolver): void {
    this.resolver = resolver;
  }

  getSymbolResolver(): SymbolResolver {
    return this.resolver;
  }

  setLayerElapsed(elapsed: Map<string, number>): void {
    this.layerElapsed = elapsed;
    this.requestRender();
  }

  getLayerElapsed(layerId: string): number {
    return this.layerElapsed.get(layerId) ?? 0;
  }

  setAliasFixEnabled(enabled: boolean): void {
    this.aliasFix = enabled;
    this.requestRender();
  }

  setAfterRenderCallback(cb: (() => void) | null): void {
    this.onAfterRender = cb;
  }

  updateConfig(config: CanvasConfig): void {
    this.config = config;
    this.syncResolution();
    this.requestRender();
  }

  setCamera(camera: Camera): void {
    this.camera = camera;
    this.requestRender();
  }

  applyCamera(): void {
    this.requestRender();
  }

  updateView(): void {
    this.requestRender();
  }

  /** Symbol content changed: drop parsed templates. */
  invalidateContentCache(): void {
    contentCache.clear();
    this.requestRender();
  }

  private syncResolution(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(this.config.viewportWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(this.config.viewportHeight * dpr));
    this.canvas.style.width = `${this.config.viewportWidth}px`;
    this.canvas.style.height = `${this.config.viewportHeight}px`;
  }

  screenToWorld(x: number, y: number): Px {
    return this.camera ? this.camera.screenToWorld(x, y) : { x, y };
  }

  worldToScreen(x: number, y: number): Px {
    return this.camera ? this.camera.worldToScreen(x, y) : { x, y };
  }

  private cameraMatrix(): Affine {
    return this.camera ? this.camera.getTransformMatrix() : IDENTITY;
  }

  // ------------------------------------------------------------
  // Layers
  // ------------------------------------------------------------

  private newCell(frame: number | null = null): Cell {
    return { frame, art: new VectorLayer(), instances: [] };
  }

  private freeCell(cell: Cell): void {
    cell.art.free();
  }

  createLayer(id: string, name: string): void {
    if (this.layers.has(id)) return;
    this.layers.set(id, {
      id,
      name,
      visible: true,
      cells: [this.newCell()],
      imageAsset: null,
      dirty: false,
    });
    this.order.push(id);
    this.activeLayerId = id;
    this.requestRender();
  }

  initializeDefaultLayer(id: string, name: string): void {
    this.createLayer(id, name);
  }

  deleteLayer(id: string): boolean {
    const layer = this.layers.get(id);
    if (!layer) return false;
    this.selection = this.selection.filter((p) => {
      if (p.layerId !== id) return true;
      p.base.free();
      return false;
    });
    for (const c of layer.cells) this.freeCell(c);
    this.layers.delete(id);
    this.order = this.order.filter((x) => x !== id);
    if (this.activeLayerId === id) this.activeLayerId = this.order[this.order.length - 1] ?? null;
    this.requestRender();
    return true;
  }

  setActiveLayer(id: string): boolean {
    if (!this.layers.has(id)) return false;
    this.activeLayerId = id;
    return true;
  }

  getActiveLayerId(): string | null {
    return this.activeLayerId;
  }

  setLayerVisibility(id: string, visible: boolean): void {
    const layer = this.layers.get(id);
    if (!layer || layer.visible === visible) return;
    layer.visible = visible;
    this.requestRender();
  }

  getLayerVisibility(id: string): boolean {
    return this.layers.get(id)?.visible ?? false;
  }

  setLayerName(id: string, name: string): boolean {
    const layer = this.layers.get(id);
    if (!layer) return false;
    layer.name = name;
    return true;
  }

  getLayerName(id: string): string | null {
    return this.layers.get(id)?.name ?? null;
  }

  getLayerIds(): string[] {
    return [...this.order];
  }

  reorderLayers(bottomToTop: string[]): boolean {
    const next = bottomToTop.filter((id) => this.layers.has(id));
    for (const id of this.order) if (!next.includes(id)) next.push(id);
    const changed = next.some((id, i) => this.order[i] !== id);
    this.order = next;
    if (changed) this.requestRender();
    return changed;
  }

  markLayerDirty(layerId: string): void {
    const layer = this.layers.get(layerId);
    if (layer) layer.dirty = true;
    this.requestRender();
  }

  consumeDirtyLayerIds(): string[] {
    const out: string[] = [];
    for (const layer of this.layers.values()) {
      if (layer.dirty) {
        out.push(layer.id);
        layer.dirty = false;
      }
    }
    return out;
  }

  isLayerDirty(layerId: string): boolean {
    return this.layers.get(layerId)?.dirty ?? false;
  }

  /** Layers that carry the selection are implicitly dirty. */
  getSelectionLayerIds(): string[] {
    return [...new Set(this.selection.map((p) => p.layerId))];
  }

  isLayerEmpty(id: string): boolean {
    const layer = this.layers.get(id);
    if (!layer) return true;
    if (layer.imageAsset) return false;
    if (this.selection.some((p) => p.layerId === id)) return false;
    return layer.cells.every((c) => c.art.isEmpty() && c.instances.length === 0);
  }

  /** Current content string for a layer (selection is placed virtually). */
  exportLayerJSON(id: string): string {
    const layer = this.layers.get(id);
    if (!layer) return "";
    if (layer.imageAsset) return JSON.stringify({ asset: layer.imageAsset });
    const cell = layer.cells[0];
    if (!cell) return "";
    return this.exportCell(cell, this.selection.filter((p) => p.layerId === id && p.cellFrame === cell.frame));
  }

  private exportCell(cell: Cell, parts: SelectionPart[]): string {
    if (parts.length === 0) return encodeLayerContent(cell.art, cell.instances);
    const merged = cell.art.clone();
    const instances = cell.instances.map(cloneInstance);
    for (const p of parts) {
      merged.stamp(p.base, p.xf);
      for (const inst of p.instances) {
        instances.push({ ...cloneInstance(inst), matrix: mulAffine(p.xf, inst.matrix) });
      }
    }
    const json = encodeLayerContent(merged, instances);
    merged.free();
    return json;
  }

  /**
   * Replace layer structure/content. `json === undefined` keeps the cell as
   * is (hold frames are free).
   */
  restoreLayersSnapshot(
    layers: Array<{ id: string; name: string; visible: boolean; json?: string }>,
    activeLayerId: string,
  ): void {
    const wanted = new Set(layers.map((l) => l.id));
    for (const id of [...this.layers.keys()]) {
      if (!wanted.has(id)) this.deleteLayer(id);
    }
    for (const w of layers) {
      let layer = this.layers.get(w.id);
      if (!layer) {
        this.createLayer(w.id, w.name);
        layer = this.layers.get(w.id)!;
      }
      layer.name = w.name;
      layer.visible = w.visible;
      if (w.json !== undefined) this.loadLayerContent(layer, w.json);
      layer.dirty = false;
    }
    this.reorderLayers(layers.map((l) => l.id));
    if (this.layers.has(activeLayerId)) this.activeLayerId = activeLayerId;
    else if (!this.activeLayerId || !this.layers.has(this.activeLayerId)) {
      this.activeLayerId = this.order[this.order.length - 1] ?? null;
    }
    this.requestRender();
  }

  private loadLayerContent(layer: StageLayer, json: string): void {
    // Drop any floating parts from this layer: the document is authoritative.
    this.selection = this.selection.filter((p) => {
      if (p.layerId !== layer.id) return true;
      p.base.free();
      return false;
    });
    for (const c of layer.cells) this.freeCell(c);
    layer.cells = [this.newCell()];
    layer.imageAsset = null;
    if (!json) return;
    const asset = parseImageContent(json);
    if (asset) {
      layer.imageAsset = asset;
      return;
    }
    const content = decodeContent(json);
    const cell = layer.cells[0];
    if (content.map.length > 0) {
      try {
        cell.art.free();
        cell.art = VectorLayer.fromBytes(content.map);
      } catch {
        cell.art = new VectorLayer();
      }
    }
    cell.instances = content.instances;
  }

  // ------------------------------------------------------------
  // Edit Multiple Frames cells
  // ------------------------------------------------------------

  setLayerContentsByKeyframe(
    layerId: string,
    contents: Array<{ keyframeFrame: number; json: string }>,
  ): void {
    const layer = this.layers.get(layerId);
    if (!layer) return;
    this.selection = this.selection.filter((p) => {
      if (p.layerId !== layerId) return true;
      p.base.free();
      return false;
    });
    for (const c of layer.cells) this.freeCell(c);
    layer.cells = [];
    for (const { keyframeFrame, json } of contents) {
      const cell = this.newCell(keyframeFrame);
      const content = decodeContent(json);
      if (content.map.length > 0) {
        try {
          cell.art.free();
          cell.art = VectorLayer.fromBytes(content.map);
        } catch {
          cell.art = new VectorLayer();
        }
      }
      cell.instances = content.instances;
      layer.cells.push(cell);
    }
    layer.cells.sort((a, b) => (a.frame ?? 0) - (b.frame ?? 0));
    layer.dirty = false;
    this.requestRender();
  }

  /** Export each EMF cell. Cells missing for `playhead` are created lazily. */
  exportLayerContentsByKeyframe(layerId: string, playhead: number): Map<number, string> {
    const layer = this.layers.get(layerId);
    const out = new Map<number, string>();
    if (!layer) return out;
    for (const cell of layer.cells) {
      if (cell.frame == null) continue;
      out.set(
        cell.frame,
        this.exportCell(cell, this.selection.filter((p) => p.layerId === layerId && p.cellFrame === cell.frame)),
      );
    }
    const strays = this.selection.filter(
      (p) => p.layerId === layerId && p.cellFrame != null && !out.has(p.cellFrame),
    );
    for (const p of strays) {
      const frame = p.cellFrame ?? playhead;
      const tmp = this.newCell(frame);
      out.set(frame, this.exportCell(tmp, [p]));
      this.freeCell(tmp);
    }
    return out;
  }

  setEmfPlayheadFrame(frame: number | null): void {
    this.emfPlayheadFrame = frame;
  }

  getEmfPlayheadFrame(): number | null {
    return this.emfPlayheadFrame;
  }

  /** Cell new strokes go into on `layerId` (EMF: the playhead bucket). */
  targetCell(layerId: string): Cell | null {
    const layer = this.layers.get(layerId);
    if (!layer || layer.imageAsset) return null;
    if (layer.cells.length === 1 && layer.cells[0].frame == null) return layer.cells[0];
    const frame = this.emfPlayheadFrame;
    if (frame == null) {
      // Outside the range: paint into the last cell covering nothing — fall back to first.
      return layer.cells[0] ?? null;
    }
    let best: Cell | null = null;
    for (const c of layer.cells) {
      if (c.frame != null && c.frame <= frame && (!best || (best.frame ?? -1) < c.frame)) best = c;
    }
    if (best && best.frame === frame) return best;
    if (best) return best;
    const cell = this.newCell(frame);
    layer.cells.push(cell);
    layer.cells.sort((a, b) => (a.frame ?? 0) - (b.frame ?? 0));
    return cell;
  }

  cellsOf(layerId: string): Cell[] {
    return this.layers.get(layerId)?.cells ?? [];
  }

  // ------------------------------------------------------------
  // Painting
  // ------------------------------------------------------------

  /** Paint rings (world px) onto the active layer. */
  paint(rings: Ring[], fill: number, mode: PaintMode = PaintMode.Over, target = 0, layerId = this.activeLayerId): boolean {
    if (!layerId || rings.length === 0) return false;
    const cell = this.targetCell(layerId);
    if (!cell) return false;
    cell.art.paint(rings, fill, mode, target);
    this.markLayerDirty(layerId);
    return true;
  }

  erase(rings: Ring[], layerId = this.activeLayerId): boolean {
    return this.paint(rings, 0, PaintMode.Erase, 0, layerId);
  }

  /** Paint under existing art (Flash "paint behind"). */
  paintBehind(rings: Ring[], fill: number, layerId = this.activeLayerId): boolean {
    return this.paint(rings, fill, PaintMode.Behind, 0, layerId);
  }

  /** Clip new paint to the face under `at` (Flash "paint inside"). */
  paintInside(rings: Ring[], fill: number, at: Px, layerId = this.activeLayerId): boolean {
    if (!layerId) return false;
    const cell = this.targetCell(layerId);
    if (!cell) return false;
    const target = cell.art.faceAt(at);
    if (target === 0) return this.paint(rings, fill, PaintMode.Behind, 0, layerId);
    return this.paint(rings, fill, PaintMode.Inside, target, layerId);
  }

  /** Flood the face under `at` on the active layer. */
  fillFaceAt(at: Px, fill: number, layerId = this.activeLayerId): boolean {
    if (!layerId) return false;
    const cell = this.targetCell(layerId);
    if (!cell) return false;
    if (!cell.art.fillAt(at, fill)) return false;
    this.markLayerDirty(layerId);
    return true;
  }

  /** Add a symbol instance to a layer at a world point. */
  addInstanceToLayer(layerId: string, data: SymbolInstanceData, world: Px, matrix?: Affine, pivot?: Px): PlacedInstance | null {
    const cell = this.targetCell(layerId);
    if (!cell) return null;
    const inst: PlacedInstance = {
      ...data,
      matrix: matrix ? ([...matrix] as Affine) : translation(world.x, world.y),
      pivot: pivot ? { ...pivot } : { x: 0, y: 0 },
    };
    cell.instances.push(inst);
    this.markLayerDirty(layerId);
    return inst;
  }

  /** Replace a layer's cell art wholesale (import / paste). */
  stampOntoLayer(layerId: string, art: VectorLayer, instances: PlacedInstance[], xf: Affine = IDENTITY): void {
    const cell = this.targetCell(layerId);
    if (!cell) return;
    cell.art.stamp(art, xf);
    for (const inst of instances) {
      cell.instances.push({ ...cloneInstance(inst), matrix: mulAffine(xf, inst.matrix) });
    }
    this.markLayerDirty(layerId);
  }

  // ------------------------------------------------------------
  // Hit testing
  // ------------------------------------------------------------

  private selectableLayersTopFirst(scope: SelectLayerScope, selectable: (id: string) => boolean): StageLayer[] {
    const ids = scope === "active" && this.activeLayerId ? [this.activeLayerId] : [...this.order].reverse();
    const out: StageLayer[] = [];
    for (const id of ids) {
      const layer = this.layers.get(id);
      if (!layer || !layer.visible || layer.imageAsset) continue;
      if (!selectable(id)) continue;
      out.push(layer);
    }
    return out;
  }

  /** Can this layer be edited by select tools (visible, unlocked)? Set by the app. */
  private selectableFilter: (layerId: string) => boolean = () => true;

  setSelectableFilter(fn: (layerId: string) => boolean): void {
    this.selectableFilter = fn;
  }

  /** Topmost face or instance under a world point. */
  hitTest(world: Px, scope: SelectLayerScope = "all"): Hit | null {
    for (const layer of this.selectableLayersTopFirst(scope, this.selectableFilter)) {
      for (let ci = layer.cells.length - 1; ci >= 0; ci--) {
        const cell = layer.cells[ci];
        for (let i = cell.instances.length - 1; i >= 0; i--) {
          const inst = cell.instances[i];
          if (this.instanceContains(inst, world, 0)) {
            return { layerId: layer.id, cellFrame: cell.frame, kind: "instance", fill: 0, instance: inst, world };
          }
        }
        const fill = cell.art.faceAt(world);
        if (fill !== 0) {
          return { layerId: layer.id, cellFrame: cell.frame, kind: "face", fill, instance: null, world };
        }
      }
    }
    return null;
  }

  /** Face hit ignoring lock state (fill tools on the active layer). */
  faceFillAt(world: Px, layerId = this.activeLayerId): number {
    if (!layerId) return 0;
    const cell = this.targetCell(layerId);
    return cell ? cell.art.faceAt(world) : 0;
  }

  /** Topmost visible color under a point (eyedropper). */
  colorAt(world: Px): string | null {
    for (const id of [...this.order].reverse()) {
      const layer = this.layers.get(id);
      if (!layer || !layer.visible || layer.imageAsset) continue;
      for (let ci = layer.cells.length - 1; ci >= 0; ci--) {
        const cell = layer.cells[ci];
        for (let i = cell.instances.length - 1; i >= 0; i--) {
          const c = this.instanceColorAt(cell.instances[i], world, 0);
          if (c) return c;
        }
        const fill = cell.art.faceAt(world);
        if (fill !== 0) return this.palette.colorOf(fill);
      }
    }
    for (const p of this.selection) {
      const local = applyAffine(invertAffine(p.xf), world);
      const fill = p.base.faceAt(local);
      if (fill !== 0) return this.palette.colorOf(fill);
    }
    return null;
  }

  private instanceContains(inst: PlacedInstance, world: Px, depth: number, elapsed = 0): boolean {
    return this.instanceColorAt(inst, world, depth, elapsed) !== null;
  }

  private instanceColorAt(inst: PlacedInstance, world: Px, depth: number, elapsed = 0): string | null {
    if (depth >= MAX_SYMBOL_DEPTH) return null;
    const symbol = this.resolver.getSymbol(inst.symbol);
    if (!symbol) return null;
    const local = applyAffine(invertAffine(inst.matrix), world);
    const frame = childFrameFor(inst, elapsed, symbol.duration);
    const layers = resolveSymbolFrame(symbol, frame, this.resolver);
    for (let i = layers.length - 1; i >= 0; i--) {
      const { layer, content } = contentCache.get(layers[i].json);
      const childElapsed = frame - layers[i].keyframeFrame;
      for (let k = content.instances.length - 1; k >= 0; k--) {
        const c = this.instanceColorAt(content.instances[k], local, depth + 1, childElapsed);
        if (c) return c;
      }
      if (layer) {
        const fill = layer.faceAt(local);
        if (fill !== 0) return this.palette.colorOf(fill) ?? "#000000";
      }
    }
    return null;
  }

  // ------------------------------------------------------------
  // Selection (lift / transform / stamp)
  // ------------------------------------------------------------

  getSelection(): readonly SelectionPart[] {
    return this.selection;
  }

  hasSelection(): boolean {
    return this.selection.length > 0;
  }

  selectionInstances(): PlacedInstance[] {
    return this.selection.flatMap((p) => p.instances);
  }

  /** Is `world` over the floating selection? */
  selectionContains(world: Px): boolean {
    for (const p of this.selection) {
      const local = applyAffine(invertAffine(p.xf), world);
      if (p.base.faceAt(local) !== 0) return true;
      for (const inst of p.instances) {
        if (this.instanceContains(inst, local, 0)) return true;
      }
    }
    return false;
  }

  private partFor(layerId: string, cellFrame: number | null): SelectionPart {
    let part = this.selection.find((p) => p.layerId === layerId && p.cellFrame === cellFrame && this.isIdentity(p.xf));
    if (!part) {
      part = { layerId, cellFrame, base: new VectorLayer(), instances: [], xf: IDENTITY };
      this.selection.push(part);
    }
    return part;
  }

  private isIdentity(m: Affine): boolean {
    return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
  }

  /** Lift the face / instance under `world`. Returns false when nothing hit. */
  liftAt(world: Px, scope: SelectLayerScope = "all"): Hit | null {
    const hit = this.hitTest(world, scope);
    if (!hit) return null;
    const layer = this.layers.get(hit.layerId)!;
    const cell = layer.cells.find((c) => c.frame === hit.cellFrame)!;
    const part = this.partFor(hit.layerId, hit.cellFrame);
    if (hit.kind === "instance" && hit.instance) {
      cell.instances = cell.instances.filter((i) => i !== hit.instance);
      part.instances.push(hit.instance);
    } else {
      const lifted = cell.art.splitOffFace(world);
      part.base.stamp(lifted, IDENTITY);
      lifted.free();
    }
    layer.dirty = true;
    this.requestRender();
    return hit;
  }

  /** Lift everything inside a world polygon (faces clipped, instances by pivot/bounds centre). */
  liftInPolygon(poly: Px[], scope: SelectLayerScope = "all", targetCellOnly = false): boolean {
    const ring = polygonRing(poly);
    if (!ring) return false;
    let any = false;
    for (const layer of this.selectableLayersTopFirst(scope, this.selectableFilter)) {
      const target = targetCellOnly ? this.targetCell(layer.id) : null;
      for (const cell of layer.cells) {
        if (targetCellOnly && cell !== target) continue;
        const keep: PlacedInstance[] = [];
        const taken: PlacedInstance[] = [];
        for (const inst of cell.instances) {
          const b = this.instanceBounds(inst, 0);
          const c = b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : applyAffine(inst.matrix, inst.pivot);
          (pointInPolygon(c, poly) ? taken : keep).push(inst);
        }
        let lifted: VectorLayer | null = null;
        if (!cell.art.isEmpty()) {
          lifted = cell.art.splitOff([ring]);
          if (lifted.isEmpty()) {
            lifted.free();
            lifted = null;
          }
        }
        if (taken.length === 0 && !lifted) continue;
        const part = this.partFor(layer.id, cell.frame);
        cell.instances = keep;
        part.instances.push(...taken);
        if (lifted) {
          part.base.stamp(lifted, IDENTITY);
          lifted.free();
        }
        layer.dirty = true;
        any = true;
      }
    }
    if (any) this.requestRender();
    return any;
  }

  liftInRect(a: Px, b: Px, scope: SelectLayerScope = "all"): boolean {
    const x0 = Math.min(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    return this.liftInPolygon([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], scope);
  }

  /** Lift every shape and instance on the given layers (select all). */
  liftAll(scope: SelectLayerScope = "all"): boolean {
    let any = false;
    for (const layer of this.selectableLayersTopFirst(scope, this.selectableFilter)) {
      for (const cell of layer.cells) {
        if (cell.art.isEmpty() && cell.instances.length === 0) continue;
        const part = this.partFor(layer.id, cell.frame);
        part.base.stamp(cell.art, IDENTITY);
        cell.art.free();
        cell.art = new VectorLayer();
        part.instances.push(...cell.instances);
        cell.instances = [];
        layer.dirty = true;
        any = true;
      }
    }
    if (any) this.requestRender();
    return any;
  }

  /** Lift with explicit parts (paste / duplicate): floats a copy of the given content. */
  liftContent(layerId: string, art: VectorLayer, instances: PlacedInstance[], xf: Affine = IDENTITY): void {
    const cellFrame = this.targetCell(layerId)?.frame ?? null;
    const part: SelectionPart = { layerId, cellFrame, base: art, instances, xf };
    this.selection.push(part);
    const layer = this.layers.get(layerId);
    if (layer) layer.dirty = true;
    this.requestRender();
  }

  /** Apply an incremental world-space affine to the floating selection. */
  transformSelection(m: Affine): void {
    for (const p of this.selection) p.xf = mulAffine(m, p.xf);
    this.requestRender();
  }

  /** Stamp the selection back into its layers. */
  placeSelection(): string[] {
    const touched = new Set<string>();
    for (const p of this.selection) {
      const layer = this.layers.get(p.layerId);
      if (!layer) {
        p.base.free();
        continue;
      }
      let cell = layer.cells.find((c) => c.frame === p.cellFrame);
      if (!cell) {
        cell = this.targetCell(p.layerId) ?? layer.cells[0];
        if (!cell) {
          p.base.free();
          continue;
        }
      }
      cell.art.stamp(p.base, p.xf);
      for (const inst of p.instances) {
        cell.instances.push({ ...inst, matrix: mulAffine(p.xf, inst.matrix) });
      }
      p.base.free();
      layer.dirty = true;
      touched.add(p.layerId);
    }
    this.selection = [];
    this.requestRender();
    return [...touched];
  }

  /** Drop the selection without stamping (delete). */
  deleteSelection(): string[] {
    const touched = new Set<string>();
    for (const p of this.selection) {
      p.base.free();
      touched.add(p.layerId);
      const layer = this.layers.get(p.layerId);
      if (layer) layer.dirty = true;
    }
    this.selection = [];
    this.requestRender();
    return [...touched];
  }

  /** Move the whole selection onto another layer (stamp there on place). */
  moveSelectionToLayer(layerId: string): void {
    const cellFrame = this.targetCell(layerId)?.frame ?? null;
    for (const p of this.selection) {
      const from = this.layers.get(p.layerId);
      if (from) from.dirty = true;
      p.layerId = layerId;
      p.cellFrame = cellFrame;
    }
    const to = this.layers.get(layerId);
    if (to) to.dirty = true;
    this.requestRender();
  }

  /** Recolor every filled face in the selection. */
  recolorSelection(fill: number): boolean {
    let changed = false;
    for (const p of this.selection) {
      const fills = p.base.fills().filter((f) => f !== 0 && f !== fill);
      if (fills.length === 0) continue;
      p.base.remapFills(fills.map((f) => [f, fill] as const));
      changed = true;
    }
    if (changed) this.requestRender();
    return changed;
  }

  /** Duplicate the floating selection in place (offset in world px). */
  duplicateSelection(dx: number, dy: number): void {
    const copies: SelectionPart[] = this.selection.map((p) => ({
      layerId: p.layerId,
      cellFrame: p.cellFrame,
      base: p.base.clone(),
      instances: p.instances.map((i) => ({ ...cloneInstance(i), iid: newInstanceId() })),
      xf: mulAffine(translation(dx, dy), p.xf),
    }));
    this.placeSelection();
    this.selection = copies;
    for (const p of copies) {
      const layer = this.layers.get(p.layerId);
      if (layer) layer.dirty = true;
    }
    this.requestRender();
  }

  /** Snapshot the selection as content parts (clipboard / symbols). */
  selectionSnapshot(): Array<{ layerId: string; art: VectorLayer; instances: PlacedInstance[] }> {
    return this.selection.map((p) => {
      const art = p.base.clone();
      art.transform(p.xf);
      return {
        layerId: p.layerId,
        art,
        instances: p.instances.map((i) => ({ ...cloneInstance(i), matrix: mulAffine(p.xf, i.matrix) })),
      };
    });
  }

  /** World-space bounds of the selection (tight for shapes). */
  selectionBounds(): Bounds | null {
    let acc: Bounds | null = null;
    for (const p of this.selection) acc = boundsUnion(acc, this.partBounds(p));
    return acc;
  }

  private partBounds(p: Pick<SelectionPart, "base" | "instances" | "xf">): Bounds | null {
    let acc: Bounds | null = null;
    if (!p.base.isEmpty()) {
      if (this.isIdentity(p.xf)) acc = p.base.bounds();
      else {
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        const add = (q: Px) => {
          const w = applyAffine(p.xf, q);
          if (w.x < x0) x0 = w.x;
          if (w.x > x1) x1 = w.x;
          if (w.y < y0) y0 = w.y;
          if (w.y > y1) y1 = w.y;
        };
        for (const e of p.base.edges()) {
          add(e.a);
          add(e.b);
          if (e.ctrl) add(e.ctrl);
        }
        if (x0 !== Infinity) acc = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      }
    }
    for (const inst of p.instances) {
      acc = boundsUnion(acc, this.instanceBounds({ ...inst, matrix: mulAffine(p.xf, inst.matrix) }, 0));
    }
    return acc;
  }

  selectionScreenBounds(): Bounds | null {
    const b = this.selectionBounds();
    if (!b) return null;
    const sb = transformBounds(b, this.cameraMatrix());
    return sb;
  }

  /** Rotation pivot: single instance → its pivot; else bounds centre. */
  selectionPivotWorld(): Px | null {
    const insts = this.selectionInstances();
    if (insts.length === 1 && this.selection.length === 1 && this.selection[0].base.isEmpty()) {
      const p = this.selection[0];
      return applyAffine(mulAffine(p.xf, insts[0].matrix), insts[0].pivot);
    }
    const b = this.selectionBounds();
    return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
  }

  /** The single selected instance (pivot handle, instance panel). */
  singleSelectedInstance(): { part: SelectionPart; instance: PlacedInstance } | null {
    if (this.selection.length !== 1) return null;
    const p = this.selection[0];
    if (!p.base.isEmpty() || p.instances.length !== 1) return null;
    return { part: p, instance: p.instances[0] };
  }

  /** Move an instance's pivot to a world point without moving the artwork. */
  setInstancePivotWorld(world: Px): boolean {
    const single = this.singleSelectedInstance();
    if (!single) return false;
    const full = mulAffine(single.part.xf, single.instance.matrix);
    single.instance.pivot = applyAffine(invertAffine(full), world);
    this.requestRender();
    return true;
  }

  resetInstancePivot(): boolean {
    const single = this.singleSelectedInstance();
    if (!single) return false;
    single.instance.pivot = { x: 0, y: 0 };
    this.requestRender();
    return true;
  }

  updateSelectedInstances(patch: Partial<Omit<SymbolInstanceData, "iid">>): boolean {
    let changed = false;
    for (const p of this.selection) {
      for (const inst of p.instances) {
        if (patch.symbol !== undefined && inst.symbol !== patch.symbol) {
          inst.symbol = patch.symbol;
          changed = true;
        }
        if (patch.mode !== undefined && inst.mode !== patch.mode) {
          inst.mode = patch.mode;
          changed = true;
        }
        if (patch.firstFrame !== undefined && inst.firstFrame !== patch.firstFrame) {
          inst.firstFrame = patch.firstFrame;
          changed = true;
        }
      }
    }
    if (changed) this.requestRender();
    return changed;
  }

  instanceBounds(inst: PlacedInstance, depth: number, elapsed = 0): Bounds | null {
    if (depth >= MAX_SYMBOL_DEPTH) return null;
    const symbol = this.resolver.getSymbol(inst.symbol);
    if (!symbol) return null;
    const frame = childFrameFor(inst, elapsed, symbol.duration);
    let acc: Bounds | null = null;
    for (const l of resolveSymbolFrame(symbol, frame, this.resolver)) {
      const { layer, content } = contentCache.get(l.json);
      if (layer) acc = boundsUnion(acc, layer.bounds());
      for (const c of content.instances) {
        acc = boundsUnion(acc, this.instanceBounds(c, depth + 1, frame - l.keyframeFrame));
      }
    }
    return transformBounds(acc, inst.matrix);
  }

  /** Bounds of all visible vector art (export / fit). */
  getContentBounds(): Bounds | null {
    let acc: Bounds | null = null;
    for (const id of this.order) {
      const layer = this.layers.get(id);
      if (!layer || !layer.visible) continue;
      for (const cell of layer.cells) {
        acc = boundsUnion(acc, cell.art.bounds());
        for (const inst of cell.instances) acc = boundsUnion(acc, this.instanceBounds(inst, 0, this.getLayerElapsed(id)));
      }
    }
    return boundsUnion(acc, this.selectionBounds());
  }

  /** World bounds of a layer's art. */
  getLayerBounds(layerId: string): Bounds | null {
    const layer = this.layers.get(layerId);
    if (!layer) return null;
    let acc: Bounds | null = null;
    for (const cell of layer.cells) {
      acc = boundsUnion(acc, cell.art.bounds());
      for (const inst of cell.instances) acc = boundsUnion(acc, this.instanceBounds(inst, 0));
    }
    for (const p of this.selection) if (p.layerId === layerId) acc = boundsUnion(acc, this.partBounds(p));
    return acc;
  }

  // ------------------------------------------------------------
  // Snap / magnet geometry access
  // ------------------------------------------------------------

  /** Vertices of committed art on selectable layers (world px). */
  snapVertices(scope: SelectLayerScope = "all"): Px[] {
    const out: Px[] = [];
    for (const layer of this.selectableLayersTopFirst(scope, this.selectableFilter)) {
      for (const cell of layer.cells) out.push(...cell.art.vertices());
    }
    return out;
  }

  /** Selectable (visible, unlocked) vector layer ids, bottom → top. */
  snapLayerIds(): string[] {
    return this.selectableLayersTopFirst("all", this.selectableFilter)
      .map((l) => l.id)
      .reverse();
  }

  /** Committed edges on a layer (world px), capped for snapping cost. */
  snapEdges(layerId: string, cap = 4096): KernelEdge[] {
    const layer = this.layers.get(layerId);
    if (!layer) return [];
    const out: KernelEdge[] = [];
    for (const cell of layer.cells) {
      for (const e of cell.art.edges()) {
        out.push(e);
        if (out.length >= cap) return out;
      }
    }
    return out;
  }

  /** The active layer's editable kernel (direct select / magnet). */
  activeArt(): VectorLayer | null {
    return this.activeLayerId ? (this.targetCell(this.activeLayerId)?.art ?? null) : null;
  }

  // ------------------------------------------------------------
  // Onion skin / backdrop
  // ------------------------------------------------------------

  setOnionSkin(ghosts: OnionGhost[], outline = true, outlineWidth = 6): void {
    this.ghosts = ghosts;
    this.ghostOutline = outline;
    this.ghostOutlineWidth = outlineWidth;
    this.requestRender();
  }

  clearOnionSkin(): void {
    if (this.ghosts.length === 0) return;
    this.ghosts = [];
    this.requestRender();
  }

  setContextBackdrop(levels: BackdropLevel[]): void {
    const innermost = levels[levels.length - 1];
    if (!innermost || !innermost.instanceIid || !innermost.matrix) {
      this.clearContextBackdrop();
      return;
    }
    const below: Array<{ json: string; xf: Affine; elapsed: number }> = [];
    const above: Array<{ json: string; xf: Affine; elapsed: number }> = [];
    let acc: Affine = IDENTITY;
    for (let i = levels.length - 1; i >= 0; i--) {
      const level = levels[i];
      if (!level.instanceIid || !level.matrix) break;
      acc = mulAffine(acc, invertAffine(level.matrix));
      const frame = Math.max(0, Math.round(level.frame));
      const entryIndex = level.tracks.findIndex((t) => t.id === level.layerId);
      level.tracks.forEach((track, index) => {
        if (!track.visible || track.kind === "audio" || track.kind === "image") return;
        const kf = coveringKeyframeOf(track, frame);
        if (!kf || kf.contentId === EMPTY_CONTENT_ID) return;
        const json = this.resolver.getContent(kf.contentId);
        if (!json) return;
        const elapsed = frame - kf.frameIndex;
        const isEntry = index === entryIndex;
        if (isEntry) {
          // Entry layer: strip the entered instance, the rest goes below.
          const c = decodeContent(json);
          const rest = c.instances.filter((inst) => inst.iid !== level.instanceIid);
          const stripped = encodeLayerContent(
            c.map.length > 0 ? VectorLayer.fromBytes(c.map) : null,
            rest,
          );
          if (stripped) below.push({ json: stripped, xf: acc, elapsed });
          return;
        }
        const goesAbove = entryIndex >= 0 && index > entryIndex;
        (goesAbove ? above : below).push({ json, xf: acc, elapsed });
      });
    }
    this.backdrop = { below, above };
    this.requestRender();
  }

  clearContextBackdrop(): void {
    if (!this.backdrop) return;
    this.backdrop = null;
    this.requestRender();
  }

  hasContextBackdrop(): boolean {
    return this.backdrop !== null;
  }

  // ------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------

  requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  /** Synchronous draw (export / tests). */
  render(): void {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const cam = this.cameraMatrix();
    const view: Affine = mulAffine([dpr, 0, 0, dpr, 0, 0], cam);
    this.drawScene(ctx, view);
    this.onAfterRender?.();
  }

  /** Draw the whole scene with a given world→device matrix. */
  drawScene(ctx: CanvasRenderingContext2D, view: Affine, opts: { skipChrome?: boolean; skipGhosts?: boolean; layerIds?: Set<string> } = {}): void {
    const zoom = Math.hypot(view[0], view[1]) || 1;
    const setView = (m: Affine) => ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);

    if (this.backdrop && !opts.skipGhosts) {
      for (const b of this.backdrop.below) this.drawContent(ctx, b.json, mulAffine(view, b.xf), b.elapsed, 0, 0.3);
    }

    const activeIndex = this.activeLayerId ? this.order.indexOf(this.activeLayerId) : -1;
    const filledGhosts = !this.ghostOutline && this.ghosts.length > 0 && !opts.skipGhosts;

    this.order.forEach((id, index) => {
      const layer = this.layers.get(id);
      if (!layer || !layer.visible) return;
      if (opts.layerIds && !opts.layerIds.has(id)) return;
      if (filledGhosts && index === Math.max(0, activeIndex)) this.drawGhosts(ctx, view, zoom);
      if (layer.imageAsset) {
        this.drawImage(ctx, view, layer.imageAsset);
        return;
      }
      const elapsed = this.getLayerElapsed(id);
      for (const cell of layer.cells) {
        setView(view);
        this.drawArt(ctx, cell.art, zoom, 1);
        for (const inst of cell.instances) this.drawInstance(ctx, inst, view, elapsed, 0, 1);
      }
    });
    if (filledGhosts && activeIndex < 0) this.drawGhosts(ctx, view, zoom);

    // Floating selection draws above everything.
    for (const p of this.selection) {
      const m = mulAffine(view, p.xf);
      setView(m);
      this.drawArt(ctx, p.base, zoom, 1);
      for (const inst of p.instances) this.drawInstance(ctx, inst, m, this.getLayerElapsed(p.layerId), 0, 1);
    }

    if (this.ghostOutline && !opts.skipGhosts) this.drawGhosts(ctx, view, zoom);

    if (this.backdrop && !opts.skipGhosts) {
      for (const b of this.backdrop.above) this.drawContent(ctx, b.json, mulAffine(view, b.xf), b.elapsed, 0, 0.3);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Draw selectable layers (bottom → top) for raster fill analysis. */
  drawFillScope(ctx: CanvasRenderingContext2D, view: Affine, scope: SelectLayerScope): void {
    const layers = this.selectableLayersTopFirst(scope, this.selectableFilter).reverse();
    const zoom = Math.hypot(view[0], view[1]) || 1;
    for (const layer of layers) {
      ctx.setTransform(view[0], view[1], view[2], view[3], view[4], view[5]);
      for (const cell of layer.cells) {
        this.drawArt(ctx, cell.art, zoom, 1);
        for (const inst of cell.instances) this.drawInstance(ctx, inst, view, this.getLayerElapsed(layer.id), 0, 1);
        ctx.setTransform(view[0], view[1], view[2], view[3], view[4], view[5]);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawArt(ctx: CanvasRenderingContext2D, art: VectorLayer, zoom: number, alpha: number, tint: string | null = null): void {
    const faces = art.faces();
    if (faces.length === 0) return;
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha;
    const hairline = this.aliasFix ? 0.8 / zoom : 0;
    for (const f of faces) {
      const color = tint ?? this.palette.colorOf(f.fill) ?? "#000000";
      ctx.fillStyle = color;
      ctx.fill(f.path, "evenodd");
      if (hairline > 0 && !tint) {
        ctx.strokeStyle = color;
        ctx.lineWidth = hairline;
        ctx.lineJoin = "round";
        ctx.stroke(f.path);
      }
    }
    ctx.globalAlpha = prevAlpha;
  }

  private drawInstance(ctx: CanvasRenderingContext2D, inst: PlacedInstance, parent: Affine, elapsed: number, depth: number, alpha: number, tint: string | null = null): void {
    if (depth >= MAX_SYMBOL_DEPTH) return;
    const symbol = this.resolver.getSymbol(inst.symbol);
    if (!symbol) return;
    const frame = childFrameFor(inst, elapsed, symbol.duration);
    const m = mulAffine(parent, inst.matrix);
    for (const l of resolveSymbolFrame(symbol, frame, this.resolver)) {
      this.drawContent(ctx, l.json, m, frame - l.keyframeFrame, depth + 1, alpha, tint);
    }
  }

  /** Draw a content string under a world→device matrix. */
  drawContent(ctx: CanvasRenderingContext2D, json: string, m: Affine, elapsed: number, depth: number, alpha: number, tint: string | null = null): void {
    const { layer, content } = contentCache.get(json);
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    const zoom = Math.hypot(m[0], m[1]) || 1;
    if (layer) this.drawArt(ctx, layer, zoom, alpha, tint);
    for (const inst of content.instances) this.drawInstance(ctx, inst, m, elapsed, depth, alpha, tint);
  }

  private drawGhosts(ctx: CanvasRenderingContext2D, view: Affine, zoom: number): void {
    for (const g of this.ghosts) {
      for (const json of g.jsons) {
        if (this.ghostOutline) this.strokeContent(ctx, json, view, g.color, g.opacity, this.ghostOutlineWidth / zoom, 0);
        else this.drawContent(ctx, json, view, 0, 0, g.opacity, g.color);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private strokeContent(ctx: CanvasRenderingContext2D, json: string, m: Affine, color: string, alpha: number, width: number, depth: number): void {
    if (depth >= MAX_SYMBOL_DEPTH) return;
    const { layer, content } = contentCache.get(json);
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    if (layer) for (const f of layer.faces()) ctx.stroke(f.path);
    ctx.globalAlpha = prev;
    for (const inst of content.instances) {
      const symbol = this.resolver.getSymbol(inst.symbol);
      if (!symbol) continue;
      const frame = childFrameFor(inst, 0, symbol.duration);
      const mm = mulAffine(m, inst.matrix);
      for (const l of resolveSymbolFrame(symbol, frame, this.resolver)) {
        this.strokeContent(ctx, l.json, mm, color, alpha, width, depth + 1);
      }
    }
  }

  private drawImage(ctx: CanvasRenderingContext2D, view: Affine, assetId: string): void {
    const img = this.imageResolver(assetId);
    if (!img || !img.naturalWidth) return;
    const { width, height } = stageStore.get();
    const scale = Math.min(width / img.naturalWidth, height / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.setTransform(view[0], view[1], view[2], view[3], view[4], view[5]);
    ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
  }

  // ------------------------------------------------------------
  // Chrome
  // ------------------------------------------------------------

  /** Dashed outline of the floating selection on the chrome canvas (screen space). */
  strokeSelectionOutline(ctx: CanvasRenderingContext2D, accent: string | null = null): void {
    this.strokePartsOutline(ctx, this.selection, accent);
  }

  /** Dashed outline for arbitrary floating parts (world art + instances under `xf`). */
  strokePartsOutline(
    ctx: CanvasRenderingContext2D,
    parts: ReadonlyArray<Pick<SelectionPart, "base" | "instances" | "xf">>,
    accent: string | null = null,
  ): void {
    const cam = this.cameraMatrix();
    const passes = accent
      ? [
          { style: accent, width: 10, alpha: 0.22, dash: [] as number[] },
          { style: accent, width: 5, alpha: 0.35, dash: [] as number[] },
          { style: "#ffffff", width: 3, alpha: 1, dash: [3, 2] },
          { style: accent, width: 1.5, alpha: 1, dash: [3, 2] },
        ]
      : [
          { style: "rgba(0, 0, 0, 0.45)", width: 5, alpha: 1, dash: [6, 5] },
          { style: "#ffffff", width: 3.5, alpha: 1, dash: [6, 5] },
          { style: "#000000", width: 1.5, alpha: 1, dash: [6, 5] },
        ];
    ctx.save();
    ctx.lineJoin = "round";
    for (const pass of passes) {
      ctx.setLineDash(pass.dash);
      ctx.strokeStyle = pass.style;
      ctx.globalAlpha = pass.alpha;
      for (const p of parts) {
        const m = mulAffine(cam, p.xf);
        const zoom = Math.hypot(m[0], m[1]) || 1;
        ctx.save();
        ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
        ctx.lineWidth = pass.width / zoom;
        for (const f of p.base.faces()) ctx.stroke(f.path);
        ctx.restore();
        for (const inst of p.instances) {
          const b = this.instanceBounds({ ...inst, matrix: mulAffine(p.xf, inst.matrix) }, 0);
          if (!b) continue;
          const sb = transformBounds(b, cam)!;
          ctx.lineWidth = pass.width;
          ctx.strokeRect(sb.x, sb.y, sb.width, sb.height);
        }
      }
    }
    ctx.restore();
  }

  /** World bounds of arbitrary parts (same rule as `selectionBounds`). */
  partsBounds(parts: ReadonlyArray<Pick<SelectionPart, "base" | "instances" | "xf">>): Bounds | null {
    let acc: Bounds | null = null;
    for (const p of parts) acc = boundsUnion(acc, this.partBounds(p));
    return acc;
  }

  /** Outline + transform handles. Returns handle positions (screen px). */
  drawSelection(
    ctx: CanvasRenderingContext2D,
    rotating?: { cursor: Px; pivot: Px } | null,
  ): SelectionHandle[] {
    if (this.selection.length === 0) return [];
    this.strokeSelectionOutline(ctx);
    const sb = this.selectionScreenBounds();
    if (!sb) return [];
    const single = this.singleSelectedInstance();
    let pivotScreen: Px | null = null;
    if (single) {
      const w = applyAffine(mulAffine(single.part.xf, single.instance.matrix), single.instance.pivot);
      pivotScreen = this.worldToScreen(w.x, w.y);
    }
    return drawTransformChrome(sb, ctx, rotating, pivotScreen);
  }

  // ------------------------------------------------------------
  // Offscreen helpers
  // ------------------------------------------------------------

  /** Render a content string into an offscreen canvas (thumbnails). */
  renderContentToCanvas(
    jsons: string[],
    bounds: Bounds,
    size: { width: number; height: number },
    background: string | null = null,
  ): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(size.width));
    canvas.height = Math.max(1, Math.round(size.height));
    const ctx = canvas.getContext("2d")!;
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    const scale = Math.min(size.width / Math.max(1e-6, bounds.width), size.height / Math.max(1e-6, bounds.height));
    const ox = (size.width - bounds.width * scale) / 2 - bounds.x * scale;
    const oy = (size.height - bounds.height * scale) / 2 - bounds.y * scale;
    const m: Affine = [scale, 0, 0, scale, ox, oy];
    for (const json of jsons) this.drawContent(ctx, json, m, 0, 0, 1);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return canvas;
  }

  /** Bounds of a list of content strings (world px). */
  contentBounds(jsons: string[]): Bounds | null {
    let acc: Bounds | null = null;
    for (const json of jsons) {
      const { layer, content } = contentCache.get(json);
      if (layer) acc = boundsUnion(acc, layer.bounds());
      for (const inst of content.instances) acc = boundsUnion(acc, this.instanceBounds(inst, 0));
    }
    return acc;
  }

  /** Build a Path2D of a world rect (helper for tools). */
  static rectPath(b: Bounds): Path2D {
    return ringsToPath2D([rectRing(b.x, b.y, b.width, b.height)]);
  }
}
