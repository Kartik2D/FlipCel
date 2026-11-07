/**
 * Selection Controller (object select).
 *
 * Click a face or symbol instance to lift it out of the kernel into the
 * renderer's floating selection; drag marquees (rect / lasso) lift every
 * face inside. Dragging a selected item moves it; handles scale / rotate.
 * Releasing or switching tools stamps the selection back (`placeSelection`).
 * Touch drag before the gesture starts pans.
 */
import type { Point, CanvasConfig } from "../geometry/types";
import type {
  StageRenderer,
  SelectLayerScope,
  SelectionHandleId,
  SelectionHandle,
} from "../render/stage-renderer";
import type { Camera } from "../render/camera";
import type { ChromeLayer } from "../render/chrome-layer";
import { scheduler, Surface } from "../render/frame-scheduler";
import {
  configStore,
  toolSettingsStore,
  selectionStore,
  quickShapeEnabledStore,
  quickShapeCurveStyleStore,
  quickShapeShapesEnabledStore,
  quickShapeHoldMsStore,
  modifiersStore,
} from "../state/index";
import { pixelToViewport } from "../geometry/coords";
import { LassoQuickShapeSession } from "../geometry/quick-shape";
import { MarqueeTracker } from "./marquee";
import {
  isAddToSelectionModifierHeld,
  isConstrainMoveModifierHeld,
  isConstrainScaleModifierHeld,
} from "../input/shortcuts";
import {
  TransformGizmoController,
  constrainAxisScreenDelta,
} from "./transform-gizmo";
import {
  snapLockFromConstrain,
  snapScreenPoint,
  snapWorldTranslation,
  sourcesFromBounds,
  offsetPoints,
  setSnapGuides,
  type SnapGuide,
  type SnapSource,
} from "./snap";
import {
  invertAffine,
  mulAffine,
  rotateAbout,
  scaleAbout,
  translation,
  type Affine,
  type Px,
} from "../vector/kernel";
import type { PlacedInstance } from "../vector/content";

/** Publish the renderer's floating selection to the shared store. */
export function publishSelection(renderer: StageRenderer): void {
  const parts = renderer.getSelection();
  const instances = renderer.selectionInstances();
  selectionStore.set({
    count: parts.reduce((n, p) => n + (p.base.isEmpty() ? 0 : 1), 0) + instances.length,
    hasShapes: parts.some((p) => !p.base.isEmpty()),
    instances,
    layerIds: [...new Set(parts.map((p) => p.layerId))],
  });
}

export class SelectionController {
  /** Ignore sub-pixel jitter: only count drags after this many viewport px from pointer-down. */
  private readonly dragMoveThresholdSq = 5 * 5;
  private dragPointerOrigin: Point | null = null;
  private dragPastThreshold = false;

  /** Last click that selected a symbol instance; a second press enters it. */
  private lastShapeClick: { timestampMs: number; point: Point; iid: string } | null = null;
  private readonly doubleClickWindowMs = 350;
  private readonly doubleClickDistanceSq = 6 * 6;

  private selectionShape: "rect" | "lasso" = "rect";
  private layerScope: SelectLayerScope = "all";
  private hideGizmoWhileMoving = false;
  private lassoQuickShape = new LassoQuickShapeSession();
  private isDragging = false;
  private dragStartPoint: Point | null = null;
  private lastAppliedWorld: Point = { x: 0, y: 0 };
  private snapSources: SnapSource | null = null;
  private snapGuides: SnapGuide[] = [];
  private didMove = false;
  private config: CanvasConfig;
  private onSnapshot?: () => void;
  private onLiveEditStart?: () => void;
  private onActivateLayer?: (layerId: string) => void;
  private onEnterInstance?: (instance: PlacedInstance, worldMatrix: Affine, layerId: string) => void;

  private renderer: StageRenderer;
  private camera: Camera;
  private chromeLayer: ChromeLayer;
  private chromeCtx: CanvasRenderingContext2D;

  private handles: SelectionHandle[] = [];
  private marquee = new MarqueeTracker();
  private transformGizmo: TransformGizmoController;
  private pivotDragging = false;
  private lastViewportPoint: Point | null = null;

  constructor(renderer: StageRenderer, camera: Camera, chromeLayer: ChromeLayer) {
    this.renderer = renderer;
    this.camera = camera;
    this.chromeLayer = chromeLayer;
    this.chromeCtx = chromeLayer.getContext();
    this.transformGizmo = new TransformGizmoController({
      getScreenBounds: () => this.renderer.selectionScreenBounds(),
      getRotatePivotWorld: () => this.renderer.selectionPivotWorld(),
      applyScale: (incSX, incSY, worldAnchor) => {
        this.renderer.transformSelection(this.viewScale(incSX, incSY, worldAnchor));
      },
      applyRotate: (degrees, worldPivot) => {
        this.renderer.transformSelection(rotateAbout(degrees, worldPivot));
      },
    });
    this.config = configStore.get();
    configStore.subscribe((config) => {
      this.config = config;
    });
    const applySelectSettings = () => {
      const selectSettings = toolSettingsStore.get().select as {
        shape?: unknown;
        scope?: unknown;
        hideGizmoWhileMoving?: unknown;
      };
      this.selectionShape = selectSettings.shape === "lasso" ? "lasso" : "rect";
      this.layerScope = selectSettings.scope === "active" ? "active" : "all";
      this.hideGizmoWhileMoving = selectSettings.hideGizmoWhileMoving === "on";
      this.syncLassoQuickShapePrefs();
    };
    applySelectSettings();
    toolSettingsStore.subscribe(() => applySelectSettings());
    quickShapeEnabledStore.subscribe(() => this.syncLassoQuickShapePrefs());
    quickShapeCurveStyleStore.subscribe(() => this.syncLassoQuickShapePrefs());
    quickShapeShapesEnabledStore.subscribe(() => this.syncLassoQuickShapePrefs());
    quickShapeHoldMsStore.subscribe(() => this.syncLassoQuickShapePrefs());
  }

  /** Scale about a world anchor along the *screen* axes (camera may be rotated). */
  private viewScale(sx: number, sy: number, worldAnchor: Px): Affine {
    const cam = this.camera.getTransformMatrix();
    const anchorScreen = this.camera.worldToScreen(worldAnchor.x, worldAnchor.y);
    const inScreen = scaleAbout(sx, sy, anchorScreen);
    return mulAffine(invertAffine(cam), mulAffine(inScreen, cam));
  }

  private syncLassoQuickShapePrefs(): void {
    this.lassoQuickShape.setEnabled(quickShapeEnabledStore.get() && this.selectionShape === "lasso");
    this.lassoQuickShape.setCurveStyle(quickShapeCurveStyleStore.get());
    this.lassoQuickShape.setAllowShapes(quickShapeShapesEnabledStore.get());
    this.lassoQuickShape.setHoldMs(quickShapeHoldMsStore.get());
  }

  setSnapshotCallback(callback: () => void): void {
    this.onSnapshot = callback;
  }

  /** Fired once when a selection first diverges from committed content (move/transform). */
  setLiveEditStartCallback(callback: () => void): void {
    this.onLiveEditStart = callback;
  }

  setActivateLayerCallback(callback: (layerId: string) => void): void {
    this.onActivateLayer = callback;
  }

  /** Double-tap on a selected symbol instance (edit in place). */
  setEnterInstanceCallback(
    callback: (instance: PlacedInstance, worldMatrix: Affine, layerId: string) => void,
  ): void {
    this.onEnterInstance = callback;
  }

  hasSelection(): boolean {
    return this.renderer.hasSelection();
  }

  hasTransientUI(): boolean {
    return this.hasSelection() || this.marquee.isTracking();
  }

  getLayerScope(): SelectLayerScope {
    return this.layerScope;
  }

  /** Lift everything on selectable layers. */
  selectAll(): void {
    this.placeSelection();
    this.renderer.liftAll(this.layerScope);
    this.afterSelectionChanged();
  }

  /** Select by world point (programmatic; used by contextual actions). */
  selectAtWorld(world: Px): boolean {
    this.placeSelection();
    const hit = this.renderer.liftAt(world, this.layerScope);
    this.afterSelectionChanged();
    return !!hit;
  }

  /** Clone the current selection and select the clones. */
  duplicateSelection(offsetX: number, offsetY: number): boolean {
    if (!this.hasSelection()) return false;
    if (this.didMove) this.onSnapshot?.();
    this.renderer.duplicateSelection(offsetX, offsetY);
    this.didMove = false;
    this.noteLiveEditStarted();
    this.afterSelectionChanged();
    return true;
  }

  /** Mirror the selection about its screen-space center. */
  flipSelection(axis: "horizontal" | "vertical"): void {
    const b = this.renderer.selectionBounds();
    if (!b) return;
    const center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const m = axis === "horizontal" ? this.viewScale(-1, 1, center) : this.viewScale(1, -1, center);
    this.renderer.transformSelection(m);
    this.markSelectionAsModified();
  }

  /** Stamp the selection back; snapshot history if it moved. */
  placeSelection(): void {
    if (this.hasSelection()) {
      this.renderer.placeSelection();
      if (this.didMove) this.onSnapshot?.();
    }
    this.didMove = false;
    this.handles = [];
    publishSelection(this.renderer);
  }

  /** Always place (never revert), then clear drag/gizmo chrome. */
  confirmAndClearSelection(): void {
    this.placeSelection();
    this.resetGesture();
    this.drawUI();
  }

  clearSelection(): void {
    this.placeSelection();
    this.resetGesture();
    this.drawUI();
  }

  /** Delete the selection outright. */
  deleteSelection(): boolean {
    if (!this.hasSelection()) return false;
    this.renderer.deleteSelection();
    this.didMove = false;
    this.resetGesture();
    publishSelection(this.renderer);
    this.drawUI();
    this.onSnapshot?.();
    return true;
  }

  discardSelection(): void {
    // Content already reloaded by the document: drop floating state.
    if (this.hasSelection()) this.renderer.placeSelection();
    this.didMove = false;
    this.resetGesture();
    this.lastShapeClick = null;
    publishSelection(this.renderer);
    this.drawUI();
  }

  /** Block marquee revert during a live edit. Does not republish or redraw. */
  pinLiveEdit(): void {
    if (!this.hasSelection()) return;
    this.noteLiveEditStarted();
  }

  markSelectionAsModified(): void {
    if (!this.hasSelection()) return;
    this.noteLiveEditStarted();
    publishSelection(this.renderer);
    this.drawUI();
  }

  releasePendingExtraction(): void {
    // No pending-extraction state with kernel lifts.
  }

  private resetGesture(): void {
    this.isDragging = false;
    this.dragStartPoint = null;
    this.resetDragThreshold();
    this.lassoQuickShape.reset();
    this.marquee.reset();
    this.clearTransformState();
  }

  private afterSelectionChanged(): void {
    this.handles = [];
    publishSelection(this.renderer);
    this.drawUI();
  }

  handleStart(point: Point): void {
    const viewportPoint = pixelToViewport(point, this.config);
    const world = this.camera.screenToWorld(viewportPoint.x, viewportPoint.y);

    if (this.hasSelection() && this.handles.length > 0) {
      const hitHandle = this.hitTestHandle(viewportPoint);
      if (hitHandle === "pivot") {
        this.lastShapeClick = null;
        this.pivotDragging = true;
        this.isDragging = true;
        this.dragStartPoint = viewportPoint;
        this.beginDragThreshold(viewportPoint);
        this.didMove = false;
        return;
      }
      if (hitHandle && this.transformGizmo.begin(hitHandle, viewportPoint, this.camera)) {
        this.lastShapeClick = null;
        this.isDragging = true;
        this.dragStartPoint = viewportPoint;
        this.beginDragThreshold(viewportPoint);
        this.didMove = false;
        return;
      }
    }

    // Already-selected shape: click-drag moves the selection.
    if (this.hasSelection() && this.renderer.selectionContains(world)) {
      const single = this.renderer.singleSelectedInstance();
      if (single && this.onEnterInstance) {
        const now = performance.now();
        if (this.isDoubleClickOnShape(viewportPoint, single.instance.iid, now)) {
          this.lastShapeClick = null;
          const m = mulAffine(single.part.xf, single.instance.matrix);
          const layerId = single.part.layerId;
          this.onEnterInstance(single.instance, m, layerId);
          return;
        }
        this.lastShapeClick = { timestampMs: now, point: { ...viewportPoint }, iid: single.instance.iid };
      } else {
        this.lastShapeClick = null;
      }
      this.isDragging = true;
      this.dragStartPoint = viewportPoint;
      this.beginDragThreshold(viewportPoint);
      this.didMove = false;
      this.drawUI();
      return;
    }

    // Press on empty space or an unselected shape: marquee until release.
    // A tap (no drag) selects on pointer-up. A drag stays a marquee.
    this.startMarquee(viewportPoint);
    this.drawUI();
  }

  handleMove(point: Point): void {
    const viewportPoint = pixelToViewport(point, this.config);
    this.lastViewportPoint = viewportPoint;

    if (this.marquee.isTracking()) {
      if (this.selectionShape === "lasso") {
        const mode = this.lassoQuickShape.noteMove(viewportPoint);
        if (mode === "adjust") {
          const path = this.lassoQuickShape.getPath();
          if (path) this.marquee.setLassoPoints(path);
          this.drawUI();
          return;
        }
      }
      this.marquee.update(
        viewportPoint,
        this.selectionShape,
        isConstrainScaleModifierHeld(modifiersStore.get()),
      );
      this.drawUI();
      return;
    }

    if (!this.isDragging || !this.hasSelection() || !this.dragStartPoint) return;

    // Nothing changes until the pointer leaves the drag threshold.
    if (!this.pastDragThreshold(viewportPoint)) return;

    if (this.pivotDragging) {
      const snapped = snapScreenPoint(viewportPoint, this.camera, this.renderer, undefined, [], false);
      this.snapGuides = snapped.guides;
      const world = this.camera.screenToWorld(snapped.screen.x, snapped.screen.y);
      this.renderer.setInstancePivotWorld(world);
      this.noteLiveEditStarted();
    } else if (this.transformGizmo.isTransforming()) {
      let vp = viewportPoint;
      if (this.transformGizmo.getActiveHandle() !== "rotate") {
        const snapped = snapScreenPoint(viewportPoint, this.camera, this.renderer, undefined, [], false);
        vp = snapped.screen;
        this.snapGuides = snapped.guides;
      } else {
        this.snapGuides = [];
      }
      if (this.transformGizmo.update(vp, this.camera)) this.noteLiveEditStarted();
    } else {
      this.handleTranslateMove(viewportPoint);
    }

    setSnapGuides(this.snapGuides);
    this.drawUI();
  }

  handleEnd(): void {
    if (this.marquee.isTracking()) {
      const marqueeStartPoint = this.marquee.getStartPoint();
      const marqueeCurrentPoint = this.marquee.getCurrentPoint();
      const lassoPoints = this.marquee.getLassoPoints();
      if (!marqueeStartPoint || !marqueeCurrentPoint) {
        this.lassoQuickShape.reset();
        this.marquee.reset();
        this.drawUI();
        return;
      }
      const add = isAddToSelectionModifierHeld(modifiersStore.get());
      if (this.hasActiveMarquee()) {
        if (!add) this.placeSelection();
        else if (this.didMove) {
          // Commit the moved selection, then keep lifting into it.
          this.onSnapshot?.();
          this.didMove = false;
        }
        const toWorld = (p: Point) => this.camera.screenToWorld(p.x, p.y);
        if (this.selectionShape === "lasso") {
          const poly = lassoPoints.map(toWorld);
          if (poly.length >= 3) this.renderer.liftInPolygon(poly, this.layerScope);
        } else {
          const a = toWorld(marqueeStartPoint);
          const b = toWorld(marqueeCurrentPoint);
          const c = toWorld({ x: marqueeCurrentPoint.x, y: marqueeStartPoint.y });
          const d = toWorld({ x: marqueeStartPoint.x, y: marqueeCurrentPoint.y });
          this.renderer.liftInPolygon([a, c, b, d], this.layerScope);
        }
        if (this.layerScope === "all") this.activateTopmostSelectedLayer();
        publishSelection(this.renderer);
      } else {
        // Tap: select the shape or symbol under the pointer. Empty space deselects.
        const world = this.camera.screenToWorld(marqueeStartPoint.x, marqueeStartPoint.y);
        this.lassoQuickShape.reset();
        this.marquee.reset();
        this.isDragging = false;
        this.dragStartPoint = null;
        this.resetDragThreshold();
        this.clearTransformState();
        const probe = this.renderer.hitTest(world, this.layerScope);
        if (probe) {
          if (!add) this.placeSelection();
          else if (this.didMove) {
            this.onSnapshot?.();
            this.didMove = false;
          }
          const hit = this.renderer.liftAt(world, this.layerScope);
          if (hit) this.onActivateLayer?.(hit.layerId);
          if (hit?.instance && this.onEnterInstance) {
            this.lastShapeClick = {
              timestampMs: performance.now(),
              point: { ...marqueeStartPoint },
              iid: hit.instance.iid,
            };
          } else {
            this.lastShapeClick = null;
          }
          this.handles = [];
          publishSelection(this.renderer);
          this.drawUI();
        } else if (!add) {
          this.clearSelection();
        } else {
          this.drawUI();
        }
        return;
      }
      this.lassoQuickShape.reset();
      this.marquee.reset();
      this.isDragging = false;
      this.dragStartPoint = null;
      this.resetDragThreshold();
      this.clearTransformState();
      this.drawUI();
      return;
    }

    this.isDragging = false;
    this.dragStartPoint = null;
    this.resetDragThreshold();
    this.clearTransformState();
    this.drawUI();
  }

  handleCancel(): void {
    this.resetGesture();
    this.drawUI();
  }

  /** Mark the chrome surface dirty; `paintUI` runs once on the next frame. */
  drawUI(): void {
    scheduler.invalidate(Surface.CHROME);
  }

  /**
   * Paint the selection chrome onto the (already cleared) chrome canvas.
   * Called by the frame scheduler's CHROME painter, never directly.
   */
  paintUI(): void {
    if (this.hasSelection() && !this.marquee.isTracking()) {
      const hideChrome =
        this.hideGizmoWhileMoving &&
        this.isDragging &&
        (this.didMove || this.transformGizmo.isTransforming());
      if (hideChrome) {
        this.handles = [];
        const ui = document.getElementById("ui-canvas");
        if (ui) ui.style.cursor = "none";
      } else {
        const rotating = this.transformGizmo.getRotationOverlay(this.camera, this.lastViewportPoint);
        this.handles = this.renderer.drawSelection(this.chromeCtx, rotating);
      }
    } else {
      this.handles = [];
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
  }

  // ------------------------------------------------------------
  // Private
  // ------------------------------------------------------------

  private hitTestHandle(viewportPoint: Point): SelectionHandleId | null {
    const hitRadiusSq = 12 * 12;
    for (const handle of this.handles) {
      const dx = viewportPoint.x - handle.x;
      const dy = viewportPoint.y - handle.y;
      if (dx * dx + dy * dy <= hitRadiusSq) return handle.id;
    }
    return null;
  }

  private handleTranslateMove(viewportPoint: Point): void {
    const origin = this.dragPointerOrigin ?? this.dragStartPoint;
    if (!origin) return;

    const total = { x: viewportPoint.x - origin.x, y: viewportPoint.y - origin.y };
    const constrain = isConstrainMoveModifierHeld(modifiersStore.get());
    const constrained = constrainAxisScreenDelta(total.x, total.y, constrain);
    const desired = this.camera.screenDeltaToWorld(constrained.x, constrained.y);
    const sources = this.snapSources ?? { xs: [], ys: [], points: [] };
    const snapped = snapWorldTranslation(
      sources,
      desired,
      this.camera,
      this.renderer,
      snapLockFromConstrain(constrained, constrain),
      offsetPoints(sources.points, this.lastAppliedWorld),
      false,
    );
    this.snapGuides = snapped.guides;

    const apply = { x: snapped.dx - this.lastAppliedWorld.x, y: snapped.dy - this.lastAppliedWorld.y };
    if (apply.x !== 0 || apply.y !== 0) {
      this.renderer.transformSelection(translation(apply.x, apply.y));
      this.lastAppliedWorld = { x: snapped.dx, y: snapped.dy };
      this.dragStartPoint = viewportPoint;
      this.noteLiveEditStarted();
    }
  }

  private captureSnapSources(): void {
    const bounds = this.renderer.selectionBounds();
    this.snapSources = bounds ? sourcesFromBounds(bounds) : { xs: [], ys: [], points: [] };
  }

  /** Mark the selection as dirty and refresh onion once on the first edit. */
  private noteLiveEditStarted(): void {
    if (this.didMove) return;
    this.didMove = true;
    this.onLiveEditStart?.();
  }

  private clearTransformState(): void {
    this.transformGizmo.reset();
    this.pivotDragging = false;
    this.lastViewportPoint = null;
  }

  private beginDragThreshold(viewportPoint: Point): void {
    this.dragPointerOrigin = viewportPoint;
    this.dragPastThreshold = false;
    this.captureSnapSources();
    this.lastAppliedWorld = { x: 0, y: 0 };
    this.snapGuides = [];
  }

  private resetDragThreshold(): void {
    this.dragPointerOrigin = null;
    this.dragPastThreshold = false;
    this.lastAppliedWorld = { x: 0, y: 0 };
    this.snapSources = null;
    this.snapGuides = [];
    setSnapGuides([]);
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

  private startMarquee(viewportPoint: Point): void {
    this.isDragging = false;
    this.dragStartPoint = null;
    this.marquee.start(viewportPoint);
    this.clearTransformState();
    if (this.selectionShape === "lasso") {
      this.syncLassoQuickShapePrefs();
      this.lassoQuickShape.begin(
        viewportPoint,
        () => this.marquee.getLassoPoints(),
        (path) => {
          this.marquee.setLassoPoints(path);
          this.drawUI();
        },
      );
    } else {
      this.lassoQuickShape.reset();
    }
  }

  private isDoubleClickOnShape(viewportPoint: Point, iid: string, nowMs: number): boolean {
    const last = this.lastShapeClick;
    if (!last || last.iid !== iid) return false;
    if (nowMs - last.timestampMs > this.doubleClickWindowMs) return false;
    const dx = viewportPoint.x - last.point.x;
    const dy = viewportPoint.y - last.point.y;
    return dx * dx + dy * dy <= this.doubleClickDistanceSq;
  }

  private activateTopmostSelectedLayer(): void {
    const ids = this.renderer.getSelectionLayerIds();
    if (ids.length === 0) return;
    const order = this.renderer.getLayerIds();
    let best: string | null = null;
    for (const id of ids) {
      if (best === null || order.indexOf(id) > order.indexOf(best)) best = id;
    }
    if (best) this.onActivateLayer?.(best);
  }

  private hasActiveMarquee(): boolean {
    return this.marquee.hasActiveMarquee(this.selectionShape);
  }
}
