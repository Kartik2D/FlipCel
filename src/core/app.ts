/**
 * Main Application Orchestrator
 *
 * Central coordinator that:
 * - Initializes all three canvases and their contexts
 * - Creates and wires up all component modules
 * - Manages the complete drawing lifecycle (start → move → end → trace → render)
 * - Handles window resize events and updates all components
 * - Auto-calculates pixel canvas resolution (~8x downscale from viewport)
 * - Manages camera system for pan/zoom functionality
 *
 * Key responsibilities:
 * - Component initialization and dependency injection
 * - Event flow coordination between UnifiedInputManager → PixelCanvas → Tracer → PaperRenderer
 * - Canvas sizing and configuration management
 * - Camera transformation management
 * - Tool and modifier state management
 */
import { init, potrace } from "esm-potrace-wasm";
import paper from "paper";
import { UnifiedInputManager } from "./unified-input";
import { PixelCanvas } from "./pixel-canvas";
import { Tracer } from "./tracer";
import { PaperRenderer } from "./paper-renderer";
import { UIOverlay } from "./ui-overlay";
import { ChromeOverlay } from "./chrome-overlay";
import { Camera } from "./camera";
import { SelectionController } from "./selection-controller";
import { DirectSelectController } from "./direct-select-controller";
import { MagnetController } from "./magnet-controller";
import { HistoryManager } from "./history";
import { bus, Events } from "./event-bus";
import type { CanvasConfig, Point, Modifiers } from "./types";
import { cycleDockMode, type ToolId, type AllToolSettings } from "./tools";
import { pixelToViewport } from "./coords";
import {
  getAvailableFunctions,
  runFunction,
  type FunctionContext,
} from "./functions";
import type {
  InkwellColorPanel,
  InkwellToolsPanel,
  InkwellUniversalPanel,
  InkwellTopBarPanel,
  InkwellLayersPanel,
  InkwellFunctionsPanel,
} from "../ui/ui-lib";
import "../ui/ui-lib"; // Register Lit components
import {
  colorStore,
  prevColorStore,
  toolStore,
  prevToolStore,
  configStore,
  modifiersStore,
  toolSettingsStore,
  layerStore,
  selectionStore,
  viewOverlayStore,
  themeModeStore,
  type ThemeMode,
} from "./stores";

/**
 * Snap to 0° when |view rotation| is strictly inside this bound (degrees), i.e. |θ| < 15°.
 * Uses strict inequality so a single 15° UI step from 0 does not immediately snap back.
 */
const SNAP_ROTATION_TO_ZERO_WITHIN_DEG = 15;

const ROTATION_SNAP_TO_ZERO_MS = 280;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

class App {
  private paperCanvas: HTMLCanvasElement;
  private pixelCanvas: HTMLCanvasElement;
  private uiCanvas: HTMLCanvasElement;
  private chromeCanvas: HTMLCanvasElement;
  private pixelCanvas2D: CanvasRenderingContext2D;
  private uiCanvas2D: CanvasRenderingContext2D;
  private chromeCanvas2D: CanvasRenderingContext2D;
  private config: CanvasConfig;
  private inputManager: UnifiedInputManager;
  private pixelCanvasManager: PixelCanvas;
  private tracer: Tracer;
  private paperRenderer: PaperRenderer;
  private uiOverlay: UIOverlay;
  private chromeOverlay: ChromeOverlay;
  private selectionController: SelectionController;
  private directSelectController: DirectSelectController;
  private magnetController: MagnetController;
  private historyManager: HistoryManager;
  private colorPanel: InkwellColorPanel;
  private toolsPanel: InkwellToolsPanel;
  private universalPanel: InkwellUniversalPanel;
  private topBarPanel: InkwellTopBarPanel;
  private layersPanel: InkwellLayersPanel;
  private functionsPanel: InkwellFunctionsPanel;
  private camera: Camera;
  private isInitialized = false;
  private pixelResScale = 2;

  /** Inside mode only: clip to path under pointer, or null for full viewport ("paint behind"). */
  private insideClipForStroke: paper.PathItem | null | undefined = undefined;

  private rotationSnapRaf: number | null = null;

  private cameraLoopLastMs = performance.now();
  private functionsPanelDismissed = false;
  private lastFunctionsPanelKey = "";
  private duplicateDragSession:
    | {
        items: paper.PathItem[];
        lastWorldDelta: { x: number; y: number };
      }
    | null = null;

  constructor() {
    // Get canvas elements
    this.paperCanvas = document.getElementById("paper-canvas") as HTMLCanvasElement;
    this.pixelCanvas = document.getElementById("pixel-canvas") as HTMLCanvasElement;
    this.uiCanvas = document.getElementById("ui-canvas") as HTMLCanvasElement;
    this.chromeCanvas = document.getElementById("chrome-canvas") as HTMLCanvasElement;

    if (
      !this.paperCanvas ||
      !this.pixelCanvas ||
      !this.uiCanvas ||
      !this.chromeCanvas
    ) {
      throw new Error("Canvas elements not found");
    }

    // Get 2D contexts
    const pixelCtx = this.pixelCanvas.getContext("2d");
    const uiCtx = this.uiCanvas.getContext("2d");
    const chromeCtx = this.chromeCanvas.getContext("2d");

    if (!pixelCtx || !uiCtx || !chromeCtx) {
      throw new Error("Could not get 2D contexts");
    }

    this.pixelCanvas2D = pixelCtx;
    this.uiCanvas2D = uiCtx;
    this.chromeCanvas2D = chromeCtx;

    // Calculate configuration
    this.config = this.calculateConfig();

    // Initialize camera
    this.camera = new Camera(this.config.viewportWidth, this.config.viewportHeight);

    // Initialize components
    this.pixelCanvasManager = new PixelCanvas(this.pixelCanvas, this.pixelCanvas2D, this.config);
    this.tracer = new Tracer(potrace);
    this.paperRenderer = new PaperRenderer(this.paperCanvas, this.config);
    this.paperRenderer.setCamera(this.camera);
    this.uiOverlay = new UIOverlay(this.uiCanvas, this.uiCanvas2D, this.config);
    this.uiOverlay.setCamera(this.camera);
    this.chromeOverlay = new ChromeOverlay(
      this.chromeCanvas,
      this.chromeCanvas2D,
      this.config,
    );
    this.selectionController = new SelectionController(
      this.paperRenderer,
      this.camera,
      this.chromeOverlay,
    );
    this.directSelectController = new DirectSelectController(
      this.paperRenderer,
      this.camera,
      this.chromeOverlay,
    );
    this.magnetController = new MagnetController(this.paperRenderer, this.camera);
    this.historyManager = new HistoryManager();
    this.selectionController.setSnapshotCallback(() => this.historyManager.snapshot());
    this.directSelectController.setSnapshotCallback(() => this.historyManager.snapshot());
    this.directSelectController.setReconcileCallback((items) =>
      this.paperRenderer.reconcileItemsToFixpoint(items),
    );
    this.magnetController.setSnapshotCallback(() => this.historyManager.snapshot());
    this.magnetController.setReconcileCallback((items) =>
      this.paperRenderer.reconcileItemsToFixpoint(items),
    );

    // Get panel Lit elements
    this.colorPanel = document.getElementById("color-panel") as InkwellColorPanel;
    this.toolsPanel = document.getElementById("tools-panel") as InkwellToolsPanel;
    this.universalPanel = document.getElementById("universal-panel") as InkwellUniversalPanel;
    this.topBarPanel = document.getElementById("top-bar-panel") as InkwellTopBarPanel;
    this.layersPanel = document.getElementById("layers-panel") as InkwellLayersPanel;
    this.functionsPanel = document.getElementById("functions-panel") as InkwellFunctionsPanel;
    this.setupPanelEvents();

    viewOverlayStore.subscribeImmediate((prefs) => {
      this.uiOverlay.setViewOverlayPrefs(prefs);
      this.redrawActiveSelectionUI();
    });

    selectionStore.subscribeImmediate((selection) => {
      this.onSelectionItemsChange(selection.items);
    });

    // Initialize unified input manager
    this.inputManager = new UnifiedInputManager(this.uiCanvas, this.config);
    this.subscribeToInputEvents();
  }

  private subscribeToInputEvents() {
    bus.on(Events.TOOL_START, (d: { point: Point; tool: ToolId }) => this.onToolStart(d.point, d.tool));
    bus.on(Events.TOOL_MOVE, (d: { point: Point; tool: ToolId }) => this.onToolMove(d.point, d.tool));
    bus.on(Events.TOOL_END, (tool: ToolId) => this.onToolEnd(tool));
    bus.on(Events.TOOL_CANCEL, (tool: ToolId) => this.onToolCancel(tool));
    bus.on(Events.POINTER_MOVE, (point: Point) => this.onPointerMove(point));
    bus.on(Events.CAMERA_PAN, (d: { deltaX: number; deltaY: number }) => this.onCameraPan(d.deltaX, d.deltaY));
    bus.on(Events.CAMERA_ZOOM, (d: { factor: number; x: number; y: number }) =>
      this.onCameraZoom(d.factor, d.x, d.y),
    );
    bus.on(Events.CAMERA_ROTATE, (d: { delta: number; x: number; y: number }) => this.onCameraRotate(d.delta, d.x, d.y));
    bus.on(Events.PINCH_GESTURE_START, () => {
      this.cancelRotationSnapAnimation();
      this.camera.setPinchViewEasing(true);
    });
    bus.on(Events.PINCH_GESTURE_END, () => {
      this.camera.setPinchViewEasing(false);
      this.maybeSnapRotationToZero();
    });
    bus.on(Events.TOOL_CHANGE, (tool: ToolId) => this.onInputToolChange(tool));
    bus.on(Events.MODIFIERS_CHANGE, (m: Modifiers) => this.onModifiersChange(m));
    bus.on(Events.UNDO, () => this.onUndo());
    bus.on(Events.REDO, () => this.onRedo());
  }

  private setupPanelEvents() {
    this.colorPanel.addEventListener("color-change", (e: Event) => {
      this.onColorPickerChange((e as CustomEvent<string>).detail);
    });
    this.colorPanel.addEventListener("color-change-end", (e: Event) => {
      this.onColorPickerChangeEnd((e as CustomEvent<string>).detail);
    });

    // Tools panel events - sync to inputManager and handle selection placement
    this.toolsPanel.addEventListener("tool-change", (e: Event) => {
      const tool = (e as CustomEvent<ToolId>).detail;
      this.switchTool(tool);
    });

    // Tools panel also emits settings events (merged panel)
    this.toolsPanel.addEventListener("settings-change", (e: Event) => {
      const settings = (e as CustomEvent<AllToolSettings>).detail;
      this.onToolSettingsChange(settings);
    });

    this.toolsPanel.addEventListener("pixel-res-change", (e: Event) => {
      this.onPixelResChange((e as CustomEvent<number>).detail);
    });

    // Universal panel events
    this.universalPanel.addEventListener("brush-size-toggle", (e: Event) => {
      this.uiOverlay.setBrushSizeIndicatorEnabled((e as CustomEvent<boolean>).detail);
    });

    this.universalPanel.addEventListener("flatten", () => this.onFlatten());
    this.universalPanel.addEventListener("clear", () => this.onClear());
    this.universalPanel.addEventListener("undo", () => this.onUndo());
    this.universalPanel.addEventListener("redo", () => this.onRedo());
    this.topBarPanel.addEventListener("zoom-reset", () => this.onDockZoomReset());
    this.topBarPanel.addEventListener("rotate-reset", () => this.onDockRotationReset());
    this.topBarPanel.addEventListener("tool-cycle", () => this.onToolCycle());
    this.topBarPanel.addEventListener("mode-cycle", () => this.onModeCycle());
    this.universalPanel.addEventListener("alias-fix-toggle", (e: Event) => {
      this.onAliasFixToggle((e as CustomEvent<boolean>).detail);
    });
    this.universalPanel.addEventListener("export-view-svg", () => this.onExportViewSvg());

    // Layers panel events
    this.layersPanel.addEventListener("layer-add", (e: Event) => {
      const { id, name } = (e as CustomEvent<{ id: string; name: string }>).detail;
      this.onLayerAdd(id, name);
    });
    this.layersPanel.addEventListener("layer-delete", (e: Event) => {
      const layerId = (e as CustomEvent<string>).detail;
      this.onLayerDelete(layerId);
    });
    this.layersPanel.addEventListener("layer-select", (e: Event) => {
      const layerId = (e as CustomEvent<string>).detail;
      this.onLayerSelect(layerId);
    });
    this.layersPanel.addEventListener("layer-visibility-toggle", (e: Event) => {
      const layerId = (e as CustomEvent<string>).detail;
      this.onLayerVisibilityToggle(layerId);
    });
    this.layersPanel.addEventListener("layer-reorder", (e: Event) => {
      const orderedTopToBottom = (e as CustomEvent<string[]>).detail;
      this.onLayerReorder(orderedTopToBottom);
    });
    this.layersPanel.addEventListener("layer-rename", (e: Event) => {
      const { id, name } = (e as CustomEvent<{ id: string; name: string }>).detail;
      this.onLayerRename(id, name);
    });

    // Functions panel events
    this.functionsPanel.addEventListener("function-invoke", (e: Event) => {
      const { id } = (e as CustomEvent<{ id: string }>).detail;
      this.onFunctionInvoke(id);
    });
    this.functionsPanel.addEventListener("function-drag-start", (e: Event) => {
      const { id } = (e as CustomEvent<{ id: string; dx: number; dy: number }>).detail;
      this.onFunctionDragStart(id);
    });
    this.functionsPanel.addEventListener("function-drag-move", (e: Event) => {
      const { id, dx, dy } = (e as CustomEvent<{ id: string; dx: number; dy: number }>).detail;
      this.onFunctionDragMove(id, dx, dy);
    });
    this.functionsPanel.addEventListener("function-drag-end", (e: Event) => {
      const { id, dx, dy } = (e as CustomEvent<{ id: string; dx: number; dy: number }>).detail;
      this.onFunctionDragEnd(id, dx, dy);
    });
    this.functionsPanel.addEventListener("functions-close", (e: Event) => {
      const { reason } = (e as CustomEvent<{ reason?: "dismissed" | "hidden" }>).detail ?? {};
      if (reason === "dismissed") {
        this.functionsPanelDismissed = true;
      }
    });
  }

  private calculateConfig(): CanvasConfig {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const pixelWidth = Math.floor(viewportWidth / this.pixelResScale);
    const pixelHeight = Math.floor(viewportHeight / this.pixelResScale);

    return { pixelWidth, pixelHeight, viewportWidth, viewportHeight };
  }

  private resizeCanvases() {
    const { viewportWidth, viewportHeight } = this.config;

    // Set display size (CSS)
    this.paperCanvas.style.width = `${viewportWidth}px`;
    this.paperCanvas.style.height = `${viewportHeight}px`;
    this.pixelCanvas.style.width = `${viewportWidth}px`;
    this.pixelCanvas.style.height = `${viewportHeight}px`;
    this.uiCanvas.style.width = `${viewportWidth}px`;
    this.uiCanvas.style.height = `${viewportHeight}px`;
    // Chrome canvas sizing (CSS + internal) is handled by ChromeOverlay.updateConfig.

    // Set internal resolution
    this.pixelCanvas.width = this.config.pixelWidth;
    this.pixelCanvas.height = this.config.pixelHeight;
    this.uiOverlay.updateConfig(this.config);
    this.chromeOverlay.updateConfig(this.config);

    // Configure pixel canvas context
    this.pixelCanvas2D.imageSmoothingEnabled = false;

    // Update Paper.js view size
    if (this.isInitialized) {
      paper.view.viewSize = new paper.Size(viewportWidth, viewportHeight);
      this.paperRenderer.applyCamera();
    }
  }

  async init() {
    // Initialize esm-potrace-wasm
    await init();

    // Initialize Paper.js
    paper.setup(this.paperCanvas);
    this.isInitialized = true;

    // Initialize the default layer - map Paper.js activeLayer to our layer store
    const initialLayerState = layerStore.get();
    const defaultLayer = initialLayerState.layers[0];
    this.paperRenderer.initializeDefaultLayer(defaultLayer.id, defaultLayer.name);

    // Resize canvases
    this.resizeCanvases();

    // Apply initial camera transformation
    this.paperRenderer.applyCamera();
    this.updateDisplays();

    // Set up store subscriptions
    this.setupStoreSubscriptions();

    // Initialize stores with current values
    configStore.set(this.config);
    
    // Apply initial brush color to pixel canvas from color store
    this.pixelCanvasManager.setBrushColor(colorStore.get());

    // Handle window resize - now uses configStore for propagation
    window.addEventListener("resize", () => {
      this.config = this.calculateConfig();
      this.camera.updateViewport(this.config.viewportWidth, this.config.viewportHeight);
      this.resizeCanvases();
      configStore.set(this.config); // Propagates to all subscribers
      this.redrawActiveSelectionUI();
    });

    // Take initial history snapshot (empty canvas state)
    this.historyManager.snapshot();

    this.startCameraFrameLoop();

    console.log("App initialized with Lit UI components and stores");
  }

  /**
   * Smooth camera follow: targets update on input; present pose lerps each frame for Paper + UI.
   */
  private startCameraFrameLoop() {
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - this.cameraLoopLastMs) / 1000);
      this.cameraLoopLastMs = now;
      this.camera.stepLerp(dt);
      this.paperRenderer.applyCamera();
      // Grid/origin/brush ring live on #ui-canvas and move with the camera.
      this.uiOverlay.redraw();
      // Selection chrome lives on a separate canvas; repaint independently.
      this.redrawActiveSelectionUI();
      this.syncFunctionsPanelPosition();
      this.updateDisplays();
      requestAnimationFrame(step);
    };
    this.cameraLoopLastMs = performance.now();
    requestAnimationFrame(step);
  }

  private setupStoreSubscriptions() {
    // Color store - update pixel canvas brush color for preview
    colorStore.subscribe((color) => {
      this.pixelCanvasManager.setBrushColor(color);
    });

    // Config store - propagate to all components that need it
    configStore.subscribe((config) => {
      this.pixelCanvasManager.updateConfig(config);
      this.uiOverlay.updateConfig(config);
      this.inputManager.updateConfig(config);
      this.paperRenderer.updateConfig(config);
    });

    // Tool settings store - update UI overlay with brush max size
    toolSettingsStore.subscribe((settings) => {
      const brushSettings = settings.brush as { sizeMax?: number };
      if (brushSettings.sizeMax !== undefined) {
        this.uiOverlay.setMaxBrushSize(brushSettings.sizeMax);
      }
      const magnetSettings = settings.magnet as { size?: number } | undefined;
      if (magnetSettings && typeof magnetSettings.size === "number") {
        this.uiOverlay.setMagnetSize(magnetSettings.size);
      }
    });

    // Tool store - sync with inputManager + overlay (brush ring only when brush is active)
    toolStore.subscribeImmediate((tool) => {
      this.inputManager.setTool(tool);
      this.uiOverlay.setActiveTool(tool);
      this.updateFunctionsPanel();
    });

    themeModeStore.subscribeImmediate((mode) => {
      this.applyTheme(mode);
    });
  }

  private applyTheme(mode: ThemeMode) {
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
    this.uiOverlay.redraw();
    this.redrawActiveSelectionUI();
  }

  /**
   * Paint the chrome layer for the currently active selection tool.
   *
   * Chrome canvas is independent from the ui-overlay layer, so the two layers
   * never fight over the same pixels. The active controller owns clearing the
   * chrome canvas at the top of its drawUI() so stale shapes never persist.
   */
  private redrawActiveSelectionUI() {
    const currentTool = toolStore.get();
    if (currentTool === "direct-select") {
      // Direct-select always paints: every active-layer anchor is exposed
      // whenever the tool is active, even with nothing picked yet.
      this.directSelectController.drawUI();
      return;
    }
    if (currentTool === "select" && this.selectionController.hasTransientUI()) {
      this.selectionController.drawUI();
      return;
    }
    this.chromeOverlay.clear();
  }

  // ============================================================
  // Display Updates
  // ============================================================

  private updateDisplays() {
    const zoom = this.camera.getZoomPercent();
    const rotation = this.camera.getRotationDegrees();
    this.topBarPanel.zoomLevel = zoom;
    this.topBarPanel.rotation = rotation;
  }

  // ============================================================
  // Camera Control Handlers
  // ============================================================

  private onCameraPan(deltaX: number, deltaY: number) {
    this.camera.pan(deltaX, deltaY);
  }

  private onCameraZoom(factor: number, centerX: number, centerY: number) {
    this.camera.zoomAt(factor, centerX, centerY);
  }

  private onCameraRotate(deltaRadians: number, centerX: number, centerY: number) {
    this.cancelRotationSnapAnimation();
    this.camera.rotateAt(deltaRadians, centerX, centerY);
  }

  private cancelRotationSnapAnimation() {
    if (this.rotationSnapRaf !== null) {
      cancelAnimationFrame(this.rotationSnapRaf);
      this.rotationSnapRaf = null;
    }
  }

  /**
   * If view rotation is within ±15° of 0 (strictly inside), ease to exactly 0°.
   */
  private maybeSnapRotationToZero() {
    const deg = this.camera.getRotationDegrees();
    if (Math.abs(deg) >= SNAP_ROTATION_TO_ZERO_WITHIN_DEG || Math.abs(deg) < 1e-6) {
      return;
    }

    this.cancelRotationSnapAnimation();
    const fromRot = this.camera.rotation;
    const targetRot = 0;
    let delta = targetRot - fromRot;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    if (Math.abs(delta) < 1e-6) return;

    const cx = this.config.viewportWidth / 2;
    const cy = this.config.viewportHeight / 2;
    const start = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ROTATION_SNAP_TO_ZERO_MS);
      const e = easeInOutCubic(t);
      const desired = fromRot + delta * e;
      let step = desired - this.camera.rotation;
      while (step > Math.PI) step -= 2 * Math.PI;
      while (step < -Math.PI) step += 2 * Math.PI;

      this.camera.rotateAt(step, cx, cy);
      this.camera.syncPresentPanRotationFromTarget();

      if (t < 1) {
        this.rotationSnapRaf = requestAnimationFrame(tick);
      } else {
        this.rotationSnapRaf = null;
        this.camera.syncPresentPanRotationFromTarget();
      }
    };

    this.rotationSnapRaf = requestAnimationFrame(tick);
  }

  private onDockZoomReset() {
    const cx = this.config.viewportWidth / 2;
    const cy = this.config.viewportHeight / 2;
    this.camera.setPosition(cx, cy);
    this.camera.zoom = 1;
  }

  private onDockRotationReset() {
    this.cancelRotationSnapAnimation();
    this.camera.resetRotation();
  }

  // ============================================================
  // Tool Action Handlers (from UnifiedInputManager)
  // ============================================================

  private onToolStart(point: Point, tool: ToolId) {
    if (tool === "pan") return;

    if (tool === "select") {
      this.selectionController.handleStart(point);
      return;
    }

    if (tool === "direct-select") {
      this.directSelectController.handleStart(point);
      return;
    }

    // Safety net: if a selection is still active when another tool starts,
    // place it before the new interaction mutates the layer.
    if (this.selectionController.hasSelection()) {
      this.selectionController.clearSelection();
    }
    if (this.directSelectController.hasSelection()) {
      this.directSelectController.clearSelection();
      this.functionsPanel.close("hidden");
    }

    if (tool === "magnet") {
      this.magnetController.handleStart(point);
      this.uiOverlay.setDrawingState(true);
      this.uiOverlay.updateCursor(point);
      return;
    }

    if (tool === "eyedropper") {
      this.pickColorAt(point);
      return;
    }

    if (tool === "brush" || tool === "lasso") {
      if (this.getEffectiveMode(tool) === "inside") {
        const viewportPoint = pixelToViewport(point, this.config);
        const hit = this.paperRenderer.hitTest(viewportPoint);
        this.insideClipForStroke = this.paperRenderer.hitToClipPathItem(hit);
      } else {
        this.insideClipForStroke = undefined;
      }
    } else {
      this.insideClipForStroke = undefined;
    }

    // Delegate to tool behavior via PixelCanvas
    const settings = toolSettingsStore.get();
    this.pixelCanvasManager.startTool(tool, point, settings);
    this.uiOverlay.setDrawingState(true);
    this.uiOverlay.updateCursor(point);
  }

  private onToolMove(point: Point, tool: ToolId) {
    if (tool === "pan") return;

    if (tool === "select") {
      this.selectionController.handleMove(point);
      return;
    }

    if (tool === "direct-select") {
      this.directSelectController.handleMove(point);
      return;
    }

    if (tool === "magnet") {
      this.magnetController.handleMove(point);
      this.uiOverlay.updateCursor(point);
      return;
    }

    if (tool === "eyedropper") {
      this.pickColorAt(point);
      return;
    }

    // Delegate to tool behavior via PixelCanvas
    const settings = toolSettingsStore.get();
    this.pixelCanvasManager.moveTool(tool, point, settings);
    this.uiOverlay.updateCursor(point);
  }

  private async onToolEnd(tool: ToolId) {
    if (tool === "pan") return;

    if (tool === "select") {
      this.selectionController.handleEnd();
      this.functionsPanelDismissed = false;
      this.updateFunctionsPanel();
      return;
    }

    if (tool === "direct-select") {
      this.directSelectController.handleEnd();
      this.functionsPanelDismissed = false;
      this.updateFunctionsPanel();
      return;
    }

    if (tool === "magnet") {
      this.magnetController.handleEnd();
      this.uiOverlay.setDrawingState(false);
      return;
    }

    if (tool === "eyedropper") return;

    this.uiOverlay.setDrawingState(false);

    // Delegate to tool behavior via PixelCanvas
    const settings = toolSettingsStore.get();
    const stroke = this.pixelCanvasManager.endTool(tool, settings);

    if (!stroke || stroke.points.length === 0) {
      this.insideClipForStroke = undefined;
      return;
    }

    try {
      const svg = await this.tracer.trace(this.pixelCanvas);
      if (!svg) {
        this.insideClipForStroke = undefined;
        return;
      }

      const clipForInside = this.insideClipForStroke;
      this.insideClipForStroke = undefined;

      const effectiveMode = this.getEffectiveMode(tool);

      if (effectiveMode === "add") {
        const color = colorStore.get();
        await this.paperRenderer.addPath(svg, color);
      } else if (effectiveMode === "subtract") {
        await this.paperRenderer.subtractPath(svg);
      } else {
        const color = colorStore.get();
        await this.paperRenderer.addPathIntersectClip(svg, color, clipForInside ?? null);
      }
      this.pixelCanvasManager.clear();
      this.historyManager.snapshot(); // Record history after drawing
    } catch (error) {
      this.insideClipForStroke = undefined;
      console.error("Tracing failed:", error);
    }
  }

  private getEffectiveMode(tool: ToolId): "add" | "subtract" | "inside" {
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

  private onToolCancel(tool: ToolId) {
    if (tool === "pan") return;

    if (tool === "select") {
      this.selectionController.handleCancel();
      this.functionsPanelDismissed = false;
      this.updateFunctionsPanel();
      return;
    }

    if (tool === "direct-select") {
      this.directSelectController.handleCancel();
      this.functionsPanelDismissed = false;
      this.updateFunctionsPanel();
      return;
    }

    if (tool === "magnet") {
      this.magnetController.handleCancel();
      this.uiOverlay.setDrawingState(false);
      return;
    }

    if (tool === "eyedropper") return;

    this.insideClipForStroke = undefined;
    this.uiOverlay.setDrawingState(false);
    // End the tool action without tracing
    const settings = toolSettingsStore.get();
    this.pixelCanvasManager.endTool(tool, settings);
    this.pixelCanvasManager.clear();
  }

  private onPointerMove(point: Point) {
    this.uiOverlay.updateCursor(point);

    const currentTool = toolStore.get();
    if (currentTool === "select" && this.selectionController.hasTransientUI()) {
      this.redrawActiveSelectionUI();
    }
    if (currentTool === "direct-select") {
      this.redrawActiveSelectionUI();
    }
  }

  // ============================================================
  // Control Panel Handlers
  // ============================================================

  private onToolChange(tool: ToolId) {
    if (tool !== "select") {
      this.selectionController.clearSelection();
    }
    if (tool !== "direct-select") {
      this.directSelectController.clearSelection();
      this.functionsPanel.close("hidden");
    }
    if (tool !== "magnet" && this.magnetController.hasActiveStroke()) {
      this.magnetController.handleCancel();
    }
  }

  private onToolCycle() {
    const current = toolStore.get();
    const prev = prevToolStore.get();
    this.switchTool(prev !== current ? prev : "brush");
  }

  private onModeCycle() {
    const tid = toolStore.get();
    const current = toolSettingsStore.get()[tid] as Record<string, unknown>;
    const result = cycleDockMode(tid, current);
    if (!result) return;
    toolSettingsStore.update((s) => ({
      ...s,
      [tid]: { ...s[tid], [result.key]: result.value },
    }));
    this.onToolSettingsChange(toolSettingsStore.get());
  }

  private onToolSettingsChange(settings: AllToolSettings) {
    // Update UI overlay with brush max size if available
    const brushSettings = settings.brush as { sizeMax?: number };
    if (brushSettings.sizeMax !== undefined) {
      this.uiOverlay.setMaxBrushSize(brushSettings.sizeMax);
    }
    const magnetSettings = settings.magnet as { size?: number } | undefined;
    if (magnetSettings && typeof magnetSettings.size === "number") {
      this.uiOverlay.setMagnetSize(magnetSettings.size);
    }
  }

  private onSelectionItemsChange(items: paper.PathItem[]) {
    if (items.length === 1) {
      const fill = items[0].fillColor;
      if (fill) {
        const toHex = (channel: number) =>
          Math.round(Math.max(0, Math.min(1, channel)) * 255)
            .toString(16)
            .padStart(2, "0");
        const color = `#${toHex(fill.red)}${toHex(fill.green)}${toHex(fill.blue)}`;
        colorStore.set(color);
        prevColorStore.set(color);
      }
    }

    this.updateFunctionsPanel();
  }

  private buildFunctionContext(): FunctionContext {
    return {
      tool: toolStore.get(),
      items: selectionStore.get().items.filter((item) => item.parent),
      pickedAnchorCount: this.directSelectController.getPickedAnchorCount(),
    };
  }

  private getFunctionsPanelKey(context: FunctionContext, functionIds: string[]): string {
    const itemIds = context.items.map((item) => item.id).sort((a, b) => a - b);
    return [
      context.tool,
      itemIds.join(","),
      context.pickedAnchorCount,
      functionIds.join(","),
    ].join("|");
  }

  private getFunctionsPanelPosition(context: FunctionContext): { x: number; y: number } | null {
    if (context.tool === "select") {
      const bounds = this.paperRenderer.getSelectionFrameScreenBounds(context.items);
      if (!bounds) return null;
      return {
        x: bounds.x + bounds.width + 12,
        y: bounds.y - 8,
      };
    }

    if (context.tool === "direct-select") {
      const bounds = this.directSelectController.getSelectionScreenBounds();
      if (bounds) {
        return {
          x: bounds.x + bounds.width + 12,
          y: bounds.y - 8,
        };
      }

      const point = this.directSelectController.getLastSelectionViewport();
      if (!point) return null;
      return { x: point.x + 12, y: point.y - 8 };
    }

    return null;
  }

  private updateFunctionsPanel() {
    if (this.duplicateDragSession) {
      this.functionsPanel.close("hidden");
      return;
    }

    const context = this.buildFunctionContext();
    const functions = getAvailableFunctions(context);
    const nextKey = this.getFunctionsPanelKey(
      context,
      functions.map((fn) => fn.id),
    );

    if (functions.length === 0) {
      this.lastFunctionsPanelKey = "";
      this.functionsPanelDismissed = false;
      this.functionsPanel.functions = [];
      this.functionsPanel.close("hidden");
      return;
    }

    if (nextKey !== this.lastFunctionsPanelKey) {
      this.lastFunctionsPanelKey = nextKey;
      this.functionsPanelDismissed = false;
    }

    this.functionsPanel.functions = functions;
    if (this.functionsPanelDismissed) return;

    const position = this.getFunctionsPanelPosition(context);
    if (!position) {
      this.functionsPanel.close("hidden");
      return;
    }

    if (this.functionsPanel.open) {
      this.functionsPanel.setPosition(position.x, position.y);
    } else {
      this.functionsPanel.show(position.x, position.y);
    }
  }

  private syncFunctionsPanelPosition() {
    if (!this.functionsPanel.open || this.functionsPanelDismissed || this.duplicateDragSession) return;
    const position = this.getFunctionsPanelPosition(this.buildFunctionContext());
    if (!position) {
      this.functionsPanel.close("hidden");
      return;
    }
    this.functionsPanel.setPosition(position.x, position.y);
  }

  private onColorPickerChange(color: string) {
    const items = selectionStore.get().items.filter((item) => item.parent);
    if (items.length === 0) return;
    for (const item of items) {
      this.paperRenderer.setItemFillColor(item, color);
    }
    if (toolStore.get() === "select") this.selectionController.drawUI();
    if (toolStore.get() === "direct-select") this.directSelectController.drawUI();
  }

  private onColorPickerChangeEnd(color: string) {
    const items = selectionStore.get().items.filter((item) => item.parent);
    if (items.length === 0) return;
    for (const item of items) {
      this.paperRenderer.setItemFillColor(item, color);
    }
    this.historyManager.snapshot();
  }

  private pickColorAt(point: Point) {
    const viewportPoint = pixelToViewport(point, this.config);
    const item = this.paperRenderer.hitTest(viewportPoint);
    if (!item) return;

    let sample: paper.Color | null = null;
    if ("fillColor" in item && item.fillColor) {
      sample = item.fillColor;
    } else if ("strokeColor" in item && item.strokeColor) {
      sample = item.strokeColor;
    }
    if (!sample) return;

    const toHex = (channel: number) =>
      Math.round(Math.max(0, Math.min(1, channel)) * 255)
        .toString(16)
        .padStart(2, "0");
    const pickedColor = `#${toHex(sample.red)}${toHex(sample.green)}${toHex(sample.blue)}`;

    colorStore.set(pickedColor);
    prevColorStore.set(pickedColor);
  }

  private onPixelResChange(scale: number) {
    this.pixelResScale = scale;
    this.config = this.calculateConfig();
    this.resizeCanvases();
    this.pixelCanvasManager.clear();
    configStore.set(this.config); // Propagates to all subscribers
    this.redrawActiveSelectionUI();
    // Resizing #ui-canvas (via resizeCanvases -> uiOverlay.updateConfig) can
    // invalidate in-flight pointer captures on some mobile browsers. Clear
    // any stale input state so the next pointerdown starts a clean stroke.
    this.inputManager.resetInputState();
  }

  private onFlatten() {
    const flattenedLayerId = this.paperRenderer.flattenAllLayers();
    if (flattenedLayerId) {
      const state = layerStore.get();
      const survivingLayer =
        state.layers.find((layer) => layer.id === flattenedLayerId) ?? state.layers[0];

      if (survivingLayer) {
        layerStore.set({
          layers: [{ ...survivingLayer, visible: true }],
          activeLayerId: survivingLayer.id,
        });
      }
    }

    this.selectionController.clearSelection();
    this.directSelectController.clearSelection();
    this.historyManager.snapshot();
  }

  private onClear() {
    this.pixelCanvasManager.clear();
    this.paperRenderer.clearActiveLayer(); // Only clear the active layer
    this.selectionController.clearSelection();
    this.directSelectController.clearSelection();
    this.historyManager.snapshot(); // Record as a history action (not clear history)
  }

  private onAliasFixToggle(enabled: boolean) {
    this.paperRenderer.setAliasFixEnabled(enabled);
  }

  // ============================================================
  // Input Manager Handlers
  // ============================================================

  private onInputToolChange(tool: ToolId) {
    this.switchTool(tool);
  }

  private switchTool(next: ToolId) {
    const prev = toolStore.get();
    if (prev !== next) prevToolStore.set(prev);
    this.onToolChange(next);
    toolStore.set(next);
    this.inputManager.setTool(next);
  }

  private onModifiersChange(modifiers: Modifiers) {
    // Update modifiers store (panels subscribe to it)
    modifiersStore.set(modifiers);
  }

  // ============================================================
  // History (Undo/Redo) Handlers
  // ============================================================

  private onUndo() {
    if (this.historyManager.undo()) {
      this.selectionController.clearSelection();
      this.directSelectController.clearSelection();
      this.functionsPanel.close("hidden");
    }
  }

  private onRedo() {
    if (this.historyManager.redo()) {
      this.selectionController.clearSelection();
      this.directSelectController.clearSelection();
      this.functionsPanel.close("hidden");
    }
  }

  // ============================================================
  // Layer Handlers
  // ============================================================

  private onLayerAdd(id: string, name: string) {
    // Create the layer in Paper.js
    this.paperRenderer.createLayer(id, name);
    
    // Update the store
    layerStore.update((state) => ({
      layers: [...state.layers, { id, name, visible: true }],
      activeLayerId: id,
    }));
    
    // Clear selection when switching layers
    this.selectionController.clearSelection();
    this.directSelectController.clearSelection();
    
    // Snapshot for undo/redo
    this.historyManager.snapshot();
  }

  private onLayerDelete(layerId: string) {
    const state = layerStore.get();
    
    // Don't delete the last layer
    if (state.layers.length <= 1) return;
    
    // Delete from Paper.js
    if (!this.paperRenderer.deleteLayer(layerId)) return;
    
    // Update the store
    const remainingLayers = state.layers.filter((l) => l.id !== layerId);
    const newActiveId = state.activeLayerId === layerId
      ? remainingLayers[remainingLayers.length - 1].id
      : state.activeLayerId;
    
    layerStore.set({
      layers: remainingLayers,
      activeLayerId: newActiveId,
    });
    
    // Clear selection when deleting layers
    this.selectionController.clearSelection();
    this.directSelectController.clearSelection();
    
    // Snapshot for undo/redo
    this.historyManager.snapshot();
  }

  private onLayerSelect(layerId: string) {
    // Set active layer in Paper.js
    if (!this.paperRenderer.setActiveLayer(layerId)) return;

    // Update the store
    layerStore.update((state) => ({
      ...state,
      activeLayerId: layerId,
    }));

    // Layer-panel click always routes through the select tool: switch to it
    // (if not already active) and select every item on the active layer.
    if (toolStore.get() !== "select") {
      this.switchTool("select");
    }
    const allItems = this.paperRenderer.getAllPaths();
    this.selectionController.setSelectedItems(allItems);
  }

  private onLayerRename(layerId: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const state = layerStore.get();
    if (!state.layers.some((l) => l.id === layerId)) return;
    if (!this.paperRenderer.setLayerName(layerId, trimmed)) return;
    layerStore.update((s) => ({
      ...s,
      layers: s.layers.map((l) => (l.id === layerId ? { ...l, name: trimmed } : l)),
    }));
    this.historyManager.snapshot();
  }

  private onLayerVisibilityToggle(layerId: string) {
    const state = layerStore.get();
    const layer = state.layers.find((l) => l.id === layerId);
    if (!layer) return;
    
    const newVisibility = !layer.visible;
    
    // Update Paper.js layer visibility
    this.paperRenderer.setLayerVisibility(layerId, newVisibility);
    
    // Update the store
    layerStore.update((state) => ({
      ...state,
      layers: state.layers.map((l) =>
        l.id === layerId ? { ...l, visible: newVisibility } : l
      ),
    }));
  }

  private onFunctionInvoke(functionId: string) {
    runFunction(functionId, this.buildFunctionContext(), {
      paperRenderer: this.paperRenderer,
      selectionController: this.selectionController,
      directSelectController: this.directSelectController,
      historyManager: this.historyManager,
      camera: this.camera,
      closePanel: () => this.functionsPanel.close("hidden"),
    });
  }

  private onFunctionDragStart(functionId: string) {
    if (functionId !== "duplicate") return;
    const context = this.buildFunctionContext();
    if (context.tool !== "select" || context.items.length === 0) return;

    const items = context.items
      .map((item) => this.paperRenderer.duplicateItem(item, 0, 0))
      .filter((item): item is paper.PathItem => item !== null);
    if (items.length === 0) return;

    this.duplicateDragSession = {
      items,
      lastWorldDelta: { x: 0, y: 0 },
    };
    this.selectionController.setSelectedItems(items, { didMove: true });
    this.functionsPanel.close("hidden");
  }

  private onFunctionDragMove(functionId: string, dx: number, dy: number) {
    if (functionId !== "duplicate" || !this.duplicateDragSession) return;

    const worldDelta = this.camera.screenDeltaToWorld(dx, dy);
    const stepX = worldDelta.x - this.duplicateDragSession.lastWorldDelta.x;
    const stepY = worldDelta.y - this.duplicateDragSession.lastWorldDelta.y;
    if (stepX === 0 && stepY === 0) return;

    for (const item of this.duplicateDragSession.items) {
      if (!item.parent) continue;
      item.position = item.position.add(new paper.Point(stepX, stepY));
    }
    this.duplicateDragSession.lastWorldDelta = worldDelta;
    paper.view.update();
    this.selectionController.drawUI();
  }

  private onFunctionDragEnd(functionId: string, dx: number, dy: number) {
    if (functionId !== "duplicate" || !this.duplicateDragSession) return;

    this.onFunctionDragMove(functionId, dx, dy);

    const items = this.duplicateDragSession.items.filter((item) => item.parent);
    this.duplicateDragSession = null;
    this.selectionController.setSelectedItems(items, { didMove: true });
  }

  private onExportViewSvg() {
    const svg = this.paperRenderer.exportViewAsSvgString();
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `inkwell-view-${Date.now()}.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  private onLayerReorder(orderedTopToBottom: string[]) {
    const state = layerStore.get();
    const layersById = new Map(state.layers.map((layer) => [layer.id, layer]));

    // Store and renderer use bottom->top order; panel emits top->bottom.
    const orderedBottomToTop = [...orderedTopToBottom].reverse();
    if (orderedBottomToTop.length !== state.layers.length) return;

    const reorderedLayers = orderedBottomToTop
      .map((id) => layersById.get(id))
      .filter((layer): layer is NonNullable<typeof layer> => Boolean(layer));

    if (reorderedLayers.length !== state.layers.length) return;

    this.paperRenderer.reorderLayers(orderedBottomToTop);
    layerStore.set({
      layers: reorderedLayers,
      activeLayerId: state.activeLayerId,
    });

    this.historyManager.snapshot();
  }
}

// Initialize app when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", async () => {
    const app = new App();
    await app.init();
  });
} else {
  (async () => {
    const app = new App();
    await app.init();
  })();
}
