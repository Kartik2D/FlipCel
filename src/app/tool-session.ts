/**
 * Tool gesture lifecycle (start → move → end / cancel).
 *
 * Extracted from App so bootstrap stays focused on wiring; behavior is unchanged.
 */
import type { Camera } from "../render/camera";
import type { FeedbackLayer } from "../render/feedback-layer";
import type { PaperRenderer } from "../render/paper-renderer";
import type { PixelCanvas } from "../tools/pixel-canvas";
import type { Tracer } from "../tracing/potrace-tracer";
import type { SelectionController } from "../editing/object-select";
import type { DirectSelectController } from "../editing/direct-select";
import type { MagnetController } from "../editing/magnet";
import type { MagicMoveController } from "../editing/magic-move";
import type { MagicMorphController } from "../editing/magic-morph";
import type { HistoryManager } from "../document/history";
import type { DocumentManager } from "../document/document";
import type { CanvasConfig, Point } from "../geometry/types";
import type { ToolId } from "../tools/registry";
import { pixelToViewport } from "../geometry/coords";
import {
  colorStore,
  modifiersStore,
  toolSettingsStore,
  stageSelectedStore,
  symmetryStore,
  normalizeSymmetrySettings,
  layerStore,
} from "../state/index";
import {
  hitTestSymmetryHandle,
  setSymmetryGestureSource,
} from "../geometry/symmetry";

export interface ToolSessionDeps {
  getConfig: () => CanvasConfig;
  getPixelCanvas: () => HTMLCanvasElement;
  camera: Camera;
  documentManager: DocumentManager;
  selectionController: SelectionController;
  directSelectController: DirectSelectController;
  magnetController: MagnetController;
  magicMoveController: MagicMoveController;
  magicMorphController: MagicMorphController;
  paperRenderer: PaperRenderer;
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
  /** Inside mode only: clip to path under pointer, or null for full viewport ("paint behind"). */
  private insideClipForStroke: paper.PathItem | null | undefined = undefined;
  /** True while dragging the symmetry-axis origin handle. */
  private symmetryHandleDragging = false;

  constructor(deps: ToolSessionDeps) {
    this.deps = deps;
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

    if (symmetry.enabled) {
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
        tool === "magnet" ||
        tool === "magic-move" ||
        tool === "magic-morph")
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

    if (tool === "magic-move") {
      deps.magicMoveController.handleStart(point);
      return;
    }

    if (tool === "magic-morph") {
      deps.magicMorphController.handleStart(point);
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
    if (activeLayer?.locked) return;

    if (tool === "magnet") {
      deps.magnetController.handleStart(point);
      deps.feedbackLayer.setDrawingState(true);
      deps.feedbackLayer.updateCursor(point);
      return;
    }

    if (tool === "eyedropper") {
      deps.pickColorAt(point);
      return;
    }

    if (tool === "brush" || tool === "lasso") {
      if (getEffectiveMode(tool) === "inside") {
        const hit = deps.paperRenderer.hitTest(viewportPoint);
        this.insideClipForStroke = deps.paperRenderer.hitToClipPathItem(hit);
      } else {
        this.insideClipForStroke = undefined;
      }
    } else {
      this.insideClipForStroke = undefined;
    }

    // Delegate to tool behavior via PixelCanvas
    const settings = toolSettingsStore.get();
    deps.pixelCanvasManager.startTool(tool, point, settings);
    deps.feedbackLayer.setDrawingState(true);
    deps.feedbackLayer.updateCursor(point);
  }

  onToolMove(point: Point, tool: ToolId): void {
    if (tool === "pan") return;

    const { deps } = this;

    if (this.symmetryHandleDragging) {
      const viewportPoint = pixelToViewport(point, deps.getConfig());
      const worldPoint = deps.camera.screenToWorld(viewportPoint.x, viewportPoint.y);
      symmetryStore.update((s) =>
        normalizeSymmetrySettings({
          ...s,
          originX: worldPoint.x,
          originY: worldPoint.y,
        }),
      );
      deps.feedbackLayer.updateCursor(point);
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
      deps.feedbackLayer.updateCursor(point);
      return;
    }

    if (tool === "eyedropper") {
      deps.pickColorAt(point);
      return;
    }

    // Delegate to tool behavior via PixelCanvas
    const settings = toolSettingsStore.get();
    deps.pixelCanvasManager.moveTool(tool, point, settings);
    deps.feedbackLayer.updateCursor(point);
  }

  async onToolEnd(tool: ToolId): Promise<void> {
    if (tool === "pan") return;

    const { deps } = this;

    if (this.symmetryHandleDragging) {
      this.symmetryHandleDragging = false;
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

    if (tool === "eyedropper") return;

    deps.feedbackLayer.setDrawingState(false);

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

    try {
      const svg = await deps.tracer.trace(deps.getPixelCanvas());
      if (!svg) {
        deps.pixelCanvasManager.clear();
        return;
      }

      if (effectiveMode === "add") {
        const color = colorStore.get();
        await deps.paperRenderer.addPath(svg, color);
      } else if (effectiveMode === "subtract") {
        await deps.paperRenderer.subtractPath(svg);
      } else {
        const color = colorStore.get();
        await deps.paperRenderer.addPathIntersectClip(svg, color, clipForInside ?? null);
      }
      deps.pixelCanvasManager.clear();
      deps.historyManager.snapshot(); // Record history after drawing
    } catch (error) {
      console.error("Tracing failed:", error);
      deps.pixelCanvasManager.clear();
    }
  }

  onToolCancel(tool: ToolId): void {
    if (tool === "pan") return;

    const { deps } = this;

    if (this.symmetryHandleDragging) {
      this.symmetryHandleDragging = false;
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

    if (tool === "eyedropper") return;

    this.insideClipForStroke = undefined;
    deps.feedbackLayer.setDrawingState(false);
    // End the tool action without tracing
    const settings = toolSettingsStore.get();
    deps.pixelCanvasManager.endTool(tool, settings);
    deps.pixelCanvasManager.clear();
  }
}

export function getEffectiveMode(tool: ToolId): "add" | "subtract" | "inside" {
  const settings = toolSettingsStore.get();
  const modifiers = modifiersStore.get();
  const toolSettings = settings[tool] as { mode?: string };
  const baseMode = (toolSettings.mode ?? "add") as "add" | "subtract" | "inside";
  if (!modifiers.shift) return baseMode;

  const modeCycle: Array<"add" | "subtract" | "inside"> = [
    "add",
    "subtract",
    "inside",
  ];
  const idx = modeCycle.indexOf(baseMode);
  return modeCycle[(idx + 1) % modeCycle.length];
}
