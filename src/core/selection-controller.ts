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
import type { UIOverlay } from "./ui-overlay";
import { configStore, toolSettingsStore } from "./stores";

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
  private uiOverlay: UIOverlay;
  private uiCanvas2D: CanvasRenderingContext2D;

  // Transform handle state
  private activeHandle: SelectionHandleId | null = null;
  private handles: SelectionHandle[] = [];
  private marqueeStartPoint: Point | null = null;
  private marqueeCurrentPoint: Point | null = null;
  private lassoPoints: Point[] = [];

  // Resize state
  private transformAnchorWorld: Point | null = null;
  private originalCornerWorld: Point | null = null;
  private lastTotalScaleX = 1;
  private lastTotalScaleY = 1;

  // Rotate state
  private rotateStartAngle = 0;
  private lastTotalRotation = 0;
  private rotateCenterWorld: Point | null = null;

  // Current cursor in viewport space (for rotation visual feedback)
  private lastViewportPoint: Point | null = null;

  constructor(
    paperRenderer: PaperRenderer,
    camera: Camera,
    uiOverlay: UIOverlay,
    uiCanvas2D: CanvasRenderingContext2D,
  ) {
    this.paperRenderer = paperRenderer;
    this.camera = camera;
    this.uiOverlay = uiOverlay;
    this.uiCanvas2D = uiCanvas2D;
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
      } else {
        this.selectedItems = [];
        this.selectionNeedsPlacement = false;
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
    this.uiOverlay.redraw();

    if (this.hasSelection()) {
      const rotatingCursor =
        this.isDragging && this.activeHandle === "rotate"
          ? this.lastViewportPoint
          : null;
      this.handles = this.paperRenderer.drawSelection(
        this.selectedItems,
        this.uiCanvas2D,
        rotatingCursor,
      );
    } else {
      this.handles = [];
    }

    if (this.hasActiveMarquee() && this.marqueeStartPoint && this.marqueeCurrentPoint) {
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
    const b = this.paperRenderer.getCombinedBounds(this.selectedItems);
    if (!b) return;

    if (handle === "rotate") {
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      this.rotateCenterWorld = { x: cx, y: cy };

      const screenCenter = this.camera.worldToScreen(cx, cy);
      this.rotateStartAngle = Math.atan2(
        viewportPoint.y - screenCenter.y,
        viewportPoint.x - screenCenter.x,
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

      this.originalCornerWorld = corners[handle];
      this.transformAnchorWorld = corners[opposites[handle]];
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
      !this.transformAnchorWorld ||
      !this.originalCornerWorld
    )
      return;

    const worldPoint = this.camera.screenToWorld(
      viewportPoint.x,
      viewportPoint.y,
    );
    const anchor = this.transformAnchorWorld;
    const origCorner = this.originalCornerWorld;

    const isEdgeX = this.activeHandle === "e" || this.activeHandle === "w";
    const isEdgeY = this.activeHandle === "n" || this.activeHandle === "s";

    let desiredSX = this.lastTotalScaleX;
    let desiredSY = this.lastTotalScaleY;

    const dxOrig = origCorner.x - anchor.x;
    const dyOrig = origCorner.y - anchor.y;

    if (!isEdgeY && Math.abs(dxOrig) > 0.001) {
      desiredSX = (worldPoint.x - anchor.x) / dxOrig;
    }
    if (!isEdgeX && Math.abs(dyOrig) > 0.001) {
      desiredSY = (worldPoint.y - anchor.y) / dyOrig;
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
      for (const item of this.selectedItems) {
        this.paperRenderer.scalePath(item, incSX, incSY, anchor);
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
    this.transformAnchorWorld = null;
    this.originalCornerWorld = null;
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

    this.uiCanvas2D.save();
    this.uiCanvas2D.fillStyle = "rgba(255, 153, 0, 0.12)";
    this.uiCanvas2D.strokeStyle = "#ff9900";
    this.uiCanvas2D.lineWidth = 1.5;
    this.uiCanvas2D.setLineDash([6, 4]);
    this.uiCanvas2D.fillRect(x, y, width, height);
    this.uiCanvas2D.strokeRect(x, y, width, height);
    this.uiCanvas2D.restore();
  }

  private drawLassoPreview(points: Point[]): void {
    if (points.length < 2) return;

    this.uiCanvas2D.save();
    this.uiCanvas2D.fillStyle = "rgba(255, 153, 0, 0.12)";
    this.uiCanvas2D.strokeStyle = "#ff9900";
    this.uiCanvas2D.lineWidth = 1.5;
    this.uiCanvas2D.setLineDash([6, 4]);
    this.uiCanvas2D.beginPath();
    this.uiCanvas2D.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      this.uiCanvas2D.lineTo(points[i].x, points[i].y);
    }
    this.uiCanvas2D.closePath();
    this.uiCanvas2D.fill();
    this.uiCanvas2D.stroke();
    this.uiCanvas2D.restore();
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
