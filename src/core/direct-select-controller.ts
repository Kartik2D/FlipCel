/**
 * Direct Select Controller
 *
 * Simple model:
 *
 *   While the direct-select tool is active, EVERY anchor on the active layer
 *   is exposed. There is no "which shapes show anchors" derivation — it's
 *   always all of them.
 *
 *   The only state the tool holds is:
 *     pickedAnchors : Set<AnchorKey>   — anchors the user selected (click /
 *                                        marquee / lasso). Drag moves these.
 *     anchorHandles : AnchorHandle[]   — cached per-frame, one handle per
 *                                        anchor of every active-layer item.
 *
 *   What gets published to the shared selectionStore:
 *     items owning any picked anchor. Empty when nothing is picked.
 *     That's what the color picker and functions panel operate on.
 */
import type { Point, CanvasConfig } from "./types";
import type { PaperRenderer } from "./paper-renderer";
import type { SelectionHandle, SelectionHandleId } from "./paper-renderer";
import type { Camera } from "./camera";
import type { ChromeOverlay } from "./chrome-overlay";
import { configStore, toolSettingsStore, selectionStore } from "./stores";
import paper from "paper";
import { pixelToViewport } from "./coords";
import { MarqueeTracker } from "./marquee-tracker";
import { TransformGizmoController } from "./transform-gizmo-controller";

type AnchorKey = string;

export interface AnchorHandle {
  item: paper.PathItem;
  childIndex: number;
  segmentIndex: number;
  key: AnchorKey;
  x: number;
  y: number;
}

const anchorKey = (itemId: number, childIndex: number, segmentIndex: number): AnchorKey =>
  `${itemId}:${childIndex}:${segmentIndex}`;

const parseAnchorKey = (key: AnchorKey) => {
  const [i, c, s] = key.split(":").map(Number);
  return { itemId: i, childIndex: c, segmentIndex: s };
};

export class DirectSelectController {
  /** Ignore sub-pixel jitter: only apply drags after this many viewport px from pointer-down. */
  private readonly dragMoveThresholdSq = 5 * 5;
  private dragPointerOrigin: Point | null = null;
  private dragPastThreshold = false;

  private config: CanvasConfig;
  private paperRenderer: PaperRenderer;
  private camera: Camera;
  private chromeOverlay: ChromeOverlay;
  private chromeCtx: CanvasRenderingContext2D;
  private onSnapshot?: () => void;
  private onReconcile?: (items: paper.PathItem[]) => void;

  private selectionShape: "rect" | "lasso" = "rect";

  private pickedAnchors: Set<AnchorKey> = new Set();
  private anchorHandles: AnchorHandle[] = [];

  private isDraggingAnchor = false;
  private dragStartPoint: Point | null = null;
  private didMoveAnchor = false;

  /**
   * Active bezier-handle drag. Only populated while exactly one anchor is
   * picked and the user pointerdown'd on one of that anchor's tangent knobs.
   */
  private handleDrag: {
    kind: "in" | "out";
    segmentKey: AnchorKey;
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
    chromeOverlay: ChromeOverlay,
  ) {
    this.paperRenderer = paperRenderer;
    this.camera = camera;
    this.chromeOverlay = chromeOverlay;
    this.chromeCtx = chromeOverlay.getContext();
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
   * True when the tool has any transient UI to draw beyond the baseline
   * "all anchors on the layer" state — i.e. a pick, a drag, or an in-progress
   * marquee. The baseline itself is drawn whenever the tool is active.
   */
  hasTransientUI(): boolean {
    return (
      this.hasSelection() ||
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
    this.pickedAnchors.clear();
    this.onSnapshot?.();
    this.publishPickedItems();
    this.drawUI();
    return true;
  }

  setPickedAnchorHandleMode(mode: "corner" | "mirrored" | "asymmetric"): boolean {
    if (this.pickedAnchors.size === 0) return false;

    const targets: paper.Point[] = [];
    for (const key of this.pickedAnchors) {
      const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
      const item = this.paperRenderer.getPathById(itemId);
      if (!item) continue;
      const path = this.paperRenderer.getChildPaths(item)[childIndex];
      const seg = path?.segments[segmentIndex];
      if (!path || !seg) continue;

      targets.push(seg.point.clone());
      this.applyHandleModeToSegment(path, segmentIndex, seg, mode);
    }

    paper.view.update();
    this.commitPickedAnchorMutation(targets);
    this.drawUI();
    return true;
  }

  simplifyPickedItems(): boolean {
    const items = this.getPickedItems().filter((item) => item.parent);
    if (items.length === 0) return false;

    const targets: paper.Point[] = [];
    for (const key of this.pickedAnchors) {
      const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
      const item = this.paperRenderer.getPathById(itemId);
      const seg = item
        ? this.paperRenderer.getChildPaths(item)[childIndex]?.segments[segmentIndex]
        : undefined;
      if (seg) targets.push(seg.point.clone());
    }

    this.paperRenderer.simplifyItems(items);
    this.commitPickedAnchorMutation(targets);
    this.drawUI();
    return true;
  }

  clearSelection(): void {
    this.pickedAnchors.clear();
    this.resetDragState();
    this.resetMarqueeState();
    this.resetTransformState();
    this.lastSelectionViewport = null;
    selectionStore.set({ items: [] });
    this.drawUI();
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
    const handleHit = this.hitTestBezierHandle(viewportPoint);
    if (handleHit) {
      this.handleDrag = handleHit;
      this.dragStartPoint = viewportPoint;
      this.beginDragThreshold(viewportPoint);
      this.didMoveHandle = false;
      this.drawUI();
      return;
    }

    const hitIdx = this.hitTestAnchor(viewportPoint);
    if (hitIdx !== null) {
      const hit = this.anchorHandles[hitIdx];
      if (!this.pickedAnchors.has(hit.key)) {
        this.pickedAnchors = new Set([hit.key]);
      }
      this.isDraggingAnchor = true;
      this.dragStartPoint = viewportPoint;
      this.beginDragThreshold(viewportPoint);
      this.didMoveAnchor = false;
      this.publishPickedItems();
      this.drawUI();
      return;
    }

    const edgeHit = this.hitTestEdge(viewportPoint);
    if (edgeHit) {
      this.pickedAnchors = new Set([
        anchorKey(edgeHit.itemId, edgeHit.childIndex, edgeHit.startSegmentIndex),
        anchorKey(edgeHit.itemId, edgeHit.childIndex, edgeHit.endSegmentIndex),
      ]);
      this.edgeDrag = edgeHit;
      this.dragStartPoint = viewportPoint;
      this.beginDragThreshold(viewportPoint);
      this.didMoveEdge = false;
      this.publishPickedItems();
      this.drawUI();
      return;
    }

    const shapeHit = this.paperRenderer.resolveSelectableItem(
      this.paperRenderer.hitTest(viewportPoint),
    );
    if (shapeHit) {
      this.pickAllAnchorsOfItem(shapeHit);
      this.isDraggingAnchor = true;
      this.dragStartPoint = viewportPoint;
      this.beginDragThreshold(viewportPoint);
      this.didMoveAnchor = false;
      this.publishPickedItems();
      this.drawUI();
      return;
    }

    this.marquee.start(viewportPoint);
    this.drawUI();
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
          this.didTransformAnchors = true;
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
      this.didMoveAnchor = true;
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
    this.chromeOverlay.clear();
    this.rebuildAnchorHandles();

    const ctx = this.chromeCtx;
    ctx.save();

    // Outline every item that owns at least one picked anchor.
    for (const item of this.getPickedItems()) {
      this.paperRenderer.strokeSelectionShapeOutline(ctx, item);
    }

    // When exactly one anchor is picked, expose its bezier control handles
    // (handleIn / handleOut). Drawn before the anchor squares so the picked
    // anchor sits visually on top of the handle arms meeting at it.
    if (this.pickedAnchors.size === 1) {
      this.drawBezierHandlesForSoloPick(ctx);
    }

    // Anchor nodes: picked = black / white; exposed unpicked = solid grey (dim).
    const unpickedR = 3;
    const pickedR = 5;
    const unpickedFill = "#6e6e6e";
    const unpickedStroke = "#b8b8b8";
    for (const h of this.anchorHandles) {
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
        this.chromeOverlay.drawLassoPreview(this.marquee.getLassoPoints());
      } else {
        this.chromeOverlay.drawMarqueeRect(start, current);
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

    for (const item of this.paperRenderer.getAllPaths()) {
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
  }

  // ============================================================
  // Mutation & finalization
  // ============================================================

  /**
   * Hit test the two tangent knobs of the solo-picked anchor, if any.
   * Returns null when no anchor is solo-picked, the resolved segment has
   * zero-length handles, or the pointer is outside the hit radius.
   */
  private hitTestBezierHandle(
    viewportPoint: Point,
  ): { kind: "in" | "out"; segmentKey: AnchorKey } | null {
    if (this.pickedAnchors.size !== 1) return null;
    const key = this.pickedAnchors.values().next().value as AnchorKey | undefined;
    if (!key) return null;

    const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
    const item = this.paperRenderer.getPathById(itemId);
    if (!item) return null;
    const seg = this.paperRenderer.getChildPaths(item)[childIndex]?.segments[segmentIndex];
    if (!seg) return null;

    const hitRadiusSq = 10 * 10;
    const check = (
      handle: paper.Point,
      kind: "in" | "out",
    ): { kind: "in" | "out"; segmentKey: AnchorKey } | null => {
      if (handle.isZero()) return null;
      const tipWorld = seg.point.add(handle);
      const tipScreen = this.camera.worldToScreen(tipWorld.x, tipWorld.y);
      const dx = viewportPoint.x - tipScreen.x;
      const dy = viewportPoint.y - tipScreen.y;
      if (dx * dx + dy * dy <= hitRadiusSq) {
        return { kind, segmentKey: key };
      }
      return null;
    };

    // Prefer handleOut when both overlap — matches the draw order (out drawn
    // last so it's visually on top) and gives deterministic picking.
    return check(seg.handleOut, "out") ?? check(seg.handleIn, "in");
  }

  /**
   * Set the dragged handle's world-space offset so its tip sits at the
   * pointer. Moves the in/out vector only — the anchor point itself is not
   * touched. Other segments on the path are unaffected.
   */
  private dragBezierHandleTo(viewportPoint: Point): void {
    if (!this.handleDrag) return;

    const { itemId, childIndex, segmentIndex } = parseAnchorKey(
      this.handleDrag.segmentKey,
    );
    const item = this.paperRenderer.getPathById(itemId);
    if (!item) return;
    const seg = this.paperRenderer.getChildPaths(item)[childIndex]?.segments[segmentIndex];
    if (!seg) return;

    const world = this.camera.screenToWorld(viewportPoint.x, viewportPoint.y);
    const newHandle = new paper.Point(
      world.x - seg.point.x,
      world.y - seg.point.y,
    );

    if (this.handleDrag.kind === "in") {
      seg.handleIn = newHandle;
    } else {
      seg.handleOut = newHandle;
    }

    paper.view.update();
    this.didMoveHandle = true;
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
    this.didMoveEdge = true;
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
      this.pickedAnchors = matchedKeys;
    } else {
      // Empty click below the drag threshold: clear picks.
      this.pickedAnchors.clear();
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
    this.pickedAnchors = newKeys;

    this.onSnapshot?.();
    this.publishPickedItems();
  }

  private commitPickedAnchorMutation(targets: paper.Point[]): void {
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
    this.onReconcile(affectedItems);

    const epsilon = 1e-3;
    const remapped = new Set<AnchorKey>();
    const layerItems = this.paperRenderer.getAllPaths();
    for (const pos of targets) {
      for (const candidate of layerItems) {
        const match = this.findSegmentNear(candidate, pos, epsilon);
        if (match) {
          remapped.add(anchorKey(candidate.id, match.childIndex, match.segmentIndex));
          break;
        }
      }
    }
    this.pickedAnchors = remapped;

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
        this.pointInPolygon({ x: h.x, y: h.y }, this.marquee.getLassoPoints()),
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

  private pointInPolygon(point: Point, polygon: Point[]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x,
        yi = polygon[i].y;
      const xj = polygon[j].x,
        yj = polygon[j].y;
      const intersects =
        yi > point.y !== yj > point.y &&
        point.x < ((xj - xi) * (point.y - yi)) / (yj - yi || 1e-6) + xi;
      if (intersects) inside = !inside;
    }
    return inside;
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

  private applyHandleModeToSegment(
    path: paper.Path,
    segmentIndex: number,
    seg: paper.Segment,
    mode: "corner" | "mirrored" | "asymmetric",
  ): void {
    const { prev, next } = this.getAdjacentSegments(path, segmentIndex);
    const hasPrev = prev !== null;
    const hasNext = next !== null;

    if (mode === "corner") {
      seg.handleIn = new paper.Point(0, 0);
      seg.handleOut = new paper.Point(0, 0);
      return;
    }

    const tangent = this.getSegmentTangentDirection(seg, prev, next);
    if (!tangent) return;

    const defaultLength = this.getDefaultHandleLength(seg, prev, next);
    const currentInLength = seg.handleIn.length;
    const currentOutLength = seg.handleOut.length;

    if (mode === "mirrored") {
      const mirroredLength = Math.max(
        (currentInLength + currentOutLength) / 2,
        defaultLength,
      );
      seg.handleIn = hasPrev
        ? tangent.multiply(-mirroredLength)
        : new paper.Point(0, 0);
      seg.handleOut = hasNext
        ? tangent.multiply(mirroredLength)
        : new paper.Point(0, 0);
      return;
    }

    const inLength = Math.max(currentInLength, defaultLength);
    const outLength = Math.max(currentOutLength, defaultLength);
    seg.handleIn = hasPrev ? tangent.multiply(-inLength) : new paper.Point(0, 0);
    seg.handleOut = hasNext ? tangent.multiply(outLength) : new paper.Point(0, 0);
  }

  private getAdjacentSegments(
    path: paper.Path,
    segmentIndex: number,
  ): { prev: paper.Segment | null; next: paper.Segment | null } {
    const segments = path.segments;
    const lastIndex = segments.length - 1;
    const prev = path.closed
      ? segments[(segmentIndex - 1 + segments.length) % segments.length] ?? null
      : segmentIndex > 0
        ? segments[segmentIndex - 1]
        : null;
    const next = path.closed
      ? segments[(segmentIndex + 1) % segments.length] ?? null
      : segmentIndex < lastIndex
        ? segments[segmentIndex + 1]
        : null;
    return { prev, next };
  }

  private getSegmentTangentDirection(
    seg: paper.Segment,
    prev: paper.Segment | null,
    next: paper.Segment | null,
  ): paper.Point | null {
    const epsilon = 1e-6;

    if (!seg.handleOut.isZero() && seg.handleOut.length > epsilon) {
      return seg.handleOut.normalize();
    }
    if (!seg.handleIn.isZero() && seg.handleIn.length > epsilon) {
      return seg.handleIn.multiply(-1).normalize();
    }
    if (prev && next) {
      const across = next.point.subtract(prev.point);
      if (across.length > epsilon) return across.normalize();
    }
    if (next) {
      const forward = next.point.subtract(seg.point);
      if (forward.length > epsilon) return forward.normalize();
    }
    if (prev) {
      const backward = seg.point.subtract(prev.point);
      if (backward.length > epsilon) return backward.normalize();
    }
    return null;
  }

  private getDefaultHandleLength(
    seg: paper.Segment,
    prev: paper.Segment | null,
    next: paper.Segment | null,
  ): number {
    const neighborDistances = [
      prev ? seg.point.getDistance(prev.point) : Infinity,
      next ? seg.point.getDistance(next.point) : Infinity,
    ].filter((distance) => Number.isFinite(distance) && distance > 0);

    if (neighborDistances.length === 0) return 0;
    return Math.min(...neighborDistances) * 0.35;
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

  /**
   * Render the two bezier control handles (in / out tangents) for the single
   * picked anchor. Skips either tangent when its handle vector is zero, i.e.
   * when the segment is a corner on that side.
   */
  private drawBezierHandlesForSoloPick(ctx: CanvasRenderingContext2D): void {
    const key = this.pickedAnchors.values().next().value as AnchorKey | undefined;
    if (!key) return;

    const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
    const item = this.paperRenderer.getPathById(itemId);
    if (!item) return;

    const seg = this.paperRenderer.getChildPaths(item)[childIndex]?.segments[segmentIndex];
    if (!seg) return;

    const anchorScreen = this.camera.worldToScreen(seg.point.x, seg.point.y);

    const drawTangent = (handle: paper.Point) => {
      if (handle.isZero()) return;
      const tipWorld = seg.point.add(handle);
      const tipScreen = this.camera.worldToScreen(tipWorld.x, tipWorld.y);

      // Arm from anchor to handle tip: white halo then dark line for contrast
      // on both light and dark artwork.
      ctx.save();
      ctx.lineCap = "round";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(anchorScreen.x, anchorScreen.y);
      ctx.lineTo(tipScreen.x, tipScreen.y);
      ctx.stroke();
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(anchorScreen.x, anchorScreen.y);
      ctx.lineTo(tipScreen.x, tipScreen.y);
      ctx.stroke();

      // Handle knob: small circle (circles distinguish handles from the
      // square anchor nodes).
      const r = 3.5;
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(tipScreen.x, tipScreen.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };

    drawTangent(seg.handleIn);
    drawTangent(seg.handleOut);
  }

  private getSelectionAnchorViewport(items: paper.PathItem[]): Point | null {
    if (items.length === 0) return null;
    const bounds = this.paperRenderer.getCombinedBounds(items);
    if (!bounds) return null;
    return this.camera.worldToScreen(bounds.x + bounds.width, bounds.y);
  }
}
