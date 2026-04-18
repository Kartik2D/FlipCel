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
  private config: CanvasConfig;
  private paperRenderer: PaperRenderer;
  private camera: Camera;
  private chromeOverlay: ChromeOverlay;
  private chromeCtx: CanvasRenderingContext2D;
  private onSnapshot?: () => void;
  private onReconcile?: (item: paper.PathItem) => paper.PathItem | null;

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

  private marqueeStartPoint: Point | null = null;
  private marqueeCurrentPoint: Point | null = null;
  private lassoPoints: Point[] = [];
  private readonly marqueeDragThresholdPx = 6;

  /**
   * Multi-pick transform-gizmo state. Populated only while at least two
   * anchors are picked so the user can scale/rotate the picked cluster via
   * the same bbox handles as the select tool.
   */
  private transformHandles: SelectionHandle[] = [];
  private activeTransformHandle: SelectionHandleId | null = null;
  private isTransformingAnchors = false;
  private didTransformAnchors = false;
  private transformAnchorScreen: Point | null = null;
  private transformAnchorWorld: Point | null = null;
  private originalCornerScreen: Point | null = null;
  private lastTotalScaleX = 1;
  private lastTotalScaleY = 1;
  private rotateStartAngle = 0;
  private lastTotalRotation = 0;
  private rotatePivotWorld: Point | null = null;
  private lastViewportPoint: Point | null = null;

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

  setReconcileCallback(callback: (item: paper.PathItem) => paper.PathItem | null): void {
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
      this.marqueeStartPoint !== null ||
      this.isDraggingAnchor ||
      this.handleDrag !== null ||
      this.isTransformingAnchors
    );
  }

  getLastSelectionViewport(): Point | null {
    return this.lastSelectionViewport;
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
    const viewportPoint = this.pixelToViewport(point);
    this.rebuildAnchorHandles();

    // Transform gizmo (bbox + handles) is shown whenever >=2 anchors are
    // picked. Hit test those handles first so the user can scale/rotate
    // the cluster even when a handle sits near an anchor square.
    if (this.pickedAnchors.size >= 2 && this.transformHandles.length > 0) {
      const hitTransform = this.hitTestTransformHandle(viewportPoint);
      if (hitTransform) {
        this.activeTransformHandle = hitTransform;
        this.isTransformingAnchors = true;
        this.didTransformAnchors = false;
        this.dragStartPoint = viewportPoint;
        this.initAnchorTransform(hitTransform, viewportPoint);
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
      this.didMoveAnchor = false;
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
      this.didMoveAnchor = false;
      this.publishPickedItems();
      this.drawUI();
      return;
    }

    this.marqueeStartPoint = viewportPoint;
    this.marqueeCurrentPoint = viewportPoint;
    this.lassoPoints = [viewportPoint];
    this.drawUI();
  }

  handleMove(point: Point): void {
    const viewportPoint = this.pixelToViewport(point);
    this.lastViewportPoint = viewportPoint;

    if (this.marqueeStartPoint) {
      this.marqueeCurrentPoint = viewportPoint;
      if (this.selectionShape === "lasso") {
        this.lassoPoints.push(viewportPoint);
      }
      this.drawUI();
      return;
    }

    if (this.isTransformingAnchors) {
      if (this.activeTransformHandle === "rotate") {
        this.handleAnchorRotateMove(viewportPoint);
      } else if (this.activeTransformHandle) {
        this.handleAnchorResizeMove(viewportPoint);
      }
      this.drawUI();
      return;
    }

    if (this.handleDrag) {
      this.dragBezierHandleTo(viewportPoint);
      return;
    }

    if (!this.isDraggingAnchor || !this.dragStartPoint) return;

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
    if (this.marqueeStartPoint && this.marqueeCurrentPoint) {
      this.finalizeMarquee();
      this.resetMarqueeState();
      this.drawUI();
      return;
    }

    if (this.isTransformingAnchors) {
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
    if (this.pickedAnchors.size >= 2) {
      const bounds = this.getPickedAnchorScreenBounds();
      if (bounds) {
        let rotating:
          | { cursor: Point; pivot: Point }
          | null = null;
        if (
          this.isTransformingAnchors &&
          this.activeTransformHandle === "rotate" &&
          this.lastViewportPoint &&
          this.rotatePivotWorld
        ) {
          const pivot = this.camera.worldToScreen(
            this.rotatePivotWorld.x,
            this.rotatePivotWorld.y,
          );
          rotating = { cursor: this.lastViewportPoint, pivot };
        }
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

    if (this.marqueeStartPoint && this.marqueeCurrentPoint) {
      if (this.selectionShape === "lasso") {
        this.drawLassoPreview(this.lassoPoints);
      } else {
        this.drawMarqueeRect(this.marqueeStartPoint, this.marqueeCurrentPoint);
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
    const pathById = this.buildPathIndex();
    const items: paper.PathItem[] = [];
    const seen = new Set<number>();
    for (const key of this.pickedAnchors) {
      const { itemId } = parseAnchorKey(key);
      const item = pathById.get(itemId);
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
    const item = this.buildPathIndex().get(itemId);
    if (!item) return null;
    const seg = this.getChildPaths(item)[childIndex]?.segments[segmentIndex];
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
    const item = this.buildPathIndex().get(itemId);
    if (!item) return;
    const seg = this.getChildPaths(item)[childIndex]?.segments[segmentIndex];
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
    const pathById = this.buildPathIndex();
    const item = pathById.get(itemId);
    const seg = item
      ? this.getChildPaths(item)[childIndex]?.segments[segmentIndex]
      : undefined;
    const anchorWorld = seg ? seg.point.clone() : null;

    if (this.onReconcile && item && item.parent) {
      this.onReconcile(item);
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

  private moveSelectedAnchors(dx: number, dy: number): void {
    const delta = new paper.Point(dx, dy);
    const pathById = this.buildPathIndex();
    for (const key of this.pickedAnchors) {
      const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
      const item = pathById.get(itemId);
      if (!item) continue;
      const seg = this.getChildPaths(item)[childIndex]?.segments[segmentIndex];
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
    const pathById = this.buildPathIndex();
    for (const key of this.pickedAnchors) {
      const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
      const item = pathById.get(itemId);
      if (!item) continue;
      const seg = this.getChildPaths(item)[childIndex]?.segments[segmentIndex];
      if (!seg) continue;
      targets.push(seg.point.clone());
    }

    if (!this.onReconcile) {
      this.onSnapshot?.();
      this.publishPickedItems();
      return;
    }

    const affectedIds = new Set<number>();
    for (const key of this.pickedAnchors) {
      affectedIds.add(parseAnchorKey(key).itemId);
    }
    for (const id of affectedIds) {
      const item = pathById.get(id);
      if (!item || !item.parent) continue;
      this.onReconcile(item);
    }

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
  }

  private resetMarqueeState(): void {
    this.marqueeStartPoint = null;
    this.marqueeCurrentPoint = null;
    this.lassoPoints = [];
  }

  private resetTransformState(): void {
    this.activeTransformHandle = null;
    this.isTransformingAnchors = false;
    this.didTransformAnchors = false;
    this.transformAnchorScreen = null;
    this.transformAnchorWorld = null;
    this.originalCornerScreen = null;
    this.lastTotalScaleX = 1;
    this.lastTotalScaleY = 1;
    this.rotateStartAngle = 0;
    this.lastTotalRotation = 0;
    this.rotatePivotWorld = null;
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

  private initAnchorTransform(
    handle: SelectionHandleId,
    viewportPoint: Point,
  ): void {
    const bounds = this.getPickedAnchorScreenBounds();
    if (!bounds) return;

    if (handle === "rotate") {
      // Rotate around the world-space centroid of the picked anchors.
      // The centroid is invariant under rotation about itself, so the pivot
      // stays stable through the drag even as anchors move.
      const centroid = this.getPickedAnchorCentroidWorld();
      if (!centroid) return;
      this.rotatePivotWorld = centroid;

      const screenPivot = this.camera.worldToScreen(centroid.x, centroid.y);
      this.rotateStartAngle = Math.atan2(
        viewportPoint.y - screenPivot.y,
        viewportPoint.x - screenPivot.x,
      );
      this.lastTotalRotation = 0;
      return;
    }

    const b = bounds;
    const corners: Record<string, Point> = {
      nw: { x: b.x, y: b.y },
      n: { x: b.x + b.width / 2, y: b.y },
      ne: { x: b.x + b.width, y: b.y },
      e: { x: b.x + b.width, y: b.y + b.height / 2 },
      se: { x: b.x + b.width, y: b.y + b.height },
      s: { x: b.x + b.width / 2, y: b.y + b.height },
      sw: { x: b.x, y: b.y + b.height },
      w: { x: b.x, y: b.y + b.height / 2 },
    };

    const opposites: Record<string, string> = {
      nw: "se",
      ne: "sw",
      se: "nw",
      sw: "ne",
      n: "s",
      s: "n",
      e: "w",
      w: "e",
    };

    const anchorScreen = corners[opposites[handle]];
    const worldAnchor = this.camera.screenToWorld(
      anchorScreen.x,
      anchorScreen.y,
    );
    this.originalCornerScreen = corners[handle];
    this.transformAnchorScreen = anchorScreen;
    this.transformAnchorWorld = { x: worldAnchor.x, y: worldAnchor.y };
    this.lastTotalScaleX = 1;
    this.lastTotalScaleY = 1;
  }

  private handleAnchorResizeMove(viewportPoint: Point): void {
    if (
      !this.transformAnchorScreen ||
      !this.transformAnchorWorld ||
      !this.originalCornerScreen
    )
      return;

    const anchor = this.transformAnchorScreen;
    const origCorner = this.originalCornerScreen;
    const isEdgeX =
      this.activeTransformHandle === "e" || this.activeTransformHandle === "w";
    const isEdgeY =
      this.activeTransformHandle === "n" || this.activeTransformHandle === "s";

    let desiredSX = this.lastTotalScaleX;
    let desiredSY = this.lastTotalScaleY;

    const dxOrig = origCorner.x - anchor.x;
    const dyOrig = origCorner.y - anchor.y;

    if (!isEdgeY && Math.abs(dxOrig) > 0.001) {
      desiredSX = (viewportPoint.x - anchor.x) / dxOrig;
    }
    if (!isEdgeX && Math.abs(dyOrig) > 0.001) {
      desiredSY = (viewportPoint.y - anchor.y) / dyOrig;
    }

    const minScale = 0.01;
    if (Math.abs(desiredSX) < minScale)
      desiredSX = desiredSX < 0 ? -minScale : minScale;
    if (Math.abs(desiredSY) < minScale)
      desiredSY = desiredSY < 0 ? -minScale : minScale;

    const incSX = desiredSX / this.lastTotalScaleX;
    const incSY = desiredSY / this.lastTotalScaleY;

    if (Math.abs(incSX - 1) > 0.0001 || Math.abs(incSY - 1) > 0.0001) {
      this.didTransformAnchors = true;
      this.scalePickedAnchorsInViewSpace(
        incSX,
        incSY,
        this.transformAnchorWorld,
      );
      this.lastTotalScaleX = desiredSX;
      this.lastTotalScaleY = desiredSY;
    }
  }

  private handleAnchorRotateMove(viewportPoint: Point): void {
    if (!this.rotatePivotWorld) return;

    const screenCenter = this.camera.worldToScreen(
      this.rotatePivotWorld.x,
      this.rotatePivotWorld.y,
    );
    const currentAngle = Math.atan2(
      viewportPoint.y - screenCenter.y,
      viewportPoint.x - screenCenter.x,
    );
    const desiredRotation = currentAngle - this.rotateStartAngle;
    const incrementalRotation = desiredRotation - this.lastTotalRotation;

    if (Math.abs(incrementalRotation) > 0.0001) {
      this.didTransformAnchors = true;
      const degrees = (incrementalRotation * 180) / Math.PI;
      this.rotatePickedAnchors(degrees, this.rotatePivotWorld);
      this.lastTotalRotation = desiredRotation;
    }
  }

  private getPickedAnchorCentroidWorld(): Point | null {
    if (this.pickedAnchors.size === 0) return null;
    const pathById = this.buildPathIndex();
    let sx = 0,
      sy = 0,
      n = 0;
    for (const key of this.pickedAnchors) {
      const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
      const item = pathById.get(itemId);
      if (!item) continue;
      const seg = this.getChildPaths(item)[childIndex]?.segments[segmentIndex];
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

    const pathById = this.buildPathIndex();
    for (const key of this.pickedAnchors) {
      const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
      const item = pathById.get(itemId);
      if (!item) continue;
      const seg = this.getChildPaths(item)[childIndex]?.segments[segmentIndex];
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
    const pathById = this.buildPathIndex();
    for (const key of this.pickedAnchors) {
      const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
      const item = pathById.get(itemId);
      if (!item) continue;
      const seg = this.getChildPaths(item)[childIndex]?.segments[segmentIndex];
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

  private collectMarqueeMatches(): AnchorHandle[] {
    const handles = this.anchorHandles;

    if (this.selectionShape === "lasso") {
      return handles.filter((h) => this.pointInPolygon({ x: h.x, y: h.y }, this.lassoPoints));
    }
    if (!this.marqueeStartPoint || !this.marqueeCurrentPoint) return [];
    const minX = Math.min(this.marqueeStartPoint.x, this.marqueeCurrentPoint.x);
    const minY = Math.min(this.marqueeStartPoint.y, this.marqueeCurrentPoint.y);
    const maxX = Math.max(this.marqueeStartPoint.x, this.marqueeCurrentPoint.x);
    const maxY = Math.max(this.marqueeStartPoint.y, this.marqueeCurrentPoint.y);
    return handles.filter(
      (h) => h.x >= minX && h.x <= maxX && h.y >= minY && h.y <= maxY,
    );
  }

  private hasActiveMarquee(): boolean {
    if (this.selectionShape === "lasso") {
      if (this.lassoPoints.length < 2) return false;
      const first = this.lassoPoints[0];
      const last = this.lassoPoints[this.lassoPoints.length - 1];
      const dx = last.x - first.x;
      const dy = last.y - first.y;
      return dx * dx + dy * dy >= this.marqueeDragThresholdPx ** 2;
    }
    if (!this.marqueeStartPoint || !this.marqueeCurrentPoint) return false;
    const dx = this.marqueeCurrentPoint.x - this.marqueeStartPoint.x;
    const dy = this.marqueeCurrentPoint.y - this.marqueeStartPoint.y;
    return dx * dx + dy * dy >= this.marqueeDragThresholdPx ** 2;
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

  private buildPathIndex(): Map<number, paper.PathItem> {
    const map = new Map<number, paper.PathItem>();
    for (const p of this.paperRenderer.getAllPaths()) {
      map.set(p.id, p);
    }
    return map;
  }

  private getChildPaths(item: paper.PathItem): paper.Path[] {
    if (item instanceof paper.Path) return [item];
    if (item instanceof paper.CompoundPath) {
      return item.children.filter((c): c is paper.Path => c instanceof paper.Path);
    }
    return [];
  }

  private forEachSegment(
    item: paper.PathItem,
    fn: (childIndex: number, segmentIndex: number, seg: paper.Segment) => void,
  ): void {
    const childPaths = this.getChildPaths(item);
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

  /**
   * Render the two bezier control handles (in / out tangents) for the single
   * picked anchor. Skips either tangent when its handle vector is zero, i.e.
   * when the segment is a corner on that side.
   */
  private drawBezierHandlesForSoloPick(ctx: CanvasRenderingContext2D): void {
    const key = this.pickedAnchors.values().next().value as AnchorKey | undefined;
    if (!key) return;

    const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
    const item = this.buildPathIndex().get(itemId);
    if (!item) return;

    const seg = this.getChildPaths(item)[childIndex]?.segments[segmentIndex];
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

  private drawMarqueeRect(start: Point, end: Point): void {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);

    const ctx = this.chromeCtx;
    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.1)";
    ctx.fillRect(x, y, width, height);
    const dash = [6, 4];
    ctx.setLineDash(dash);
    ctx.lineJoin = "miter";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, width, height);
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, width, height);
    ctx.setLineDash([]);
    ctx.restore();
  }

  private drawLassoPreview(points: Point[]): void {
    if (points.length < 2) return;
    const ctx = this.chromeCtx;
    ctx.save();
    const dash = [6, 4];
    ctx.setLineDash(dash);
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(0, 0, 0, 0.1)";
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  private getSelectionAnchorViewport(items: paper.PathItem[]): Point | null {
    if (items.length === 0) return null;
    const bounds = this.paperRenderer.getCombinedBounds(items);
    if (!bounds) return null;
    return this.camera.worldToScreen(bounds.x + bounds.width, bounds.y);
  }

  private pixelToViewport(point: Point): Point {
    return {
      x: (point.x / this.config.pixelWidth) * this.config.viewportWidth,
      y: (point.y / this.config.pixelHeight) * this.config.viewportHeight,
    };
  }
}
