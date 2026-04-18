/**
 * Selection Controller
 *
 * Manages the selection tool state and interactions.
 * Handles selecting, dragging, resizing, rotating, and placing paths on the canvas.
 */
import type { Point, CanvasConfig } from "./types";
import type { PaperRenderer } from "./paper-renderer";
import type { SelectionHandleId, SelectionHandle } from "./paper-renderer";
import type { Camera } from "./camera";
import type { ChromeOverlay } from "./chrome-overlay";
import { configStore, toolSettingsStore, selectionStore } from "./stores";

export class SelectionController {
  private readonly marqueeDragThresholdPx = 6;
  private selectionShape: "rect" | "lasso" = "rect";
  private selectedItems: paper.PathItem[] = [];
  private isDragging = false;
  private dragStartPoint: Point | null = null;
  private didMove = false;
  private selectionNeedsPlacement = false;
  private config: CanvasConfig;
  private onSnapshot?: () => void;

  private paperRenderer: PaperRenderer;
  private camera: Camera;
  private chromeOverlay: ChromeOverlay;
  private chromeCtx: CanvasRenderingContext2D;

  // Transform handle state
  private activeHandle: SelectionHandleId | null = null;
  private handles: SelectionHandle[] = [];
  private marqueeStartPoint: Point | null = null;
  private marqueeCurrentPoint: Point | null = null;
  private lassoPoints: Point[] = [];

  // Resize state (all in screen/viewport space so dragging behaves correctly
  // when the camera is rotated). The world anchor is derived once when the
  // transform starts and kept fixed in world so paper.js scaling pivots stay
  // stable across the drag.
  private transformAnchorScreen: Point | null = null;
  private transformAnchorWorld: Point | null = null;
  private originalCornerScreen: Point | null = null;
  private lastTotalScaleX = 1;
  private lastTotalScaleY = 1;

  // Rotate state: the pivot lives in WORLD space (fed straight into
  // paper.js rotate). For a single-item selection we use `item.position` so
  // the item's own rotation point is honored; for multi-selection we fall
  // back to the combined bounds center.
  private rotateStartAngle = 0;
  private lastTotalRotation = 0;
  private rotateCenterWorld: Point | null = null;

  // Current cursor in viewport space (for rotation visual feedback)
  private lastViewportPoint: Point | null = null;

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
      const selectSettings = settings.select as { shape?: unknown };
      const shape = selectSettings.shape;
      this.selectionShape = shape === "lasso" ? "lasso" : "rect";
    });
  }

  setSnapshotCallback(callback: () => void): void {
    this.onSnapshot = callback;
  }

  getSelectedItem(): paper.Item | null {
    return this.selectedItems[0] ?? null;
  }

  getSelectedItems(): paper.PathItem[] {
    return [...this.selectedItems];
  }

  setSelectedItems(items: paper.PathItem[]): void {
    this.selectedItems = [...items];
    this.selectionNeedsPlacement = false;
    this.didMove = false;
    this.handles = [];
    selectionStore.set({ items: [...this.selectedItems] });
    this.drawUI();
  }

  hasSelection(): boolean {
    return this.selectedItems.length > 0;
  }

  hasTransientUI(): boolean {
    return this.hasSelection() || this.hasActiveMarquee();
  }

  placeSelection(): void {
    if (this.selectedItems.length > 0 && (this.selectionNeedsPlacement || this.didMove)) {
      for (const item of this.selectedItems) {
        if (!item.parent) continue;
        this.paperRenderer.placeSelection(item);
      }
      if (this.didMove) {
        this.onSnapshot?.();
      }
    }
    this.selectedItems = [];
    this.selectionNeedsPlacement = false;
    this.didMove = false;
    this.handles = [];
    selectionStore.set({ items: [] });
  }

  clearSelection(): void {
    this.placeSelection();
    this.isDragging = false;
    this.dragStartPoint = null;
    this.marqueeStartPoint = null;
    this.marqueeCurrentPoint = null;
    this.lassoPoints = [];
    this.activeHandle = null;
    this.clearTransformState();
    this.drawUI();
  }

  handleStart(point: Point): void {
    const viewportPoint = this.pixelToViewport(point);

    // Check transform handles on existing selection first
    if (this.hasSelection() && this.handles.length > 0) {
      const hitHandle = this.hitTestHandle(viewportPoint);
      if (hitHandle) {
        this.activeHandle = hitHandle;
        this.isDragging = true;
        this.dragStartPoint = viewportPoint;
        this.didMove = false;
        this.initTransform(hitHandle, viewportPoint);
        return;
      }
    }

    const hitItem = this.paperRenderer.resolveSelectableItem(
      this.paperRenderer.hitTest(viewportPoint),
    );

    if (hitItem && this.isSelectedItem(hitItem)) {
      this.isDragging = true;
      this.dragStartPoint = viewportPoint;
      this.didMove = false;
      this.activeHandle = null;
      this.bringSelectionToFront();
    } else if (hitItem) {
      // Click inside (or on) another shape: select that whole path, then drag.
      this.placeSelection();
      this.setSelectedItems([hitItem]);
      this.isDragging = true;
      this.dragStartPoint = viewportPoint;
      this.didMove = false;
      this.activeHandle = null;
      this.bringSelectionToFront();
    } else {
      this.placeSelection();
      this.startMarquee(viewportPoint);
    }

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

    if (!this.isDragging || !this.hasSelection() || !this.dragStartPoint) return;

    if (this.activeHandle === "rotate") {
      this.handleRotateMove(viewportPoint);
    } else if (this.activeHandle) {
      this.handleResizeMove(viewportPoint);
    } else {
      this.handleTranslateMove(viewportPoint);
    }

    this.drawUI();
  }

  handleEnd(): void {
    if (this.marqueeStartPoint && this.marqueeCurrentPoint) {
      if (this.hasActiveMarquee()) {
        this.selectedItems =
          this.selectionShape === "lasso"
            ? this.paperRenderer.extractSelectionFromScreenLasso(this.lassoPoints)
            : this.paperRenderer.extractSelectionFromScreenRect(
                this.marqueeStartPoint,
                this.marqueeCurrentPoint,
              );
        this.selectionNeedsPlacement = this.selectedItems.length > 0;
        selectionStore.set({ items: [...this.selectedItems] });
      } else {
        this.selectedItems = [];
        this.selectionNeedsPlacement = false;
        selectionStore.set({ items: [] });
      }
      this.marqueeStartPoint = null;
      this.marqueeCurrentPoint = null;
      this.lassoPoints = [];
      this.isDragging = false;
      this.dragStartPoint = null;
      this.activeHandle = null;
      this.clearTransformState();
      this.drawUI();
      return;
    }

    this.isDragging = false;
    this.dragStartPoint = null;
    this.activeHandle = null;
    this.clearTransformState();
    this.drawUI();
  }

  handleCancel(): void {
    this.isDragging = false;
    this.dragStartPoint = null;
    this.marqueeStartPoint = null;
    this.marqueeCurrentPoint = null;
    this.lassoPoints = [];
    this.activeHandle = null;
    this.clearTransformState();
    this.drawUI();
  }

  drawUI(): void {
    this.chromeOverlay.clear();

    if (this.hasSelection()) {
      let rotating:
        | { cursor: Point; pivot: Point }
        | null = null;
      if (
        this.isDragging &&
        this.activeHandle === "rotate" &&
        this.lastViewportPoint &&
        this.rotateCenterWorld
      ) {
        const pivot = this.camera.worldToScreen(
          this.rotateCenterWorld.x,
          this.rotateCenterWorld.y,
        );
        rotating = { cursor: this.lastViewportPoint, pivot };
      }
      this.handles = this.paperRenderer.drawSelection(
        this.selectedItems,
        this.chromeCtx,
        rotating,
      );
    } else {
      this.handles = [];
    }

    if (this.marqueeStartPoint && this.marqueeCurrentPoint) {
      if (this.selectionShape === "lasso") {
        this.drawLassoPreview(this.lassoPoints);
      } else {
        this.drawMarqueeRect(this.marqueeStartPoint, this.marqueeCurrentPoint);
      }
    }
  }

  // ============================================================
  // Private: Handle hit testing
  // ============================================================

  private hitTestHandle(viewportPoint: Point): SelectionHandleId | null {
    const hitRadiusSq = 12 * 12;

    for (const handle of this.handles) {
      const dx = viewportPoint.x - handle.x;
      const dy = viewportPoint.y - handle.y;
      if (dx * dx + dy * dy <= hitRadiusSq) {
        return handle.id;
      }
    }
    return null;
  }

  // ============================================================
  // Private: Transform initialization
  // ============================================================

  private initTransform(
    handle: SelectionHandleId,
    viewportPoint: Point,
  ): void {
    const b = this.paperRenderer.getSelectionFrameScreenBounds(
      this.selectedItems,
    );
    if (!b) return;

    if (handle === "rotate") {
      // Rotation pivot: the item's own position for single selections (so the
      // rotation feedback line springs from the true rotation point, not the
      // bbox center), else the combined world-bounds center for multi-select.
      let pivotWorld: Point;
      if (this.selectedItems.length === 1) {
        const pos = this.selectedItems[0].position;
        pivotWorld = { x: pos.x, y: pos.y };
      } else {
        const wb = this.paperRenderer.getCombinedBounds(this.selectedItems);
        if (!wb) return;
        pivotWorld = { x: wb.x + wb.width / 2, y: wb.y + wb.height / 2 };
      }
      this.rotateCenterWorld = pivotWorld;

      const screenPivot = this.camera.worldToScreen(pivotWorld.x, pivotWorld.y);
      this.rotateStartAngle = Math.atan2(
        viewportPoint.y - screenPivot.y,
        viewportPoint.x - screenPivot.x,
      );
      this.lastTotalRotation = 0;
    } else {
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
  }

  // ============================================================
  // Private: Move handlers for each transform mode
  // ============================================================

  private handleTranslateMove(viewportPoint: Point): void {
    const screenDelta = {
      x: viewportPoint.x - this.dragStartPoint!.x,
      y: viewportPoint.y - this.dragStartPoint!.y,
    };

    const worldDelta = this.camera.screenDeltaToWorld(
      screenDelta.x,
      screenDelta.y,
    );

    if (worldDelta.x !== 0 || worldDelta.y !== 0) {
      this.didMove = true;
      for (const item of this.selectedItems) {
        this.paperRenderer.movePath(item, worldDelta);
      }
      this.dragStartPoint = viewportPoint;
    }
  }

  private handleResizeMove(viewportPoint: Point): void {
    if (
      !this.hasSelection() ||
      !this.transformAnchorScreen ||
      !this.transformAnchorWorld ||
      !this.originalCornerScreen
    )
      return;

    // Work entirely in screen space for the scale-factor math so dragging a
    // handle rightward on screen always produces horizontal scaling regardless
    // of camera rotation. The item transform is then applied in view-aligned
    // axes around the fixed world anchor.
    const anchor = this.transformAnchorScreen;
    const origCorner = this.originalCornerScreen;

    const isEdgeX = this.activeHandle === "e" || this.activeHandle === "w";
    const isEdgeY = this.activeHandle === "n" || this.activeHandle === "s";

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
      this.didMove = true;
      const worldAnchor = this.transformAnchorWorld;
      for (const item of this.selectedItems) {
        this.paperRenderer.scalePathInViewSpace(
          item,
          incSX,
          incSY,
          worldAnchor,
        );
      }
      this.lastTotalScaleX = desiredSX;
      this.lastTotalScaleY = desiredSY;
    }
  }

  private handleRotateMove(viewportPoint: Point): void {
    if (!this.hasSelection() || !this.rotateCenterWorld) return;

    const screenCenter = this.camera.worldToScreen(
      this.rotateCenterWorld.x,
      this.rotateCenterWorld.y,
    );
    const currentAngle = Math.atan2(
      viewportPoint.y - screenCenter.y,
      viewportPoint.x - screenCenter.x,
    );
    const desiredRotation = currentAngle - this.rotateStartAngle;
    const incrementalRotation = desiredRotation - this.lastTotalRotation;

    if (Math.abs(incrementalRotation) > 0.0001) {
      this.didMove = true;
      const degrees = (incrementalRotation * 180) / Math.PI;
      for (const item of this.selectedItems) {
        this.paperRenderer.rotatePath(item, degrees, this.rotateCenterWorld);
      }
      this.lastTotalRotation = desiredRotation;
    }
  }

  // ============================================================
  // Private: Utilities
  // ============================================================

  private clearTransformState(): void {
    this.transformAnchorScreen = null;
    this.transformAnchorWorld = null;
    this.originalCornerScreen = null;
    this.lastTotalScaleX = 1;
    this.lastTotalScaleY = 1;
    this.rotateStartAngle = 0;
    this.lastTotalRotation = 0;
    this.rotateCenterWorld = null;
    this.lastViewportPoint = null;
  }

  private startMarquee(viewportPoint: Point): void {
    this.isDragging = false;
    this.dragStartPoint = null;
    this.activeHandle = null;
    this.marqueeStartPoint = viewportPoint;
    this.marqueeCurrentPoint = viewportPoint;
    this.lassoPoints = [viewportPoint];
    this.clearTransformState();
  }

  private isSelectedItem(item: paper.Item): boolean {
    return this.selectedItems.some((selected) => selected.id === item.id);
  }

  private bringSelectionToFront(): void {
    for (const item of this.selectedItems) {
      this.paperRenderer.bringToFront(item);
    }
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

  private hasActiveMarquee(): boolean {
    if (this.selectionShape === "lasso") {
      if (this.lassoPoints.length < 2) return false;
      const first = this.lassoPoints[0];
      const last = this.lassoPoints[this.lassoPoints.length - 1];
      const dx = last.x - first.x;
      const dy = last.y - first.y;
      return dx * dx + dy * dy >= this.marqueeDragThresholdPx * this.marqueeDragThresholdPx;
    }

    if (!this.marqueeStartPoint || !this.marqueeCurrentPoint) return false;
    const dx = this.marqueeCurrentPoint.x - this.marqueeStartPoint.x;
    const dy = this.marqueeCurrentPoint.y - this.marqueeStartPoint.y;
    return dx * dx + dy * dy >= this.marqueeDragThresholdPx * this.marqueeDragThresholdPx;
  }

  private pixelToViewport(point: Point): Point {
    return {
      x: (point.x / this.config.pixelWidth) * this.config.viewportWidth,
      y: (point.y / this.config.pixelHeight) * this.config.viewportHeight,
    };
  }
}
