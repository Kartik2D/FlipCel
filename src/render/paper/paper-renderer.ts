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
import { STAGE_LAYER_ID, layerStore, symmetryStore } from "../../state/index";
import {
  buildMirrorTransforms,
  buildSourceClipRegion,
  getSymmetryGestureSource,
} from "../../geometry/symmetry";

import type { SelectionHandle, MergePassResult } from "./types";
import {
  strokeSelectionShapeOutline as strokeSelectionShapeOutlineHelper,
  strokeAccentSelectionOutline as strokeAccentSelectionOutlineHelper,
  drawTransformChrome as drawTransformChromeHelper,
} from "./selection-chrome";
import {
  getContainmentPoint,
  likelyFullyCovered,
  forceEvenOdd,
  normalizeBooleanResult,
  pathsCollide,
  tryUnite,
  trySubtract,
  tryIntersect,
} from "./path-geometry";
import { OnionSkin } from "./onion-skin";
import { flattenGroups, importSVG } from "./svg-io";

export type { SelectionHandle, SelectionHandleId, MergePassResult } from "./types";

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
  private readonly selectionFramePaddingPx = 10;
  private nextSelectionMarkerId = 1;
  private markerByItemId = new Map<number, string>();

  // Onion-skin ghost layers: locked, dimmed renders of nearby animation
  // frames. Deliberately NOT in layerMap, so layer restore/reorder/flatten
  // logic never treats them as document content.
  private readonly onionSkin = new OnionSkin();

  // Layer management: maps logical layer IDs to Paper.js layers.
  // The active layer is the single source of truth for hit-testable shapes;
  // we deliberately do not maintain a separate spatial index. All neighbor
  // queries do a linear AABB scan over the layer's children, which is
  // trivially fast for hand-drawn vector scenes and removes a whole class
  // of index-drift bugs.
  private layerMap = new Map<string, paper.Layer>();
  private activeLayerId: string | null = null;
  /**
   * While Edit Multiple Frames is on, new strokes are tagged with this
   * keyframe frame (the playhead). Null when EMF is off.
   */
  private emfPlayheadFrame: number | null = null;

  constructor(_canvas: HTMLCanvasElement, config: CanvasConfig) {
    this.config = config;
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
   * Same-color unite / add-merge may only fold items that belong to the same
   * EMF keyframe bucket (or any items when EMF is off).
   */
  private emfContentCompatible(a: paper.Item, b: paper.Item): boolean {
    if (this.emfPlayheadFrame === null) {
      return this.getEmfKeyframeFrame(a) === null && this.getEmfKeyframeFrame(b) === null;
    }
    return this.resolveEmfKeyframeFrame(a) === this.resolveEmfKeyframeFrame(b);
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
    this.markerByItemId.clear();
    paper.view.update();
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
        layer.children.length === 0 ? "" : ((layer.exportJSON() as string) ?? ""),
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

  /**
   * Linear AABB sweep over the active layer for shapes whose bounds intersect
   * `bounds` (expanded by `padding` on each side). Replaces the previous
   * RBush spatial index — at the scale of a hand-drawn vector scene this is
   * sub-millisecond and removes any possibility of index drift.
   */
  private queryByBounds(
    bounds: paper.Rectangle,
    padding: number = 0,
  ): paper.PathItem[] {
    const expanded = bounds.expand(padding * 2);
    const out: paper.PathItem[] = [];
    for (const item of this.getAllPaths()) {
      if (!item.parent) continue;
      if (!expanded.intersects(item.bounds)) continue;
      out.push(item);
    }
    return out;
  }

  private getLayerOrder(layer: paper.Layer): Map<number, number> {
    const order = new Map<number, number>();
    for (let i = 0; i < layer.children.length; i++) {
      const child = layer.children[i];
      if (child instanceof paper.Path || child instanceof paper.CompoundPath) {
        order.set(child.id, i);
      }
    }
    return order;
  }

  private getOrderedNeighbors(
    seeds: paper.PathItem[],
    padding: number = 2,
  ): paper.PathItem[] {
    if (seeds.length === 0) return [];
    const layer = paper.project.activeLayer;
    const seedIds = new Set(seeds.map((seed) => seed.id));
    const neighbors = new Map<number, paper.PathItem>();
    for (const seed of seeds) {
      for (const hit of this.queryByBounds(seed.bounds, padding)) {
        if (hit.layer !== layer || !hit.parent || seedIds.has(hit.id)) continue;
        neighbors.set(hit.id, hit);
      }
    }
    const layerOrder = this.getLayerOrder(layer);
    return [...neighbors.values()].sort(
      (a, b) => (layerOrder.get(a.id) ?? 0) - (layerOrder.get(b.id) ?? 0),
    );
  }

  private splitDisconnectedItems(items: paper.CompoundPath[]): void {
    for (const item of items) {
      const layer = item.layer;
      if (!layer || !item.parent) continue;
      if (item.children.length <= 1) continue;

      const fillColor = item.fillColor;
      const selectionMarker = this.getSelectionMarker(item);
      const subs = item.children as paper.Path[];
      const n = subs.length;

      // Capture path data before modifying
      const subData = subs.map((s) => s.pathData);

      // Build containment parent tree (smallest containing path becomes parent)
      const parents: Array<number | null> = new Array(n).fill(null);
      const absArea = subs.map((p) => {
        try {
          return Math.abs(p.area);
        } catch {
          return Math.abs(p.bounds.area);
        }
      });

      // One reliable interior point per child is enough to decide parity.
      const interiorPoints = subs.map((p) => getContainmentPoint(p));

      for (let i = 0; i < n; i++) {
        let bestParent: number | null = null;
        let bestArea = Infinity;

        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const candidate = subs[j];

          // Quick reject by bounds
          if (!candidate.bounds.contains(subs[i].bounds)) continue;

          const interiorPoint = interiorPoints[i];
          if (!interiorPoint) continue;
          try {
            if (!candidate.contains(interiorPoint)) continue;
          } catch {
            continue;
          }

          const a = absArea[j];
          if (a < bestArea) {
            bestArea = a;
            bestParent = j;
          }
        }

        parents[i] = bestParent;
      }

      // Compute depths
      const depth = new Array(n).fill(0);
      const computeDepth = (i: number): number => {
        const p = parents[i];
        if (p == null) return 0;
        const d = computeDepth(p) + 1;
        depth[i] = d;
        return d;
      };
      for (let i = 0; i < n; i++) computeDepth(i);

      // Group contours by nearest even-depth ancestor (evenodd fill parity)
      const nearestEven = (i: number): number => {
        if (depth[i] % 2 === 0) return i;
        const p = parents[i];
        return p == null ? i : nearestEven(p);
      };

      const groups = new Map<number, number[]>();
      for (let i = 0; i < n; i++) {
        const root = nearestEven(i);
        if (!groups.has(root)) groups.set(root, []);
        // Root itself and odd-depth descendants belong to this piece.
        // Even-depth descendants start their own piece.
        if (i === root || depth[i] % 2 === 1) groups.get(root)!.push(i);
      }

      const filledRoots = [...groups.keys()].filter((k) => depth[k] % 2 === 0);
      if (filledRoots.length <= 1) continue;

      // Replace original compound with one item per filled region, attaching its holes.
      const idx = layer.children.indexOf(item);
      let insertAt = idx;
      const emfKeyframeFrame = this.getEmfKeyframeFrame(item);

      for (const root of filledRoots) {
        const indices = groups.get(root) ?? [root];
        if (indices.length === 1) {
          const src = subs[root];
          const newPath = new paper.Path(subData[root]);
          this.applyPathStyle(newPath, fillColor);
          if (selectionMarker) this.setSelectionMarker(newPath, selectionMarker);
          if (emfKeyframeFrame !== null) this.setEmfKeyframeFrame(newPath, emfKeyframeFrame);
          newPath.closed = src.closed;
          normalizeBooleanResult(newPath);
          layer.insertChild(insertAt++, newPath);
        } else {
          const newCompound = new paper.CompoundPath([]);
          this.applyPathStyle(newCompound, fillColor);
          if (selectionMarker) {
            this.setSelectionMarker(newCompound, selectionMarker);
          }
          if (emfKeyframeFrame !== null) {
            this.setEmfKeyframeFrame(newCompound, emfKeyframeFrame);
          }
          // Even-odd is robust to winding issues and preserves holes / islands correctly
          newCompound.fillRule = "evenodd";
          for (const ci of indices) {
            const src = subs[ci];
            const child = new paper.Path(subData[ci]);
            child.closed = src.closed;
            normalizeBooleanResult(child);
            newCompound.addChild(child);
          }
          normalizeBooleanResult(newCompound);
          layer.insertChild(insertAt++, newCompound);
        }
      }

      this.clearSelectionMarker(item);
      item.remove();
    }
  }

  private normalizeAfterLocalEdit(changedItems: paper.PathItem[]): void {
    // Local edits never introduce groups; keep layer flat and split only changed compounds.
    const compounds = changedItems.filter(
      (it): it is paper.CompoundPath =>
        it instanceof paper.CompoundPath && it.parent != null,
    );
    if (compounds.length) this.splitDisconnectedItems(compounds);
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
   * Serialize the current viewport (pan/zoom/rotation) to an SVG document.
   * Uses Paper's view bounds and view matrix so output matches on-screen art.
   */
  exportViewAsSvgString(): string {
    // Hide onion-skin ghosts for the export; they are not document content.
    return this.onionSkin.withHidden(
      () =>
        paper.project.exportSVG({
          bounds: "view",
          asString: true,
          precision: 4,
        }) as string,
    );
  }

  // ============================================================
  // Layer Management
  // ============================================================

  /**
   * Logical layer id for a path item’s Paper.js layer, or null if unknown.
   */
  getLayerIdForPathItem(item: paper.PathItem): string | null {
    const pl = item.layer;
    if (!pl) return null;
    for (const [id, layer] of this.layerMap) {
      if (layer === pl) return id;
    }
    return null;
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
    const json = layer.exportJSON() as string;
    layer.visible = wasVisible;
    return json;
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
    const wantedIds = new Set(layers.map((l) => l.id));

    // Remove Paper layers that no longer exist in the target state.
    for (const [id, layer] of [...this.layerMap.entries()]) {
      if (!wantedIds.has(id)) {
        layer.remove();
        this.layerMap.delete(id);
      }
    }

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
        if (wanted.json) layer.importJSON(wanted.json);
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

  // ============================================================
  // Onion Skin
  // ============================================================

  /** Remove all onion-skin ghost layers. */
  clearOnionSkin(): void {
    this.onionSkin.clear();
  }

  /**
   * Replace the onion-skin ghosts. Each ghost is one neighbor frame: its
   * visible layers' content JSONs (bottom→top), tinted at the given opacity.
   * Outline mode sits above artwork; filled mode sits under the active layer.
   */
  setOnionSkin(
    ghosts: Array<{ jsons: string[]; opacity: number; color: string }>,
    outline = true,
  ): void {
    // Creating paper.Layer activates it; remember the real active layer.
    const prevActive = this.activeLayerId
      ? this.layerMap.get(this.activeLayerId)
      : null;
    this.onionSkin.set(ghosts, outline, prevActive);
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
  ): Map<string, paper.PathItem[]> {
    const map = new Map<string, paper.PathItem[]>();
    for (const layer of this.getSelectablePaperLayersTopFirst(scope)) {
      const id = this.getLayerIdForPaperLayer(layer);
      if (!id) continue;
      map.set(
        id,
        this.getPathsOnPaperLayer(layer).map(
          (item) => item.clone({ insert: false }) as paper.PathItem,
        ),
      );
    }
    return map;
  }

  restoreSelectableLayersSnapshot(
    snapshot: Map<string, paper.PathItem[]>,
  ): void {
    const prev = paper.project.activeLayer;
    this.markerByItemId.clear();
    for (const [id, items] of snapshot) {
      const layer = this.layerMap.get(id);
      if (!layer) continue;
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

  private removeIfFullyCovered(
    cutter: paper.PathItem,
    target: paper.PathItem,
  ): boolean {
    if (!target.parent) return false;
    if (!likelyFullyCovered(cutter, target)) return false;
    this.clearSelectionMarker(target);
    target.remove();
    return true;
  }

  /**
   * Fold same-color neighbors into `current` via unite. Neighbors that fail to
   * unite (including pathsCollide reject) are left in place.
   */
  private foldSameColorUnites(
    layer: paper.Layer,
    current: paper.PathItem,
    neighbors: paper.PathItem[],
    changedItems: paper.PathItem[],
    consumedIds: Set<number>,
  ): { current: paper.PathItem; unitedAny: boolean } {
    let unitedAny = false;
    const currentColor = current.fillColor?.toCSS(true) ?? "none";

    for (const neighbor of neighbors) {
      if (!current.parent || !neighbor.parent) continue;
      if (current === neighbor || consumedIds.has(neighbor.id)) continue;
      if (!this.emfContentCompatible(current, neighbor)) continue;
      const neighborColor = neighbor.fillColor?.toCSS(true) ?? "none";
      if (neighborColor !== currentColor) continue;

      // tryUnite gates on pathsCollide once — AABB-only near-misses skip boolean.
      const united = tryUnite(current, neighbor);
      if (!united) continue;

      this.applyPathStyle(united, current.fillColor);
      this.copySelectionMarkerFromMany([current, neighbor], united);
      this.copyEmfKeyframeFrame(current, united);
      this.clearSelectionMarker(current);
      this.clearSelectionMarker(neighbor);
      consumedIds.add(neighbor.id);
      current.remove();
      neighbor.remove();
      if (!united.parent) layer.addChild(united);
      changedItems.push(united);
      current = united;
      unitedAny = true;
    }

    return { current, unitedAny };
  }

  private mergeAddInto(
    layer: paper.Layer,
    additions: paper.PathItem[],
  ): MergePassResult {
    const changedItems: paper.PathItem[] = [];
    const survivors: paper.PathItem[] = [];

    // New strokes during EMF belong to the playhead frame.
    if (this.emfPlayheadFrame !== null) {
      for (const addition of additions) {
        if (this.getEmfKeyframeFrame(addition) === null) {
          this.setEmfKeyframeFrame(addition, this.emfPlayheadFrame);
        }
      }
    }

    for (const addition of additions) {
      if (!addition.parent) continue;
      let current = addition;
      const consumedIds = new Set<number>();

      // One AABB neighbor query, then same-color unites, then other-color cuts.
      // After a successful unite pass, re-query once for newly overlapping
      // same-color neighbors whose bounds were outside the pre-unite AABB.
      // During EMF, only interact with items in the same content bucket so
      // drawing on the playhead cannot merge into / punch other frames.
      const neighbors = this.getOrderedNeighbors([current]);
      const currentColor = current.fillColor?.toCSS(true) ?? "none";

      const sameColor: paper.PathItem[] = [];
      let otherColor: paper.PathItem[] = [];
      for (const neighbor of neighbors) {
        if (!neighbor.parent || neighbor === current) continue;
        if (!this.emfContentCompatible(current, neighbor)) continue;
        const neighborColor = neighbor.fillColor?.toCSS(true) ?? "none";
        if (neighborColor === currentColor) sameColor.push(neighbor);
        else otherColor.push(neighbor);
      }

      let fold = this.foldSameColorUnites(
        layer,
        current,
        sameColor,
        changedItems,
        consumedIds,
      );
      current = fold.current;

      if (fold.unitedAny && current.parent) {
        const expandedNeighbors = this.getOrderedNeighbors([current]);
        const fillColor = current.fillColor?.toCSS(true) ?? "none";
        const newSameColor: paper.PathItem[] = [];
        otherColor = [];
        for (const neighbor of expandedNeighbors) {
          if (!neighbor.parent || neighbor === current) continue;
          if (consumedIds.has(neighbor.id)) continue;
          if (!this.emfContentCompatible(current, neighbor)) continue;
          const neighborColor = neighbor.fillColor?.toCSS(true) ?? "none";
          if (neighborColor === fillColor) newSameColor.push(neighbor);
          else otherColor.push(neighbor);
        }
        fold = this.foldSameColorUnites(
          layer,
          current,
          newSameColor,
          changedItems,
          consumedIds,
        );
        current = fold.current;
      }

      if (!current.parent) continue;

      for (const neighbor of otherColor) {
        if (!current.parent || !neighbor.parent) continue;
        if (consumedIds.has(neighbor.id)) continue;

        // pathsCollide inside trySubtract skips non-touching AABB overlaps.
        const cutNeighbor = trySubtract(neighbor, current);
        if (cutNeighbor) {
          this.applyPathStyle(cutNeighbor, neighbor.fillColor);
          this.swapIn(neighbor, cutNeighbor, changedItems);
          continue;
        }
        // Only delete when subtract returned empty and coverage heuristic agrees.
        this.removeIfFullyCovered(current, neighbor);
      }

      if (current.parent) survivors.push(current);
    }

    return { survivors, changedItems };
  }

  private mergeSubtractInto(cutters: paper.PathItem[]): MergePassResult {
    const changedItems: paper.PathItem[] = [];
    for (const cutter of cutters) {
      const neighbors = this.getOrderedNeighbors([cutter]);
      for (const neighbor of neighbors) {
        if (!neighbor.parent) continue;
        const cutNeighbor = trySubtract(neighbor, cutter);
        if (cutNeighbor) {
          this.applyPathStyle(cutNeighbor, neighbor.fillColor);
          this.swapIn(neighbor, cutNeighbor, changedItems);
          continue;
        }
        this.removeIfFullyCovered(cutter, neighbor);
      }
      this.clearSelectionMarker(cutter);
      cutter.remove();
    }
    return { survivors: [], changedItems };
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
        clipped = tryIntersect(item, clipRegion);
        if (!clipped && likelyFullyCovered(clipRegion, item)) {
          clipped = item.clone({ insert: false }) as paper.PathItem;
          normalizeBooleanResult(clipped);
          forceEvenOdd(clipped);
        }
      } finally {
        clipRegion.remove();
      }

      this.clearSelectionMarker(item);
      item.remove();

      if (!clipped || clipped.isEmpty()) {
        clipped?.remove();
        continue;
      }

      this.applyPathStyle(clipped, fill);
      if (clipped.parent !== layer) layer.addChild(clipped);
      if (marker) this.setSelectionMarker(clipped, marker);
      expanded.push(clipped);

      for (const matrix of transforms) {
        const mirror = clipped.clone({ insert: false }) as paper.PathItem;
        mirror.transform(matrix);
        this.applyPathStyle(mirror, fill);
        layer.addChild(mirror);
        expanded.push(mirror);
      }
    }

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
    const merged = this.mergeAddInto(layer, additions);
    this.normalizeAfterLocalEdit([...merged.changedItems, ...merged.survivors]);
    flattenGroups();
    paper.view.update();
  }

  /**
   * Subtract a pre-built shape (in viewport/screen coordinates) from the
   * active layer, mirroring `subtractPath`.
   */
  subtractShape(shape: paper.PathItem): void {
    this.transformScreenToWorld(shape);
    if (!shape.parent) paper.project.activeLayer.addChild(shape);

    const cutters = this.expandIncomingWithSymmetry([shape]);
    if (cutters.length === 0) {
      paper.view.update();
      return;
    }
    const merged = this.mergeSubtractInto(cutters);
    this.normalizeAfterLocalEdit(merged.changedItems);
    flattenGroups();
    paper.view.update();
  }

  /**
   * Add a pre-built shape clipped by intersect with a target item (or behind
   * existing geometry when `clipPathItem` is null), mirroring
   * `addPathIntersectClip`.
   */
  addShapeIntersectClip(
    shape: paper.PathItem,
    color: string = "#000000",
    clipPathItem: paper.PathItem | null,
  ): void {
    const layer = paper.project.activeLayer;
    const paperColor = new paper.Color(color);

    this.transformScreenToWorld(shape);
    if (shape.parent !== layer) layer.addChild(shape);

    const clippedPaths: paper.PathItem[] = [];
    if (clipPathItem) {
      const clip = clipPathItem.clone({ insert: false });
      try {
        const clipped = tryIntersect(shape, clip);
        shape.remove();
        if (clipped) {
          this.applyPathStyle(clipped, paperColor);
          layer.addChild(clipped);
          clippedPaths.push(clipped);
        }
      } finally {
        clip.remove();
      }
    } else {
      const padding = 2;
      let remaining: paper.PathItem | null = shape;
      const existing = this.queryByBounds(shape.bounds, padding).filter(
        (it) => it.layer === layer,
      );
      for (const ex of existing) {
        if (!remaining || !ex.parent) break;
        const diff = trySubtract(remaining, ex);
        if (diff) {
          remaining.remove();
          remaining = diff;
          continue;
        }
        if (likelyFullyCovered(ex, remaining)) {
          remaining.remove();
          remaining = null;
          break;
        }
      }
      if (remaining && !remaining.isEmpty()) {
        this.applyPathStyle(remaining, paperColor);
        if (remaining.parent !== layer) layer.addChild(remaining);
        clippedPaths.push(remaining);
      } else {
        remaining?.remove();
      }
    }

    if (clippedPaths.length === 0) {
      paper.view.update();
      return;
    }

    const additions = this.expandIncomingWithSymmetry(clippedPaths);
    if (additions.length === 0) {
      paper.view.update();
      return;
    }
    const merged = this.mergeAddInto(layer, additions);
    this.normalizeAfterLocalEdit([...merged.changedItems, ...merged.survivors]);
    flattenGroups();
    paper.view.update();
  }

  async addPath(svg: string, color: string = "#000000"): Promise<void> {
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
    const merged = this.mergeAddInto(layer, additions);
    this.normalizeAfterLocalEdit([...merged.changedItems, ...merged.survivors]);
    flattenGroups();
    paper.view.update();
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
  resolveSelectableItem(hit: paper.Item | null): paper.PathItem | null {
    if (!hit) return null;
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

  /**
   * Add traced paths clipped by intersect with a shape (or full viewport when clipPathItem is null).
   * Result merges into the layer like addPath.
   */
  async addPathIntersectClip(
    svg: string,
    color: string = "#000000",
    clipPathItem: paper.PathItem | null,
  ): Promise<void> {
    const layer = paper.project.activeLayer;
    const paperColor = new paper.Color(color);

    const newPaths = importSVG(svg, this.config, this.camera);
    if (newPaths.length === 0) return;

    const clippedPaths: paper.PathItem[] = [];
    if (clipPathItem) {
      const clip = clipPathItem.clone({ insert: false });
      try {
        for (const p of newPaths) {
          const clipped = tryIntersect(p, clip);
          p.remove();
          if (clipped) {
            this.applyPathStyle(clipped, paperColor);
            layer.addChild(clipped);
            clippedPaths.push(clipped);
          }
        }
      } finally {
        clip.remove();
      }
    } else {
      // Paint-behind fallback: keep only the non-overlapping parts vs all touching existing paths.
      const padding = 2;
      for (const p of newPaths) {
        let remaining: paper.PathItem | null = p;
        const existing = this.queryByBounds(p.bounds, padding).filter(
          (it) => it.layer === layer,
        );
        for (const ex of existing) {
          if (!remaining || !ex.parent) break;
          const diff = trySubtract(remaining, ex);
          if (diff) {
            remaining.remove();
            remaining = diff;
            continue;
          }
          if (likelyFullyCovered(ex, remaining)) {
            remaining.remove();
            remaining = null;
            break;
          }
        }
        if (remaining && !remaining.isEmpty()) {
          this.applyPathStyle(remaining, paperColor);
          layer.addChild(remaining);
          clippedPaths.push(remaining);
        } else {
          remaining?.remove();
        }
      }
    }

    if (clippedPaths.length === 0) {
      paper.view.update();
      return;
    }

    const additions = this.expandIncomingWithSymmetry(clippedPaths);
    if (additions.length === 0) {
      paper.view.update();
      return;
    }
    const merged = this.mergeAddInto(layer, additions);
    this.normalizeAfterLocalEdit([...merged.changedItems, ...merged.survivors]);
    flattenGroups();
    paper.view.update();
  }

  async subtractPath(svg: string): Promise<void> {
    const eraserPaths = importSVG(svg, this.config, this.camera);
    if (eraserPaths.length === 0) return;

    const cutters = this.expandIncomingWithSymmetry(eraserPaths);
    if (cutters.length === 0) {
      paper.view.update();
      return;
    }
    const merged = this.mergeSubtractInto(cutters);
    this.normalizeAfterLocalEdit(merged.changedItems);
    flattenGroups();
    paper.view.update();
  }

  /**
   * Clear all content from the active layer
   */
  clearActiveLayer() {
    const layer = paper.project.activeLayer;
    layer.removeChildren();
    this.markerByItemId.clear();
    paper.view.update();
  }

  /**
   * Clear all content from all layers
   */
  clear() {
    for (const layer of this.layerMap.values()) {
      layer.removeChildren();
    }
    this.markerByItemId.clear();
    paper.view.update();
  }

  /**
   * Full flatten: merge same colors, cut overlaps
   */
  flatten() {
    const layer = paper.project.activeLayer;
    const allPaths = this.getAllPaths();
    if (allPaths.length < 2) {
      paper.view.update();
      return;
    }

    // Replay the current layer through the exact same merge pipeline the
    // tools use: bottom-to-top additions where later items cut earlier ones
    // and same-color overlaps union. This keeps flatten behavior aligned with
    // normal drawing instead of maintaining a separate global boolean path.
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

    const merged = this.mergeAddInto(layer, replayItems);
    this.normalizeAfterLocalEdit([...merged.changedItems, ...merged.survivors]);
    flattenGroups();
    paper.view.update();
  }

  /**
   * Merge every layer into the active layer, then flatten overlaps/colors.
   * Returns the surviving layer ID, or null if no active layer exists.
   */
  flattenAllLayers(): string | null {
    const targetLayerId = this.activeLayerId;
    if (!targetLayerId) return null;

    const targetLayer = this.layerMap.get(targetLayerId);
    if (!targetLayer) return null;

    targetLayer.activate();

    for (const layer of [...paper.project.layers]) {
      // Onion-skin ghosts are view furniture, not document content.
      if (this.onionSkin.includes(layer)) continue;
      for (const child of [...layer.children]) {
        targetLayer.addChild(child);
      }
    }

    for (const [layerId, layer] of [...this.layerMap.entries()]) {
      if (layerId === targetLayerId) continue;
      layer.remove();
      this.layerMap.delete(layerId);
    }

    targetLayer.visible = true;
    this.flatten();
    return targetLayerId;
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
      if (result?.item) return result.item;
    }
    return null;
  }

  getAllPaths(): paper.PathItem[] {
    // Single source of truth for "what shapes exist on the active layer".
    // Flatten any stray Group first so a path can never hide inside a wrapper
    // — that's the entire invariant the codebase now relies on.
    flattenGroups();
    return this.getPathsOnPaperLayer(paper.project.activeLayer);
  }

  /** Paths in the select tool’s layer scope (unlocked + effectively visible). */
  getSelectablePaths(scope: SelectLayerScope = "all"): paper.PathItem[] {
    const out: paper.PathItem[] = [];
    for (const layer of this.getSelectablePaperLayersTopFirst(scope)) {
      out.push(...this.getPathsOnPaperLayer(layer));
    }
    return out;
  }

  private getPathsOnPaperLayer(layer: paper.Layer): paper.PathItem[] {
    return layer.children.filter(
      (c): c is paper.PathItem =>
        c instanceof paper.Path || c instanceof paper.CompoundPath,
    );
  }

  /** Selectable Paper layers, top-most first. */
  private getSelectablePaperLayersTopFirst(
    scope: SelectLayerScope = "all",
  ): paper.Layer[] {
    const state = layerStore.get();
    const locked = new Set(
      state.layers.filter((l) => l.locked || l.kind === "stage").map((l) => l.id),
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
  getTopmostSelectedLayerId(items: paper.PathItem[]): string | null {
    if (items.length === 0) return null;
    const ids = new Set(items.map((item) => item.id));
    for (const layer of this.getSelectablePaperLayersTopFirst()) {
      for (let i = layer.children.length - 1; i >= 0; i--) {
        const child = layer.children[i];
        if (!ids.has(child.id)) continue;
        if (child instanceof paper.Path || child instanceof paper.CompoundPath) {
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
    const bounds = this.getCombinedBounds(items);
    if (!bounds) return null;
    const worldPadding = this.camera
      ? this.selectionFramePaddingPx / this.camera.zoom
      : this.selectionFramePaddingPx;
    return new paper.Rectangle(
      bounds.x - worldPadding,
      bounds.y - worldPadding,
      bounds.width + worldPadding * 2,
      bounds.height + worldPadding * 2,
    );
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

    const pad = this.selectionFramePaddingPx;
    return {
      x: minX - pad,
      y: minY - pad,
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2,
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
    items: paper.PathItem[],
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

  simplifyItems(items: paper.PathItem[]): void {
    const liveItems = items.filter((item) => item.parent);
    if (liveItems.length === 0) return;

    for (const item of liveItems) {
      for (const path of this.getChildPaths(item)) {
        path.simplify();
      }
    }
    paper.view.update();
  }

  extractSelectionFromScreenRect(
    start: { x: number; y: number },
    end: { x: number; y: number },
    scope: SelectLayerScope = "all",
    itemFilter?: (item: paper.PathItem) => boolean,
  ): paper.PathItem[] {
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
    itemFilter?: (item: paper.PathItem) => boolean,
  ): paper.PathItem[] {
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

  private extractSelectionFromPath(
    selectionPath: paper.Path,
    scope: SelectLayerScope = "all",
    itemFilter?: (item: paper.PathItem) => boolean,
  ): paper.PathItem[] {
    if (selectionPath.isEmpty()) return [];

    const selectionMarker = this.createSelectionMarker();
    const selectedItems: paper.PathItem[] = [];
    const changedItems: paper.PathItem[] = [];
    const prev = paper.project.activeLayer;

    for (const layer of this.getSelectablePaperLayersTopFirst(scope)) {
      layer.activate();
      flattenGroups();
      const layerOrder = this.getLayerOrder(layer);
      const candidates = this.getPathsOnPaperLayer(layer)
        .filter((item) => item.parent)
        .filter((item) => !itemFilter || itemFilter(item))
        .filter((item) => selectionPath.bounds.expand(4).intersects(item.bounds))
        .sort((a, b) => (layerOrder.get(a.id) ?? 0) - (layerOrder.get(b.id) ?? 0));

      for (const candidate of candidates) {
        if (!pathsCollide(candidate, selectionPath)) continue;
        const fill = candidate.fillColor;
        const selectedPiece = tryIntersect(candidate, selectionPath);
        if (!selectedPiece) continue;

        this.applyPathStyle(selectedPiece, fill);
        this.setSelectionMarker(selectedPiece, selectionMarker);
        this.copyEmfKeyframeFrame(candidate, selectedPiece);

        const remainder = trySubtract(candidate, selectionPath);
        if (remainder) {
          this.applyPathStyle(remainder, fill);
          this.swapIn(candidate, remainder, changedItems);
        } else if (!this.removeIfFullyCovered(selectionPath, candidate)) {
          this.clearSelectionMarker(selectedPiece);
          selectedPiece.remove();
          continue;
        }

        if (!selectedPiece.parent) layer.addChild(selectedPiece);
        selectedItems.push(selectedPiece);
      }
    }

    prev.activate();

    if (changedItems.length || selectedItems.length) {
      this.normalizeAfterLocalEdit([...changedItems, ...selectedItems]);
      const survivingSelectedItems = this.getSelectablePaths(scope).filter(
        (item) => this.getSelectionMarker(item) === selectionMarker,
      );
      for (const item of survivingSelectedItems) {
        if (item.parent) item.bringToFront();
        this.clearSelectionMarker(item);
      }
      paper.view.update();
      return survivingSelectedItems;
    }

    return [];
  }

  scalePath(
    item: paper.Item,
    sx: number,
    sy: number,
    anchor: { x: number; y: number },
  ): void {
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
    item.rotate(degrees, new paper.Point(center.x, center.y));
    paper.view.update();
  }

  /**
   * Bring an item to the top of the layer (z-order)
   */
  bringToFront(item: paper.Item) {
    item.bringToFront();
    paper.view.update();
  }

  /**
   * Place a selected item using "add" logic - union with same color, cut different colors.
   * Merges into the item’s own layer (not necessarily the active layer).
   */
  placeSelection(item: paper.PathItem): void {
    const layer = item.layer;
    if (!layer) return;
    const prev = paper.project.activeLayer;
    layer.activate();
    try {
      const additions = this.expandIncomingWithSymmetry([item]);
      if (additions.length === 0) {
        paper.view.update();
        return;
      }
      const merged = this.mergeAddInto(layer, additions);
      this.normalizeAfterLocalEdit([...merged.changedItems, ...merged.survivors]);
      flattenGroups();
    } finally {
      prev.activate();
    }
    paper.view.update();
  }

  placeItemsAsSelection(items: paper.PathItem[]): paper.PathItem[] {
    const liveItems = items.filter((item) => item.parent);
    if (liveItems.length === 0) return [];

    const markerOrder = new Map<string, number>();
    for (const [index, item] of liveItems.entries()) {
      const marker = this.createSelectionMarker();
      markerOrder.set(marker, index);
      this.setSelectionMarker(item, marker);
    }

    for (const item of liveItems) {
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
    return survivors;
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
    const fill = item.fillColor;

    normalizeBooleanResult(item);
    forceEvenOdd(item);
    this.applyPathStyle(item, fill);

    const merged = this.mergeAddInto(layer, [item]);
    this.normalizeAfterLocalEdit([...merged.changedItems, ...merged.survivors]);
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
        const neighbors = this.getOrderedNeighbors(seeds);
        for (const item of [...seeds, ...neighbors]) enqueue(item);
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
  duplicateItem(item: paper.PathItem, offsetX = 10, offsetY = 10): paper.PathItem | null {
    if (!item.parent) return null;
    const clone = item.clone() as paper.PathItem;
    clone.position = clone.position.add(new paper.Point(offsetX, offsetY));
    this.applyPathStyle(clone, item.fillColor);
    paper.view.update();
    return clone;
  }

  /**
   * Delete a path item from the active layer.
   */
  deleteItem(item: paper.PathItem): void {
    if (!item.parent) return;
    this.clearSelectionMarker(item);
    item.remove();
    paper.view.update();
  }

  setItemFillColor(item: paper.PathItem, color: string): void {
    if (!item.parent) return;
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

    return this.drawTransformChrome(screenBounds, ctx, rotating);
  }
}
