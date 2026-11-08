/**
 * Tool gesture lifecycle (start → move → end / cancel).
 *
 * Extracted from App so bootstrap stays focused on wiring; behavior is unchanged.
 */
import type { Camera } from "../render/camera";
import type { FeedbackLayer } from "../render/feedback-layer";
import type { StageRenderer } from "../render/stage-renderer";
import type { PixelCanvas } from "../tools/pixel-canvas";
import type { Tracer } from "../tracing/potrace-tracer";
import type { SelectionController } from "../editing/object-select";
import type { DirectSelectController } from "../editing/direct-select";
import type { CreatePointsController } from "../editing/create-points";
import type { ArtisticTextController } from "../editing/artistic-text";
import type { MagnetController } from "../editing/magnet";
import type { MagicMoveController } from "../editing/magic-move";
import type { MagicMorphController } from "../editing/magic-morph";
import type { HistoryManager } from "../document/history";
import type { DocumentManager } from "../document/document";
import type { CanvasConfig, Point } from "../geometry/types";
import type { ToolId } from "../tools/registry";
import { pixelToViewport, viewportToPixel } from "../geometry/coords";
import { setSnapGuides, snapWorldPoint, type SnapGuide } from "../editing/snap";
import {
  adjustQuickShape,
  quickShapeAdjustPivot,
  recognizeQuickShape,
  resampleWithPressure,
  QUICK_SHAPE_SLOP_PX,
  type QuickShapeResult,
} from "../geometry/quick-shape";
import {
  colorStore,
  modifiersStore,
  toolSettingsStore,
  stageSelectedStore,
  symmetryStore,
  normalizeSymmetrySettings,
  layerStore,
  isLayerDrawable,
  quickShapeEnabledStore,
  quickShapeCurveStyleStore,
  quickShapeShapesEnabledStore,
  quickShapeHoldMsStore,
  paintSizeScale,
} from "../state/index";
import {
  hitTestSymmetryHandle,
  setSymmetryGestureSource,
} from "../geometry/symmetry";
import { isPaintModeModifierHeld, isConstrainScaleModifierHeld } from "../input/shortcuts";
import { stampBrushStroke } from "../tools/brush";
import { replaceLassoStroke } from "../tools/lasso";
import { buildPrimitiveShape, isShapeKind } from "../tools/shape";
import { clampStrokeWidth } from "../tools/paint-mode";
import { fillAt } from "../editing/fill-region";
import { simplifyRings } from "../editing/direct-select/fit-curve";
import { commitPaint, pixelToWorldAffine, tracedSvgToWorldRings, viewportToWorldAffine, worldRings } from "../vector/paint";
import type { Px } from "../vector/kernel";

interface PixelQuickShapeState {
  tool: "brush" | "lasso";
  /** Freehand stroke captured at snap time (for pressure remap). */
  originalPoints: Point[];
  /** Recognition result at identity transform. */
  base: QuickShapeResult;
  /** Latest adjusted result. */
  result: QuickShapeResult;
  /** Stroke start — scale/rotate pivot. */
  pivot: Point;
  /** Pointer position when snap fired (reference tip). */
  adjustOrigin: Point;
}

export interface ToolSessionDeps {
  getConfig: () => CanvasConfig;
  getPixelCanvas: () => HTMLCanvasElement;
  camera: Camera;
  documentManager: DocumentManager;
  selectionController: SelectionController;
  directSelectController: DirectSelectController;
  createPointsController: CreatePointsController;
  artisticTextController: ArtisticTextController;
  magnetController: MagnetController;
  magicMoveController: MagicMoveController;
  magicMorphController: MagicMorphController;
  renderer: StageRenderer;
  pixelCanvasManager: PixelCanvas;
  feedbackLayer: FeedbackLayer;
  tracer: Tracer;
  historyManager: HistoryManager;
  /** Shared with App UI (functions panel gating during select gestures). */
  setSelectionGestureActive: (active: boolean) => void;
  setFunctionsPanelDismissed: (dismissed: boolean) => void;
  updateFunctionsPanel: () => void;
  pickColorAt: (point: Point) => void;
  closeFunctionsPanelHidden: () => void;
}

export class ToolSession {
  private readonly deps: ToolSessionDeps;
  /** Inside mode only: world point of the face to clip to, or null for "paint behind". */
  private insideClipForStroke: Px | null | undefined = undefined;
  /** True while dragging the symmetry-axis origin handle. */
  private symmetryHandleDragging = false;
  /** True between an accepted pixel-tool start and its end. */
  private pixelGestureActive = false;

  /** Active brush/lasso gesture eligible for Quick Shape. */
  private pixelDrawingTool: "brush" | "lasso" | null = null;
  private lastPixelPoint: Point | null = null;
  /** Anchor for still-slop; timer resets when pointer leaves this neighborhood. */
  private quickShapeStillAnchor: Point | null = null;
  private quickShapeStillTimer: ReturnType<typeof setTimeout> | null = null;
  private pixelQuickShape: PixelQuickShapeState | null = null;
  /** Prevent overlapping paint-bucket operations from stacked clicks. */
  private fillBusy = false;
  private shapeSnapGuides: SnapGuide[] = [];

  constructor(deps: ToolSessionDeps) {
    this.deps = deps;
    deps.createPointsController.setRasterStrokeCallback((pixelPoints, paint, clip) => {
      void this.commitCreatePointsStroke(pixelPoints, paint, clip);
    });
  }

  /** Create Points stroke style: raster closed outline → potrace. */
  private async commitCreatePointsStroke(
    pixelPoints: Point[],
    paint: "add" | "subtract" | "inside",
    clip: Px | null | undefined,
  ): Promise<void> {
    const { deps } = this;
    if (pixelPoints.length < 2) return;
    const width =
      clampStrokeWidth(
        (toolSettingsStore.get()["create-points"] as { width?: number } | undefined)
          ?.width,
      ) * paintSizeScale(deps.camera.zoom, "create-points");
    const tc = deps.pixelCanvasManager.getToolContext();
    tc.clear();
    tc.ctx.beginPath();
    tc.ctx.moveTo(pixelPoints[0].x, pixelPoints[0].y);
    for (let i = 1; i < pixelPoints.length; i++) {
      tc.ctx.lineTo(pixelPoints[i].x, pixelPoints[i].y);
    }
    tc.ctx.closePath();
    tc.ctx.lineWidth = width;
    tc.ctx.lineJoin = "round";
    tc.ctx.lineCap = "round";
    tc.ctx.stroke();
    await this.commitTracedPixelCanvas("create-points", paint, clip);
  }

  private async commitTracedPixelCanvas(
    tool: ToolId,
    effectiveMode: "add" | "subtract" | "inside",
    clipForInside: Px | null | undefined,
  ): Promise<void> {
    const { deps } = this;
    try {
      const svg = await deps.tracer.trace(deps.getPixelCanvas());
      if (!svg) {
        deps.pixelCanvasManager.clear();
        return;
      }
      const config = deps.getConfig();
      const rings = simplifyRings(
        tracedSvgToWorldRings(svg, config, deps.camera),
        traceSimplifyWorld(tool, config, deps.camera),
      );
      const changed = commitPaint(
        deps.renderer,
        rings,
        effectiveMode,
        colorStore.get(),
        clipForInside ?? null,
      );
      deps.pixelCanvasManager.clear();
      if (changed) deps.historyManager.snapshot();
    } catch (error) {
      console.error("Tracing failed:", error);
      deps.pixelCanvasManager.clear();
    }
  }

  private async runFill(viewportPoint: Point): Promise<void> {
    if (this.fillBusy) return;
    this.fillBusy = true;
    try {
      const fillSettings = toolSettingsStore.get().fill;
      const gapPx = Number(fillSettings.gap ?? 0);
      const scope = fillSettings.scope === "active" ? "active" : "all";
      const changed = await fillAt(
        {
          renderer: this.deps.renderer,
          tracer: this.deps.tracer,
          camera: this.deps.camera,
          getConfig: this.deps.getConfig,
        },
        viewportPoint,
        colorStore.get(),
        { gapPx, scope },
      );
      if (changed) this.deps.historyManager.snapshot();
    } catch (error) {
      console.error("Fill failed:", error);
    } finally {
      this.fillBusy = false;
    }
  }

  private clearQuickShapeStillTimer(): void {
    if (this.quickShapeStillTimer !== null) {
      clearTimeout(this.quickShapeStillTimer);
      this.quickShapeStillTimer = null;
    }
  }

  private resetPixelQuickShape(): void {
    this.clearQuickShapeStillTimer();
    this.pixelQuickShape = null;
    this.pixelDrawingTool = null;
    this.lastPixelPoint = null;
    this.quickShapeStillAnchor = null;
  }

  private isQuickShapeEnabled(): boolean {
    return quickShapeEnabledStore.get();
  }

  /** Still-slop in pixel-canvas units (~8 CSS px). */
  private pixelQuickShapeSlop(): number {
    const c = this.deps.getConfig();
    return Math.max(
      1,
      QUICK_SHAPE_SLOP_PX * (c.pixelWidth / Math.max(c.viewportWidth, 1)),
    );
  }

  private armQuickShapeStillTimer(tool: "brush" | "lasso"): void {
    this.clearQuickShapeStillTimer();
    if (!this.isQuickShapeEnabled() || this.pixelQuickShape) return;

    this.quickShapeStillTimer = setTimeout(() => {
      this.quickShapeStillTimer = null;
      const hold = this.lastPixelPoint;
      if (!hold || this.pixelDrawingTool !== tool) return;
      this.trySnapPixelQuickShape(tool, hold);
    }, quickShapeHoldMsStore.get());
  }

  private trySnapPixelQuickShape(tool: "brush" | "lasso", holdPoint: Point): void {
    if (this.pixelDrawingTool !== tool || this.pixelQuickShape) return;
    if (!this.isQuickShapeEnabled()) return;

    const stroke = this.deps.pixelCanvasManager.getCurrentStroke();
    if (stroke.length < 3) return;

    const recognized = recognizeQuickShape(stroke, {
      preferClosed: tool === "lasso",
      curveStyle: quickShapeCurveStyleStore.get(),
      allowShapes: quickShapeShapesEnabledStore.get(),
    });
    if (!recognized) return;

    const originalPoints = stroke.map((p) => ({ ...p }));
    this.pixelQuickShape = {
      tool,
      originalPoints,
      base: recognized,
      result: recognized,
      pivot: quickShapeAdjustPivot(recognized, originalPoints[0]),
      adjustOrigin: { ...holdPoint },
    };
    this.applyPixelQuickShapePreview();
    try {
      navigator.vibrate?.(10);
    } catch {
      /* ignore */
    }
  }

  private applyPixelQuickShapePreview(): void {
    const state = this.pixelQuickShape;
    if (!state) return;

    const { deps } = this;
    const settings = toolSettingsStore.get();
    const tc = deps.pixelCanvasManager.getToolContext();

    const sizeScale = paintSizeScale(deps.camera.zoom, state.tool);
    if (state.tool === "brush") {
      const brushSettings = settings.brush as {
        sizeMin: number;
        sizeMax: number;
        tip?: "circle" | "square" | "ellipse" | "diag";
        angle?: number;
      };
      const stamped = resampleWithPressure(
        state.originalPoints,
        state.result.path,
      );
      deps.pixelCanvasManager.setCurrentStroke(stamped);
      stampBrushStroke(
        tc,
        stamped,
        brushSettings.sizeMin * sizeScale,
        brushSettings.sizeMax * sizeScale,
        brushSettings.tip ?? "circle",
        brushSettings.angle ?? 0,
      );
    } else {
      const lassoSettings = settings.lasso as {
        style: "fill" | "stroke";
        width?: number;
      };
      replaceLassoStroke(
        tc,
        state.result.path,
        lassoSettings.style ?? "fill",
        (lassoSettings.width ?? 2) * sizeScale,
      );
    }
  }

  onToolStart(point: Point, tool: ToolId): void {
    if (tool === "pan") return;

    const { deps } = this;
    const config = deps.getConfig();
    const viewportPoint = pixelToViewport(point, config);
    const worldPoint = deps.camera.screenToWorld(viewportPoint.x, viewportPoint.y);
    const symmetry = symmetryStore.get();

    // Symmetry origin handle takes priority over tools when enabled.
    if (
      !deps.documentManager.isPlaying() &&
      hitTestSymmetryHandle(
        viewportPoint.x,
        viewportPoint.y,
        symmetry,
        (x, y) => deps.camera.worldToScreen(x, y),
      )
    ) {
      this.symmetryHandleDragging = true;
      return;
    }

    // Create Points: pin source to the first click of a draft so later verts /
    // close-click don't flip the clip half mid-shape.
    if (
      symmetry.enabled &&
      !(tool === "create-points" && deps.createPointsController.hasDraft()) &&
      !(tool === "artistic-text" && deps.artisticTextController.hasDraft())
    ) {
      setSymmetryGestureSource(worldPoint.x, worldPoint.y, symmetry);
    }

    // Select/magnet manipulate live Paper items, which the frame loader
    // replaces on every playhead move — those still stop playback. Pixel
    // tools (brush/lasso/shapes) draw on their own canvas and commit
    // atomically on release, so they can run while the animation plays
    // (the stroke lands on whichever frame is current at release).
    if (
      deps.documentManager.isPlaying() &&
      (tool === "select" ||
        tool === "direct-select" ||
        tool === "create-points" ||
        tool === "artistic-text" ||
        tool === "magnet" ||
        tool === "magic-move" ||
        tool === "magic-morph" ||
        tool === "fill")
    ) {
      deps.documentManager.setPlaying(false);
    }

    if (
      tool !== "select" &&
      tool !== "direct-select" &&
      tool !== "magic-move" &&
      tool !== "magic-morph"
    ) {
      stageSelectedStore.set(false);
    }

    if (tool === "select") {
      deps.setSelectionGestureActive(true);
      deps.selectionController.handleStart(point);
      deps.updateFunctionsPanel();
      return;
    }

    if (tool === "direct-select") {
      deps.setSelectionGestureActive(true);
      deps.directSelectController.handleStart(point);
      deps.updateFunctionsPanel();
      return;
    }

    if (tool === "create-points") {
      const layerState = layerStore.get();
      const activeLayer = layerState.layers.find(
        (l) => l.id === layerState.activeLayerId,
      );
      if (!activeLayer || !isLayerDrawable(activeLayer)) return;
      deps.createPointsController.handleStart(point);
      return;
    }

    if (tool === "artistic-text") {
      const layerState = layerStore.get();
      const activeLayer = layerState.layers.find(
        (l) => l.id === layerState.activeLayerId,
      );
      if (!activeLayer || !isLayerDrawable(activeLayer)) return;
      deps.artisticTextController.handleStart(point);
      return;
    }

    if (tool === "magic-move" || tool === "magic-morph") {
      const layerState = layerStore.get();
      const activeLayer = layerState.layers.find(
        (l) => l.id === layerState.activeLayerId,
      );
      if (!activeLayer || !isLayerDrawable(activeLayer)) return;
      if (tool === "magic-move") deps.magicMoveController.handleStart(point);
      else deps.magicMorphController.handleStart(point);
      return;
    }

    // Safety net: if a selection is still active when another tool starts,
    // place it before the new interaction mutates the layer.
    if (deps.selectionController.hasSelection()) {
      deps.selectionController.clearSelection();
    }
    if (deps.directSelectController.hasSelection()) {
      deps.directSelectController.clearSelection();
      deps.closeFunctionsPanelHidden();
    }
    if (deps.magicMoveController.hasSelection()) {
      deps.magicMoveController.deactivate();
    }
    if (deps.magicMorphController.hasTransientUI()) {
      deps.magicMorphController.deactivate();
    }

    // Locked layers accept no drawing / magnet edits.
    const layerState = layerStore.get();
    const activeLayer = layerState.layers.find(
      (l) => l.id === layerState.activeLayerId,
    );
    if (!activeLayer || !isLayerDrawable(activeLayer)) return;

    if (tool === "magnet") {
      deps.magnetController.handleStart(point);
      deps.feedbackLayer.setDrawingState(true);
      deps.feedbackLayer.setCursor(point);
      return;
    }

    if (tool === "eyedropper") {
      deps.pickColorAt(point);
      return;
    }

    if (tool === "fill") {
      void this.runFill(viewportPoint);
      return;
    }

    if (tool === "brush" || tool === "lasso" || tool === "shape") {
      if (getEffectiveMode(tool) === "inside") {
        const hit = deps.renderer.hitTest(worldPoint, "active");
        this.insideClipForStroke = hit && hit.kind === "face" ? worldPoint : null;
      } else {
        this.insideClipForStroke = undefined;
      }
    } else {
      this.insideClipForStroke = undefined;
    }

    // Delegate to tool behavior via PixelCanvas
    const settings = toolSettingsStore.get();
    const startPoint = tool === "shape" ? this.snapShapePixel(point) : point;
    this.pixelGestureActive = true;
    deps.pixelCanvasManager.startTool(tool, startPoint, settings);
    deps.feedbackLayer.setDrawingState(true);
    deps.feedbackLayer.setCursor(point);
    if (tool === "shape") this.paintShapeSnapGuides();

    if (tool === "brush" || tool === "lasso") {
      this.resetPixelQuickShape();
      this.pixelDrawingTool = tool;
      this.lastPixelPoint = { ...point };
      this.quickShapeStillAnchor = { ...point };
      this.armQuickShapeStillTimer(tool);
    }
  }

  onToolMove(point: Point, tool: ToolId): void {
    if (tool === "pan") return;

    const { deps } = this;

    if (this.symmetryHandleDragging) {
      const viewportPoint = pixelToViewport(point, deps.getConfig());
      const worldPoint = deps.camera.screenToWorld(viewportPoint.x, viewportPoint.y);
      const snapped = snapWorldPoint(worldPoint, deps.camera, deps.renderer);
      setSnapGuides(snapped.guides);
      symmetryStore.update((s) =>
        normalizeSymmetrySettings({
          ...s,
          originX: snapped.x,
          originY: snapped.y,
        }),
      );
      return;
    }

    if (tool === "select") {
      deps.selectionController.handleMove(point);
      return;
    }

    if (tool === "direct-select") {
      deps.directSelectController.handleMove(point);
      return;
    }

    if (tool === "create-points") {
      deps.createPointsController.handleMove(point);
      return;
    }

    if (tool === "artistic-text") {
      deps.artisticTextController.handleMove(point);
      return;
    }

    if (tool === "magic-move") {
      deps.magicMoveController.handleMove(point);
      return;
    }

    if (tool === "magic-morph") {
      deps.magicMorphController.handleMove(point);
      return;
    }

    if (tool === "magnet") {
      deps.magnetController.handleMove(point);
      return;
    }

    if (tool === "eyedropper") {
      deps.pickColorAt(point);
      return;
    }

    if (tool === "fill") return;

    // Start was refused (locked / non-vector layer): ignore the rest of the gesture.
    if (!this.pixelGestureActive) return;

    // Quick Shape adjust: scale+rotate snapped preview; do not append freehand.
    if (
      (tool === "brush" || tool === "lasso") &&
      this.pixelQuickShape &&
      this.pixelQuickShape.tool === tool
    ) {
      const adjusted = adjustQuickShape(
        this.pixelQuickShape.base,
        this.pixelQuickShape.pivot,
        this.pixelQuickShape.adjustOrigin,
        point,
      );
      this.pixelQuickShape.result = adjusted;
      this.applyPixelQuickShapePreview();
      this.lastPixelPoint = { ...point };
      return;
    }

    // Delegate to tool behavior via PixelCanvas
    const settings = toolSettingsStore.get();
    const movePoint = tool === "shape" ? this.snapShapePixel(point) : point;
    deps.pixelCanvasManager.moveTool(tool, movePoint, settings);
    if (tool === "shape") this.paintShapeSnapGuides();

    if (tool === "brush" || tool === "lasso") {
      this.lastPixelPoint = { ...point };
      const anchor = this.quickShapeStillAnchor;
      const slop = this.pixelQuickShapeSlop();
      if (!anchor) {
        this.quickShapeStillAnchor = { ...point };
        this.armQuickShapeStillTimer(tool);
      } else {
        const dx = point.x - anchor.x;
        const dy = point.y - anchor.y;
        if (dx * dx + dy * dy >= slop * slop) {
          this.quickShapeStillAnchor = { ...point };
          this.armQuickShapeStillTimer(tool);
        }
      }
    }
  }

  async onToolEnd(tool: ToolId): Promise<void> {
    if (tool === "pan") return;

    const { deps } = this;

    if (this.symmetryHandleDragging) {
      this.symmetryHandleDragging = false;
      setSnapGuides([]);
      return;
    }

    if (tool === "select") {
      deps.selectionController.handleEnd();
      deps.setSelectionGestureActive(false);
      deps.setFunctionsPanelDismissed(false);
      deps.updateFunctionsPanel();
      return;
    }

    if (tool === "direct-select") {
      deps.directSelectController.handleEnd();
      deps.setSelectionGestureActive(false);
      deps.setFunctionsPanelDismissed(false);
      deps.updateFunctionsPanel();
      return;
    }

    if (tool === "create-points") {
      deps.createPointsController.handleEnd();
      return;
    }

    if (tool === "artistic-text") {
      deps.artisticTextController.handleEnd();
      return;
    }

    if (tool === "magic-move") {
      deps.magicMoveController.handleEnd();
      return;
    }

    if (tool === "magic-morph") {
      deps.magicMorphController.handleEnd();
      return;
    }

    if (tool === "magnet") {
      deps.magnetController.handleEnd();
      deps.feedbackLayer.setDrawingState(false);
      return;
    }

    if (tool === "eyedropper" || tool === "fill") return;

    if (!this.pixelGestureActive) return;
    this.pixelGestureActive = false;

    this.clearQuickShapeStillTimer();
    // Leave snapped raster on the canvas; endTool still returns points for the gate.
    this.pixelQuickShape = null;
    this.pixelDrawingTool = null;
    this.lastPixelPoint = null;
    this.quickShapeStillAnchor = null;

    deps.feedbackLayer.setDrawingState(false);
    this.clearShapeSnapGuides();

    // Delegate to tool behavior via PixelCanvas
    const settings = toolSettingsStore.get();
    const stroke = deps.pixelCanvasManager.endTool(tool, settings);

    if (!stroke || stroke.points.length === 0) {
      this.insideClipForStroke = undefined;
      return;
    }

    const clipForInside = this.insideClipForStroke;
    this.insideClipForStroke = undefined;
    const effectiveMode = getEffectiveMode(tool);

    // Shape fill skips potrace and commits a native Paper path.
    // Stroke style stays on the pixel canvas and traces like brush/lasso.
    if (tool === "shape") {
      const toolSettings = settings.shape as {
        shape?: unknown;
        from?: string;
        points?: number;
        style?: string;
      };
      if (toolSettings.style !== "stroke") {
        const kind = isShapeKind(toolSettings.shape) ? toolSettings.shape : "circle";
        const shapePath = buildPrimitiveShape(
          deps.getConfig(),
          kind,
          stroke.points,
          toolSettings.from === "center",
          Number(toolSettings.points) || 5,
          isConstrainScaleModifierHeld(modifiersStore.get()),
        );
        if (!shapePath) {
          deps.pixelCanvasManager.clear();
          return;
        }
        const rings = worldRings(shapePath, viewportToWorldAffine(deps.camera));
        const changed = commitPaint(
          deps.renderer,
          rings,
          effectiveMode,
          colorStore.get(),
          clipForInside ?? null,
        );
        deps.pixelCanvasManager.clear();
        if (changed) deps.historyManager.snapshot();
        return;
      }
    }

    await this.commitTracedPixelCanvas(tool, effectiveMode, clipForInside);
  }

  onToolCancel(tool: ToolId): void {
    if (tool === "pan") return;

    const { deps } = this;
    this.pixelGestureActive = false;

    if (this.symmetryHandleDragging) {
      this.symmetryHandleDragging = false;
      setSnapGuides([]);
      return;
    }

    if (tool === "select") {
      deps.selectionController.handleCancel();
      deps.setSelectionGestureActive(false);
      deps.setFunctionsPanelDismissed(false);
      deps.updateFunctionsPanel();
      return;
    }

    if (tool === "direct-select") {
      deps.directSelectController.handleCancel();
      deps.setSelectionGestureActive(false);
      deps.setFunctionsPanelDismissed(false);
      deps.updateFunctionsPanel();
      return;
    }

    if (tool === "create-points") {
      deps.createPointsController.handleCancel();
      return;
    }

    if (tool === "artistic-text") {
      deps.artisticTextController.handleCancel();
      return;
    }

    if (tool === "magic-move") {
      deps.magicMoveController.handleCancel();
      return;
    }

    if (tool === "magic-morph") {
      deps.magicMorphController.handleCancel();
      return;
    }

    if (tool === "magnet") {
      deps.magnetController.handleCancel();
      deps.feedbackLayer.setDrawingState(false);
      return;
    }

    if (tool === "eyedropper" || tool === "fill") return;

    this.resetPixelQuickShape();
    this.insideClipForStroke = undefined;
    this.clearShapeSnapGuides();
    deps.feedbackLayer.setDrawingState(false);
    // End the tool action without tracing
    const settings = toolSettingsStore.get();
    deps.pixelCanvasManager.endTool(tool, settings);
    deps.pixelCanvasManager.clear();
  }

  private snapShapePixel(point: Point): Point {
    const { deps } = this;
    const config = deps.getConfig();
    const vp = pixelToViewport(point, config);
    const world = deps.camera.screenToWorld(vp.x, vp.y);
    const snapped = snapWorldPoint(world, deps.camera, deps.renderer);
    this.shapeSnapGuides = snapped.guides;
    const screen = deps.camera.worldToScreen(snapped.x, snapped.y);
    return viewportToPixel({ x: screen.x, y: screen.y, pressure: point.pressure }, config);
  }

  private paintShapeSnapGuides(): void {
    setSnapGuides(this.shapeSnapGuides);
  }

  private clearShapeSnapGuides(): void {
    this.shapeSnapGuides = [];
    setSnapGuides([]);
  }
}

/** Screen-pixel simplify amount for `tool`, converted into world px. 0 skips the refit. */
function traceSimplifyWorld(tool: ToolId, config: CanvasConfig, camera: Camera): number {
  const raw = (toolSettingsStore.get()[tool] as { simplify?: unknown } | undefined)?.simplify;
  const px = typeof raw === "number" && raw > 0 ? raw : 0;
  if (px === 0) return 0;
  const m = pixelToWorldAffine(config, camera);
  return px * Math.hypot(m[0], m[1]);
}

export function getEffectiveMode(tool: ToolId): "add" | "subtract" | "inside" {
  const settings = toolSettingsStore.get();
  const modifiers = modifiersStore.get();
  const toolSettings = settings[tool] as { mode?: string };
  const baseMode = (toolSettings.mode ?? "add") as "add" | "subtract" | "inside";
  if (!isPaintModeModifierHeld(modifiers)) return baseMode;

  const modeCycle: Array<"add" | "subtract" | "inside"> = [
    "add",
    "subtract",
    "inside",
  ];
  const idx = modeCycle.indexOf(baseMode);
  return modeCycle[(idx + 1) % modeCycle.length];
}
