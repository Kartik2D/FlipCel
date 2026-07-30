/**
 * Direct Select Controller
 *
 * Simple model:
 *
 *   Anchor visibility is per-shape and gated on two states:
 *     1. The shape owns at least one PICKED anchor (real selection), or
 *     2. The shape is EXPOSED — single-clicked by the user as a peek-only
 *        gesture that reveals its anchors + outline without picking
 *        anything (so color-picker / functions panel stay empty).
 *   Shapes that are neither picked-into nor exposed render no chrome.
 *
 *   Click semantics on a shape's interior fill:
 *     - Single click → expose that shape (replaces any prior exposure;
 *                      clears picks).
 *     - Double click → pick every anchor of that shape (legacy behavior).
 *                      Peek persists since the shape is still "in focus".
 *
 *   Peek lifetime: a peek-exposure stays in place across every gesture
 *   that targets a shape (anchor click, edge click, marquee drag,
 *   vertex deletion, anchor moves, handle drags, etc.). The ONLY things
 *   that clear it are:
 *     - A click outside any shape (empty-area tap → "deselect"),
 *     - A single click on a different shape (peek shifts to that shape),
 *     - A clearSelection() call (tool switch / undo / layer change),
 *     - The exposed item disappearing from the layer entirely.
 *
 *   Hit-testing and marquee still see every anchor on the layer, so the
 *   user can pick into a "blank" shape by clicking its edge or marqueeing
 *   across it.
 *
 *   The only state the tool holds is:
 *     pickedAnchors  : Set<AnchorKey>  — anchors the user picked (anchor
 *                                        click / marquee / lasso / shape
 *                                        double-click). Drag moves these.
 *     exposedItemIds : Set<number>     — shapes shown via single-click
 *                                        peek; not part of the published
 *                                        selection.
 *     anchorHandles  : AnchorHandle[]  — cached per-frame, one handle per
 *                                        anchor of every active-layer item;
 *                                        used for hit-testing and marquee
 *                                        regardless of visibility state.
 *
 *   What gets published to the shared selectionStore:
 *     items owning any picked anchor. Exposed-only shapes are NOT
 *     published (single-click is purely visual).
 */
import type { Point, CanvasConfig } from "../../geometry/types";
import type { PaperRenderer } from "../../render/paper-renderer";
import type { SelectionHandle, SelectionHandleId } from "../../render/paper-renderer";
import type { Camera } from "../../render/camera";
import type { ChromeLayer } from "../../render/chrome-layer";
import { configStore, toolSettingsStore, selectionStore } from "../../state/index";
import paper from "paper";
import { pixelToViewport } from "../../geometry/coords";
import { MarqueeTracker } from "../marquee";
import { TransformGizmoController } from "../transform-gizmo";

import {
  type AnchorKey,
  type AnchorHandle,
  anchorKey,
  parseAnchorKey,
} from "./anchors";
import {
  pointInPolygon,
  applyHandleModeToSegment,
  type AnchorHandleMode,
} from "./geometry";
import {
  hitTestBezierHandle,
  dragBezierHandleTo as applyBezierHandleDrag,
  drawBezierHandlesForSoloPick,
  type HandleLinkage,
} from "./bezier-handles";

export type { AnchorHandle, AnchorKey } from "./anchors";

export class DirectSelectController {
  /** Ignore sub-pixel jitter: only apply drags after this many viewport px from pointer-down. */
  private readonly dragMoveThresholdSq = 5 * 5;
  private dragPointerOrigin: Point | null = null;
  private dragPastThreshold = false;

  private config: CanvasConfig;
  private paperRenderer: PaperRenderer;
  private camera: Camera;
  private chromeLayer: ChromeLayer;
  private chromeCtx: CanvasRenderingContext2D;
  private onSnapshot?: () => void;
  private onLiveEditStart?: () => void;
  private onActivateLayer?: (layerId: string) => void;
  private onReconcile?: (items: paper.PathItem[]) => void;

  private selectionShape: "rect" | "lasso" = "rect";

  private pickedAnchors: Set<AnchorKey> = new Set();
  private anchorHandles: AnchorHandle[] = [];

  /**
   * Shapes the user single-clicked to expose. Exposed shapes show their
   * anchors + outline like picked shapes, but no anchors are actually
   * picked (selectionStore is not populated). Replaced (not augmented) by
   * each new single-click; cleared by any pick-changing gesture.
   */
  private exposedItemIds: Set<number> = new Set();

  /**
   * Last shape-interior click. Used to detect a double-click on the same
   * shape: a second `handleStart` within `doubleClickWindowMs` and within
   * `doubleClickDistanceSq` viewport-pixels² of the first promotes the
   * single-click peek into a "pick all anchors" gesture.
   */
  private lastShapeClick: {
    timestampMs: number;
    point: Point;
    itemId: number;
  } | null = null;

  /**
   * Last edge-interior click. Used to detect a double-click on the same
   * curve segment of the same path: a second `handleStart` within
   * `doubleClickWindowMs` and within `doubleClickEdgeDistanceSq`
   * viewport-pixels² of the first inserts a new vertex on that edge.
   */
  private lastEdgeClick: {
    timestampMs: number;
    point: Point;
    itemId: number;
    childIndex: number;
    curveIndex: number;
  } | null = null;
  private readonly doubleClickWindowMs = 350;
  private readonly doubleClickDistanceSq = 6 * 6;
  /** Slightly larger window for edges since the cursor target is a thin line. */
  private readonly doubleClickEdgeDistanceSq = 10 * 10;

  /**
   * True when the in-flight marquee was armed by a shape-interior tap
   * (peek). On finalize, a tap that never crossed the marquee threshold
   * keeps the peek-exposure visible; an empty-area tap clears it instead.
   */
  private marqueeFromShapePeek = false;

  private isDraggingAnchor = false;
  private dragStartPoint: Point | null = null;
  private didMoveAnchor = false;

  /**
   * Active bezier-handle drag. Only populated while exactly one anchor is
   * picked and the user pointerdown'd on one of that anchor's tangent knobs.
   */
  /**
   * Explicit Sharp / Mirrored / Detached mode per anchor (from the popup).
   * Defaults to detached — never inferred from handle angles.
   */
  private anchorHandleModes = new Map<AnchorKey, AnchorHandleMode>();
  private handleDrag: {
    kind: "in" | "out";
    segmentKey: AnchorKey;
    /** From the popup mode only — "mirrored" links the opposite handle. */
    linkage: HandleLinkage;
  } | null = null;
  private didMoveHandle = false;
  private edgeDrag: {
    itemId: number;
    childIndex: number;
    startSegmentIndex: number;
    endSegmentIndex: number;
  } | null = null;
  private didMoveEdge = false;

  private marquee = new MarqueeTracker();

  /**
   * Multi-pick transform-gizmo state. Populated only while at least two
   * anchors are picked so the user can scale/rotate the picked cluster via
   * the same bbox handles as the select tool.
   */
  private transformHandles: SelectionHandle[] = [];
  private didTransformAnchors = false;
  private lastViewportPoint: Point | null = null;
  private transformGizmo: TransformGizmoController;

  private lastSelectionViewport: Point | null = null;
  private selectionChangeCallback?: (hasSelection: boolean) => void;

  constructor(
    paperRenderer: PaperRenderer,
    camera: Camera,
    chromeLayer: ChromeLayer,
  ) {
    this.paperRenderer = paperRenderer;
    this.camera = camera;
    this.chromeLayer = chromeLayer;
    this.chromeCtx = chromeLayer.getContext();
    this.transformGizmo = new TransformGizmoController({
      getScreenBounds: () => this.getPickedAnchorScreenBounds(),
      getRotatePivotWorld: () => this.getPickedAnchorCentroidWorld(),
      applyScale: (incSX, incSY, worldAnchor) => {
        this.scalePickedAnchorsInViewSpace(incSX, incSY, worldAnchor);
      },
      applyRotate: (degrees, worldPivot) => {
        this.rotatePickedAnchors(degrees, worldPivot);
      },
    });
    this.config = configStore.get();
    configStore.subscribe((config) => {
      this.config = config;
    });
    toolSettingsStore.subscribe((settings) => {
      const directSelectSettings = settings["direct-select"] as { shape?: unknown };
      this.selectionShape = directSelectSettings.shape === "lasso" ? "lasso" : "rect";
    });
  }

  setSnapshotCallback(callback: () => void): void {
    this.onSnapshot = callback;
  }

  setLiveEditStartCallback(callback: () => void): void {
    this.onLiveEditStart = callback;
  }

  setActivateLayerCallback(callback: (layerId: string) => void): void {
    this.onActivateLayer = callback;
  }

  setReconcileCallback(callback: (items: paper.PathItem[]) => void): void {
    this.onReconcile = callback;
  }

  onSelectionChange(callback: (hasSelection: boolean) => void): void {
    this.selectionChangeCallback = callback;
  }

  // ============================================================
  // Public API
  // ============================================================

  /** True when the user has picked at least one anchor. */
  hasSelection(): boolean {
    return this.pickedAnchors.size > 0;
  }

  /**
   * True when the tool currently has anything to draw — a pick, an
   * exposed shape, an in-flight drag, or a marquee. The tool no longer
   * has a "baseline" draw state; without one of these flags the chrome
   * canvas is fully empty.
   */
  hasTransientUI(): boolean {
    return (
      this.hasSelection() ||
      this.exposedItemIds.size > 0 ||
      this.marquee.isTracking() ||
      this.isDraggingAnchor ||
      this.handleDrag !== null ||
      this.transformGizmo.isTransforming()
    );
  }

  getLastSelectionViewport(): Point | null {
    return this.lastSelectionViewport;
  }

  getPickedAnchorCount(): number {
    return this.pickedAnchors.size;
  }

  getSelectionScreenBounds():
    | { x: number; y: number; width: number; height: number }
    | null {
    return this.getPickedAnchorScreenBounds();
  }

  getSinglePickedAnchorViewport(): Point | null {
    if (this.pickedAnchors.size !== 1) return null;

    const key = this.pickedAnchors.values().next().value as AnchorKey | undefined;
    if (!key) return null;

    const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
    const item = this.paperRenderer.getPathById(itemId);
    if (!item) return null;

    const seg = this.paperRenderer.getChildPaths(item)[childIndex]?.segments[segmentIndex];
    if (!seg) return null;

    return this.camera.worldToScreen(seg.point.x, seg.point.y);
  }

  getSinglePickedAnchorScreenBounds():
    | { x: number; y: number; width: number; height: number }
    | null {
    if (this.pickedAnchors.size !== 1) return null;

    const key = this.pickedAnchors.values().next().value as AnchorKey | undefined;
    if (!key) return null;

    const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
    const item = this.paperRenderer.getPathById(itemId);
    if (!item) return null;

    const seg = this.paperRenderer.getChildPaths(item)[childIndex]?.segments[segmentIndex];
    if (!seg) return null;

    const points = [this.camera.worldToScreen(seg.point.x, seg.point.y)];
    if (!seg.handleIn.isZero()) {
      const tip = seg.point.add(seg.handleIn);
      points.push(this.camera.worldToScreen(tip.x, tip.y));
    }
    if (!seg.handleOut.isZero()) {
      const tip = seg.point.add(seg.handleOut);
      points.push(this.camera.worldToScreen(tip.x, tip.y));
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of points) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }

    const pad = 10;
    return {
      x: minX - pad,
      y: minY - pad,
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2,
    };
  }

  deletePickedVertices(): boolean {
    if (this.pickedAnchors.size === 0) return false;

    const removalsByItem = new Map<number, Map<number, number[]>>();
    for (const key of this.pickedAnchors) {
      const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
      if (!removalsByItem.has(itemId)) removalsByItem.set(itemId, new Map());
      const childMap = removalsByItem.get(itemId)!;
      if (!childMap.has(childIndex)) childMap.set(childIndex, []);
      childMap.get(childIndex)!.push(segmentIndex);
    }

    const affectedItems: paper.PathItem[] = [];
    for (const [itemId, childMap] of removalsByItem) {
      const item = this.paperRenderer.getPathById(itemId);
      if (!item?.parent) continue;

      const childPaths = this.paperRenderer.getChildPaths(item);
      for (const [childIndex, rawIndices] of childMap) {
        const path = childPaths[childIndex];
        if (!path) continue;

        const indices = [...new Set(rawIndices)].sort((a, b) => b - a);
        for (const index of indices) {
          if (index < 0 || index >= path.segments.length) continue;
          path.removeSegment(index);
        }

        const minSegments = path.closed ? 3 : 2;
        if (path.segments.length < minSegments) {
          path.remove();
        }
      }

      if (item instanceof paper.CompoundPath) {
        const survivingChildren = item.children.filter(
          (child): child is paper.Path => child instanceof paper.Path,
        );
        if (survivingChildren.length === 0) {
          item.remove();
          continue;
        }
      } else if (item instanceof paper.Path) {
        const minSegments = item.closed ? 3 : 2;
        if (item.segments.length < minSegments) {
          item.remove();
          continue;
        }
      }

      affectedItems.push(item);
    }

    if (this.onReconcile && affectedItems.length > 0) {
      this.onReconcile(affectedItems.filter((item) => item.parent));
    }

    paper.view.update();
    for (const key of this.pickedAnchors) this.anchorHandleModes.delete(key);
    this.pickedAnchors.clear();
    this.onSnapshot?.();
    this.publishPickedItems();
    this.drawUI();
    return true;
  }

  setPickedAnchorHandleMode(mode: AnchorHandleMode): boolean {
    if (this.pickedAnchors.size === 0) return false;

    for (const key of this.pickedAnchors) {
      const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
      const item = this.paperRenderer.getPathById(itemId);
      if (!item) continue;
      const path = this.paperRenderer.getChildPaths(item)[childIndex];
      const seg = path?.segments[segmentIndex];
      if (!path || !seg) continue;

      applyHandleModeToSegment(path, segmentIndex, seg, mode);
      this.anchorHandleModes.set(key, mode);
    }

    paper.view.update();
    // Tangents only — skip reconcile/merge. Running it here can mis-classify
    // compound holes (containment false-negatives) and union them away.
    this.onSnapshot?.();
    this.publishPickedItems();
    this.drawUI();
    return true;
  }

  /** Popup mode for an anchor; unmarked handles drag as detached. */
  private handleLinkageFor(key: AnchorKey): HandleLinkage {
    return this.anchorHandleModes.get(key) === "mirrored" ? "mirrored" : "detached";
  }

  clearSelection(): void {
    this.pickedAnchors.clear();
    // Keep modes so Mirrored / Detached survive deselect/reselect.
    this.exposedItemIds.clear();
    this.lastShapeClick = null;
    this.lastEdgeClick = null;
    this.resetDragState();
    this.resetMarqueeState();
    this.resetTransformState();
    this.lastSelectionViewport = null;
    selectionStore.set({ items: [] });
    this.drawUI();
  }

  /**
   * Finalize any in-progress anchor/handle/transform edit, then clear picks
   * and chrome. Used when leaving the frame (playhead move) so edits commit
   * to the frame they were made on.
   */
  confirmAndClearSelection(): void {
    if (this.transformGizmo.isTransforming() && this.didTransformAnchors) {
      this.finalizeAnchorMove();
    } else if (this.handleDrag && this.didMoveHandle) {
      this.finalizeHandleMove();
    } else if (this.edgeDrag && this.didMoveEdge) {
      this.finalizeEdgeMove();
    } else if (this.isDraggingAnchor && this.didMoveAnchor) {
      this.finalizeAnchorMove();
    }
    this.clearSelection();
  }

  // ============================================================
  // Pointer events
  // ============================================================

  handleStart(point: Point): void {
    const viewportPoint = pixelToViewport(point, this.config);
    this.rebuildAnchorHandles();

    // Transform gizmo (bbox + handles) is shown whenever >=2 anchors are
    // picked. Hit test those handles first so the user can scale/rotate
    // the cluster even when a handle sits near an anchor square.
    if (this.pickedAnchors.size >= 2 && this.transformHandles.length > 0) {
      const hitTransform = this.hitTestTransformHandle(viewportPoint);
      if (hitTransform && this.transformGizmo.begin(hitTransform, viewportPoint, this.camera)) {
        this.didTransformAnchors = false;
        this.dragStartPoint = viewportPoint;
        this.beginDragThreshold(viewportPoint);
        this.drawUI();
        return;
      }
    }

    // Bezier handle drag takes priority over anchor hit testing when a
    // single anchor is picked (its handles are visible and hit-testable).
    const handleHit = hitTestBezierHandle(viewportPoint, this.pickedAnchors, this.paperRenderer, this.camera);
    if (handleHit) {
      this.handleDrag = {
        ...handleHit,
        linkage: this.handleLinkageFor(handleHit.segmentKey),
      };
      this.dragStartPoint = viewportPoint;
      this.beginDragThreshold(viewportPoint);
      this.didMoveHandle = false;
      this.lastShapeClick = null;
      this.lastEdgeClick = null;
      this.drawUI();
      return;
    }

    const hitIdx = this.hitTestAnchor(viewportPoint);
    if (hitIdx !== null) {
      const hit = this.anchorHandles[hitIdx];
      if (!this.pickedAnchors.has(hit.key)) {
        this.pickedAnchors = new Set([hit.key]);
      }
      // Anchor click is "on a shape" — leave peek intact. Only the
      // double-click detectors are invalidated.
      this.lastShapeClick = null;
      this.lastEdgeClick = null;
      this.isDraggingAnchor = true;
      this.dragStartPoint = viewportPoint;
      this.beginDragThreshold(viewportPoint);
      this.didMoveAnchor = false;
      this.bringInteractedItemsToFront();
      this.publishPickedItems();
      this.drawUI();
      return;
    }

    const edgeHit = this.hitTestEdge(viewportPoint);
    if (edgeHit) {
      const now = performance.now();
      const isDoubleClickEdge = this.isDoubleClickOnEdge(viewportPoint, edgeHit, now);

      if (isDoubleClickEdge) {
        const inserted = this.insertVertexOnEdge(viewportPoint, edgeHit);
        if (inserted) {
          // Pick the freshly inserted anchor and arm an anchor-drag so
          // the user can immediately reposition it without lifting
          // the pointer.
          const newKey = anchorKey(
            edgeHit.itemId,
            edgeHit.childIndex,
            inserted.newSegmentIndex,
          );
          this.pickedAnchors = new Set([newKey]);
          this.lastShapeClick = null;
          this.lastEdgeClick = null;
          this.isDraggingAnchor = true;
          this.dragStartPoint = viewportPoint;
          this.beginDragThreshold(viewportPoint);
          this.didMoveAnchor = false;
          this.bringInteractedItemsToFront();
          // Snapshot the insertion now so undo always recovers the
          // pre-insert state, even if the user never drags.
          this.onSnapshot?.();
          this.rebuildAnchorHandles();
          this.publishPickedItems();
          this.drawUI();
          return;
        }
      }

      this.pickedAnchors = new Set([
        anchorKey(edgeHit.itemId, edgeHit.childIndex, edgeHit.startSegmentIndex),
        anchorKey(edgeHit.itemId, edgeHit.childIndex, edgeHit.endSegmentIndex),
      ]);
      // Edge click is "on a shape" — leave peek intact, but record the
      // edge click so a quick second tap on the same curve can promote
      // into a vertex-insert.
      this.lastShapeClick = null;
      this.lastEdgeClick = {
        timestampMs: now,
        point: viewportPoint,
        itemId: edgeHit.itemId,
        childIndex: edgeHit.childIndex,
        curveIndex: edgeHit.startSegmentIndex,
      };
      this.edgeDrag = edgeHit;
      this.dragStartPoint = viewportPoint;
      this.beginDragThreshold(viewportPoint);
      this.didMoveEdge = false;
      this.bringInteractedItemsToFront();
      this.publishPickedItems();
      this.drawUI();
      return;
    }

    const shapeHit = this.paperRenderer.resolveSelectableItem(
      this.paperRenderer.hitTestSelectable(viewportPoint),
    );
    if (shapeHit) {
      const layerId = this.paperRenderer.getLayerIdForPathItem(shapeHit);
      if (layerId) this.onActivateLayer?.(layerId);
      const now = performance.now();
      const isDoubleClick = this.isDoubleClickOnShape(viewportPoint, shapeHit.id, now);

      if (isDoubleClick) {
        // Double-click on an already-exposed shape: promote to a real
        // selection of every anchor + start the same drag-to-move
        // gesture the legacy single-click used to start. Peek stays as
        // it was — the shape is still "on screen" via picks anyway, and
        // keeping the peek means the next tap on this shape's interior
        // doesn't blow it away.
        this.pickAllAnchorsOfItem(shapeHit);
        this.lastShapeClick = null;
        this.lastEdgeClick = null;
        this.isDraggingAnchor = true;
        this.dragStartPoint = viewportPoint;
        this.beginDragThreshold(viewportPoint);
        this.didMoveAnchor = false;
        this.bringInteractedItemsToFront();
        this.publishPickedItems();
        this.drawUI();
        return;
      }

      // Single click on a shape: peek-only. Drop any prior picks /
      // exposures and show just this shape's anchors + outline. Arm a
      // marquee from the same point so that if the user keeps the
      // pointer down and drags, it promotes into a marquee selection
      // (matching the historical "drag-from-shape" gesture). A pure
      // tap that never crosses the marquee threshold leaves the peek
      // exposure in place — see finalizeMarquee.
      this.pickedAnchors.clear();
      this.exposedItemIds = new Set([shapeHit.id]);
      this.lastShapeClick = { timestampMs: now, point: viewportPoint, itemId: shapeHit.id };
      this.lastEdgeClick = null;
      this.marqueeFromShapePeek = true;
      this.marquee.start(viewportPoint);
      this.bringInteractedItemsToFront();
      this.publishPickedItems();
      this.drawUI();
      return;
    }

    this.lastShapeClick = null;
    this.lastEdgeClick = null;
    this.marqueeFromShapePeek = false;
    this.marquee.start(viewportPoint);
    this.drawUI();
  }

  /**
   * Treat the current `handleStart` as a double-click iff the previous
   * click was on the same shape, recent (< doubleClickWindowMs ago), and
   * landed within doubleClickDistanceSq viewport-pixels². Otherwise it's
   * either a fresh single-click or the second half of a triple-click that
   * we choose to handle as a single-click.
   */
  private isDoubleClickOnShape(
    viewportPoint: Point,
    itemId: number,
    nowMs: number,
  ): boolean {
    const last = this.lastShapeClick;
    if (!last) return false;
    if (last.itemId !== itemId) return false;
    if (nowMs - last.timestampMs > this.doubleClickWindowMs) return false;
    const dx = viewportPoint.x - last.point.x;
    const dy = viewportPoint.y - last.point.y;
    return dx * dx + dy * dy <= this.doubleClickDistanceSq;
  }

  /**
   * Treat the current `handleStart` as a double-click on the SAME edge
   * iff the previous click landed on the same item/child/curve, recent
   * (< doubleClickWindowMs ago), and within doubleClickEdgeDistanceSq
   * viewport-pixels² of the first.
   */
  private isDoubleClickOnEdge(
    viewportPoint: Point,
    edgeHit: { itemId: number; childIndex: number; startSegmentIndex: number },
    nowMs: number,
  ): boolean {
    const last = this.lastEdgeClick;
    if (!last) return false;
    if (last.itemId !== edgeHit.itemId) return false;
    if (last.childIndex !== edgeHit.childIndex) return false;
    if (last.curveIndex !== edgeHit.startSegmentIndex) return false;
    if (nowMs - last.timestampMs > this.doubleClickWindowMs) return false;
    const dx = viewportPoint.x - last.point.x;
    const dy = viewportPoint.y - last.point.y;
    return dx * dx + dy * dy <= this.doubleClickEdgeDistanceSq;
  }

  /**
   * Insert a new segment on the curve identified by `edgeHit` at the
   * point closest to `viewportPoint`. Uses Paper.js's `Curve#divideAt`,
   * which subdivides the curve in-place via De Casteljau so the path
   * shape is preserved (the two resulting curves get correctly adjusted
   * handles).
   *
   * Returns the inserted segment's index in `path.segments`, or null if
   * the location was too close to an existing endpoint to safely split
   * (which would create a duplicate segment).
   */
  private insertVertexOnEdge(
    viewportPoint: Point,
    edgeHit: { itemId: number; childIndex: number; startSegmentIndex: number },
  ): { newSegmentIndex: number } | null {
    const item = this.paperRenderer.getPathById(edgeHit.itemId);
    if (!item) return null;
    const path = this.paperRenderer.getChildPaths(item)[edgeHit.childIndex];
    if (!path) return null;
    const curve = path.curves[edgeHit.startSegmentIndex];
    if (!curve) return null;

    const worldPoint = this.camera.screenToWorld(viewportPoint.x, viewportPoint.y);
    const queryPoint = new paper.Point(worldPoint.x, worldPoint.y);
    const location = curve.getNearestLocation(queryPoint);
    if (!location) return null;

    // Don't split if we're effectively on top of an endpoint — that
    // would just clone an existing segment in place.
    const epsilon = 1e-3;
    if (location.time <= epsilon || location.time >= 1 - epsilon) return null;

    const newCurve = curve.divideAt(location);
    if (!newCurve) return null;

    paper.view.update();
    return { newSegmentIndex: edgeHit.startSegmentIndex + 1 };
  }

  handleMove(point: Point): void {
    const viewportPoint = pixelToViewport(point, this.config);
    this.lastViewportPoint = viewportPoint;

    if (this.marquee.isTracking()) {
      this.marquee.update(viewportPoint, this.selectionShape);
      this.drawUI();
      return;
    }

    if (this.transformGizmo.isTransforming()) {
      if (this.pastDragThreshold(viewportPoint)) {
        if (this.transformGizmo.update(viewportPoint, this.camera)) {
          this.noteLiveEditStarted("transform");
        }
      }
      this.drawUI();
      return;
    }

    if (this.handleDrag) {
      if (this.pastDragThreshold(viewportPoint)) {
        this.dragBezierHandleTo(viewportPoint);
      }
      return;
    }

    if (this.edgeDrag) {
      if (this.pastDragThreshold(viewportPoint)) {
        this.dragBezierEdgeTo(viewportPoint);
      }
      return;
    }

    if (!this.isDraggingAnchor || !this.dragStartPoint) return;

    if (!this.pastDragThreshold(viewportPoint)) {
      this.drawUI();
      return;
    }

    const worldPoint = this.camera.screenToWorld(viewportPoint.x, viewportPoint.y);
    const worldStart = this.camera.screenToWorld(this.dragStartPoint.x, this.dragStartPoint.y);
    const dx = worldPoint.x - worldStart.x;
    const dy = worldPoint.y - worldStart.y;

    if (dx !== 0 || dy !== 0) {
      this.noteLiveEditStarted("anchor");
      this.moveSelectedAnchors(dx, dy);
      this.dragStartPoint = viewportPoint;
      this.drawUI();
    }
  }

  handleEnd(): void {
    if (this.marquee.isTracking()) {
      this.finalizeMarquee();
      this.resetMarqueeState();
      this.drawUI();
      return;
    }

    if (this.transformGizmo.isTransforming()) {
      if (this.didTransformAnchors) this.finalizeAnchorMove();
      this.resetTransformState();
      this.resetDragState();
      this.drawUI();
      return;
    }

    if (this.handleDrag) {
      if (this.didMoveHandle) this.finalizeHandleMove();
      this.resetDragState();
      this.drawUI();
      return;
    }

    if (this.edgeDrag) {
      if (this.didMoveEdge) this.finalizeEdgeMove();
      this.resetDragState();
      this.drawUI();
      return;
    }

    if (this.isDraggingAnchor && this.didMoveAnchor) {
      this.finalizeAnchorMove();
    }

    this.resetDragState();
    this.drawUI();
  }

  handleCancel(): void {
    this.resetDragState();
    this.resetMarqueeState();
    this.resetTransformState();
    this.drawUI();
  }

  // ============================================================
  // Drawing
  // ============================================================

  drawUI(): void {
    this.chromeLayer.clear();
    this.rebuildAnchorHandles();

    const ctx = this.chromeCtx;
    ctx.save();

    // Shown shapes = picked-into shapes ∪ peek-exposed shapes. Outline
    // every shown shape; the anchor loop below uses the same set so verts
    // and outline always appear (or disappear) together.
    const shownItemIds = new Set<number>();
    for (const item of this.getPickedItems()) {
      shownItemIds.add(item.id);
      this.paperRenderer.strokeSelectionShapeOutline(ctx, item);
    }
    for (const itemId of this.exposedItemIds) {
      if (shownItemIds.has(itemId)) continue;
      const item = this.paperRenderer.getPathById(itemId);
      if (!item || !item.parent) continue;
      shownItemIds.add(item.id);
      this.paperRenderer.strokeSelectionShapeOutline(ctx, item);
    }

    // When exactly one anchor is picked, expose its bezier control handles
    // (handleIn / handleOut). Drawn before the anchor squares so the picked
    // anchor sits visually on top of the handle arms meeting at it.
    if (this.pickedAnchors.size === 1) {
      drawBezierHandlesForSoloPick(ctx, this.pickedAnchors, this.paperRenderer, this.camera);
    }

    // Anchor nodes: picked = black / white; exposed unpicked = solid grey (dim).
    // Only shown shapes (picked-into or peek-exposed) render their anchor
    // squares — every other shape draws nothing.
    const unpickedR = 3;
    const pickedR = 5;
    const unpickedFill = "#6e6e6e";
    const unpickedStroke = "#b8b8b8";
    for (const h of this.anchorHandles) {
      if (!shownItemIds.has(h.item.id)) continue;
      const isPicked = this.pickedAnchors.has(h.key);
      const r = isPicked ? pickedR : unpickedR;
      ctx.fillStyle = isPicked ? "#000000" : unpickedFill;
      ctx.strokeStyle = isPicked ? "#ffffff" : unpickedStroke;
      ctx.lineWidth = isPicked ? 2 : 1.5;
      ctx.beginPath();
      ctx.rect(h.x - r, h.y - r, r * 2, r * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Multi-pick transform gizmo: same bbox + 8 resize + 1 rotate handles as
    // the select tool, but sized to the picked anchors' screen bounds.
    // Suppress it during edge dragging so curvature editing stays visually focused.
    if (this.pickedAnchors.size >= 2 && !this.edgeDrag) {
      const bounds = this.getPickedAnchorScreenBounds();
      if (bounds) {
        const rotating = this.transformGizmo.getRotationOverlay(
          this.camera,
          this.lastViewportPoint,
        );
        this.transformHandles = this.paperRenderer.drawTransformChrome(
          bounds,
          ctx,
          rotating,
        );
      } else {
        this.transformHandles = [];
      }
    } else {
      this.transformHandles = [];
    }

    if (this.marquee.isTracking()) {
      const start = this.marquee.getStartPoint();
      const current = this.marquee.getCurrentPoint();
      if (!start || !current) return;
      if (this.selectionShape === "lasso") {
        this.chromeLayer.drawLassoPreview(this.marquee.getLassoPoints());
      } else {
        this.chromeLayer.drawMarqueeRect(start, current);
      }
    }

    ctx.restore();
  }

  // ============================================================
  // Derived state
  // ============================================================

  /** Items on the active layer that own at least one picked anchor. */
  private getPickedItems(): paper.PathItem[] {
    if (this.pickedAnchors.size === 0) return [];
    const items: paper.PathItem[] = [];
    const seen = new Set<number>();
    for (const key of this.pickedAnchors) {
      const { itemId } = parseAnchorKey(key);
      const item = this.paperRenderer.getPathById(itemId);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    return items;
  }

  /** Replace picks with every anchor on this shape (fill click / interior hit). */
  private pickAllAnchorsOfItem(item: paper.PathItem): void {
    const keys = new Set<AnchorKey>();
    this.forEachSegment(item, (ci, si) => {
      keys.add(anchorKey(item.id, ci, si));
    });
    this.pickedAnchors = keys;
  }

  private rebuildAnchorHandles(): void {
    const handles: AnchorHandle[] = [];
    const liveKeys = new Set<AnchorKey>();
    const liveItemIds = new Set<number>();

    for (const item of this.paperRenderer.getAllPaths()) {
      liveItemIds.add(item.id);
      this.forEachSegment(item, (ci, si, seg) => {
        const screen = this.camera.worldToScreen(seg.point.x, seg.point.y);
        const key = anchorKey(item.id, ci, si);
        liveKeys.add(key);
        handles.push({
          item,
          childIndex: ci,
          segmentIndex: si,
          key,
          x: screen.x,
          y: screen.y,
        });
      });
    }
    this.anchorHandles = handles;

    // Drop picks that reference anchors that no longer exist.
    if (this.pickedAnchors.size > 0) {
      const pruned = new Set<AnchorKey>();
      for (const k of this.pickedAnchors) {
        if (liveKeys.has(k)) pruned.add(k);
      }
      if (pruned.size !== this.pickedAnchors.size) {
        this.pickedAnchors = pruned;
      }
    }

    // Drop peek-exposures that reference shapes no longer on the layer.
    if (this.exposedItemIds.size > 0) {
      const pruned = new Set<number>();
      for (const id of this.exposedItemIds) {
        if (liveItemIds.has(id)) pruned.add(id);
      }
      if (pruned.size !== this.exposedItemIds.size) {
        this.exposedItemIds = pruned;
      }
    }
  }

  // ============================================================
  // Mutation & finalization
  // ============================================================

  /**
   * Set the dragged handle's world-space offset so its tip sits at the
   * pointer. Moves the in/out vector only — the anchor point itself is not
   * touched. Other segments on the path are unaffected.
   */
  private dragBezierHandleTo(viewportPoint: Point): void {
    if (!this.handleDrag) return;
    const moved = applyBezierHandleDrag(
      viewportPoint,
      this.handleDrag,
      this.paperRenderer,
      this.camera,
    );
    if (!moved) return;
    this.noteLiveEditStarted("handle");
    this.drawUI();
  }

  /**
   * Drag the curve itself by moving the outgoing tangent of the start anchor
   * and the incoming tangent of the end anchor together. This edits curvature
   * while leaving the anchor positions fixed.
   */
  private dragBezierEdgeTo(viewportPoint: Point): void {
    if (!this.edgeDrag || !this.dragStartPoint) return;

    const item = this.paperRenderer.getPathById(this.edgeDrag.itemId);
    if (!item) return;
    const path = this.paperRenderer.getChildPaths(item)[this.edgeDrag.childIndex];
    if (!path) return;

    const startSeg = path.segments[this.edgeDrag.startSegmentIndex];
    const endSeg = path.segments[this.edgeDrag.endSegmentIndex];
    if (!startSeg || !endSeg) return;

    const screenDelta = {
      x: viewportPoint.x - this.dragStartPoint.x,
      y: viewportPoint.y - this.dragStartPoint.y,
    };
    const worldDelta = this.camera.screenDeltaToWorld(screenDelta.x, screenDelta.y);
    if (worldDelta.x === 0 && worldDelta.y === 0) return;

    const delta = new paper.Point(worldDelta.x, worldDelta.y);
    startSeg.handleOut = startSeg.handleOut.add(delta);
    endSeg.handleIn = endSeg.handleIn.add(delta);

    this.dragStartPoint = viewportPoint;
    paper.view.update();
    this.noteLiveEditStarted("edge");
    this.drawUI();
  }

  /**
   * Commit a handle drag: reconcile the host item (a pulled handle can fold
   * the path over itself) and snapshot history. The anchor world-position is
   * unchanged by a handle move, so we remap the picked key to whichever
   * segment sits at that position after reconcile.
   */
  private finalizeHandleMove(): void {
    if (!this.handleDrag) return;

    const { itemId, childIndex, segmentIndex } = parseAnchorKey(
      this.handleDrag.segmentKey,
    );
    const item = this.paperRenderer.getPathById(itemId);
    const seg = item
      ? this.paperRenderer.getChildPaths(item)[childIndex]?.segments[segmentIndex]
      : undefined;
    const anchorWorld = seg ? seg.point.clone() : null;

    if (this.onReconcile && item && item.parent) {
      this.onReconcile([item]);
    }

    // Remap pick to whichever segment now sits at the original anchor's
    // world position (reconcile may have replaced the item).
    if (anchorWorld) {
      const epsilon = 1e-3;
      const remapped = new Set<AnchorKey>();
      for (const candidate of this.paperRenderer.getAllPaths()) {
        const match = this.findSegmentNear(candidate, anchorWorld, epsilon);
        if (match) {
          remapped.add(
            anchorKey(candidate.id, match.childIndex, match.segmentIndex),
          );
          break;
        }
      }
      if (remapped.size > 0) {
        this.pickedAnchors = remapped;
      }
    }

    this.onSnapshot?.();
    this.publishPickedItems();
  }

  /**
   * Commit an edge drag by reconciling the owning item, then remapping the
   * picked endpoint anchors by their unchanged world positions.
   */
  private finalizeEdgeMove(): void {
    if (!this.edgeDrag) return;

    const item = this.paperRenderer.getPathById(this.edgeDrag.itemId);
    const path = item
      ? this.paperRenderer.getChildPaths(item)[this.edgeDrag.childIndex]
      : undefined;
    const targets: paper.Point[] = [];
    if (path) {
      const startSeg = path.segments[this.edgeDrag.startSegmentIndex];
      const endSeg = path.segments[this.edgeDrag.endSegmentIndex];
      if (startSeg) targets.push(startSeg.point.clone());
      if (endSeg) targets.push(endSeg.point.clone());
    }

    if (this.onReconcile && item && item.parent) {
      this.onReconcile([item]);
    }

    if (targets.length > 0) {
      const epsilon = 1e-3;
      const remapped = new Set<AnchorKey>();
      for (const pos of targets) {
        for (const candidate of this.paperRenderer.getAllPaths()) {
          const match = this.findSegmentNear(candidate, pos, epsilon);
          if (match) {
            remapped.add(anchorKey(candidate.id, match.childIndex, match.segmentIndex));
            break;
          }
        }
      }
      if (remapped.size > 0) {
        this.pickedAnchors = remapped;
      }
    }

    this.onSnapshot?.();
    this.publishPickedItems();
  }

  private moveSelectedAnchors(dx: number, dy: number): void {
    const delta = new paper.Point(dx, dy);
    for (const key of this.pickedAnchors) {
      const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
      const item = this.paperRenderer.getPathById(itemId);
      if (!item) continue;
      const seg = this.paperRenderer.getChildPaths(item)[childIndex]?.segments[segmentIndex];
      if (!seg) continue;
      seg.point = seg.point.add(delta);
    }
    paper.view.update();
  }

  private finalizeMarquee(): void {
    const matched = this.collectMarqueeMatches();
    const matchedKeys = new Set(matched.map((h) => h.key));

    if (this.hasActiveMarquee()) {
      // User actually dragged a marquee. Picks update to whatever the
      // marquee covered; peek stays intact (a drag is not "a click
      // outside the shape").
      this.pickedAnchors = matchedKeys;
      this.lastShapeClick = null;
      this.lastEdgeClick = null;
      this.bringInteractedItemsToFront();
    } else if (this.marqueeFromShapePeek) {
      // Pure tap on a shape: handleStart already cleared picks and
      // installed the new exposure + lastShapeClick. Leave them be so
      // the peek persists and the next click can register as a
      // double-click.
    } else {
      // Tap on empty area — the "click outside the shape" gesture.
      // Clears picks, peek, and the double-click memory.
      this.pickedAnchors.clear();
      this.exposedItemIds.clear();
      this.lastShapeClick = null;
      this.lastEdgeClick = null;
    }

    this.publishPickedItems();
  }

  /**
   * Reconcile every item that carried a picked anchor, then remap picks by
   * matching pre-move world positions against segments on whatever is on the
   * layer now. We don't need to track survivors or new items — since every
   * active-layer anchor is exposed automatically, the user always sees the
   * boolean result. Remap is purely about keeping the "picked" set meaningful
   * across the reconcile.
   *
   * Special case: when an item that was FULLY picked gets absorbed into a
   * same-color union (its anchors are now interior to a survivor and don't
   * exist on any path's outline), the position-based remap would silently
   * drop the interior picks and leave only the union's silhouette anchors
   * selected. We detect this by sampling each fully-picked item's interior
   * point post-rotation and re-picking every anchor of whichever survivor
   * contains that sample. This keeps "rotate a multi-shape selection" from
   * collapsing the pick set down to the silhouette of the merged result.
   */
  private finalizeAnchorMove(): void {
    const targets: paper.Point[] = [];
    for (const key of this.pickedAnchors) {
      const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
      const item = this.paperRenderer.getPathById(itemId);
      if (!item) continue;
      const seg = this.paperRenderer.getChildPaths(item)[childIndex]?.segments[segmentIndex];
      if (!seg) continue;
      targets.push(seg.point.clone());
    }

    if (!this.onReconcile) {
      this.onSnapshot?.();
      this.publishPickedItems();
      return;
    }

    const affectedIds = new Set<number>();
    for (const key of this.pickedAnchors) affectedIds.add(parseAnchorKey(key).itemId);
    const affectedItems = [...affectedIds]
      .map((id) => this.paperRenderer.getPathById(id))
      .filter((item): item is paper.PathItem => !!item?.parent);

    // Capture interior sample points for every fully-picked affected
    // item, BEFORE reconcile potentially removes them. We use these
    // post-reconcile to find the survivor that absorbed the original
    // item, so we can re-pick all of its anchors instead of losing
    // the interior anchors to a same-color union.
    const fullyPickedSamples: paper.Point[] = [];
    for (const item of affectedItems) {
      let total = 0;
      let picked = 0;
      this.forEachSegment(item, (ci, si) => {
        total++;
        if (this.pickedAnchors.has(anchorKey(item.id, ci, si))) picked++;
      });
      if (total > 0 && picked === total) {
        fullyPickedSamples.push(item.bounds.center.clone());
      }
    }

    this.onReconcile(affectedItems);

    const epsilon = 1e-3;
    const newKeys = new Set<AnchorKey>();
    const layerItems = this.paperRenderer.getAllPaths();
    for (const pos of targets) {
      for (const candidate of layerItems) {
        const match = this.findSegmentNear(candidate, pos, epsilon);
        if (match) {
          newKeys.add(anchorKey(candidate.id, match.childIndex, match.segmentIndex));
          break;
        }
      }
    }

    // For each fully-picked item, find the surviving path that
    // contains its interior sample and pick every one of that
    // survivor's anchors. If the item itself survived, this is a
    // no-op (we just re-add the picks we already had); if the item
    // was absorbed into a union, this rescues every "now interior"
    // anchor by picking the absorbing shape in its entirety.
    for (const sample of fullyPickedSamples) {
      for (const candidate of layerItems) {
        if (!candidate.contains(sample)) continue;
        this.forEachSegment(candidate, (ci, si) => {
          newKeys.add(anchorKey(candidate.id, ci, si));
        });
        break;
      }
    }

    this.pickedAnchors = newKeys;

    this.bringInteractedItemsToFront();
    this.onSnapshot?.();
    this.publishPickedItems();
  }

  // ============================================================
  // Sync / state helpers
  // ============================================================

  private publishPickedItems(): void {
    const items = this.getPickedItems();
    this.lastSelectionViewport = this.getSelectionAnchorViewport(items);
    selectionStore.set({ items });
    this.selectionChangeCallback?.(items.length > 0);
  }

  /**
   * Move every shape we're currently interacting with — picked-into or
   * peek-exposed — to the top of the active layer's z-order. Mirrors the
   * select tool's "click to bring to front" behavior so direct-select
   * gestures (anchor / edge / shape click, marquee, double-click) also
   * surface the touched shapes above their neighbors. Iterates in current
   * layer order so calling `bringToFront` repeatedly preserves relative
   * order among the lifted items.
   */
  private bringInteractedItemsToFront(): void {
    const ids = new Set<number>();
    for (const key of this.pickedAnchors) ids.add(parseAnchorKey(key).itemId);
    for (const id of this.exposedItemIds) ids.add(id);
    if (ids.size === 0) return;

    for (const item of this.paperRenderer.getAllPaths()) {
      if (!ids.has(item.id)) continue;
      this.paperRenderer.bringToFront(item);
    }
  }

  private resetDragState(): void {
    this.isDraggingAnchor = false;
    this.dragStartPoint = null;
    this.didMoveAnchor = false;
    this.handleDrag = null;
    this.didMoveHandle = false;
    this.edgeDrag = null;
    this.didMoveEdge = false;
    this.resetDragThreshold();
  }

  private resetMarqueeState(): void {
    this.marquee.reset();
    this.marqueeFromShapePeek = false;
  }

  private resetTransformState(): void {
    this.didTransformAnchors = false;
    this.transformGizmo.reset();
    this.lastViewportPoint = null;
  }

  private beginDragThreshold(viewportPoint: Point): void {
    this.dragPointerOrigin = viewportPoint;
    this.dragPastThreshold = false;
  }

  private noteLiveEditStarted(kind: "anchor" | "handle" | "edge" | "transform"): void {
    if (kind === "anchor") {
      if (this.didMoveAnchor) return;
      this.didMoveAnchor = true;
    } else if (kind === "handle") {
      if (this.didMoveHandle) return;
      this.didMoveHandle = true;
    } else if (kind === "edge") {
      if (this.didMoveEdge) return;
      this.didMoveEdge = true;
    } else {
      if (this.didTransformAnchors) return;
      this.didTransformAnchors = true;
    }
    this.onLiveEditStart?.();
  }

  private resetDragThreshold(): void {
    this.dragPointerOrigin = null;
    this.dragPastThreshold = false;
  }

  private pastDragThreshold(viewportPoint: Point): boolean {
    if (this.dragPastThreshold) return true;
    if (!this.dragPointerOrigin) return true;
    const dx = viewportPoint.x - this.dragPointerOrigin.x;
    const dy = viewportPoint.y - this.dragPointerOrigin.y;
    if (dx * dx + dy * dy >= this.dragMoveThresholdSq) {
      this.dragPastThreshold = true;
      return true;
    }
    return false;
  }

  // ============================================================
  // Multi-pick transform gizmo (scale + rotate picked anchors)
  // ============================================================

  /**
   * Screen-space bbox enclosing every picked anchor, with a small pad so the
   * box doesn't sit flush on the outermost anchor squares. Returns null when
   * fewer than two anchors are picked or they haven't been cached this frame.
   */
  private getPickedAnchorScreenBounds():
    | { x: number; y: number; width: number; height: number }
    | null {
    if (this.pickedAnchors.size < 2) return null;

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    let count = 0;
    for (const h of this.anchorHandles) {
      if (!this.pickedAnchors.has(h.key)) continue;
      if (h.x < minX) minX = h.x;
      if (h.y < minY) minY = h.y;
      if (h.x > maxX) maxX = h.x;
      if (h.y > maxY) maxY = h.y;
      count++;
    }
    if (count < 2) return null;

    const pad = 10;
    return {
      x: minX - pad,
      y: minY - pad,
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2,
    };
  }

  private hitTestTransformHandle(viewportPoint: Point): SelectionHandleId | null {
    const hitRadiusSq = 12 * 12;
    for (const h of this.transformHandles) {
      const dx = viewportPoint.x - h.x;
      const dy = viewportPoint.y - h.y;
      if (dx * dx + dy * dy <= hitRadiusSq) return h.id;
    }
    return null;
  }

  private getPickedAnchorCentroidWorld(): Point | null {
    if (this.pickedAnchors.size === 0) return null;
    let sx = 0,
      sy = 0,
      n = 0;
    for (const key of this.pickedAnchors) {
      const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
      const item = this.paperRenderer.getPathById(itemId);
      if (!item) continue;
      const seg = this.paperRenderer.getChildPaths(item)[childIndex]?.segments[segmentIndex];
      if (!seg) continue;
      sx += seg.point.x;
      sy += seg.point.y;
      n++;
    }
    if (n === 0) return null;
    return { x: sx / n, y: sy / n };
  }

  /**
   * Scale every picked anchor about `worldPivot` in **view-aligned axes**,
   * so dragging a handle rightward scales horizontally on screen even when
   * the camera is rotated. Bezier tangents are scaled with the anchor so the
   * curvature of each picked segment is preserved.
   */
  private scalePickedAnchorsInViewSpace(
    incSX: number,
    incSY: number,
    worldPivot: Point,
  ): void {
    const rotDeg = this.camera.getRotationDegrees();
    const origin = new paper.Point(0, 0);
    const matrix = new paper.Matrix();
    matrix.translate(worldPivot.x, worldPivot.y);
    matrix.rotate(-rotDeg, origin);
    matrix.scale(incSX, incSY);
    matrix.rotate(rotDeg, origin);
    matrix.translate(-worldPivot.x, -worldPivot.y);

    for (const key of this.pickedAnchors) {
      const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
      const item = this.paperRenderer.getPathById(itemId);
      if (!item) continue;
      const seg = this.paperRenderer.getChildPaths(item)[childIndex]?.segments[segmentIndex];
      if (!seg) continue;

      const newPoint = matrix.transform(seg.point);
      // Handles are relative vectors — transform (anchor + handle), subtract
      // the new anchor to get the new relative handle. This applies the
      // rotational/scale portion of the matrix to the vector and drops the
      // translational part, which is exactly what we want for handles.
      const inAbsNew = matrix.transform(seg.point.add(seg.handleIn));
      const outAbsNew = matrix.transform(seg.point.add(seg.handleOut));

      seg.point = newPoint;
      seg.handleIn = new paper.Point(
        inAbsNew.x - newPoint.x,
        inAbsNew.y - newPoint.y,
      );
      seg.handleOut = new paper.Point(
        outAbsNew.x - newPoint.x,
        outAbsNew.y - newPoint.y,
      );
    }
    paper.view.update();
  }

  private rotatePickedAnchors(degrees: number, worldPivot: Point): void {
    const pivot = new paper.Point(worldPivot.x, worldPivot.y);
    for (const key of this.pickedAnchors) {
      const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
      const item = this.paperRenderer.getPathById(itemId);
      if (!item) continue;
      const seg = this.paperRenderer.getChildPaths(item)[childIndex]?.segments[segmentIndex];
      if (!seg) continue;

      seg.point = seg.point.rotate(degrees, pivot);
      // Handles are relative vectors; rotate them about the origin.
      seg.handleIn = seg.handleIn.rotate(degrees, new paper.Point(0, 0));
      seg.handleOut = seg.handleOut.rotate(degrees, new paper.Point(0, 0));
    }
    paper.view.update();
  }

  // ============================================================
  // Hit testing & marquee
  // ============================================================

  private hitTestAnchor(viewportPoint: Point): number | null {
    const hitRadiusSq = 10 * 10;
    for (let i = 0; i < this.anchorHandles.length; i++) {
      const h = this.anchorHandles[i];
      const dx = viewportPoint.x - h.x;
      const dy = viewportPoint.y - h.y;
      if (dx * dx + dy * dy <= hitRadiusSq) return i;
    }
    return null;
  }

  private hitTestEdge(
    viewportPoint: Point,
  ): {
    itemId: number;
    childIndex: number;
    startSegmentIndex: number;
    endSegmentIndex: number;
  } | null {
    const worldPoint = this.camera.screenToWorld(viewportPoint.x, viewportPoint.y);
    const queryPoint = new paper.Point(worldPoint.x, worldPoint.y);
    const hitRadiusSq = 10 * 10;
    let best:
      | {
          itemId: number;
          childIndex: number;
          startSegmentIndex: number;
          endSegmentIndex: number;
          distSq: number;
        }
      | null = null;

    const items = [...this.paperRenderer.getAllPaths()].reverse();
    for (const item of items) {
      const childPaths = this.paperRenderer.getChildPaths(item);
      for (let childIndex = 0; childIndex < childPaths.length; childIndex++) {
        const path = childPaths[childIndex];
        const curves = path.curves;
        for (let curveIndex = 0; curveIndex < curves.length; curveIndex++) {
          const location = curves[curveIndex].getNearestLocation(queryPoint);
          if (!location) continue;
          const screenPoint = this.camera.worldToScreen(location.point.x, location.point.y);
          const dx = viewportPoint.x - screenPoint.x;
          const dy = viewportPoint.y - screenPoint.y;
          const distSq = dx * dx + dy * dy;
          if (distSq > hitRadiusSq) continue;
          if (best && distSq >= best.distSq) continue;

          const startSegmentIndex = curveIndex;
          const endSegmentIndex =
            curveIndex + 1 < path.segments.length ? curveIndex + 1 : 0;
          best = {
            itemId: item.id,
            childIndex,
            startSegmentIndex,
            endSegmentIndex,
            distSq,
          };
        }
      }
    }

    if (!best) return null;
    return {
      itemId: best.itemId,
      childIndex: best.childIndex,
      startSegmentIndex: best.startSegmentIndex,
      endSegmentIndex: best.endSegmentIndex,
    };
  }

  private collectMarqueeMatches(): AnchorHandle[] {
    const handles = this.anchorHandles;

    if (this.selectionShape === "lasso") {
      return handles.filter((h) =>
        pointInPolygon({ x: h.x, y: h.y }, this.marquee.getLassoPoints()),
      );
    }
    const start = this.marquee.getStartPoint();
    const current = this.marquee.getCurrentPoint();
    if (!start || !current) return [];
    const minX = Math.min(start.x, current.x);
    const minY = Math.min(start.y, current.y);
    const maxX = Math.max(start.x, current.x);
    const maxY = Math.max(start.y, current.y);
    return handles.filter(
      (h) => h.x >= minX && h.x <= maxX && h.y >= minY && h.y <= maxY,
    );
  }

  private hasActiveMarquee(): boolean {
    return this.marquee.hasActiveMarquee(this.selectionShape);
  }

  // ============================================================
  // Path helpers
  // ============================================================

  private forEachSegment(
    item: paper.PathItem,
    fn: (childIndex: number, segmentIndex: number, seg: paper.Segment) => void,
  ): void {
    const childPaths = this.paperRenderer.getChildPaths(item);
    for (let ci = 0; ci < childPaths.length; ci++) {
      const segs = childPaths[ci].segments;
      for (let si = 0; si < segs.length; si++) {
        fn(ci, si, segs[si]);
      }
    }
  }

  private findSegmentNear(
    item: paper.PathItem,
    worldPoint: paper.Point,
    epsilon: number,
  ): { childIndex: number; segmentIndex: number } | null {
    const eps2 = epsilon * epsilon;
    let bestChild = -1;
    let bestSeg = -1;
    let bestDist2 = Infinity;
    this.forEachSegment(item, (ci, si, seg) => {
      const dx = seg.point.x - worldPoint.x;
      const dy = seg.point.y - worldPoint.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= eps2 && d2 < bestDist2) {
        bestChild = ci;
        bestSeg = si;
        bestDist2 = d2;
      }
    });
    return bestChild >= 0 ? { childIndex: bestChild, segmentIndex: bestSeg } : null;
  }

  // ============================================================
  // Drawing helpers
  // ============================================================

  private getSelectionAnchorViewport(items: paper.PathItem[]): Point | null {
    if (items.length === 0) return null;
    const bounds = this.paperRenderer.getCombinedBounds(items);
    if (!bounds) return null;
    return this.camera.worldToScreen(bounds.x + bounds.width, bounds.y);
  }
}
