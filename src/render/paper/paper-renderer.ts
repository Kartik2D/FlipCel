/**
 * Paper Renderer - Vector Path Rendering
 *
 * Layer model:
 * - Flat list of non-overlapping paths (no groups)
 * - CompoundPaths only for shapes with holes
 * - Same color overlap → union
 * - Different color overlap → top cuts bottom
 *
 * Camera support:
 * - Applies camera transformations to Paper.js view
 * - Converts screen coordinates to world coordinates for path placement
 * - Provides methods for camera-aware hit testing
 */
import paper from "paper";
import type { CanvasConfig } from "../../geometry/types";
import type { Camera } from "../camera";
import { STAGE_LAYER_ID, layerStore, stageStore, symmetryStore } from "../../state/index";
import { parseImageContent } from "../../document/document";
import {
  buildMirrorTransforms,
  buildSourceClipRegion,
  clearSymmetryGestureSource,
  getSymmetryGestureSource,
  snapPathItemToSymmetryAxis,
} from "../../geometry/symmetry";

import type { SelectionHandle, MergePassResult } from "./types";
import {
  strokeSelectionShapeOutline as strokeSelectionShapeOutlineHelper,
  strokeAccentSelectionOutline as strokeAccentSelectionOutlineHelper,
  drawTransformChrome as drawTransformChromeHelper,
} from "./selection-chrome";
import {
  nearestDocumentColor,
  paperColorToHex,
} from "../../import/image-import";
import { convertStrokesToFills } from "../../import/svg-import";
import {
  pathsCollide,
  forceUniteFamily,
  subtractOf,
  intersectOf,
  fullyInside,
} from "./path-geometry";
import { OnionSkin } from "./onion-skin";
import { ContextBackdrop, type BackdropLevel } from "./context-backdrop";
import { extractPaths, flattenGroups, importSVG } from "./svg-io";
import {
  addToLayer,
  addToLayerSequential,
  exportItemsJson,
  mergeJsons,
  paintInsideLayer,
  splitCompounds,
  subtractFromLayer,
  type MergeAdopt,
} from "./merge-layer";
import { createMergeBaker, MergeQueue } from "./merge-queue";
import type { SymbolInstanceData, SymbolResolver } from "../../document/symbols";
import {
  createInstance,
  hydrateInstance,
  hydrateLayer,
  duplicateInstance,
  instancesOnLayer,
  instanceRootOf,
  isSymbolInstance,
  normalizeInstanceOrder,
  readInstance,
  replaceLayerContentKeepingInstances,
  withInstancesStripped,
  writeInstance,
} from "./symbol-instances";

export type { SelectionHandle, SelectionHandleId, MergePassResult } from "./types";

const NULL_SYMBOL_RESOLVER: SymbolResolver = {
  getSymbol: () => null,
  getContent: () => "",
};

/** Select tool layer scope: active layer only, or all unlocked visible layers. */
export type SelectLayerScope = "active" | "all";

export class PaperRenderer {
  private config: CanvasConfig;
  private camera: Camera | null = null;
  private aliasFixEnabled = false;
  /** Legacy fixed width in world space when there is no camera. */
  private readonly aliasFixStrokeWidth = 0.5;
  /** Target on-screen width (CSS px) of the same-color “alias fix” stroke; world width = this / camera.zoom. */
  private readonly aliasFixScreenWidthPx = 1;
  private lastAliasFixCameraZoom: number | null = null;
  private nextSelectionMarkerId = 1;
  private markerByItemId = new Map<number, string>();

  // Onion-skin ghost layers: locked, dimmed renders of nearby animation
  // frames. Deliberately NOT in layerMap, so layer restore/reorder/flatten
  // logic never treats them as document content.
  private readonly onionSkin = new OnionSkin();
  /** Edit-in-place parent artwork (dimmed, locked; not in layerMap). */
  private readonly contextBackdrop = new ContextBackdrop();

  // Logical layer IDs → Paper.js layers.
  private layerMap = new Map<string, paper.Layer>();
  private activeLayerId: string | null = null;
  /**
   * While Edit Multiple Frames is on, new strokes are tagged with this
   * keyframe frame (the playhead). Null when EMF is off.
   */
  private emfPlayheadFrame: number | null = null;
  /** Layers whose live Paper content may differ from the document store. */
  private dirtyLayerIds = new Set<string>();
  /** Pending unmerged strokes; not in layerMap. */
  private overlayLayer: paper.Layer | null = null;
  private onMergeBaked: (() => void) | null = null;
  private readonly mergeQueue = new MergeQueue({
    bake: createMergeBaker(),
    getBaseJson: (layerId) => this.exportLayerJSON(layerId) ?? "",
    apply: (layerId, json, items) => this.applyMergeResult(layerId, json, items),
    commitNow: (layerId, items) => this.commitPendingNow(layerId, items),
    onBaked: () => this.onMergeBaked?.(),
  });
  private imageResolver: (assetId: string) => HTMLImageElement | null = () => null;
  private symbolResolver: SymbolResolver = NULL_SYMBOL_RESOLVER;
  /**
   * Frames elapsed since each layer's covering keyframe started (set by the
   * document before every load) — drives which symbol frame instances show.
   */
  private elapsedByLayer = new Map<string, number>();
  /** Layers whose instances change with the playhead inside a hold. */
  private animatedInstanceLayers = new Set<string>();
  private lastStageW = 0;
  private lastStageH = 0;

  constructor(_canvas: HTMLCanvasElement, config: CanvasConfig) {
    this.config = config;
    const stage = stageStore.get();
    this.lastStageW = stage.width;
    this.lastStageH = stage.height;
    stageStore.subscribe((s) => {
      if (s.width === this.lastStageW && s.height === this.lastStageH) return;
      this.lastStageW = s.width;
      this.lastStageH = s.height;
      this.refitImageRasters();
    });
  }

  setImageResolver(resolver: (assetId: string) => HTMLImageElement | null): void {
    this.imageResolver = resolver;
  }

  setSymbolResolver(resolver: SymbolResolver): void {
    this.symbolResolver = resolver;
    // Onion ghosts show neighbor keyframes at their start (elapsed 0).
    this.onionSkin.hydrate = (layer) => hydrateLayer(layer, resolver, 0);
  }

  /** Elapsed frames into the covering keyframe, per layer (before a load). */
  setLayerElapsed(elapsed: Map<string, number>): void {
    this.elapsedByLayer = elapsed;
  }

  private elapsedFor(layerId: string): number {
    return this.elapsedByLayer.get(layerId) ?? 0;
  }

  /** Frames since the covering keyframe started on `layerId` (last reload). */
  getLayerElapsed(layerId: string): number {
    return this.elapsedFor(layerId);
  }

  /** Hydrate instances on a Paper layer and track whether they animate. */
  private hydratePaperLayer(layerId: string, layer: paper.Layer): void {
    if (instancesOnLayer(layer).length === 0) {
      this.animatedInstanceLayers.delete(layerId);
      return;
    }
    const animates = hydrateLayer(layer, this.symbolResolver, this.elapsedFor(layerId));
    if (animates) this.animatedInstanceLayers.add(layerId);
    else this.animatedInstanceLayers.delete(layerId);
  }

  /** Re-resolve instance children on a layer (e.g. new elapsed). */
  rehydrateLayerInstances(layerId: string): void {
    const layer = this.layerMap.get(layerId);
    if (!layer) return;
    this.hydratePaperLayer(layerId, layer);
  }

  /** Layers whose content id is unchanged but whose instances animate on scrub. */
  getAnimatedInstanceLayerIds(): string[] {
    return [...this.animatedInstanceLayers];
  }

  /** Re-hydrate every layer with instances (symbol content edited / swapped). */
  rehydrateAllInstances(): void {
    for (const [id, layer] of this.layerMap) this.hydratePaperLayer(id, layer);
    paper.view.update();
  }

  /** Root symbol instance for an item, or null. */
  instanceOf(item: paper.Item | null): paper.Group | null {
    return instanceRootOf(item);
  }

  /** Keep instances above shapes on a layer after a merge pass. */
  private normalizeInstances(layer: paper.Layer | null | undefined): void {
    if (layer) normalizeInstanceOrder(layer);
  }

  setMergeBakedCallback(callback: (() => void) | null): void {
    this.onMergeBaked = callback;
  }

  mergeIdle(): Promise<void> {
    return this.mergeQueue.idle();
  }

  /** Playhead frame bucket for new strokes during Edit Multiple Frames. */
  setEmfPlayheadFrame(frame: number | null): void {
    this.emfPlayheadFrame = frame;
  }

  getEmfKeyframeFrame(item: paper.Item): number | null {
    const frame = (item.data as { emfKeyframeFrame?: unknown } | null)?.emfKeyframeFrame;
    return typeof frame === "number" && Number.isFinite(frame) ? frame : null;
  }

  setEmfKeyframeFrame(item: paper.Item, frame: number): void {
    const data = (item.data as Record<string, unknown> | null) ?? {};
    data.emfKeyframeFrame = frame;
    item.data = data;
  }

  private copyEmfKeyframeFrame(source: paper.Item, target: paper.Item): void {
    const frame = this.getEmfKeyframeFrame(source);
    if (frame !== null) this.setEmfKeyframeFrame(target, frame);
  }

  /** Resolve an item's EMF keyframe bucket; untagged items belong to the playhead. */
  private resolveEmfKeyframeFrame(item: paper.Item): number | null {
    return this.getEmfKeyframeFrame(item) ?? this.emfPlayheadFrame;
  }

  /**
   * Merge ops may only touch items in the same EMF keyframe bucket. When EMF
   * is off everything interacts; stale tags left in saved content are ignored.
   */
  private emfContentCompatible(a: paper.Item, b: paper.Item): boolean {
    if (this.emfPlayheadFrame === null) return true;
    return this.resolveEmfKeyframeFrame(a) === this.resolveEmfKeyframeFrame(b);
  }

  /** Kernel hooks: EMF gating, styling, selection markers. */
  private adopt(): MergeAdopt {
    return {
      compatible: (a, b) => this.emfContentCompatible(a, b),
      paint: (from, to) => this.applyPathStyle(to, from.fillColor),
      stamp: (froms, to) => {
        this.copySelectionMarkerFromMany(froms, to);
        this.copyEmfKeyframeFrame(froms[0]!, to);
      },
      removed: (item) => this.clearSelectionMarker(item),
    };
  }

  /**
   * Replace a layer with one imported copy per keyframe in the EMF range.
   * Each copy is tagged with its keyframe frame so select edits write back
   * independently (Flash-style), even when content ids were shared.
   */
  setLayerContentsByKeyframe(
    layerId: string,
    contents: Array<{ keyframeFrame: number; json: string }>,
  ): void {
    const layer = this.layerMap.get(layerId);
    if (!layer) return;
    layer.removeChildren();
    for (const { keyframeFrame, json } of contents) {
      if (!json) continue;
      const scratch = new paper.Layer();
      scratch.importJSON(json);
      for (const child of [...scratch.children]) {
        this.setEmfKeyframeFrame(child, keyframeFrame);
        layer.addChild(child);
      }
      scratch.remove();
    }
    // Instances in an EMF composite: the bucket at the playhead's covering
    // keyframe shows its true elapsed frame; other buckets show their first.
    const playhead = this.emfPlayheadFrame;
    for (const inst of instancesOnLayer(layer)) {
      const bucket = this.getEmfKeyframeFrame(inst);
      const elapsed =
        playhead !== null && bucket !== null && playhead >= bucket
          ? this.emfElapsedFor(layerId, bucket, playhead)
          : 0;
      hydrateInstance(inst, this.symbolResolver, elapsed);
    }
    this.markerByItemId.clear();
    paper.view.update();
  }

  /**
   * Elapsed frames for an EMF bucket: playhead − bucket start when the
   * playhead sits inside that bucket's span (tracked via `elapsedByLayer`
   * for the covering keyframe), else 0.
   */
  private emfElapsedFor(layerId: string, bucket: number, playhead: number): number {
    const coveringElapsed = this.elapsedByLayer.get(layerId);
    if (coveringElapsed === undefined) return 0;
    return playhead - coveringElapsed === bucket ? coveringElapsed : 0;
  }

  /**
   * Export each EMF keyframe bucket on a layer as its own JSON string.
   * Untagged children join `playheadFrame`.
   */
  exportLayerContentsByKeyframe(
    layerId: string,
    playheadFrame: number,
  ): Map<number, string> {
    const layer = this.layerMap.get(layerId);
    const out = new Map<number, string>();
    if (!layer) return out;

    const buckets = new Map<number, paper.Item[]>();
    for (const child of layer.children) {
      const tag = this.getEmfKeyframeFrame(child) ?? playheadFrame;
      let list = buckets.get(tag);
      if (!list) {
        list = [];
        buckets.set(tag, list);
      }
      list.push(child);
    }

    const allChildren = [...layer.children];
    for (const [frame, items] of buckets) {
      const keep = new Set(items);
      for (const child of allChildren) {
        if (!keep.has(child)) child.remove();
      }
      const wasVisible = layer.visible;
      layer.visible = true;
      out.set(
        frame,
        layer.children.length === 0
          ? ""
          : withInstancesStripped(layer, () => (layer.exportJSON() as string) ?? ""),
      );
      layer.visible = wasVisible;
      layer.removeChildren();
      for (const child of allChildren) layer.addChild(child);
    }

    return out;
  }

  updateConfig(config: CanvasConfig) {
    this.config = config;
  }

  private createSelectionMarker(): string {
    return `selection-${this.nextSelectionMarkerId++}`;
  }

  private getSelectionMarker(item: paper.PathItem): string | null {
    return this.markerByItemId.get(item.id) ?? null;
  }

  private setSelectionMarker(item: paper.PathItem, marker: string): void {
    this.markerByItemId.set(item.id, marker);
  }

  private clearSelectionMarker(item: paper.PathItem): void {
    this.markerByItemId.delete(item.id);
  }

  private copySelectionMarker(source: paper.PathItem, target: paper.PathItem): void {
    const marker = this.getSelectionMarker(source);
    if (!marker) return;
    this.setSelectionMarker(target, marker);
  }

  private copySelectionMarkerFromMany(
    sources: paper.PathItem[],
    target: paper.PathItem,
  ): void {
    for (const source of sources) {
      const marker = this.getSelectionMarker(source);
      if (marker) {
        this.setSelectionMarker(target, marker);
        return;
      }
    }
  }

  /**
   * Atomically replace `oldItem` with `newItem` on the layer, transferring
   * the selection marker so direct-select picks survive boolean swaps.
   */
  private swapIn(
    oldItem: paper.PathItem,
    newItem: paper.PathItem,
    changedItems?: paper.PathItem[],
  ): paper.PathItem {
    this.copySelectionMarker(oldItem, newItem);
    this.copyEmfKeyframeFrame(oldItem, newItem);
    oldItem.replaceWith(newItem);
    this.clearSelectionMarker(oldItem);
    changedItems?.push(newItem);
    return newItem;
  }

  /** AABB hits on the active layer. */
  private queryByBounds(
    bounds: paper.Rectangle,
    padding: number = 0,
  ): paper.PathItem[] {
    const layer = paper.project?.activeLayer;
    if (!layer) return [];
    const expanded = bounds.expand(padding * 2);
    const out: paper.PathItem[] = [];
    // ponytail: no flattenGroups; merge callers keep the layer flat
    for (const item of this.getPathsOnPaperLayer(layer)) {
      if (!item.parent) continue;
      if (!expanded.intersects(item.bounds)) continue;
      out.push(item);
    }
    return out;
  }

  /**
   * Set the camera for view transformations
   */
  setCamera(camera: Camera) {
    this.camera = camera;
  }

  /**
   * Apply camera transformation to Paper.js view
   */
  applyCamera(): void {
    if (!this.camera) return;

    // Get the world-to-screen transformation matrix from camera
    const [a, b, c, d, tx, ty] = this.camera.getTransformMatrix();

    // Reset and apply the matrix to Paper.js view
    paper.view.matrix.set(a, b, c, d, tx, ty);

    this.updateAliasFixStrokesForCurrentZoom();

    paper.view.update();
  }

  /**
   * Convert screen coordinates to world coordinates using camera
   */
  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    if (!this.camera) {
      return { x: screenX, y: screenY };
    }
    return this.camera.screenToWorld(screenX, screenY);
  }

  /**
   * Convert world coordinates to screen coordinates using camera
   */
  worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    if (!this.camera) {
      return { x: worldX, y: worldY };
    }
    return this.camera.worldToScreen(worldX, worldY);
  }

  /**
   * Export document artwork as SVG in stage/world space (camera-independent).
   * `bounds: "content"` = auto-crop; otherwise pass a stage rectangle.
   * Optional `onlyLayerId` hides other document layers for the duration.
   * Optional `stageFill` draws a background rect behind the art.
   */
  exportDocumentSvgString(opts: {
    bounds: "content" | { x: number; y: number; width: number; height: number };
    onlyLayerId?: string | null;
    stageFill?: string | null;
  }): string {
    return this.onionSkin.withHidden(() => this.contextBackdrop.withHidden(() => {
      const visibility = new Map<string, boolean>();
      if (opts.onlyLayerId) {
        for (const [id, layer] of this.layerMap) {
          visibility.set(id, layer.visible);
          layer.visible = id === opts.onlyLayerId;
        }
      }

      let bg: paper.Path | null = null;
      try {
        // Plain rect / "content" — never Paper's "view" (viewport + camera matrix).
        const bounds =
          opts.bounds === "content"
            ? "content"
            : [
                opts.bounds.x,
                opts.bounds.y,
                opts.bounds.width,
                opts.bounds.height,
              ];
        const stageBox =
          opts.bounds === "content"
            ? null
            : new paper.Rectangle(
                opts.bounds.x,
                opts.bounds.y,
                opts.bounds.width,
                opts.bounds.height,
              );

        if (opts.stageFill) {
          let box: paper.Rectangle | null = stageBox;
          if (!box) {
            for (const layer of paper.project.layers) {
              if (!layer.visible) continue;
              if (this.onionSkin.includes(layer) || this.contextBackdrop.includes(layer)) continue;
              const b = layer.bounds;
              if (!b || (b.width <= 0 && b.height <= 0)) continue;
              box = box ? box.unite(b) : b.clone();
            }
          }
          if (box && box.width > 0 && box.height > 0) {
            bg = new paper.Path.Rectangle(box);
            bg.fillColor = new paper.Color(opts.stageFill);
            bg.strokeColor = null;
            const host =
              (opts.onlyLayerId
                ? this.layerMap.get(opts.onlyLayerId)
                : null) ??
              [...this.layerMap.values()].find((l) => l.visible) ??
              paper.project.activeLayer;
            host.insertChild(0, bg);
          }
        }

        return paper.project.exportSVG({
          bounds,
          // Force stage/world coords — never paper.view.matrix (viewport).
          matrix: new paper.Matrix(),
          asString: true,
          precision: 4,
        }) as string;
      } finally {
        bg?.remove();
        if (opts.onlyLayerId) {
          for (const [id, layer] of this.layerMap) {
            const prev = visibility.get(id);
            if (prev !== undefined) layer.visible = prev;
          }
        }
      }
    }));
  }

  // ============================================================
  // Layer Management
  // ============================================================

  /**
   * Logical layer id for a path item’s Paper.js layer, or null if unknown.
   */
  getLayerIdForPathItem(item: paper.Item): string | null {
    const pl = item.layer;
    if (!pl) return null;
    return this.getLayerIdForPaperLayer(pl);
  }

  markLayerDirty(layerId: string): void {
    if (!this.layerMap.has(layerId)) return;
    this.dirtyLayerIds.add(layerId);
  }

  consumeDirtyLayerIds(): string[] {
    const ids = [...this.dirtyLayerIds];
    this.dirtyLayerIds.clear();
    return ids;
  }

  isLayerDirty(layerId: string): boolean {
    return this.dirtyLayerIds.has(layerId);
  }

  getLayerName(id: string): string | null {
    const layer = this.layerMap.get(id);
    return layer ? layer.name : null;
  }

  private markPaperLayerDirty(layer: paper.Layer | null | undefined): void {
    if (!layer) return;
    const id = this.getLayerIdForPaperLayer(layer);
    if (id) this.dirtyLayerIds.add(id);
  }

  private markItemLayerDirty(item: paper.Item): void {
    this.markPaperLayerDirty(item.layer);
  }

  /**
   * Create a new layer with the given ID and name.
   * The new layer becomes the active layer.
   */
  createLayer(id: string, name: string): void {
    if (id === STAGE_LAYER_ID) return;
    // Create a new Paper.js layer - it automatically gets added to the project and becomes active
    const newLayer = new paper.Layer();
    newLayer.name = name;
    this.layerMap.set(id, newLayer);
    this.activeLayerId = id;
    this.overlayLayer?.bringToFront();
    newLayer.activate();
    paper.view.update();
  }

  /** Move live path items onto an existing layer (keeps draw order among them). */
  moveItemsToLayer(items: paper.Item[], layerId: string): void {
    const layer = this.layerMap.get(layerId);
    if (!layer) return;
    for (const item of items) {
      if (!item.parent) continue;
      this.markItemLayerDirty(item);
      layer.addChild(item);
    }
    this.normalizeInstances(layer);
    this.markLayerDirty(layerId);
    paper.view.update();
  }

  /**
   * Delete a layer by ID.
   * If the deleted layer was active, switches to another layer.
   * Returns false if layer doesn't exist or is the only layer.
   */
  deleteLayer(id: string): boolean {
    if (id === STAGE_LAYER_ID) return false;
    const layer = this.layerMap.get(id);
    if (!layer) return false;
    
    // Don't allow deleting the only layer
    if (this.layerMap.size <= 1) return false;
    
    // If deleting active layer, switch to another one first
    if (this.activeLayerId === id) {
      // Find another layer to activate
      for (const [otherId] of this.layerMap) {
        if (otherId !== id) {
          this.setActiveLayer(otherId);
          break;
        }
      }
    }
    
    // Remove the layer from Paper.js and our map
    layer.remove();
    this.layerMap.delete(id);
    paper.view.update();
    return true;
  }

  /**
   * Set the active layer by ID.
   * Returns false if layer doesn't exist.
   */
  setActiveLayer(id: string): boolean {
    if (id === STAGE_LAYER_ID) return false;
    const layer = this.layerMap.get(id);
    if (!layer) return false;
    this.activeLayerId = id;
    this.overlayLayer?.bringToFront();
    layer.activate();
    paper.view.update();
    return true;
  }

  /**
   * Get the currently active layer ID
   */
  getActiveLayerId(): string | null {
    return this.activeLayerId;
  }

  /**
   * Set layer visibility
   */
  setLayerVisibility(id: string, visible: boolean): void {
    if (id === STAGE_LAYER_ID) return;
    const layer = this.layerMap.get(id);
    if (!layer) return;
    
    layer.visible = visible;
    paper.view.update();
  }

  /**
   * Rename a logical layer (Paper.js layer name).
   */
  setLayerName(id: string, name: string): boolean {
    if (id === STAGE_LAYER_ID) return false;
    const layer = this.layerMap.get(id);
    if (!layer) return false;
    layer.name = name;
    paper.view.update();
    return true;
  }

  /**
   * Get layer visibility
   */
  getLayerVisibility(id: string): boolean {
    const layer = this.layerMap.get(id);
    return layer?.visible ?? false;
  }

  /**
   * Serialize a logical layer's content for history snapshots.
   * Always exports as visible so hide/solo state is not baked into artwork
   * (otherwise the next import would re-hide the layer).
   */
  exportLayerJSON(id: string): string | null {
    const layer = this.layerMap.get(id);
    if (!layer) return null;
    const wasVisible = layer.visible;
    layer.visible = true;
    // Symbol instances export as empty groups (matrix + pivot + data only).
    const json = withInstancesStripped(layer, () => layer.exportJSON() as string);
    layer.visible = wasVisible;
    return json;
  }

  /**
   * Serialize clones of `items` as a standalone layer JSON, translated so
   * `origin` (world) becomes (0,0). Originals are untouched. Used by
   * Convert to Symbol; the result is a symbol-content blob.
   */
  /** Union bounds of a stored layer JSON, or null when empty. */
  measureLayerJsonBounds(
    json: string,
  ): { x: number; y: number; width: number; height: number } | null {
    if (!json) return null;
    const scratch = new paper.Layer();
    scratch.importJSON(json);
    const b = scratch.bounds;
    const out =
      !b || (b.width <= 0 && b.height <= 0)
        ? null
        : { x: b.x, y: b.y, width: b.width, height: b.height };
    scratch.remove();
    return out;
  }

  /** Translate every child of a stored layer JSON by `delta`. */
  translateLayerJson(json: string, delta: { x: number; y: number }): string {
    if (!json || (delta.x === 0 && delta.y === 0)) return json;
    const scratch = new paper.Layer();
    scratch.importJSON(json);
    const point = new paper.Point(delta.x, delta.y);
    for (const child of scratch.children) child.translate(point);
    const out = scratch.exportJSON() as string;
    scratch.remove();
    return out;
  }

  /** Layer JSON containing one empty instance at `world` (for placing after convert). */
  exportInstanceLayerJSON(
    data: SymbolInstanceData,
    world: { x: number; y: number },
    name: string,
  ): string {
    const temp = new paper.Layer({ insert: false });
    temp.name = name;
    temp.addChild(createInstance(data, world));
    const json = temp.exportJSON() as string;
    temp.remove();
    return json;
  }

  exportItemsAsLayerJSON(items: paper.Item[], origin: { x: number; y: number }): string {
    const temp = new paper.Layer({ insert: false });
    for (const item of items) {
      if (!item.parent) continue;
      const clone = item.clone({ insert: false });
      if (isSymbolInstance(clone)) clone.removeChildren();
      const data = clone.data as Record<string, unknown> | null;
      if (data && "emfKeyframeFrame" in data) delete data.emfKeyframeFrame;
      clone.translate(new paper.Point(-origin.x, -origin.y));
      temp.addChild(clone);
    }
    normalizeInstanceOrder(temp);
    const json = temp.exportJSON() as string;
    temp.remove();
    return json;
  }

  /**
   * Insert a new symbol instance on `layerId` at `world`, hydrate it, and
   * mark the layer dirty. Returns the group (already selectable).
   */
  addInstanceToLayer(
    layerId: string,
    data: SymbolInstanceData,
    world: { x: number; y: number },
  ): paper.Group | null {
    const layer = this.layerMap.get(layerId);
    if (!layer) return null;
    const group = createInstance(data, world);
    layer.addChild(group);
    hydrateInstance(group, this.symbolResolver, this.elapsedFor(layerId));
    this.normalizeInstances(layer);
    this.markLayerDirty(layerId);
    this.overlayLayer?.bringToFront();
    paper.view.update();
    return group;
  }

  /**
   * Change an instance's symbol / playback and re-resolve its artwork.
   * Returns false when the item is not a live instance.
   */
  updateInstance(item: paper.Item, patch: Partial<Omit<SymbolInstanceData, "iid">>): boolean {
    if (!isSymbolInstance(item) || !item.parent) return false;
    const data = readInstance(item);
    if (!data) return false;
    writeInstance(item, { ...data, ...patch, iid: data.iid });
    const layerId = this.getLayerIdForPathItem(item);
    hydrateInstance(item, this.symbolResolver, layerId ? this.elapsedFor(layerId) : 0);
    if (layerId) this.markLayerDirty(layerId);
    paper.view.update();
    return true;
  }

  /** Move an instance's pivot back to the symbol's registration point (local 0,0). */
  resetInstancePivot(item: paper.Item): boolean {
    if (!isSymbolInstance(item) || !item.parent) return false;
    this.markItemLayerDirty(item);
    item.pivot = new paper.Point(0, 0);
    paper.view.update();
    return true;
  }

  /** True when the layer has no children (lets empty layers share one content id). */
  isLayerEmpty(id: string): boolean {
    const layer = this.layerMap.get(id);
    return !layer || layer.children.length === 0;
  }

  /**
   * Restore the full layer structure from a history entry: create missing
   * Paper layers, drop extras, sync name/visibility/z-order, and reimport
   * content for layers whose `json` is provided (undefined = unchanged,
   * skip the expensive reimport).
   */
  restoreLayersSnapshot(
    layers: Array<{
      id: string;
      name: string;
      visible: boolean;
      /** Layer content JSON; undefined means "content unchanged, keep as is". */
      json?: string;
    }>,
    activeLayerId: string,
  ): void {
    this.discardPendingMerge();
    const wantedIds = new Set(layers.map((l) => l.id));

    // Remove Paper layers that no longer exist in the target state.
    for (const [id, layer] of [...this.layerMap.entries()]) {
      if (!wantedIds.has(id)) {
        layer.remove();
        this.layerMap.delete(id);
        this.animatedInstanceLayers.delete(id);
      }
    }

    this.dirtyLayerIds.clear();
    let contentChanged = false;
    for (const wanted of layers) {
      let layer = this.layerMap.get(wanted.id);
      if (!layer) {
        layer = new paper.Layer();
        this.layerMap.set(wanted.id, layer);
      }
      layer.name = wanted.name;
      if (wanted.json !== undefined) {
        layer.removeChildren();
        if (wanted.json) this.importLayerContent(layer, wanted.json);
        this.hydratePaperLayer(wanted.id, layer);
        contentChanged = true;
      }
      // Re-apply after importJSON: Layer exports can embed a stale `name`
      // (from before a rename) or `visible: false` (from while hidden).
      layer.name = wanted.name;
      layer.visible = wanted.visible;
    }

    // Restored content has fresh item ids; stale markers would never match
    // (and would otherwise accumulate forever across undo/redo cycles).
    if (contentChanged) this.markerByItemId.clear();

    this.reorderLayers(layers.map((l) => l.id));

    const activeId =
      activeLayerId !== STAGE_LAYER_ID && this.layerMap.has(activeLayerId)
        ? activeLayerId
        : layers[layers.length - 1]?.id ?? null;
    if (activeId) {
      const activeLayer = this.layerMap.get(activeId);
      if (activeLayer) {
        this.activeLayerId = activeId;
        activeLayer.activate();
      }
    }

    paper.view.update();
  }

  private importLayerContent(layer: paper.Layer, json: string): void {
    const assetId = parseImageContent(json);
    if (assetId) {
      const image = this.imageResolver(assetId);
      if (!image) return;
      const raster = new paper.Raster(image);
      raster.locked = true;
      raster.data = { ...(raster.data as object), assetId };
      layer.addChild(raster);
      this.fitRasterContain(raster);
      return;
    }
    layer.importJSON(json);
  }

  private fitRasterContain(raster: paper.Raster): void {
    const { width, height } = stageStore.get();
    raster.matrix.reset();
    const rw = raster.width || 1;
    const rh = raster.height || 1;
    const scale = Math.min(width / rw, height / rh);
    raster.scaling = new paper.Point(scale, scale);
    raster.position = new paper.Point(width / 2, height / 2);
  }

  refitImageRasters(): void {
    for (const layer of this.layerMap.values()) {
      for (const child of layer.children) {
        if (child instanceof paper.Raster && (child.data as { assetId?: string }).assetId) {
          this.fitRasterContain(child);
        }
      }
    }
    if (typeof paper !== "undefined" && paper.view) paper.view.update();
  }

  // ============================================================
  // Onion Skin
  // ============================================================

  /** Remove all onion-skin ghost layers. */
  clearOnionSkin(): void {
    this.onionSkin.clear();
  }

  // ============================================================
  // Edit-in-place backdrop
  // ============================================================

  /** Rebuild the dimmed parent artwork behind a symbol being edited in place. */
  setContextBackdrop(levels: BackdropLevel[]): void {
    const prevActive = this.activeLayerId ? this.layerMap.get(this.activeLayerId) : null;
    this.contextBackdrop.set(levels, this.symbolResolver, prevActive);
    this.overlayLayer?.bringToFront();
    prevActive?.activate();
  }

  clearContextBackdrop(): void {
    this.contextBackdrop.clear();
  }

  hasContextBackdrop(): boolean {
    return this.contextBackdrop.isActive();
  }

  /**
   * Replace the onion-skin ghosts. Each ghost is one neighbor frame: its
   * visible layers' content JSONs (bottom→top), tinted at the given opacity.
   * Outline mode sits above artwork; filled mode sits under the active layer.
   */
  setOnionSkin(
    ghosts: Array<{ jsons: string[]; opacity: number; color: string }>,
    outline = true,
    outlineWidth = 6,
  ): void {
    // Creating paper.Layer activates it; remember the real active layer.
    const prevActive = this.activeLayerId
      ? this.layerMap.get(this.activeLayerId)
      : null;
    this.onionSkin.set(ghosts, outline, prevActive, outlineWidth);
  }

  /**
   * Initialize default layer - called once on app startup
   * Maps the initial Paper.js activeLayer to the given ID
   */
  initializeDefaultLayer(id: string, name: string): void {
    const defaultLayer = paper.project.activeLayer;
    defaultLayer.name = name;
    this.layerMap.set(id, defaultLayer);
    this.activeLayerId = id;
  }

  /**
   * Get all layer IDs in z-order (bottom to top)
   */
  getLayerIds(): string[] {
    const ids: string[] = [];
    // Paper.js layers are stored in z-order in project.layers
    for (const layer of paper.project.layers) {
      for (const [id, l] of this.layerMap) {
        if (l === layer) {
          ids.push(id);
          break;
        }
      }
    }
    return ids;
  }

  /**
   * Reorder layers by IDs from bottom to top.
   * Returns false if the provided list doesn't match existing layers.
   */
  reorderLayers(layerIdsBottomToTop: string[]): boolean {
    const filtered = layerIdsBottomToTop.filter((id) => id !== STAGE_LAYER_ID);
    if (filtered.length !== this.layerMap.size) return false;

    const orderedLayers: paper.Layer[] = [];
    for (const id of filtered) {
      const layer = this.layerMap.get(id);
      if (!layer) return false;
      orderedLayers.push(layer);
    }

    // Bringing each layer to front in bottom->top sequence yields exact z-order.
    for (const layer of orderedLayers) {
      layer.bringToFront();
    }

    // bringToFront() re-inserts layers via remove+insert; when the active
    // layer is removed, Paper silently moves project._activeLayer to a
    // sibling and it stays there after reinsertion. Re-activate the layer we
    // actually track — otherwise drawing lands on the wrong (old) layer
    // right after adding or reordering layers.
    const active = this.activeLayerId
      ? this.layerMap.get(this.activeLayerId)
      : null;
    active?.activate();

    // Outline ghosts above artwork; filled ghosts under the active layer.
    this.onionSkin.reposition(active);
    this.contextBackdrop.reposition();
    this.overlayLayer?.bringToFront();
    active?.activate();

    paper.view.update();
    return true;
  }

  /**
   * Detached clones of every selectable shape on the active layer, in z-order.
   * Used by the select tool to revert a floating extraction if the user
   * cancels instead of placing it.
   */
  captureActiveLayerSnapshot(): paper.PathItem[] {
    return this.getAllPaths().map((item) => item.clone({ insert: false }) as paper.PathItem);
  }

  /**
   * Replace the active layer contents with a previously captured snapshot.
   */
  restoreActiveLayerSnapshot(snapshot: paper.PathItem[]): paper.PathItem[] {
    const layer = paper.project.activeLayer;
    this.markPaperLayerDirty(layer);
    layer.removeChildren();
    this.markerByItemId.clear();
    for (const item of snapshot) {
      layer.addChild(item);
    }
    flattenGroups();
    paper.view.update();
    return [...snapshot];
  }

  /**
   * Snapshot layers in the select scope (for marquee extract revert).
   */
  captureSelectableLayersSnapshot(
    scope: SelectLayerScope = "all",
  ): Map<string, paper.Item[]> {
    const map = new Map<string, paper.Item[]>();
    for (const layer of this.getSelectablePaperLayersTopFirst(scope)) {
      const id = this.getLayerIdForPaperLayer(layer);
      if (!id) continue;
      // Paths and symbol instances (clones keep matrix / data / children).
      map.set(
        id,
        layer.children
          .filter((c) => this.isSelectableRoot(c))
          .map((item) => item.clone({ insert: false })),
      );
    }
    return map;
  }

  private isSelectableRoot(item: paper.Item): boolean {
    return (
      item instanceof paper.Path ||
      item instanceof paper.CompoundPath ||
      isSymbolInstance(item)
    );
  }

  restoreSelectableLayersSnapshot(
    snapshot: Map<string, paper.Item[]>,
  ): void {
    const prev = paper.project.activeLayer;
    this.markerByItemId.clear();
    for (const [id, items] of snapshot) {
      const layer = this.layerMap.get(id);
      if (!layer) continue;
      this.markLayerDirty(id);
      layer.activate();
      layer.removeChildren();
      for (const item of items) {
        layer.addChild(item);
      }
      flattenGroups();
    }
    prev.activate();
    paper.view.update();
  }

  /**
   * World-space width so the stroke stays ~`aliasFixScreenWidthPx` CSS pixels on screen
   * after the camera view scale (no camera: fixed hairline in world space).
   */
  private worldSpaceAliasFixStrokeWidth(): number {
    if (this.camera) {
      return this.aliasFixScreenWidthPx / this.camera.zoom;
    }
    return this.aliasFixStrokeWidth;
  }

  /**
   * Keep only stroke width in sync with zoom; avoids fill clone when `applyCamera` runs every frame.
   */
  private updateAliasFixStrokesForCurrentZoom(): void {
    if (!this.camera || !this.aliasFixEnabled) return;
    const z = this.camera.zoom;
    if (
      this.lastAliasFixCameraZoom != null &&
      Math.abs(z - this.lastAliasFixCameraZoom) < 1e-5
    ) {
      return;
    }
    this.lastAliasFixCameraZoom = z;
    for (const layer of paper.project.layers) {
      for (const child of layer.children) {
        if (child instanceof paper.Path || child instanceof paper.CompoundPath) {
          if (child.fillColor) {
            child.strokeWidth = this.worldSpaceAliasFixStrokeWidth();
          }
        }
      }
    }
  }

  /**
   * Apply fill and tiny same-color stroke to hide anti-aliased seams.
   */
  private applyPathStyle(item: paper.PathItem, fill: paper.Color | null): void {
    if (!fill) {
      item.fillColor = null;
      item.strokeColor = null;
      item.strokeWidth = 0;
      return;
    }
    item.fillColor = fill.clone();
    if (this.aliasFixEnabled) {
      item.strokeColor = fill.clone();
      item.strokeWidth = this.worldSpaceAliasFixStrokeWidth();
    } else {
      item.strokeColor = null;
      item.strokeWidth = 0;
    }
  }

  setAliasFixEnabled(enabled: boolean): void {
    this.aliasFixEnabled = enabled;
    for (const layer of paper.project.layers) {
      for (const child of layer.children) {
        if (child instanceof paper.Path || child instanceof paper.CompoundPath) {
          this.applyPathStyle(child, child.fillColor);
        }
      }
    }
    this.lastAliasFixCameraZoom =
      this.aliasFixEnabled && this.camera != null ? this.camera.zoom : null;
    paper.view.update();
  }

  private discardPendingMerge(): void {
    this.mergeQueue.discard();
    if (this.overlayLayer) {
      this.overlayLayer.removeChildren();
    }
  }

  private ensureOverlay(): paper.Layer {
    if (this.overlayLayer?.parent) return this.overlayLayer;
    const prev = paper.project.activeLayer;
    const overlay = new paper.Layer();
    overlay.name = "__pending_merge";
    overlay.locked = true;
    this.overlayLayer = overlay;
    prev?.activate();
    return overlay;
  }

  private enqueueOverlayAdditions(additions: paper.PathItem[]): void {
    const layerId = this.activeLayerId;
    if (!layerId || additions.length === 0) return;
    if (this.emfPlayheadFrame !== null) {
      for (const addition of additions) {
        if (this.getEmfKeyframeFrame(addition) === null) {
          this.setEmfKeyframeFrame(addition, this.emfPlayheadFrame);
        }
      }
    }
    const overlay = this.ensureOverlay();
    for (const item of additions) {
      if (item.parent !== overlay) overlay.addChild(item);
    }
    overlay.bringToFront();
    const json = exportItemsJson(additions);
    this.mergeQueue.enqueue(layerId, additions, json, this.emfPlayheadFrame !== null);
    paper.view.update();
  }

  /** Bake failed: move the pending strokes into their layer and merge here. */
  private commitPendingNow(layerId: string, items: Array<{ remove(): void }>): void {
    const layer = this.layerMap.get(layerId);
    if (!layer) {
      for (const item of items) item.remove();
      return;
    }
    const additions = items.filter(
      (item): item is paper.PathItem =>
        item instanceof paper.Path || item instanceof paper.CompoundPath,
    );
    for (const item of additions) layer.addChild(item);
    const prev = paper.project.activeLayer;
    layer.activate();
    this.commitAdditionsNow(layer, additions);
    prev?.activate();
    this.overlayLayer?.bringToFront();
  }

  private applyMergeResult(
    layerId: string,
    json: string,
    items: Array<{ remove(): void }>,
  ): void {
    for (const item of items) {
      item.remove();
    }
    const layer = this.layerMap.get(layerId);
    if (!layer) return;
    this.markLayerDirty(layerId);
    // Keep instance objects (by iid) so a selected instance survives the
    // worker rebuild; then re-resolve their artwork.
    replaceLayerContentKeepingInstances(layer, json);
    this.hydratePaperLayer(layerId, layer);
    const active = this.activeLayerId ? this.layerMap.get(this.activeLayerId) : null;
    active?.activate();
    this.updateAliasFixStrokesForCurrentZoom();
    this.overlayLayer?.bringToFront();
    paper.view.update();
  }

  private commitAdditionsNow(
    layer: paper.Layer,
    additions: paper.PathItem[],
  ): void {
    this.mergeAddInto(layer, additions);
    flattenGroups();
    paper.view.update();
  }

  private mergeAddInto(
    layer: paper.Layer,
    additions: paper.PathItem[],
  ): MergePassResult {
    this.markPaperLayerDirty(layer);
    this.tagEmfPlayhead(additions);
    const result = addToLayer(layer, additions, this.adopt());
    this.normalizeInstances(layer);
    return result;
  }

  /**
   * Import overlapping stacked fills (VTracer stacked / painter's SVG) without
   * the back-most full-image path deleting everything else already on the layer.
   * Each path only cuts fills committed earlier (back → front).
   */
  private mergeAddSequential(
    layer: paper.Layer,
    additions: paper.PathItem[],
  ): void {
    this.markPaperLayerDirty(layer);
    this.tagEmfPlayhead(additions);
    addToLayerSequential(layer, additions, this.adopt());
    this.normalizeInstances(layer);
  }

  private mergeSubtractInto(cutters: paper.PathItem[]): void {
    for (const cutter of cutters) this.markItemLayerDirty(cutter);
    subtractFromLayer(paper.project.activeLayer, cutters, this.adopt());
    flattenGroups();
    this.normalizeInstances(paper.project.activeLayer);
    paper.view.update();
  }

  /**
   * Transform an unattached item from screen (viewport) space into world
   * space using the camera's inverse matrix. Used by shape-primitive tools
   * that build their geometry directly in viewport coordinates rather than
   * going through an SVG trace.
   */
  private transformScreenToWorld(item: paper.Item): void {
    if (this.camera) {
      const [a, b, c, d, tx, ty] = this.camera.getInverseTransformMatrix();
      const screenToWorldMatrix = new paper.Matrix(a, b, c, d, tx, ty);
      item.transform(screenToWorldMatrix);
    } else {
      item.position = paper.view.center;
    }
  }

  /**
   * Cut each incoming path to the gesture's source symmetry region and append
   * mirrored copies. Tools stay unaware — call this immediately before merge.
   * When symmetry is off or no gesture side is set, returns `items` unchanged.
   */
  expandIncomingWithSymmetry(items: paper.PathItem[]): paper.PathItem[] {
    const settings = symmetryStore.get();
    const sourceSide = getSymmetryGestureSource();
    if (!settings.enabled || sourceSide === null || items.length === 0) {
      return items;
    }

    const layer = paper.project.activeLayer;
    const transforms = buildMirrorTransforms(settings);
    const expanded: paper.PathItem[] = [];

    for (const item of items) {
      if (!item || item.isEmpty()) {
        item?.remove();
        continue;
      }

      const fill = item.fillColor;
      const marker = this.getSelectionMarker(item);
      const clipRegion = buildSourceClipRegion(settings, sourceSide);

      let clipped: paper.PathItem | null = null;
      try {
        clipped = intersectOf(item, clipRegion);
      } finally {
        clipRegion.remove();
      }

      if (!clipped) clipped = item;
      if (clipped !== item) {
        this.clearSelectionMarker(item);
        item.remove();
      }

      if (!clipped || clipped.isEmpty()) {
        clipped?.remove();
        continue;
      }

      // Snap source onto the axis first so mirrors share exact centerline verts.
      snapPathItemToSymmetryAxis(clipped, settings);
      const family: paper.PathItem[] = [clipped];
      for (const matrix of transforms) {
        const mirror = clipped.clone({ insert: false }) as paper.PathItem;
        mirror.transform(matrix);
        snapPathItemToSymmetryAxis(mirror, settings);
        family.push(mirror);
      }

      const welded = forceUniteFamily(family);
      for (const piece of welded) {
        this.applyPathStyle(piece, fill);
        if (piece.parent !== layer) layer.addChild(piece);
        if (marker) this.setSelectionMarker(piece, marker);
        expanded.push(piece);
      }
    }

    clearSymmetryGestureSource();
    return expanded;
  }

  /**
   * Add a pre-built shape (given in viewport/screen coordinates) into the
   * active layer, mirroring the add-path merge pipeline used by traced
   * strokes.
   */
  addShape(shape: paper.PathItem, color: string = "#000000"): void {
    const layer = paper.project.activeLayer;
    const paperColor = new paper.Color(color);

    this.transformScreenToWorld(shape);
    this.applyPathStyle(shape, paperColor);
    if (shape.parent !== layer) layer.addChild(shape);

    const additions = this.expandIncomingWithSymmetry([shape]);
    if (additions.length === 0) {
      paper.view.update();
      return;
    }
    this.enqueueOverlayAdditions(additions);
  }

  /**
   * Subtract a pre-built shape (in viewport/screen coordinates) from the
   * active layer, mirroring `subtractPath`.
   */
  async subtractShape(shape: paper.PathItem): Promise<void> {
    await this.mergeIdle();
    this.transformScreenToWorld(shape);
    if (!shape.parent) paper.project.activeLayer.addChild(shape);

    const cutters = this.expandIncomingWithSymmetry([shape]);
    if (cutters.length === 0) {
      paper.view.update();
      return;
    }
    this.mergeSubtractInto(cutters);
  }

  private tagEmfPlayhead(items: paper.PathItem[]): void {
    if (this.emfPlayheadFrame === null) return;
    for (const item of items) {
      if (this.getEmfKeyframeFrame(item) === null) {
        this.setEmfKeyframeFrame(item, this.emfPlayheadFrame);
      }
    }
  }

  /** Inside mode: clip to `clip`, or paint behind everything when null. */
  private paintInside(
    layer: paper.Layer,
    incoming: paper.PathItem[],
    color: paper.Color,
    clip: paper.PathItem | null,
  ): void {
    for (const p of incoming) {
      this.applyPathStyle(p, color);
      if (p.parent !== layer) layer.addChild(p);
    }
    const pieces = this.expandIncomingWithSymmetry(incoming);
    if (pieces.length === 0) {
      paper.view.update();
      return;
    }
    this.markPaperLayerDirty(layer);
    this.tagEmfPlayhead(pieces);
    paintInsideLayer(layer, pieces, clip?.parent ? clip : null, this.adopt());
    flattenGroups();
    this.normalizeInstances(layer);
    paper.view.update();
  }

  async addShapeIntersectClip(
    shape: paper.PathItem,
    color: string = "#000000",
    clipPathItem: paper.PathItem | null,
  ): Promise<void> {
    await this.mergeIdle();
    const layer = paper.project.activeLayer;
    this.transformScreenToWorld(shape);
    if (shape.parent !== layer) layer.addChild(shape);
    this.paintInside(layer, [shape], new paper.Color(color), clipPathItem);
  }

  async addPath(
    svg: string,
    color: string = "#000000",
    immediate = false,
  ): Promise<void> {
    const layer = paper.project.activeLayer;
    const paperColor = new paper.Color(color);

    const newPaths = importSVG(svg, this.config, this.camera);
    if (newPaths.length === 0) return;

    for (const p of newPaths) {
      this.applyPathStyle(p, paperColor);
      layer.addChild(p);
    }

    const additions = this.expandIncomingWithSymmetry(newPaths);
    if (additions.length === 0) {
      paper.view.update();
      return;
    }
    if (immediate) {
      this.commitAdditionsNow(layer, additions);
      return;
    }
    this.enqueueOverlayAdditions(additions);
  }

  /**
   * Import an SVG into stage/world space (not viewport stroke space).
   * Preserves per-path fills unless `fillOverride` is set; optionally snaps fills
   * to the nearest document color. Set `convertStrokesToFills` for direct SVG
   * import (FlipCel is fill-only).
   */
  async addImportedSvg(
    svg: string,
    options: {
      stageWidth: number;
      stageHeight: number;
      fillOverride?: string | null;
      snapColors?: string[];
      convertStrokesToFills?: boolean;
      /** Leave painter's-order fills as-is (VTracer stacked hangs if planarized). */
      skipMerge?: boolean;
    },
  ): Promise<boolean> {
    await this.mergeIdle();
    const layer = paper.project.activeLayer;
    const item = paper.project.importSVG(svg) as paper.Item | null;
    if (!item) return false;

    let paths = extractPaths(item);
    for (const p of paths) {
      if (p.parent !== layer) layer.addChild(p);
    }
    if (
      item.parent &&
      item !== layer &&
      !(item instanceof paper.Path) &&
      !(item instanceof paper.CompoundPath)
    ) {
      item.remove();
    }
    flattenGroups();

    if (options.convertStrokesToFills) {
      paths = convertStrokesToFills(paths);
      for (const p of paths) {
        if (p.parent !== layer) layer.addChild(p);
      }
    }

    if (paths.length === 0) return false;

    // Fit traced artwork into the stage, centered.
    let bounds = paths[0].bounds.clone();
    for (let i = 1; i < paths.length; i += 1) {
      bounds = bounds.unite(paths[i].bounds);
    }
    if (bounds.width > 0 && bounds.height > 0) {
      const scale = Math.min(
        options.stageWidth / bounds.width,
        options.stageHeight / bounds.height,
      );
      const cx = bounds.center.x;
      const cy = bounds.center.y;
      const targetX = options.stageWidth / 2;
      const targetY = options.stageHeight / 2;
      for (const p of paths) {
        if (scale !== 1) p.scale(scale, new paper.Point(cx, cy));
        p.translate(new paper.Point(targetX - cx, targetY - cy));
      }
    }

    const snapPalette = options.snapColors ?? [];
    const override = options.fillOverride
      ? new paper.Color(options.fillOverride)
      : null;

    for (const p of paths) {
      let fill = override;
      if (!fill) {
        const existing = p.fillColor;
        if (existing && snapPalette.length > 0) {
          const snapped = nearestDocumentColor(paperColorToHex(existing), snapPalette);
          fill = new paper.Color(snapped);
        } else if (existing) {
          fill = existing;
        } else {
          fill = new paper.Color("#000000");
        }
      } else if (snapPalette.length > 0) {
        fill = new paper.Color(
          nearestDocumentColor(options.fillOverride!, snapPalette),
        );
      }
      this.applyPathStyle(p, fill);
    }

    const additions = this.expandIncomingWithSymmetry(paths);
    if (additions.length === 0) {
      paper.view.update();
      return false;
    }
    if (options.skipMerge) {
      this.markPaperLayerDirty(layer);
      this.tagEmfPlayhead(additions);
    } else {
      this.mergeAddSequential(layer, additions);
    }
    flattenGroups();
    paper.view.update();
    return true;
  }

  /**
   * Resolve a hit-test item to a root Path/CompoundPath on the active layer (for inside-mode clip).
   */
  hitToClipPathItem(hit: paper.Item | null): paper.PathItem | null {
    if (!hit) return null;
    let cur: paper.Item | null = hit;
    const layer = paper.project.activeLayer;
    let root: paper.PathItem | null = null;
    while (cur) {
      if (cur instanceof paper.Path || cur instanceof paper.CompoundPath) {
        if (cur.layer === layer) root = cur;
      }
      cur = cur.parent;
    }
    return root;
  }

  /**
   * Resolve any hit-tested child back to the selectable root shape (any layer).
   */
  resolveSelectableItem(hit: paper.Item | null): paper.Item | null {
    if (!hit) return null;
    const instance = instanceRootOf(hit);
    if (instance) return instance;
    return this.resolveSelectablePath(hit);
  }

  /** Like `resolveSelectableItem`, but ignores symbol instances (vertex tools). */
  resolveSelectablePath(hit: paper.Item | null): paper.PathItem | null {
    if (!hit) return null;
    if (instanceRootOf(hit)) return null;
    let cur: paper.Item | null = hit;
    let root: paper.PathItem | null = null;
    while (cur) {
      if (cur instanceof paper.Path || cur instanceof paper.CompoundPath) {
        root = cur;
      }
      cur = cur.parent;
    }
    return root;
  }

  /** Clip to `clipPathItem`, or paint behind all existing fills when it is null. */
  async addPathIntersectClip(
    svg: string,
    color: string = "#000000",
    clipPathItem: paper.PathItem | null,
  ): Promise<void> {
    await this.mergeIdle();
    const newPaths = importSVG(svg, this.config, this.camera);
    if (newPaths.length === 0) return;
    const layer =
      clipPathItem?.layer ?? paper.project.activeLayer;
    this.paintInside(
      layer,
      newPaths,
      new paper.Color(color),
      clipPathItem,
    );
  }

  async subtractPath(svg: string): Promise<void> {
    await this.mergeIdle();
    const eraserPaths = importSVG(svg, this.config, this.camera);
    if (eraserPaths.length === 0) return;

    const cutters = this.expandIncomingWithSymmetry(eraserPaths);
    if (cutters.length === 0) {
      paper.view.update();
      return;
    }
    this.mergeSubtractInto(cutters);
  }

  /**
   * Clear all content from the active layer
   */
  clearActiveLayer() {
    this.discardPendingMerge();
    const layer = paper.project.activeLayer;
    this.markPaperLayerDirty(layer);
    layer.removeChildren();
    this.markerByItemId.clear();
    paper.view.update();
  }

  /**
   * Clear all content from all layers
   */
  clear() {
    this.discardPendingMerge();
    for (const [id, layer] of this.layerMap) {
      this.dirtyLayerIds.add(id);
      layer.removeChildren();
    }
    this.markerByItemId.clear();
    paper.view.update();
  }

  /**
   * Full flatten: merge same colors, cut overlaps
   */
  async flatten() {
    await this.mergeIdle();
    const layer = paper.project.activeLayer;
    this.markPaperLayerDirty(layer);
    this.flattenLayer(layer);
    paper.view.update();
  }

  /**
   * Merge `aboveJson` down into `belowJson` using the same draw-merge
   * pipeline as live strokes (same-color unite, other-color cut). Only the
   * above paths are treated as new additions so they cut/unite into the
   * layer below — not the other way around. Does not touch `layerMap`.
   */
  mergeLayerJsons(belowJson: string, aboveJson: string): string {
    return mergeJsons(belowJson, aboveJson);
  }

  /**
   * Replay a layer through the draw-merge pipeline (bottom → top).
   */
  private flattenLayer(layer: paper.Layer): void {
    layer.activate();
    flattenGroups();
    const allPaths = this.getPathsOnPaperLayer(layer);
    if (allPaths.length < 2) return;

    // Replay through the same merge pipeline the tools use: later items cut
    // earlier ones and same-color overlaps union.
    const replayItems = allPaths.map((item) => {
      const clone = item.clone({ insert: false }) as paper.PathItem;
      this.copySelectionMarker(item, clone);
      return clone;
    });

    for (const item of allPaths) {
      this.clearSelectionMarker(item);
      item.remove();
    }

    for (const item of replayItems) {
      layer.addChild(item);
    }

    this.mergeAddInto(layer, replayItems);
    flattenGroups();
  }

  /**
   * Hit test at a screen position, converting to world coordinates if camera is active
   * Only tests against items on the active layer
   */
  hitTest(point: { x: number; y: number }): paper.Item | null {
    // Convert screen to world coordinates for hit testing
    const worldPoint = this.screenToWorld(point.x, point.y);
    
    // Hit test only against the active layer (not all layers)
    const result = paper.project.activeLayer.hitTest(
      new paper.Point(worldPoint.x, worldPoint.y),
      {
        fill: true,
        stroke: true,
        tolerance: 5 / (this.camera?.zoom ?? 1), // Adjust tolerance for zoom level
      },
    );
    return result?.item ?? null;
  }

  /**
   * Hit-test selectable art (top → bottom). With `scope: "active"` only the
   * active unlocked layer is tested; `"all"` covers every unlocked visible layer.
   * Draw tools keep `hitTest` (active layer, ignores lock).
   */
  hitTestSelectable(
    point: { x: number; y: number },
    scope: SelectLayerScope = "all",
  ): paper.Item | null {
    const worldPoint = this.screenToWorld(point.x, point.y);
    const paperPoint = new paper.Point(worldPoint.x, worldPoint.y);
    const options = {
      fill: true,
      stroke: true,
      tolerance: 5 / (this.camera?.zoom ?? 1),
    };
    for (const layer of this.getSelectablePaperLayersTopFirst(scope)) {
      const result = layer.hitTest(paperPoint, options);
      if (result?.item) {
        // Hits inside a symbol instance select the instance as a whole.
        return instanceRootOf(result.item) ?? result.item;
      }
    }
    return null;
  }

  getAllPaths(): paper.PathItem[] {
    const layer = paper.project?.activeLayer;
    if (!layer) return [];
    flattenGroups();
    return this.getPathsOnPaperLayer(layer);
  }

  /** Every selectable root on the active layer: merge shapes and symbol instances. */
  getAllSelectableItems(): paper.Item[] {
    const layer = paper.project?.activeLayer;
    if (!layer) return [];
    flattenGroups();
    return [...this.getPathsOnPaperLayer(layer), ...instancesOnLayer(layer)];
  }

  /** Paths in the select tool’s layer scope (unlocked + effectively visible). */
  getSelectablePaths(scope: SelectLayerScope = "all"): paper.PathItem[] {
    const out: paper.PathItem[] = [];
    for (const layer of this.getSelectablePaperLayersTopFirst(scope)) {
      out.push(...this.getPathsOnPaperLayer(layer));
    }
    return out;
  }

  /** Selectable roots in that scope: merge shapes and symbol instances. */
  getSelectableItems(scope: SelectLayerScope = "all"): paper.Item[] {
    const out: paper.Item[] = [];
    for (const layer of this.getSelectablePaperLayersTopFirst(scope)) {
      for (const child of layer.children) {
        if (this.isSelectableRoot(child)) out.push(child);
      }
    }
    return out;
  }

  private getPathsOnPaperLayer(layer: paper.Layer): paper.PathItem[] {
    return layer.children.filter(
      (c): c is paper.PathItem =>
        c instanceof paper.Path || c instanceof paper.CompoundPath,
    );
  }

  /** Layers the fill tool rasterizes: active only, or all unlocked visible. */
  getFillRasterLayers(scope: SelectLayerScope = "active"): paper.Layer[] {
    if (scope === "all") return this.getSelectablePaperLayersTopFirst("all");
    const layer = paper.project.activeLayer;
    return layer ? [layer] : [];
  }

  /** Selectable Paper layers, top-most first. */
  private getSelectablePaperLayersTopFirst(
    scope: SelectLayerScope = "all",
  ): paper.Layer[] {
    const state = layerStore.get();
    const locked = new Set(
      state.layers
        .filter((l) => l.locked || (l.kind ?? "regular") !== "regular")
        .map((l) => l.id),
    );

    if (scope === "active") {
      const layer = paper.project.activeLayer;
      if (!layer || this.onionSkin.includes(layer) || !layer.visible) return [];
      const id = this.getLayerIdForPaperLayer(layer);
      if (!id || locked.has(id)) return [];
      return [layer];
    }

    const layers: paper.Layer[] = [];
    // paper.project.layers is bottom → top
    for (let i = paper.project.layers.length - 1; i >= 0; i--) {
      const layer = paper.project.layers[i];
      if (this.onionSkin.includes(layer)) continue;
      if (!layer.visible) continue;
      const id = this.getLayerIdForPaperLayer(layer);
      if (!id || locked.has(id)) continue;
      layers.push(layer);
    }
    return layers;
  }

  private getLayerIdForPaperLayer(layer: paper.Layer): string | null {
    for (const [id, mapped] of this.layerMap) {
      if (mapped === layer) return id;
    }
    return null;
  }

  /** Top-most selected item’s layer id (among the given items), or null. */
  getTopmostSelectedLayerId(items: paper.Item[]): string | null {
    if (items.length === 0) return null;
    const ids = new Set(items.map((item) => item.id));
    for (const layer of this.getSelectablePaperLayersTopFirst()) {
      for (let i = layer.children.length - 1; i >= 0; i--) {
        const child = layer.children[i];
        if (!ids.has(child.id)) continue;
        if (this.isSelectableRoot(child)) {
          return this.getLayerIdForPaperLayer(layer);
        }
      }
    }
    return this.getLayerIdForPathItem(items[0]);
  }

  getPathById(id: number): paper.PathItem | null {
    for (const p of this.getAllPaths()) {
      if (p.id === id) return p;
    }
    return null;
  }

  getChildPaths(item: paper.PathItem): paper.Path[] {
    if (item instanceof paper.Path) return [item];
    if (item instanceof paper.CompoundPath) {
      return item.children.filter((child): child is paper.Path => child instanceof paper.Path);
    }
    return [];
  }

  getCombinedBounds(items: paper.Item[]): paper.Rectangle | null {
    if (items.length === 0) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const item of items) {
      const b = item.bounds;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width);
      maxY = Math.max(maxY, b.y + b.height);
    }

    return new paper.Rectangle(minX, minY, maxX - minX, maxY - minY);
  }

  getSelectionFrameBounds(items: paper.Item[]): paper.Rectangle | null {
    return this.getCombinedBounds(items);
  }

  /**
   * Screen-space axis-aligned bounding rectangle for the selection. Computed
   * by projecting the items' world-space bounds corners through the camera
   * and taking the axis-aligned box around the projected points. This is the
   * bbox the selection UI draws so the frame always looks like a proper
   * rectangle on screen regardless of camera rotation.
   */
  getSelectionFrameScreenBounds(
    items: paper.Item[],
  ): { x: number; y: number; width: number; height: number } | null {
    const worldBounds = this.getCombinedBounds(items);
    if (!worldBounds) return null;

    const worldCorners = [
      { x: worldBounds.x, y: worldBounds.y },
      { x: worldBounds.x + worldBounds.width, y: worldBounds.y },
      { x: worldBounds.x + worldBounds.width, y: worldBounds.y + worldBounds.height },
      { x: worldBounds.x, y: worldBounds.y + worldBounds.height },
    ];

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const c of worldCorners) {
      const s = this.worldToScreen(c.x, c.y);
      if (s.x < minX) minX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.x > maxX) maxX = s.x;
      if (s.y > maxY) maxY = s.y;
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  /**
   * Get the bounding box of all content in world space
   */
  getContentBounds(): {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null {
    const paths = this.getAllPaths();
    if (paths.length === 0) return null;

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;

    for (const path of paths) {
      const b = path.bounds;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width);
      maxY = Math.max(maxY, b.y + b.height);
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  movePath(item: paper.Item, delta: { x: number; y: number }) {
    this.markItemLayerDirty(item);
    item.position = item.position.add(new paper.Point(delta.x, delta.y));
    paper.view.update();
  }

  /**
   * Indices of `items` among siblings that share the same EMF keyframe tag
   * (or among all layer children when untagged). Used to map a live selection
   * onto matching children inside stored per-keyframe JSON.
   */
  getEmfBucketChildIndices(items: paper.Item[]): number[] {
    const indices: number[] = [];
    for (const item of items) {
      const parent = item.parent;
      if (!parent) continue;
      const tag = this.getEmfKeyframeFrame(item);
      let bucketIndex = 0;
      for (const child of parent.children) {
        if (child === item) {
          indices.push(bucketIndex);
          break;
        }
        if (this.getEmfKeyframeFrame(child) === tag) bucketIndex++;
      }
    }
    return indices;
  }

  /**
   * Import layer JSON, translate the given top-level children by `delta`,
   * and return the updated JSON. Does not touch the live layer.
   */
  translateLayerJsonChildren(
    json: string,
    childIndices: number[],
    delta: { x: number; y: number },
  ): string {
    if (!json || (delta.x === 0 && delta.y === 0)) return json;
    const scratch = new paper.Layer();
    scratch.importJSON(json);
    const point = new paper.Point(delta.x, delta.y);
    const unique = [...new Set(childIndices)].sort((a, b) => a - b);
    for (const idx of unique) {
      const child = scratch.children[idx];
      if (child) child.position = child.position.add(point);
    }
    const out = scratch.exportJSON() as string;
    scratch.remove();
    return out;
  }

  /**
   * Import layer JSON and move the union center of `childIndices` to `target`
   * (exact Magic Move positioning). Does not touch the live layer.
   */
  moveLayerJsonChildrenCenterTo(
    json: string,
    childIndices: number[],
    target: { x: number; y: number },
  ): string {
    return this.transformLayerJsonChildren(json, childIndices, {
      moveCenterTo: target,
    });
  }

  /**
   * Characteristic size of selected top-level children in layer JSON
   * (max of union width/height). Used so Magic Move scale stays relative to
   * frame 1 even when later keyframes have different native sizes.
   */
  getLayerJsonChildrenSize(json: string, childIndices: number[]): number {
    if (!json || childIndices.length === 0) return 0;
    const scratch = new paper.Layer();
    scratch.importJSON(json);
    const unique = [...new Set(childIndices)].sort((a, b) => a - b);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let any = false;
    for (const idx of unique) {
      const child = scratch.children[idx];
      if (!child) continue;
      const b = child.bounds;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width);
      maxY = Math.max(maxY, b.y + b.height);
      any = true;
    }
    scratch.remove();
    if (!any) return 0;
    return Math.max(maxX - minX, maxY - minY);
  }

  /**
   * Import layer JSON, optionally scale/rotate selected children around their
   * union center, then translate (relative delta or exact center snap). Does
   * not touch the live layer.
   */
  transformLayerJsonChildren(
    json: string,
    childIndices: number[],
    opts: {
      delta?: { x: number; y: number };
      moveCenterTo?: { x: number; y: number };
      rotateDeg?: number;
      /** Uniform scale about the selection center (1 = unchanged). */
      scale?: number;
    },
  ): string {
    if (!json || childIndices.length === 0) return json;
    const rotateDeg = opts.rotateDeg ?? 0;
    const scale =
      typeof opts.scale === "number" && Number.isFinite(opts.scale)
        ? opts.scale
        : 1;
    const delta = opts.delta;
    const moveCenterTo = opts.moveCenterTo;
    if (
      rotateDeg === 0 &&
      Math.abs(scale - 1) < 1e-9 &&
      !moveCenterTo &&
      (!delta || (delta.x === 0 && delta.y === 0))
    ) {
      return json;
    }

    const scratch = new paper.Layer();
    scratch.importJSON(json);
    const unique = [...new Set(childIndices)].sort((a, b) => a - b);
    const items: paper.Item[] = [];
    for (const idx of unique) {
      const child = scratch.children[idx];
      if (child) items.push(child);
    }
    if (items.length === 0) {
      scratch.remove();
      return json;
    }

    const centerOf = (): { x: number; y: number } => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const item of items) {
        const b = item.bounds;
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width);
        maxY = Math.max(maxY, b.y + b.height);
      }
      return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    };

    if (Math.abs(scale - 1) >= 1e-9 && scale > 0) {
      const pivot = centerOf();
      const origin = new paper.Point(pivot.x, pivot.y);
      for (const item of items) {
        item.scale(scale, origin);
      }
    }

    if (rotateDeg !== 0) {
      const pivot = centerOf();
      const origin = new paper.Point(pivot.x, pivot.y);
      for (const item of items) {
        item.rotate(rotateDeg, origin);
      }
    }

    if (moveCenterTo) {
      const c = centerOf();
      const point = new paper.Point(moveCenterTo.x - c.x, moveCenterTo.y - c.y);
      if (point.x !== 0 || point.y !== 0) {
        for (const item of items) {
          item.position = item.position.add(point);
        }
      }
    } else if (delta && (delta.x !== 0 || delta.y !== 0)) {
      const point = new paper.Point(delta.x, delta.y);
      for (const item of items) {
        item.position = item.position.add(point);
      }
    }

    const out = scratch.exportJSON() as string;
    scratch.remove();
    return out;
  }

  flipItemsInViewSpace(
    items: paper.Item[],
    axis: "horizontal" | "vertical",
  ): void {
    const liveItems = items.filter((item) => item.parent);
    if (liveItems.length === 0) return;

    const bounds = this.getCombinedBounds(liveItems);
    if (!bounds) return;

    const center = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
    const sx = axis === "horizontal" ? -1 : 1;
    const sy = axis === "vertical" ? -1 : 1;

    for (const item of liveItems) {
      this.scalePathInViewSpace(item, sx, sy, center);
    }
    paper.view.update();
  }

  extractSelectionFromScreenRect(
    start: { x: number; y: number },
    end: { x: number; y: number },
    scope: SelectLayerScope = "all",
    itemFilter?: (item: paper.Item) => boolean,
  ): paper.Item[] {
    // Build the selection polygon from all four screen corners projected to
    // world. This keeps the marquee matching what the user drew on screen
    // even when the camera is rotated (a camera-rotated screen rect maps to
    // a rotated world quadrilateral, not a world-axis-aligned rectangle).
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);
    const screenCorners = [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ];
    const worldPoints = screenCorners.map((c) => this.screenToWorld(c.x, c.y));
    const rect = new paper.Path({
      segments: worldPoints.map((p) => new paper.Point(p.x, p.y)),
      closed: true,
      insert: false,
    });
    const selectedItems = this.extractSelectionFromPath(rect, scope, itemFilter);
    rect.remove();
    return selectedItems;
  }

  extractSelectionFromScreenLasso(
    points: Array<{ x: number; y: number }>,
    scope: SelectLayerScope = "all",
    itemFilter?: (item: paper.Item) => boolean,
  ): paper.Item[] {
    if (points.length < 3) return [];

    const worldPoints = points.map((point) => this.screenToWorld(point.x, point.y));
    const lasso = new paper.Path({
      segments: worldPoints.map((point) => new paper.Point(point.x, point.y)),
      closed: true,
      insert: false,
    });
    const selectedItems = this.extractSelectionFromPath(lasso, scope, itemFilter);
    lasso.remove();
    return selectedItems;
  }

  /** Does the selection polygon overlap an axis-aligned world rect? */
  private pathTouchesBounds(selectionPath: paper.Path, bounds: paper.Rectangle): boolean {
    if (bounds.width <= 0 && bounds.height <= 0) {
      return selectionPath.contains(bounds.center);
    }
    const rect = new paper.Path.Rectangle({ rectangle: bounds, insert: false });
    try {
      return (
        selectionPath.intersects(rect) ||
        selectionPath.contains(bounds.center) ||
        rect.contains(selectionPath.firstSegment.point)
      );
    } finally {
      rect.remove();
    }
  }

  private extractSelectionFromPath(
    selectionPath: paper.Path,
    scope: SelectLayerScope = "all",
    itemFilter?: (item: paper.Item) => boolean,
  ): paper.Item[] {
    if (selectionPath.isEmpty()) return [];

    const selectionMarker = this.createSelectionMarker();
    const selectedItems: paper.Item[] = [];
    const changedItems: paper.PathItem[] = [];
    const prev = paper.project.activeLayer;

    for (const layer of this.getSelectablePaperLayersTopFirst(scope)) {
      this.markPaperLayerDirty(layer);
      layer.activate();
      flattenGroups();
      // Symbol instances are selected whole (never cut) when the marquee
      // touches their bounds.
      for (const inst of instancesOnLayer(layer)) {
        if (itemFilter && !itemFilter(inst)) continue;
        if (inst.children.length === 0) continue;
        if (!selectionPath.bounds.intersects(inst.bounds)) continue;
        if (this.pathTouchesBounds(selectionPath, inst.bounds)) {
          selectedItems.push(inst);
        }
      }
      const candidates = this.getPathsOnPaperLayer(layer)
        .filter((item) => item.parent)
        .filter((item) => !itemFilter || itemFilter(item))
        .filter((item) => selectionPath.bounds.expand(4).intersects(item.bounds));

      for (const candidate of candidates) {
        // Polygon containment, not the lasso box. A slash's box holds the
        // whole drawing; boolean subtract also returns empty when a holed
        // compound sits fully inside with no cut edge.
        if (fullyInside(selectionPath, candidate)) {
          this.setSelectionMarker(candidate, selectionMarker);
          selectedItems.push(candidate);
          continue;
        }
        if (!pathsCollide(candidate, selectionPath)) continue;
        const fill = candidate.fillColor;
        const selectedPiece = intersectOf(candidate, selectionPath);
        if (!selectedPiece) continue;

        this.applyPathStyle(selectedPiece, fill);
        this.setSelectionMarker(selectedPiece, selectionMarker);
        this.copyEmfKeyframeFrame(candidate, selectedPiece);

        const remainder = subtractOf(candidate, selectionPath);
        if (remainder === "gone") {
          this.clearSelectionMarker(candidate);
          candidate.remove();
        } else if (remainder && remainder !== "unchanged") {
          this.applyPathStyle(remainder, fill);
          this.swapIn(candidate, remainder, changedItems);
        } else {
          this.clearSelectionMarker(selectedPiece);
          selectedPiece.remove();
          continue;
        }

        if (!selectedPiece.parent) layer.addChild(selectedPiece);
        selectedItems.push(selectedPiece);
      }
    }

    prev.activate();

    const selectedPaths = selectedItems.filter(
      (item): item is paper.PathItem =>
        item instanceof paper.Path || item instanceof paper.CompoundPath,
    );
    const selectedInstances = selectedItems.filter((item) => isSymbolInstance(item));

    if (changedItems.length || selectedPaths.length) {
      splitCompounds([...changedItems, ...selectedPaths], this.adopt());
      const survivingSelectedItems = this.getSelectablePaths(scope).filter(
        (item) => this.getSelectionMarker(item) === selectionMarker,
      );
      for (const item of survivingSelectedItems) {
        if (item.parent) item.bringToFront();
        this.clearSelectionMarker(item);
      }
      // Shapes went to the top of their layers; instances stay above them.
      for (const layer of this.getSelectablePaperLayersTopFirst(scope)) {
        this.normalizeInstances(layer);
      }
      paper.view.update();
      return [...survivingSelectedItems, ...selectedInstances];
    }

    if (selectedInstances.length) paper.view.update();
    return selectedInstances;
  }

  scalePath(
    item: paper.Item,
    sx: number,
    sy: number,
    anchor: { x: number; y: number },
  ): void {
    this.markItemLayerDirty(item);
    item.scale(sx, sy, new paper.Point(anchor.x, anchor.y));
    paper.view.update();
  }

  /**
   * Scale in view-aligned (screen) axes around a world-space anchor. Achieved
   * by rotating the item into view-local space around the anchor, applying a
   * standard axis-aligned scale, then rotating back. This makes resize handles
   * behave intuitively when the camera is rotated — dragging a screen-right
   * handle scales horizontally on screen regardless of world orientation.
   */
  scalePathInViewSpace(
    item: paper.Item,
    sx: number,
    sy: number,
    worldAnchor: { x: number; y: number },
  ): void {
    this.markItemLayerDirty(item);
    const rotDeg = this.camera ? this.camera.getRotationDegrees() : 0;
    const anchor = new paper.Point(worldAnchor.x, worldAnchor.y);
    if (rotDeg !== 0) item.rotate(rotDeg, anchor);
    item.scale(sx, sy, anchor);
    if (rotDeg !== 0) item.rotate(-rotDeg, anchor);
    paper.view.update();
  }

  rotatePath(
    item: paper.Item,
    degrees: number,
    center: { x: number; y: number },
  ): void {
    this.markItemLayerDirty(item);
    item.rotate(degrees, new paper.Point(center.x, center.y));
    paper.view.update();
  }

  /**
   * Bring an item to the top of the layer (z-order)
   */
  bringToFront(item: paper.Item) {
    item.bringToFront();
    // Shapes never sit above symbol instances on their layer.
    if (!isSymbolInstance(item) && item.layer) this.normalizeInstances(item.layer);
    paper.view.update();
  }

  /**
   * Place a selected item using "add" logic - union with same color, cut different colors.
   * Merges into the item’s own layer (not necessarily the active layer).
   * Symbol instances don't merge; they are just kept above the shapes.
   */
  placeSelection(item: paper.Item): void {
    const layer = item.layer;
    if (!layer) return;
    if (isSymbolInstance(item)) {
      this.markPaperLayerDirty(layer);
      this.normalizeInstances(layer);
      paper.view.update();
      return;
    }
    if (!(item instanceof paper.Path || item instanceof paper.CompoundPath)) return;
    const prev = paper.project.activeLayer;
    layer.activate();
    try {
      const additions = this.expandIncomingWithSymmetry([item]);
      if (additions.length === 0) {
        paper.view.update();
        return;
      }
      this.mergeAddInto(layer, additions);
      flattenGroups();
    } finally {
      prev.activate();
    }
    paper.view.update();
  }

  placeItemsAsSelection(items: paper.Item[]): paper.Item[] {
    const liveItems = items.filter((item) => item.parent);
    if (liveItems.length === 0) return [];

    const instances: paper.Item[] = [];
    const paths: paper.PathItem[] = [];
    for (const item of liveItems) {
      if (isSymbolInstance(item)) instances.push(item);
      else if (item instanceof paper.Path || item instanceof paper.CompoundPath) {
        paths.push(item);
      }
    }
    for (const inst of instances) this.placeSelection(inst);

    const markerOrder = new Map<string, number>();
    for (const [index, item] of paths.entries()) {
      const marker = this.createSelectionMarker();
      markerOrder.set(marker, index);
      this.setSelectionMarker(item, marker);
    }

    for (const item of paths) {
      if (!item.parent) continue;
      this.placeSelection(item);
    }

    const survivors = this.getSelectablePaths()
      .filter((item) => {
        const marker = this.getSelectionMarker(item);
        return marker ? markerOrder.has(marker) : false;
      })
      .sort((a, b) => {
        const aMarker = this.getSelectionMarker(a);
        const bMarker = this.getSelectionMarker(b);
        return (aMarker ? markerOrder.get(aMarker) ?? 0 : 0)
          - (bMarker ? markerOrder.get(bMarker) ?? 0 : 0);
      });

    for (const item of survivors) {
      this.clearSelectionMarker(item);
    }

    paper.view.update();
    return [...survivors, ...instances.filter((i) => i.parent)];
  }

  /**
   * Reconcile a modified item with its spatial neighbors using the local merge algorithm.
   * First resolves self-intersections (vertex edits can fold a path over itself),
   * then merges with neighbors: same-color union, different-color top-cuts-bottom.
   * Returns the surviving item (may differ from input if a union or self-resolve occurred).
   */
  private reconcileItemOnce(item: paper.PathItem): {
    survivor: paper.PathItem | null;
    changedItems: paper.PathItem[];
    didChange: boolean;
  } {
    if (!item.parent) {
      return { survivor: null, changedItems: [], didChange: false };
    }
    const layer = item.layer ?? paper.project.activeLayer;
    const prev = paper.project.activeLayer;
    layer.activate();

    const merged = this.mergeAddInto(layer, [item]);
    const survivor = merged.survivors[0] ?? null;
    prev.activate();
    return {
      survivor,
      changedItems: merged.changedItems,
      didChange: merged.changedItems.length > 0 || survivor !== item,
    };
  }

  reconcileItemsToFixpoint(items: paper.PathItem[]): paper.PathItem[] {
    const queue: paper.PathItem[] = [];
    const queued = new Set<number>();
    const survivors = new Map<number, paper.PathItem>();

    const enqueue = (candidate: paper.PathItem | null | undefined) => {
      if (!candidate?.parent || queued.has(candidate.id)) return;
      queued.add(candidate.id);
      queue.push(candidate);
    };

    for (const item of items) enqueue(item);

    let iterations = 0;
    while (queue.length > 0 && iterations < 100) {
      const current = queue.shift()!;
      queued.delete(current.id);
      if (!current.parent) continue;

      const result = this.reconcileItemOnce(current);
      if (result.survivor?.parent) survivors.set(result.survivor.id, result.survivor);

      if (result.didChange) {
        const seeds = [
          ...(result.survivor?.parent ? [result.survivor] : []),
          ...result.changedItems.filter((item) => item.parent),
        ];
        for (const seed of seeds) {
          enqueue(seed);
          for (const hit of this.queryByBounds(seed.bounds, 2)) enqueue(hit);
        }
      }
      iterations++;
    }

    paper.view.update();
    return [...survivors.values()];
  }

  reconcileItem(item: paper.PathItem): paper.PathItem | null {
    return this.reconcileItemsToFixpoint([item])[0] ?? null;
  }

  /**
   * Duplicate a path item on the active layer with a small offset.
   */
  duplicateItem(item: paper.Item, offsetX = 10, offsetY = 10): paper.Item | null {
    if (!item.parent) return null;
    if (isSymbolInstance(item)) {
      const copy = duplicateInstance(item);
      copy.position = copy.position.add(new paper.Point(offsetX, offsetY));
      this.markItemLayerDirty(item);
      paper.view.update();
      return copy;
    }
    if (!(item instanceof paper.Path || item instanceof paper.CompoundPath)) return null;
    const clone = item.clone() as paper.PathItem;
    clone.position = clone.position.add(new paper.Point(offsetX, offsetY));
    this.applyPathStyle(clone, item.fillColor);
    paper.view.update();
    return clone;
  }

  /**
   * Paste serialized path JSON onto the active layer (any frame/layer).
   * Returns the created items (already inserted, not yet boolean-merged).
   */
  pasteJsonOntoActiveLayer(jsons: readonly string[]): paper.PathItem[] {
    if (jsons.length === 0) return [];
    const layer = paper.project.activeLayer;
    const prev = paper.project.activeLayer;
    layer.activate();
    const created: paper.PathItem[] = [];
    try {
      for (const json of jsons) {
        if (!json) continue;
        const imported = paper.project.importJSON(json) as paper.Item | null;
        if (!imported) continue;

        const paths =
          imported instanceof paper.Path || imported instanceof paper.CompoundPath
            ? [imported]
            : extractPaths(imported);

        if (
          imported.parent &&
          !(imported instanceof paper.Path) &&
          !(imported instanceof paper.CompoundPath)
        ) {
          imported.remove();
        }

        for (const path of paths) {
          if (path.parent !== layer) layer.addChild(path);
          this.applyPathStyle(path, path.fillColor);
          if (this.emfPlayheadFrame !== null) {
            this.setEmfKeyframeFrame(path, this.emfPlayheadFrame);
          }
          created.push(path);
        }
      }
      flattenGroups();
      this.normalizeInstances(layer);
    } finally {
      prev.activate();
    }
    paper.view.update();
    return created;
  }

  /**
   * Delete a path item from the active layer.
   */
  deleteItem(item: paper.Item): void {
    if (!item.parent) return;
    this.markItemLayerDirty(item);
    if (item instanceof paper.Path || item instanceof paper.CompoundPath) {
      this.clearSelectionMarker(item);
    }
    item.remove();
    paper.view.update();
  }

  /** Recolor a shape. Symbol instances are not recolorable (no-op). */
  setItemFillColor(item: paper.Item, color: string): void {
    if (!item.parent) return;
    if (!(item instanceof paper.Path || item instanceof paper.CompoundPath)) return;
    this.markItemLayerDirty(item);
    this.applyPathStyle(item, new paper.Color(color));
    paper.view.update();
  }

  /**
   * Recolor a path and merge with same-color neighbors (paint-bucket on ink).
   * Returns false when the item is gone or already that color.
   */
  recolorItem(item: paper.PathItem, color: string): boolean {
    if (!item.parent) return false;
    const paperColor = new paper.Color(color);
    const before = item.fillColor?.toCSS(true) ?? null;
    if (before === paperColor.toCSS(true)) return false;
    this.applyPathStyle(item, paperColor);
    this.reconcileItem(item);
    paper.view.update();
    return true;
  }

  strokeSelectionShapeOutline(ctx: CanvasRenderingContext2D, item: paper.Item): void {
    strokeSelectionShapeOutlineHelper(ctx, item, (x, y) => this.worldToScreen(x, y));
  }

  /** Magic Move selection: accent glow outline, no transform gizmo. */
  drawAccentSelectionOutline(
    items: paper.Item[],
    ctx: CanvasRenderingContext2D,
    accent: string,
  ): void {
    const live = items.filter((item) => item.parent);
    for (const item of live) {
      strokeAccentSelectionOutlineHelper(
        ctx,
        item,
        (x, y) => this.worldToScreen(x, y),
        accent,
      );
    }
  }

  drawTransformChrome(
    screenBounds: { x: number; y: number; width: number; height: number },
    ctx: CanvasRenderingContext2D,
    rotating?: { cursor: { x: number; y: number }; pivot: { x: number; y: number } } | null,
  ): SelectionHandle[] {
    return drawTransformChromeHelper(screenBounds, ctx, rotating);
  }

  drawSelection(
    item: paper.Item | paper.Item[] | null,
    ctx: CanvasRenderingContext2D,
    rotating?: { cursor: { x: number; y: number }; pivot: { x: number; y: number } } | null,
  ): SelectionHandle[] {
    if (!item) return [];

    const items = Array.isArray(item) ? item : [item];
    const screenBounds = this.getSelectionFrameScreenBounds(items);
    if (!screenBounds) return [];

    for (const it of items) {
      this.strokeSelectionShapeOutline(ctx, it);
    }

    const pivotWorld = this.getInstancePivotWorld(items);
    const pivotScreen = pivotWorld ? this.worldToScreen(pivotWorld.x, pivotWorld.y) : null;
    return drawTransformChromeHelper(screenBounds, ctx, rotating, pivotScreen);
  }

  /** World-space pivot when the selection is exactly one symbol instance. */
  getInstancePivotWorld(items: paper.Item[]): { x: number; y: number } | null {
    if (items.length !== 1) return null;
    const item = items[0];
    if (!isSymbolInstance(item) || !item.parent) return null;
    const pos = item.position;
    return { x: pos.x, y: pos.y };
  }

  /**
   * Move a symbol instance's transform origin to `world` without moving its
   * artwork. Paper's `position` is the pivot mapped through the matrix, so
   * only the local pivot changes.
   */
  setInstancePivotWorld(item: paper.Item, world: { x: number; y: number }): void {
    if (!isSymbolInstance(item)) return;
    this.markItemLayerDirty(item);
    item.pivot = item.matrix.inverseTransform(new paper.Point(world.x, world.y));
    paper.view.update();
  }
}
