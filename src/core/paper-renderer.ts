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
import type { CanvasConfig } from "./types";
import type { Camera } from "./camera";
import { STAGE_LAYER_ID } from "./stores";

export type SelectionHandleId =
  | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rotate";

export interface SelectionHandle {
  id: SelectionHandleId;
  x: number;
  y: number;
}

interface MergePassResult {
  survivors: paper.PathItem[];
  changedItems: paper.PathItem[];
}

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
  private onionLayers: paper.Layer[] = [];

  // Layer management: maps logical layer IDs to Paper.js layers.
  // The active layer is the single source of truth for hit-testable shapes;
  // we deliberately do not maintain a separate spatial index. All neighbor
  // queries do a linear AABB scan over the layer's children, which is
  // trivially fast for hand-drawn vector scenes and removes a whole class
  // of index-drift bugs.
  private layerMap = new Map<string, paper.Layer>();
  private activeLayerId: string | null = null;

  constructor(_canvas: HTMLCanvasElement, config: CanvasConfig) {
    this.config = config;
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
    const layer = paper.project.activeLayer;

    for (const item of items) {
      if (!item.parent) continue;
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
      const interiorPoints = subs.map((p) => this.getContainmentPoint(p));

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

      for (const root of filledRoots) {
        const indices = groups.get(root) ?? [root];
        if (indices.length === 1) {
          const src = subs[root];
          const newPath = new paper.Path(subData[root]);
          this.applyPathStyle(newPath, fillColor);
          if (selectionMarker) this.setSelectionMarker(newPath, selectionMarker);
          newPath.closed = src.closed;
          this.normalizeBooleanResult(newPath);
          layer.insertChild(insertAt++, newPath);
        } else {
          const newCompound = new paper.CompoundPath([]);
          this.applyPathStyle(newCompound, fillColor);
          if (selectionMarker) {
            this.setSelectionMarker(newCompound, selectionMarker);
          }
          // Even-odd is robust to winding issues and preserves holes / islands correctly
          newCompound.fillRule = "evenodd";
          for (const ci of indices) {
            const src = subs[ci];
            const child = new paper.Path(subData[ci]);
            child.closed = src.closed;
            this.normalizeBooleanResult(child);
            newCompound.addChild(child);
          }
          this.normalizeBooleanResult(newCompound);
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
    const prevVisibility = this.onionLayers.map((l) => l.visible);
    for (const layer of this.onionLayers) layer.visible = false;
    try {
      return paper.project.exportSVG({
        bounds: "view",
        asString: true,
        precision: 4,
      }) as string;
    } finally {
      this.onionLayers.forEach((l, i) => (l.visible = prevVisibility[i]));
    }
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
   */
  exportLayerJSON(id: string): string | null {
    const layer = this.layerMap.get(id);
    if (!layer) return null;
    return layer.exportJSON() as string;
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
      layer.visible = wanted.visible;
      if (wanted.json !== undefined) {
        layer.removeChildren();
        if (wanted.json) layer.importJSON(wanted.json);
        contentChanged = true;
      }
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
    if (this.onionLayers.length === 0) return;
    for (const layer of this.onionLayers) layer.remove();
    this.onionLayers = [];
    paper.view.update();
  }

  /**
   * Replace the onion-skin ghosts. Each ghost is one neighbor frame: its
   * visible layers' content JSONs (bottom→top), rendered flat-tinted at the
   * given opacity. Ghost layers are locked and sit below all artwork.
   */
  setOnionSkin(
    ghosts: Array<{ jsons: string[]; opacity: number; color: string }>,
  ): void {
    // Creating paper.Layer activates it; remember the real active layer.
    const prevActive = this.activeLayerId
      ? this.layerMap.get(this.activeLayerId)
      : null;

    for (const layer of this.onionLayers) layer.remove();
    this.onionLayers = [];

    for (const ghost of ghosts) {
      const ghostLayer = new paper.Layer();
      ghostLayer.locked = true;

      for (const json of ghost.jsons) {
        if (!json) continue;
        // importJSON of a Layer payload fills the receiving layer; use a
        // scratch layer so multiple document layers combine into one ghost.
        const scratch = new paper.Layer();
        scratch.importJSON(json);
        ghostLayer.addChildren([...scratch.children]);
        scratch.remove();
      }

      const tint = new paper.Color(ghost.color);
      for (const child of ghostLayer.children) {
        if (child instanceof paper.Path || child instanceof paper.CompoundPath) {
          if (child.fillColor) child.fillColor = tint.clone();
          if (child.strokeColor) child.strokeColor = tint.clone();
        }
      }
      ghostLayer.opacity = ghost.opacity;
      this.onionLayers.push(ghostLayer);
    }

    // sendToBack puts the last-sent layer lowest, so walk ghosts in reverse:
    // callers pass farthest-first, and farther ghosts belong underneath.
    for (const layer of [...this.onionLayers].reverse()) {
      layer.sendToBack();
    }

    prevActive?.activate();
    paper.view.update();
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

    paper.view.update();
    return true;
  }

  /**
   * Import and scale SVG, returning extracted paths (ungrouped)
   * When camera is active, positions paths in world space
   *
   * The SVG from potrace represents what was drawn on the pixel canvas,
   * which maps to the full viewport (screen space). We need to:
   * 1. Scale SVG to viewport size
   * 2. Transform the result so screen coordinates become world coordinates
   */
  private importSVG(svg: string): paper.PathItem[] {
    const item = paper.project.importSVG(svg) as paper.Item;
    if (!item) return [];

    // Get SVG dimensions
    const svgMatch = svg.match(/width="([^"]+)"\s+height="([^"]+)"/);
    let svgWidth = this.config.pixelWidth;
    let svgHeight = this.config.pixelHeight;

    if (svgMatch) {
      svgWidth = parseFloat(svgMatch[1]);
      svgHeight = parseFloat(svgMatch[2]);
    }

    // Scale SVG to viewport size
    // After this, the SVG content maps to screen coordinates (0,0 to viewportWidth,viewportHeight)
    if (svgWidth > 0 && svgHeight > 0) {
      const scale = Math.min(
        this.config.viewportWidth / svgWidth,
        this.config.viewportHeight / svgHeight,
      );
      item.scale(scale, new paper.Point(0, 0));
    }

    // Position at origin (top-left of viewport in screen space)
    item.bounds.topLeft = new paper.Point(0, 0);

    // Transform from screen space to world space
    if (this.camera) {
      // Get the inverse transform matrix (screen to world) from camera
      // This handles zoom, rotation, and pan correctly
      const [a, b, c, d, tx, ty] = this.camera.getInverseTransformMatrix();

      const screenToWorldMatrix = new paper.Matrix(a, b, c, d, tx, ty);

      item.transform(screenToWorldMatrix);
    } else {
      // No camera - position at view center (legacy behavior)
      item.position = paper.view.center;
    }

    // Extract paths and reparent them to the active layer BEFORE removing
    // any wrapper. Paper's importSVG can return Groups, Layers, Shapes, or
    // even nested Groups depending on the input — pulling paths out first
    // means a stray wrapper can never carry one of our paths into oblivion.
    const paths = this.extractPaths(item);
    const layer = paper.project.activeLayer;
    for (const p of paths) {
      if (p.parent !== layer) layer.addChild(p);
    }

    // Now remove the wrapper (and anything left inside it). We accept any
    // non-Path/CompoundPath wrapper here, not just Group, because Paper has
    // historically returned different container types for different SVG
    // shapes.
    if (
      item.parent &&
      item !== layer &&
      !(item instanceof paper.Path) &&
      !(item instanceof paper.CompoundPath)
    ) {
      item.remove();
    }

    // Final safety net: anything still wrapped in a Group on the active
    // layer (e.g. nested groups Paper didn't unwrap) gets dissolved here.
    this.flattenGroups();

    return paths;
  }

  /**
   * Extract all paths from an item (handles Groups recursively)
   */
  private extractPaths(item: paper.Item): paper.PathItem[] {
    if (item instanceof paper.Path || item instanceof paper.CompoundPath) {
      return [item];
    }
    if (item instanceof paper.Group) {
      const paths: paper.PathItem[] = [];
      for (const child of item.children) {
        paths.push(...this.extractPaths(child));
      }
      return paths;
    }
    return [];
  }

  /**
   * Flatten layer: ungroup all groups, move paths to layer root.
   * Returns true if any unwrapping actually happened (caller may want to
   * mark the spatial index dirty in that case).
   */
  private flattenGroups(): boolean {
    const layer = paper.project.activeLayer;
    let didFlatten = false;
    let hasGroups = true;
    while (hasGroups) {
      hasGroups = false;
      for (const child of [...layer.children]) {
        if (child instanceof paper.Group) {
          hasGroups = true;
          didFlatten = true;
          for (const gc of [...child.children]) {
            layer.insertChild(layer.children.indexOf(child), gc);
          }
          child.remove();
        }
      }
    }
    return didFlatten;
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
    this.flattenGroups();
    paper.view.update();
    return [...snapshot];
  }

  /**
   * Sample a handful of points likely inside the path to make robust containment checks.
   */
  private samplePoints(path: paper.Path): paper.Point[] {
    const pts: paper.Point[] = [];

    // Best case: use a guaranteed interior point if Paper provides it.
    try {
      const ip = (path as any).getInteriorPoint?.();
      if (ip) pts.push(ip);
    } catch {}

    // Try to find interior points by offsetting along normals from the boundary.
    const len = path.length;
    // Adaptive eps based on contour size (avoid stepping outside on tiny loops).
    const minDim = Math.min(path.bounds.width, path.bounds.height);
    const epsBase = Math.max(0.05, minDim * 0.05);
    const epsList = [epsBase, epsBase * 0.5, epsBase * 2];
    if (len > 0) {
      const samples = [0.1, 0.3, 0.5, 0.7, 0.9];
      for (const t of samples) {
        const off = len * t;
        const p = path.getPointAt(off);
        if (!p) continue;
        let n: paper.Point | null = null;
        try {
          n = path.getNormalAt(off) as any;
        } catch {
          n = null;
        }
        if (n) {
          for (const eps of epsList) {
            const c1 = p.add(n.multiply(eps));
            const c2 = p.subtract(n.multiply(eps));
            try {
              if (path.contains(c1)) pts.push(c1);
            } catch {}
            try {
              if (path.contains(c2)) pts.push(c2);
            } catch {}
          }
        }
      }
    }

    // Fallbacks (may be empty on donut-like shapes, but better than nothing)
    pts.push(path.bounds.center);
    if (path.segments.length) pts.push(path.segments[0].point);

    return pts.slice(0, 25);
  }

  private getContainmentPoint(path: paper.Path): paper.Point | null {
    try {
      const interior = (path as { getInteriorPoint?: () => paper.Point | null }).getInteriorPoint?.();
      if (interior) return interior;
    } catch {}

    if (path.segments.length > 0) {
      let sx = 0;
      let sy = 0;
      for (const segment of path.segments) {
        sx += segment.point.x;
        sy += segment.point.y;
      }
      const centroid = new paper.Point(sx / path.segments.length, sy / path.segments.length);
      try {
        if (path.contains(centroid)) return centroid;
      } catch {}
    }

    const len = path.length;
    if (len > 0) {
      const minDim = Math.min(path.bounds.width, path.bounds.height);
      const eps = Math.max(0.05, minDim * 0.05);
      for (const t of [0.125, 0.375, 0.625, 0.875]) {
        const offset = len * t;
        const point = path.getPointAt(offset);
        const normal = path.getNormalAt(offset);
        if (!point || !normal) continue;
        for (const probe of [point.add(normal.multiply(eps)), point.subtract(normal.multiply(eps))]) {
          try {
            if (path.contains(probe)) return probe;
          } catch {}
        }
      }
    }

    try {
      if (path.contains(path.bounds.center)) return path.bounds.center;
    } catch {}

    return null;
  }

  /**
   * Sample points for any PathItem (Path or CompoundPath) for robust containment checks.
   */
  private samplePointsItem(item: paper.PathItem): paper.Point[] {
    if (item instanceof paper.Path) return this.samplePoints(item);
    if (item instanceof paper.CompoundPath) {
      const pts: paper.Point[] = [item.bounds.center];
      for (const child of item.children) {
        if (child instanceof paper.Path) pts.push(...this.samplePoints(child));
        if (pts.length > 20) break;
      }
      return pts;
    }
    return [item.bounds.center];
  }

  /**
   * Determine whether a cutter very likely fully covers a target (used as a guard when Paper booleans return empty).
   */
  private likelyFullyCovered(cutter: paper.PathItem, target: paper.PathItem): boolean {
    // Cheap reject first
    try {
      if (!cutter.bounds.contains(target.bounds)) return false;
    } catch {
      return false;
    }

    const pts = this.samplePointsItem(target);
    for (const p of pts) {
      try {
        if (!cutter.contains(p)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private forceEvenOdd(item: paper.PathItem | null): void {
    if (item instanceof paper.CompoundPath) item.fillRule = "evenodd";
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

  /**
   * Check if two shapes genuinely overlap.
   */
  private pathsCollide(a: paper.PathItem, b: paper.PathItem): boolean {
    if (!a.bounds.intersects(b.bounds)) return false;
    try {
      if (a.intersects(b)) return true;
    } catch {}
    try {
      if (a.contains(b.bounds.center)) return true;
    } catch {}
    try {
      if (b.contains(a.bounds.center)) return true;
    } catch {}
    for (const p of this.samplePointsItem(a)) {
      try {
        if (b.contains(p)) return true;
      } catch {}
    }
    for (const p of this.samplePointsItem(b)) {
      try {
        if (a.contains(p)) return true;
      } catch {}
    }
    return false;
  }

  /**
   * Normalize boolean-op results to keep winding/holes intact.
   */
  private normalizeBooleanResult<T extends paper.PathItem | null>(
    result: T,
  ): T {
    if (!result) return result;
    try {
      // Resolve self-intersections for robust winding
      if (typeof (result as any).resolveCrossings === "function") {
        (result as any).resolveCrossings();
      }
    } catch {}
    try {
      // Ensure proper winding for holes
      if (typeof (result as any).reorient === "function") {
        (result as any).reorient(true);
      }
    } catch {}
    return result;
  }

  private flattenForBoolean(item: paper.PathItem, flatness: number): paper.PathItem {
    const clone = item.clone({ insert: false }) as paper.PathItem;
    if (clone instanceof paper.Path) {
      clone.flatten(flatness);
    } else if (clone instanceof paper.CompoundPath) {
      for (const child of clone.children) {
        if (child instanceof paper.Path) child.flatten(flatness);
      }
    }
    return clone;
  }

  private tryBooleanOp(
    target: paper.PathItem,
    other: paper.PathItem,
    op: "unite" | "subtract" | "intersect",
  ): paper.PathItem | null {
    const run = (
      left: paper.PathItem,
      right: paper.PathItem,
    ): paper.PathItem | null => {
      try {
        const result = this.normalizeBooleanResult(
          left[op](right) as paper.PathItem | null,
        );
        if (result && !result.isEmpty()) {
          this.forceEvenOdd(result);
          return result;
        }
        result?.remove();
      } catch {}
      return null;
    };

    const direct = run(target, other);
    if (direct) return direct;

    for (const flatness of [1, 0.5]) {
      const flatTarget = this.flattenForBoolean(target, flatness);
      const flatOther = this.flattenForBoolean(other, flatness);
      const flattened = run(flatTarget, flatOther);
      flatTarget.remove();
      flatOther.remove();
      if (flattened) return flattened;
    }

    return null;
  }

  private tryUnite(a: paper.PathItem, b: paper.PathItem): paper.PathItem | null {
    if (!this.pathsCollide(a, b)) return null;
    return this.tryBooleanOp(a, b, "unite");
  }

  private trySubtract(
    target: paper.PathItem,
    cutter: paper.PathItem,
  ): paper.PathItem | null {
    if (!this.pathsCollide(target, cutter)) return null;
    return this.tryBooleanOp(target, cutter, "subtract");
  }

  private tryIntersect(
    target: paper.PathItem,
    clip: paper.PathItem,
  ): paper.PathItem | null {
    if (!this.pathsCollide(target, clip)) return null;
    const intersected = this.tryBooleanOp(target, clip, "intersect");
    if (intersected) return intersected;

    if (this.likelyFullyCovered(clip, target)) {
      const clone = target.clone({ insert: false }) as paper.PathItem;
      this.normalizeBooleanResult(clone);
      this.forceEvenOdd(clone);
      return clone;
    }
    if (this.likelyFullyCovered(target, clip)) {
      const clone = clip.clone({ insert: false }) as paper.PathItem;
      this.normalizeBooleanResult(clone);
      this.forceEvenOdd(clone);
      return clone;
    }
    return null;
  }

  private removeIfFullyCovered(
    cutter: paper.PathItem,
    target: paper.PathItem,
  ): boolean {
    if (!target.parent) return false;
    if (!this.likelyFullyCovered(cutter, target)) return false;
    this.clearSelectionMarker(target);
    target.remove();
    return true;
  }

  private mergeAddInto(
    layer: paper.Layer,
    additions: paper.PathItem[],
  ): MergePassResult {
    const changedItems: paper.PathItem[] = [];
    const survivors: paper.PathItem[] = [];

    for (const addition of additions) {
      if (!addition.parent) continue;
      let current = addition;

      // Re-query neighbors on every iteration. After a same-color union the
      // unified shape has different (usually larger) bounds, and additions
      // processed later need to see the freshly-merged result, not a stale
      // snapshot taken at the top of the call.
      let progressed = true;
      let safety = 0;
      while (progressed && current.parent && safety++ < 64) {
        progressed = false;
        const neighbors = this.getOrderedNeighbors([current]);

        for (const neighbor of neighbors) {
          if (!current.parent || !neighbor.parent) continue;
          if (current === neighbor || !this.pathsCollide(current, neighbor)) continue;

          const currentColor = current.fillColor?.toCSS(true) ?? "none";
          const neighborColor = neighbor.fillColor?.toCSS(true) ?? "none";

          if (currentColor === neighborColor) {
            const united = this.tryUnite(current, neighbor);
            if (!united) continue;
            this.applyPathStyle(united, current.fillColor);
            this.copySelectionMarkerFromMany([current, neighbor], united);
            this.clearSelectionMarker(current);
            this.clearSelectionMarker(neighbor);
            current.remove();
            neighbor.remove();
            if (!united.parent) layer.addChild(united);
            changedItems.push(united);
            current = united;
            progressed = true;
            break; // re-query neighbors using the unified bounds
          }

          const cutNeighbor = this.trySubtract(neighbor, current);
          if (cutNeighbor) {
            this.applyPathStyle(cutNeighbor, neighbor.fillColor);
            this.swapIn(neighbor, cutNeighbor, changedItems);
            continue;
          }
          this.removeIfFullyCovered(current, neighbor);
        }
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
        const cutNeighbor = this.trySubtract(neighbor, cutter);
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

    const merged = this.mergeAddInto(layer, [shape]);
    this.normalizeAfterLocalEdit([...merged.changedItems, ...merged.survivors]);
    this.flattenGroups();
    paper.view.update();
  }

  /**
   * Subtract a pre-built shape (in viewport/screen coordinates) from the
   * active layer, mirroring `subtractPath`.
   */
  subtractShape(shape: paper.PathItem): void {
    this.transformScreenToWorld(shape);

    const merged = this.mergeSubtractInto([shape]);
    this.normalizeAfterLocalEdit(merged.changedItems);
    this.flattenGroups();
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
        const clipped = this.tryIntersect(shape, clip);
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
        const diff = this.trySubtract(remaining, ex);
        if (diff) {
          remaining.remove();
          remaining = diff;
          continue;
        }
        if (this.likelyFullyCovered(ex, remaining)) {
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

    const merged = this.mergeAddInto(layer, clippedPaths);
    this.normalizeAfterLocalEdit([...merged.changedItems, ...merged.survivors]);
    this.flattenGroups();
    paper.view.update();
  }

  async addPath(svg: string, color: string = "#000000"): Promise<void> {
    const layer = paper.project.activeLayer;
    const paperColor = new paper.Color(color);

    const newPaths = this.importSVG(svg);
    if (newPaths.length === 0) return;

    for (const p of newPaths) {
      this.applyPathStyle(p, paperColor);
      layer.addChild(p);
    }

    const merged = this.mergeAddInto(layer, newPaths);
    this.normalizeAfterLocalEdit([...merged.changedItems, ...merged.survivors]);
    this.flattenGroups();
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
   * Resolve any hit-tested child back to the selectable root shape on the active layer.
   */
  resolveSelectableItem(hit: paper.Item | null): paper.PathItem | null {
    return this.hitToClipPathItem(hit);
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

    const newPaths = this.importSVG(svg);
    if (newPaths.length === 0) return;

    const clippedPaths: paper.PathItem[] = [];
    if (clipPathItem) {
      const clip = clipPathItem.clone({ insert: false });
      try {
        for (const p of newPaths) {
          const clipped = this.tryIntersect(p, clip);
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
          const diff = this.trySubtract(remaining, ex);
          if (diff) {
            remaining.remove();
            remaining = diff;
            continue;
          }
          if (this.likelyFullyCovered(ex, remaining)) {
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

    const merged = this.mergeAddInto(layer, clippedPaths);
    this.normalizeAfterLocalEdit([...merged.changedItems, ...merged.survivors]);
    this.flattenGroups();
    paper.view.update();
  }

  async subtractPath(svg: string): Promise<void> {
    const eraserPaths = this.importSVG(svg);
    if (eraserPaths.length === 0) return;

    const merged = this.mergeSubtractInto(eraserPaths);
    this.normalizeAfterLocalEdit(merged.changedItems);
    this.flattenGroups();
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
    this.flattenGroups();
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
      if (this.onionLayers.includes(layer)) continue;
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

  getAllPaths(): paper.PathItem[] {
    // Single source of truth for "what shapes exist on the active layer".
    // Flatten any stray Group first so a path can never hide inside a wrapper
    // — that's the entire invariant the codebase now relies on.
    this.flattenGroups();
    return paper.project.activeLayer.children.filter(
      (c): c is paper.PathItem =>
        c instanceof paper.Path || c instanceof paper.CompoundPath,
    );
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
    const selectedItems = this.extractSelectionFromPath(rect);
    rect.remove();
    return selectedItems;
  }

  extractSelectionFromScreenLasso(points: Array<{ x: number; y: number }>): paper.PathItem[] {
    if (points.length < 3) return [];

    const worldPoints = points.map((point) => this.screenToWorld(point.x, point.y));
    const lasso = new paper.Path({
      segments: worldPoints.map((point) => new paper.Point(point.x, point.y)),
      closed: true,
      insert: false,
    });
    const selectedItems = this.extractSelectionFromPath(lasso);
    lasso.remove();
    return selectedItems;
  }

  private extractSelectionFromPath(selectionPath: paper.Path): paper.PathItem[] {
    if (selectionPath.isEmpty()) return [];

    const selectionMarker = this.createSelectionMarker();

    const layer = paper.project.activeLayer;
    const layerOrder = this.getLayerOrder(layer);
    const candidates = this.queryByBounds(selectionPath.bounds)
      .filter((item) => item.layer === layer && item.parent)
      .sort((a, b) => (layerOrder.get(a.id) ?? 0) - (layerOrder.get(b.id) ?? 0));

    const selectedItems: paper.PathItem[] = [];
    const changedItems: paper.PathItem[] = [];

    for (const candidate of candidates) {
      if (!this.pathsCollide(candidate, selectionPath)) continue;
      const fill = candidate.fillColor;
      const selectedPiece = this.tryIntersect(candidate, selectionPath);
      if (!selectedPiece) continue;

      this.applyPathStyle(selectedPiece, fill);
      this.setSelectionMarker(selectedPiece, selectionMarker);

      const remainder = this.trySubtract(candidate, selectionPath);
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

    if (changedItems.length || selectedItems.length) {
      this.normalizeAfterLocalEdit([...changedItems, ...selectedItems]);
      const survivingSelectedItems = this.getAllPaths().filter(
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
   * Place a selected item using "add" logic - union with same color, cut different colors
   */
  placeSelection(item: paper.PathItem): void {
    const layer = paper.project.activeLayer;
    const merged = this.mergeAddInto(layer, [item]);
    this.normalizeAfterLocalEdit([...merged.changedItems, ...merged.survivors]);
    this.flattenGroups();
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

    const survivors = this.getAllPaths()
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
    const layer = paper.project.activeLayer;
    const fill = item.fillColor;

    this.normalizeBooleanResult(item);
    this.forceEvenOdd(item);
    this.applyPathStyle(item, fill);

    const merged = this.mergeAddInto(layer, [item]);
    this.normalizeAfterLocalEdit([...merged.changedItems, ...merged.survivors]);
    const survivor = merged.survivors[0] ?? null;
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
   * Trace each contour of a Path or CompoundPath in screen space, then invoke
   * `strokeContour` once per contour (typically `() => ctx.stroke()`).
   */
  private forEachOutlineContour(
    ctx: CanvasRenderingContext2D,
    item: paper.Item,
    strokeContour: () => void,
  ): void {
    const paths: paper.Path[] = [];
    if (item instanceof paper.Path) {
      paths.push(item);
    } else if (item instanceof paper.CompoundPath) {
      for (const child of item.children) {
        if (child instanceof paper.Path) paths.push(child);
      }
    }
    if (paths.length === 0) return;

    for (const path of paths) {
      const segs = path.segments;
      if (segs.length < 2) continue;

      ctx.beginPath();
      const first = this.worldToScreen(segs[0].point.x, segs[0].point.y);
      ctx.moveTo(first.x, first.y);

      for (let i = 1; i < segs.length; i++) {
        const prev = segs[i - 1];
        const cur = segs[i];
        const sp = this.worldToScreen(cur.point.x, cur.point.y);
        if (prev.handleOut.isZero() && cur.handleIn.isZero()) {
          ctx.lineTo(sp.x, sp.y);
        } else {
          const cp1 = prev.point.add(prev.handleOut);
          const cp2 = cur.point.add(cur.handleIn);
          const s1 = this.worldToScreen(cp1.x, cp1.y);
          const s2 = this.worldToScreen(cp2.x, cp2.y);
          ctx.bezierCurveTo(s1.x, s1.y, s2.x, s2.y, sp.x, sp.y);
        }
      }

      if (path.closed && segs.length > 2) {
        const last = segs[segs.length - 1];
        const firstSeg = segs[0];
        const sp = this.worldToScreen(firstSeg.point.x, firstSeg.point.y);
        if (last.handleOut.isZero() && firstSeg.handleIn.isZero()) {
          ctx.lineTo(sp.x, sp.y);
        } else {
          const cp1 = last.point.add(last.handleOut);
          const cp2 = firstSeg.point.add(firstSeg.handleIn);
          const s1 = this.worldToScreen(cp1.x, cp1.y);
          const s2 = this.worldToScreen(cp2.x, cp2.y);
          ctx.bezierCurveTo(s1.x, s1.y, s2.x, s2.y, sp.x, sp.y);
        }
        ctx.closePath();
      }

      strokeContour();
    }
  }

  /**
   * Dashed shape outline: semi-transparent underlay (main shadow) + white rim +
   * black core. Used for select-tool shape chrome and direct-select picked paths.
   */
  strokeSelectionShapeOutline(ctx: CanvasRenderingContext2D, item: paper.Item): void {
    const dash = [6, 5];
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "butt";

    const layers: Array<{ style: string; width: number }> = [
      { style: "rgba(0, 0, 0, 0.45)", width: 5 },
      { style: "#ffffff", width: 3.5 },
      { style: "#000000", width: 1.5 },
    ];

    for (const layer of layers) {
      ctx.strokeStyle = layer.style;
      ctx.lineWidth = layer.width;
      ctx.setLineDash(dash);
      this.forEachOutlineContour(ctx, item, () => ctx.stroke());
    }

    ctx.setLineDash([]);
    ctx.restore();
  }

  /**
   * Pure bbox + handle chrome given a screen-space rect. Extracted from
   * drawSelection so both the select tool (bbox over shape bounds) and
   * direct-select (bbox over picked anchor points) share the same gizmo.
   *
   * The box is screen-axis-aligned. Rotation pivot + cursor are caller-
   * supplied because callers have different conventions (item.position,
   * bbox center, anchor centroid, etc.).
   */
  drawTransformChrome(
    screenBounds: { x: number; y: number; width: number; height: number },
    ctx: CanvasRenderingContext2D,
    rotating?: { cursor: { x: number; y: number }; pivot: { x: number; y: number } } | null,
  ): SelectionHandle[] {
    const b = screenBounds;
    const controlFill = "#000000";
    const controlStroke = "#ffffff";

    ctx.save();

    // Dashed screen-aligned bounding box (white rim, black core)
    const boxDash = [5, 5];
    ctx.setLineDash(boxDash);
    ctx.lineJoin = "miter";
    ctx.strokeStyle = controlStroke;
    ctx.lineWidth = 3;
    ctx.strokeRect(b.x, b.y, b.width, b.height);
    ctx.strokeStyle = controlFill;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(b.x, b.y, b.width, b.height);
    ctx.setLineDash([]);

    const nw = { x: b.x, y: b.y };
    const ne = { x: b.x + b.width, y: b.y };
    const se = { x: b.x + b.width, y: b.y + b.height };
    const sw = { x: b.x, y: b.y + b.height };
    const n = { x: b.x + b.width / 2, y: b.y };
    const s = { x: b.x + b.width / 2, y: b.y + b.height };
    const e = { x: b.x + b.width, y: b.y + b.height / 2 };
    const w = { x: b.x, y: b.y + b.height / 2 };

    const rotateOffset = 30;
    const rotate = { x: n.x, y: n.y - rotateOffset };

    const handles: SelectionHandle[] = [
      { id: "nw", x: nw.x, y: nw.y },
      { id: "n", x: n.x, y: n.y },
      { id: "ne", x: ne.x, y: ne.y },
      { id: "e", x: e.x, y: e.y },
      { id: "se", x: se.x, y: se.y },
      { id: "s", x: s.x, y: s.y },
      { id: "sw", x: sw.x, y: sw.y },
      { id: "w", x: w.x, y: w.y },
      { id: "rotate", x: rotate.x, y: rotate.y },
    ];

    const strokeLineWhiteBlack = (
      x0: number,
      y0: number,
      x1: number,
      y1: number,
    ) => {
      ctx.lineCap = "round";
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.strokeStyle = controlStroke;
      ctx.lineWidth = 3.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.strokeStyle = controlFill;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };

    if (rotating) {
      strokeLineWhiteBlack(
        rotating.pivot.x,
        rotating.pivot.y,
        rotating.cursor.x,
        rotating.cursor.y,
      );

      ctx.fillStyle = controlFill;
      ctx.strokeStyle = controlStroke;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(rotating.pivot.x, rotating.pivot.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      strokeLineWhiteBlack(n.x, n.y, rotate.x, rotate.y);

      ctx.fillStyle = controlFill;
      ctx.strokeStyle = controlStroke;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(rotate.x, rotate.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    const handleSize = 8;
    const half = handleSize / 2;
    for (const h of handles) {
      if (h.id === "rotate") continue;
      ctx.fillStyle = controlFill;
      ctx.strokeStyle = controlStroke;
      ctx.lineWidth = 2;
      ctx.fillRect(h.x - half, h.y - half, handleSize, handleSize);
      ctx.strokeRect(h.x - half, h.y - half, handleSize, handleSize);
    }

    ctx.restore();
    return handles;
  }

  /**
   * Draw shape outlines for the selection plus the transform chrome
   * (bbox + handles). The bbox is computed from item world-bounds projected
   * to screen, so it stays screen-axis-aligned regardless of camera rotation.
   */
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
