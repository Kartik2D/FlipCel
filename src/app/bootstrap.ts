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
import { UnifiedInputManager } from "../input/pointer-gestures";
import { PixelCanvas } from "../tools/pixel-canvas";
import { Tracer } from "../tracing/potrace-tracer";
import { PaperRenderer } from "../render/paper-renderer";
import { FeedbackLayer } from "../render/feedback-layer";
import { StageLayer } from "../render/stage-layer";
import { ChromeLayer } from "../render/chrome-layer";
import { Camera } from "../render/camera";
import { SelectionController } from "../editing/object-select";
import { DirectSelectController } from "../editing/direct-select";
import { MagnetController } from "../editing/magnet";
import { MagicMoveController } from "../editing/magic-move";
import { MagicMorphController } from "../editing/magic-morph";
import { HistoryManager } from "../document/history";
import {
  DocumentManager,
  timelineStore,
  type SerializedDocument,
} from "../document/document";
import { saveAutosave, debounce } from "../document/persistence";
import { bus, Events } from "../input/event-bus";
import type { CanvasConfig, Point, Modifiers } from "../geometry/types";
import { cycleDockMode, type ToolId, type AllToolSettings } from "../tools/registry";
import { pixelToViewport } from "../geometry/coords";
import {
  getAvailableContextualActions,
  runContextualAction,
  type ContextualActionContext,
} from "../editing/contextual-actions";
import type {
  InkwellColorPanel,
  InkwellColorPopup,
  InkwellToolsPanel,
  InkwellUniversalPanel,
  InkwellStartupPanel,
  InkwellViewPanel,
  InkwellShortcutsPanel,
  InkwellLayersPanel,
  InkwellWheelPanel,
  InkwellFunctionsPanel,
  InkwellMagicMovePopup,
  InkwellMagicMorphPopup,
} from "../ui/register";
import "../ui/register"; // Register Lit components
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
  symmetryStore,
  themeModeStore,
  stageStore,
  stageSelectedStore,
  STAGE_LAYER_ID,
  THEMES,
  persistTheme,
  type ThemeMode,
} from "../state/index";
import { getStageFitViewportInsets } from "../render/stage-fit-insets";
import { bindPanelEvents } from "./panel-bridge";
import { ToolSession } from "./tool-session";
import { TimelineSession, createBlankSerializedDocument } from "./timeline-session";

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
  private stageCanvas: HTMLCanvasElement;
  private pixelCanvas: HTMLCanvasElement;
  private uiCanvas: HTMLCanvasElement;
  private chromeCanvas: HTMLCanvasElement;
  private stageCanvas2D: CanvasRenderingContext2D;
  private pixelCanvas2D: CanvasRenderingContext2D;
  private uiCanvas2D: CanvasRenderingContext2D;
  private chromeCanvas2D: CanvasRenderingContext2D;
  private config: CanvasConfig;
  private inputManager: UnifiedInputManager;
  private pixelCanvasManager: PixelCanvas;
  private tracer: Tracer;
  private paperRenderer: PaperRenderer;
  private feedbackLayer: FeedbackLayer;
  private stageLayer: StageLayer;
  private chromeLayer: ChromeLayer;
  private selectionController: SelectionController;
  private directSelectController: DirectSelectController;
  private magnetController: MagnetController;
  private magicMoveController: MagicMoveController;
  private magicMorphController: MagicMorphController;
  private historyManager: HistoryManager;
  private documentManager: DocumentManager;
  private readonly scheduleAutosave = debounce(() => {
    void saveAutosave(this.serializeDocument()).catch((err) => {
      console.error("Autosave failed:", err);
    });
  }, 800);
  private colorPanel: InkwellColorPanel;
  private colorPopup: InkwellColorPopup;
  private toolsPanel: InkwellToolsPanel;
  private universalPanel: InkwellUniversalPanel;
  private startupPanel: InkwellStartupPanel;
  private viewPanel: InkwellViewPanel;
  private shortcutsPanel: InkwellShortcutsPanel;
  private layersPanel: InkwellLayersPanel;
  private wheelPanel: InkwellWheelPanel;
  private functionsPanel: InkwellFunctionsPanel;
  private magicMovePopup: InkwellMagicMovePopup;
  private magicMorphPopup: InkwellMagicMorphPopup;
  private camera: Camera;
  private isInitialized = false;
  private pixelResScale = 2;
  private toolSession!: ToolSession;
  private timelineSession!: TimelineSession;

  private rotationSnapRaf: number | null = null;

  private cameraLoopLastMs = performance.now();
  /** One-shot flag: forces the next camera-loop frame to repaint even when the camera is settled. */
  private redrawRequested = true;
  private lastDisplayZoom = Number.NaN;
  private functionsPanelDismissed = false;
  private lastFunctionsPanelKey = "";
  private stageColorPickerSession = false;
  private selectionGestureActive = false;
  private duplicateDragSession:
    | {
        items: paper.PathItem[];
        lastWorldDelta: { x: number; y: number };
      }
    | null = null;
  /**
   * Safety net: duplicate drags start from the floating functions panel.
   * If that panel hides/re-renders mid-gesture, its pointerup/cancel can be
   * dropped, leaving duplicateDragSession stuck forever. Global listeners
   * guarantee we always finalize the session.
   */
  private readonly globalDuplicateDragEndHandler = () => {
    if (!this.duplicateDragSession) return;
    this.finalizeDuplicateDragSession();
  };

  constructor() {
    // Get canvas elements
    this.stageCanvas = document.getElementById("stage-canvas") as HTMLCanvasElement;
    this.paperCanvas = document.getElementById("paper-canvas") as HTMLCanvasElement;
    this.pixelCanvas = document.getElementById("pixel-canvas") as HTMLCanvasElement;
    this.uiCanvas = document.getElementById("ui-canvas") as HTMLCanvasElement;
    this.chromeCanvas = document.getElementById("chrome-canvas") as HTMLCanvasElement;

    if (
      !this.stageCanvas ||
      !this.paperCanvas ||
      !this.pixelCanvas ||
      !this.uiCanvas ||
      !this.chromeCanvas
    ) {
      throw new Error("Canvas elements not found");
    }

    // Get 2D contexts
    const stageCtx = this.stageCanvas.getContext("2d");
    const pixelCtx = this.pixelCanvas.getContext("2d");
    const uiCtx = this.uiCanvas.getContext("2d");
    const chromeCtx = this.chromeCanvas.getContext("2d");

    if (!stageCtx || !pixelCtx || !uiCtx || !chromeCtx) {
      throw new Error("Could not get 2D contexts");
    }

    this.stageCanvas2D = stageCtx;
    this.pixelCanvas2D = pixelCtx;
    this.uiCanvas2D = uiCtx;
    this.chromeCanvas2D = chromeCtx;

    // Calculate configuration
    this.config = this.calculateConfig();

    // Initialize camera: frame stage in view (same as dock zoom chip — see fitStageInView)
    this.camera = new Camera(this.config.viewportWidth, this.config.viewportHeight);
    this.fitStageInView(true);

    // Initialize components
    this.pixelCanvasManager = new PixelCanvas(this.pixelCanvas, this.pixelCanvas2D, this.config);
    this.tracer = new Tracer(potrace, init);
    this.paperRenderer = new PaperRenderer(this.paperCanvas, this.config);
    this.paperRenderer.setCamera(this.camera);
    this.feedbackLayer = new FeedbackLayer(this.uiCanvas, this.uiCanvas2D, this.config);
    this.feedbackLayer.setCamera(this.camera);
    this.stageLayer = new StageLayer(this.stageCanvas, this.stageCanvas2D, this.config);
    this.stageLayer.setCamera(this.camera);
    this.chromeLayer = new ChromeLayer(
      this.chromeCanvas,
      this.chromeCanvas2D,
      this.config,
    );
    this.selectionController = new SelectionController(
      this.paperRenderer,
      this.camera,
      this.chromeLayer,
    );
    this.directSelectController = new DirectSelectController(
      this.paperRenderer,
      this.camera,
      this.chromeLayer,
    );
    this.magnetController = new MagnetController(this.paperRenderer, this.camera);
    this.magicMoveController = new MagicMoveController(
      this.paperRenderer,
      this.camera,
      this.chromeLayer,
    );
    this.magicMorphController = new MagicMorphController(
      this.paperRenderer,
      this.camera,
      this.chromeLayer,
    );
    this.documentManager = new DocumentManager(this.paperRenderer);
    this.historyManager = new HistoryManager(this.documentManager);
    this.historyManager.setOnChange(() => this.scheduleAutosave());
    this.magicMoveController.setDocumentManager(this.documentManager);
    this.magicMoveController.setHistoryManager(this.historyManager);
    this.magicMorphController.setDocumentManager(this.documentManager);
    this.magicMorphController.setHistoryManager(this.historyManager);
    this.selectionController.setSnapshotCallback(() => this.historyManager.snapshot());
    this.selectionController.setLiveEditStartCallback(() =>
      this.documentManager.refreshOnionSkin(),
    );
    this.selectionController.setActivateLayerCallback((layerId) =>
      this.activateLayerFromSelect(layerId),
    );
    this.directSelectController.setSnapshotCallback(() => this.historyManager.snapshot());
    this.directSelectController.setLiveEditStartCallback(() =>
      this.documentManager.refreshOnionSkin(),
    );
    this.directSelectController.setActivateLayerCallback((layerId) =>
      this.activateLayerFromSelect(layerId),
    );
    this.directSelectController.setReconcileCallback((items) => {
      const expanded = this.paperRenderer.expandIncomingWithSymmetry(items);
      return this.paperRenderer.reconcileItemsToFixpoint(expanded);
    });
    this.magnetController.setSnapshotCallback(() => this.historyManager.snapshot());
    this.magnetController.setLiveEditStartCallback(() =>
      this.documentManager.refreshOnionSkin(),
    );
    this.magnetController.setReconcileCallback((items) => {
      const expanded = this.paperRenderer.expandIncomingWithSymmetry(items);
      return this.paperRenderer.reconcileItemsToFixpoint(expanded);
    });

    // Get panel Lit elements
    this.colorPanel = document.getElementById("color-panel") as InkwellColorPanel;
    this.colorPopup = document.getElementById("color-popup") as InkwellColorPopup;
    this.toolsPanel = document.getElementById("tools-panel") as InkwellToolsPanel;
    this.universalPanel = document.getElementById("universal-panel") as InkwellUniversalPanel;
    this.startupPanel = document.getElementById("startup-panel") as InkwellStartupPanel;
    this.viewPanel = document.getElementById("view-panel") as InkwellViewPanel;
    this.shortcutsPanel = document.getElementById("shortcuts-panel") as InkwellShortcutsPanel;
    this.layersPanel = document.getElementById("layers-panel") as InkwellLayersPanel;
    this.wheelPanel = document.getElementById("wheel-panel") as InkwellWheelPanel;
    this.functionsPanel = document.getElementById("functions-panel") as InkwellFunctionsPanel;
    this.magicMovePopup = document.getElementById(
      "magic-move-popup",
    ) as InkwellMagicMovePopup;
    this.magicMorphPopup = document.getElementById(
      "magic-morph-popup",
    ) as InkwellMagicMorphPopup;
    this.timelineSession = new TimelineSession({
      documentManager: this.documentManager,
      historyManager: this.historyManager,
      selectionController: this.selectionController,
      directSelectController: this.directSelectController,
      magicMoveController: this.magicMoveController,
      magicMorphController: this.magicMorphController,
      paperRenderer: this.paperRenderer,
      layersPanel: this.layersPanel,
      closeFunctionsPanelHidden: () => this.functionsPanel.close("hidden"),
      switchTool: (tool) => this.switchTool(tool),
      requestRedraw: () => this.requestRedraw(),
      fitStageInView: (immediate) => this.fitStageInView(immediate),
    });
    this.setupPanelEvents();
    const onMagicMoveApply = () => {
      const result = this.magicMoveController.apply();
      if (!result.ok) {
        console.warn("Magic Move:", result.error);
      }
      this.requestRedraw();
    };
    this.toolsPanel.addEventListener("magic-move-apply", onMagicMoveApply);
    this.magicMovePopup.addEventListener("magic-move-apply", onMagicMoveApply);
    const onMagicMorphApply = () => {
      const result = this.magicMorphController.apply();
      if (!result.ok) {
        console.warn("Magic Morph:", result.error);
      }
      this.requestRedraw();
    };
    this.toolsPanel.addEventListener("magic-morph-apply", onMagicMorphApply);
    this.magicMorphPopup.addEventListener("magic-morph-apply", onMagicMorphApply);
    window.addEventListener("pointerup", this.globalDuplicateDragEndHandler);
    window.addEventListener("pointercancel", this.globalDuplicateDragEndHandler);
    window.addEventListener("blur", this.globalDuplicateDragEndHandler);

    viewOverlayStore.subscribeImmediate((prefs) => {
      this.feedbackLayer.setViewOverlayPrefs(prefs);
      this.redrawActiveSelectionUI();
    });

    symmetryStore.subscribeImmediate((prefs) => {
      this.feedbackLayer.setSymmetryPrefs(prefs);
      this.requestRedraw();
    });

    timelineStore.subscribeImmediate((timeline) => {
      this.feedbackLayer.setPlaybackActive(timeline.playing);
    });

    // Keep the layer panel's active row honest: the Stage row can only be
    // "active" while it is actually selected. Without this, deselecting the
    // stage (e.g. by switching tools) left activeLayerId stuck on "stage"
    // while drawing landed on whatever Paper layer was active before.
    stageSelectedStore.subscribe((selected) => {
      if (selected) return;
      if (layerStore.get().activeLayerId !== STAGE_LAYER_ID) return;
      const paperActiveId = this.paperRenderer.getActiveLayerId();
      if (paperActiveId) {
        layerStore.update((s) => ({ ...s, activeLayerId: paperActiveId }));
      }
    });

    selectionStore.subscribeImmediate((selection) => {
      if (stageSelectedStore.get() && selection.items.some((i) => i.parent)) {
        stageSelectedStore.set(false);
        const first = selection.items.find((i) => i.parent);
        if (first) {
          const lid = this.paperRenderer.getLayerIdForPathItem(first);
          if (lid) {
            this.paperRenderer.setActiveLayer(lid);
            layerStore.update((s) => ({ ...s, activeLayerId: lid }));
          }
        }
      }
      this.onSelectionItemsChange(selection.items);
    });

    // Initialize unified input manager
    this.inputManager = new UnifiedInputManager(this.uiCanvas, this.config);
    this.toolSession = new ToolSession({
      getConfig: () => this.config,
      getPixelCanvas: () => this.pixelCanvas,
      camera: this.camera,
      documentManager: this.documentManager,
      selectionController: this.selectionController,
      directSelectController: this.directSelectController,
      magnetController: this.magnetController,
      magicMoveController: this.magicMoveController,
      magicMorphController: this.magicMorphController,
      paperRenderer: this.paperRenderer,
      pixelCanvasManager: this.pixelCanvasManager,
      feedbackLayer: this.feedbackLayer,
      tracer: this.tracer,
      historyManager: this.historyManager,
      setSelectionGestureActive: (active) => {
        this.selectionGestureActive = active;
      },
      setFunctionsPanelDismissed: (dismissed) => {
        this.functionsPanelDismissed = dismissed;
      },
      updateFunctionsPanel: () => this.updateFunctionsPanel(),
      pickColorAt: (point) => this.pickColorAt(point),
      closeFunctionsPanelHidden: () => this.functionsPanel.close("hidden"),
    });
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
    });
    bus.on(Events.PINCH_GESTURE_END, () => {
      this.maybeSnapRotationToZero();
    });
    bus.on(Events.TOOL_CHANGE, (tool: ToolId) => this.onInputToolChange(tool));
    bus.on(Events.MODIFIERS_CHANGE, (m: Modifiers) => this.onModifiersChange(m));
    bus.on(Events.UNDO, () => this.onUndo());
    bus.on(Events.REDO, () => this.onRedo());
  }

  private setupPanelEvents() {
    bindPanelEvents({
      colorPanel: this.colorPanel,
      colorPopup: this.colorPopup,
      toolsPanel: this.toolsPanel,
      universalPanel: this.universalPanel,
      viewPanel: this.viewPanel,
      shortcutsPanel: this.shortcutsPanel,
      layersPanel: this.layersPanel,
      wheelPanel: this.wheelPanel,
      functionsPanel: this.functionsPanel,

      onColorPickerChange: (color) => this.onColorPickerChange(color),
      onColorPickerChangeEnd: (color) => this.onColorPickerChangeEnd(color),
      onStageColorPickerHidden: () => {
        this.stageColorPickerSession = false;
      },
      switchTool: (tool) => this.switchTool(tool),
      onToolSettingsChange: (settings) => this.onToolSettingsChange(settings),
      onPixelResChange: (scale) => this.onPixelResChange(scale),
      onFlatten: () => this.onFlatten(),
      onClear: () => this.onClear(),
      onUndo: () => this.onUndo(),
      onRedo: () => this.onRedo(),
      setBrushSizeIndicatorEnabled: (enabled) => {
        this.feedbackLayer.setBrushSizeIndicatorEnabled(enabled);
      },
      onOnionToggle: () => this.onOnionToggle(),
      onDockZoomReset: () => this.onDockZoomReset(),
      onModeCycle: () => this.onModeCycle(),
      onPlayToggle: () => this.onPlayToggle(),
      onAliasFixToggle: (enabled) => this.onAliasFixToggle(enabled),
      openStageColorPicker: (anchor) => {
        const stageColor = stageStore.get().color;
        colorStore.set(stageColor);
        prevColorStore.set(stageColor);
        this.stageColorPickerSession = true;
        void this.colorPopup.showNearAnchor(anchor);
      },
      onStageSizeChange: () => {
        this.historyManager.snapshot();
      },
      onExportViewSvg: () => this.onExportViewSvg(),
      onDocSave: () => this.onDocSave(),
      onDocOpen: () => this.onDocOpen(),
      onDocNew: () => this.onDocNew(),
      onTimelineFrameSelect: (frame, layerId, options) =>
        this.onTimelineFrameSelect(frame, layerId, options),
      onKeyframeAdd: (blank) => this.onKeyframeAdd(blank),
      onKeyframeRemove: (range) => this.onKeyframeRemove(range),
      onFramesMove: (layerIds, layerId, start, end, delta) =>
        this.onFramesMove(layerIds, layerId, start, end, delta),
      onFramesDuplicate: (layerIds, layerId, start, end) =>
        this.onFramesDuplicate(layerIds, layerId, start, end),
      onFramesDuplicateDragStart: (layerIds, layerId, start, end) =>
        this.onFramesDuplicateDragStart(layerIds, layerId, start, end),
      onFramesDuplicateDragEnd: (layerIds, layerId, start, end, delta) =>
        this.onFramesDuplicateDragEnd(layerIds, layerId, start, end, delta),
      onFramesReverse: (layerIds, layerId, start, end) =>
        this.onFramesReverse(layerIds, layerId, start, end),
      onEditMultipleFramesToggle: (enabled, layerIds, layerId, start, end) =>
        this.onEditMultipleFramesToggle(enabled, layerIds, layerId, start, end),
      onKeyframeHoldToggle: (layerId, frame) => this.onKeyframeHoldToggle(layerId, frame),
      onAutoHoldToggle: () => {
        this.documentManager.setAutoHold(!this.documentManager.isAutoHoldEnabled());
      },
      onDurationSet: (frames) => {
        if (this.documentManager.setDuration(frames)) {
          this.historyManager.snapshot();
          this.requestRedraw();
        }
      },
      onFrameRateChange: (rate) => {
        this.documentManager.setFrameRate(rate);
        this.scheduleAutosave();
      },
      onLayerAdd: (id, name) => this.onLayerAdd(id, name),
      onLayerDelete: (layerId) => this.onLayerDelete(layerId),
      onLayerSelect: (layerId) => this.onLayerSelect(layerId),
      onLayerVisibilityToggle: (layerId) => this.onLayerVisibilityToggle(layerId),
      onLayerLockToggle: (layerId) => this.onLayerLockToggle(layerId),
      onLayerSoloToggle: (layerId) => this.onLayerSoloToggle(layerId),
      onLayerReorder: (order, movedId) => this.onLayerReorder(order, movedId),
      onLayerRename: (id, name) => this.onLayerRename(id, name),
      onFunctionInvoke: (id) => this.onFunctionInvoke(id),
      onFunctionDragStart: (id) => this.onFunctionDragStart(id),
      onFunctionDragMove: (id, dx, dy) => this.onFunctionDragMove(id, dx, dy),
      onFunctionDragEnd: (id, dx, dy) => this.onFunctionDragEnd(id, dx, dy),
      onFunctionsDismissed: () => {
        this.functionsPanelDismissed = true;
      },
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
    this.stageCanvas.style.width = `${viewportWidth}px`;
    this.stageCanvas.style.height = `${viewportHeight}px`;
    this.paperCanvas.style.width = `${viewportWidth}px`;
    this.paperCanvas.style.height = `${viewportHeight}px`;
    this.pixelCanvas.style.width = `${viewportWidth}px`;
    this.pixelCanvas.style.height = `${viewportHeight}px`;
    this.uiCanvas.style.width = `${viewportWidth}px`;
    this.uiCanvas.style.height = `${viewportHeight}px`;
    // Chrome canvas sizing (CSS + internal) is handled by ChromeLayer.updateConfig.

    // Set internal resolution
    this.pixelCanvas.width = this.config.pixelWidth;
    this.pixelCanvas.height = this.config.pixelHeight;
    this.feedbackLayer.updateConfig(this.config);
    this.stageLayer.updateConfig(this.config);
    this.chromeLayer.updateConfig(this.config);

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
    const defaultLayer =
      initialLayerState.layers.find((l) => l.kind !== "stage") ?? initialLayerState.layers[0];
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
      this.requestRedraw();
    });

    // Always start on a blank document; startup can restore autosave from before launch.
    await this.timelineSession.captureSessionAutosaveCandidate();
    this.startupPanel.canRestoreAutosave = this.timelineSession.hasSessionAutosaveCandidate();
    this.applyLoadedDocument(createBlankSerializedDocument());

    // Take initial history snapshot (baseline for undo)
    this.historyManager.snapshot();

    this.startCameraFrameLoop();
    this.setupStartupPanel();
    this.startupPanel.show();

    console.log("App initialized with Lit UI components and stores");
  }

  private setupStartupPanel() {
    this.startupPanel.addEventListener("startup-load-file", async () => {
      const opened = await this.timelineSession.onDocOpen();
      if (opened) this.startupPanel.hidePanel();
    });
    this.startupPanel.addEventListener("startup-restore-autosave", async () => {
      const restored = await this.timelineSession.restoreAutosaveDocument();
      if (restored) {
        this.startupPanel.hidePanel();
      } else {
        alert("No previous file was found to restore.");
      }
    });
    this.startupPanel.addEventListener("startup-load-example", () => {
      this.timelineSession.loadExampleDocument();
    });
  }

  /**
   * Request a full repaint (Paper view matrix, overlays, selection chrome)
   * on the next camera-loop frame. Cheap to call repeatedly.
   */
  requestRedraw(): void {
    this.redrawRequested = true;
  }

  /**
   * Camera: targets update on input; present pose eases toward target each frame for Paper + UI.
   *
   * The loop itself runs forever, but all redraw work is gated: when the
   * camera pose is settled and nothing requested a repaint, a frame is a
   * no-op. Event-driven paths (tool handlers, store subscriptions, Paper
   * mutations) repaint their own surfaces directly, so idle frames cost
   * nothing — previously this loop repainted the entire document at 60fps
   * even when nothing changed.
   */
  private startCameraFrameLoop() {
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - this.cameraLoopLastMs) / 1000);
      this.cameraLoopLastMs = now;
      this.stepPlayback(dt * 1000);
      const cameraMoved = this.camera.stepLerp(dt);
      if (cameraMoved || this.redrawRequested) {
        this.redrawRequested = false;
        this.paperRenderer.applyCamera();
        // Grid + brush ring live on #ui-canvas; stage fill on #stage-canvas.
        this.feedbackLayer.redraw();
        this.stageLayer.redraw();
        // Selection chrome lives on a separate canvas; repaint independently.
        this.redrawActiveSelectionUI();
        this.syncFunctionsPanelPosition();
        this.updateDisplays();
      }
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
      this.feedbackLayer.updateConfig(config);
      this.stageLayer.updateConfig(config);
      this.inputManager.updateConfig(config);
      this.paperRenderer.updateConfig(config);
    });

    // Tool settings store - update UI overlay with brush max size
    toolSettingsStore.subscribe((settings) => {
      const brushSettings = settings.brush as { sizeMax?: number };
      if (brushSettings.sizeMax !== undefined) {
        this.feedbackLayer.setMaxBrushSize(brushSettings.sizeMax);
      }
      const magnetSettings = settings.magnet as { size?: number } | undefined;
      if (magnetSettings && typeof magnetSettings.size === "number") {
        this.feedbackLayer.setMagnetSize(magnetSettings.size);
      }
    });

    // Tool store - sync with inputManager + overlay (brush ring only when brush is active)
    toolStore.subscribeImmediate((tool) => {
      this.inputManager.setTool(tool);
      this.feedbackLayer.setActiveTool(tool);
      this.updateFunctionsPanel();
    });

    themeModeStore.subscribeImmediate((mode) => {
      this.applyTheme(mode);
    });
  }

  private applyTheme(mode: ThemeMode) {
    const { colorScheme } = THEMES[mode];
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = colorScheme;
    persistTheme(mode);
    this.feedbackLayer.redraw();
    this.redrawActiveSelectionUI();
    this.requestRedraw();
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
      // Direct-select still calls drawUI() unconditionally so the chrome
      // canvas is cleared every frame. The controller decides what (if
      // anything) to paint — nothing is drawn until at least one anchor
      // is picked.
      this.directSelectController.drawUI();
      return;
    }
    if (currentTool === "select" && this.selectionController.hasTransientUI()) {
      this.selectionController.drawUI();
      return;
    }
    if (currentTool === "magic-move" && this.magicMoveController.hasTransientUI()) {
      this.magicMoveController.drawUI();
      return;
    }
    if (currentTool === "magic-morph" && this.magicMorphController.hasTransientUI()) {
      this.magicMorphController.drawUI();
      return;
    }
    this.chromeLayer.clear();
  }

  // ============================================================
  // Display Updates
  // ============================================================

  private updateDisplays() {
    const zoom = this.camera.getZoomPercent();
    if (zoom === this.lastDisplayZoom) return;
    this.lastDisplayZoom = zoom;
    this.shortcutsPanel.zoomLevel = zoom;
  }

  // ============================================================
  // Camera Control Handlers
  // ============================================================

  private onCameraPan(deltaX: number, deltaY: number) {
    this.camera.pan(deltaX, deltaY);
    this.dismissFunctionsPanelForCameraChange();
  }

  private onCameraZoom(factor: number, centerX: number, centerY: number) {
    this.camera.zoomAt(factor, centerX, centerY);
    this.dismissFunctionsPanelForCameraChange();
  }

  private onCameraRotate(deltaRadians: number, centerX: number, centerY: number) {
    this.cancelRotationSnapAnimation();
    this.camera.rotateAt(deltaRadians, centerX, centerY);
    this.dismissFunctionsPanelForCameraChange();
  }

  /** Hide the select/direct-select popup when the view moves; sticky until selection changes. */
  private dismissFunctionsPanelForCameraChange() {
    if (!this.functionsPanel.open && this.functionsPanelDismissed) return;
    this.functionsPanelDismissed = true;
    this.functionsPanel.close("hidden");
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
      // Present pose was mutated directly (bypassing stepLerp), so the gated
      // camera loop won't detect motion on its own.
      this.requestRedraw();

      if (t < 1) {
        this.rotationSnapRaf = requestAnimationFrame(tick);
      } else {
        this.rotationSnapRaf = null;
        this.camera.syncPresentPanRotationFromTarget();
        this.requestRedraw();
      }
    };

    this.rotationSnapRaf = requestAnimationFrame(tick);
  }

  /**
   * Fit the stage rect in the viewport with margins for top-bar docks (see `getStageFitViewportInsets`).
   * @param immediate — snap present pose; false when easing should run (dock zoom chip).
   */
  private fitStageInView(immediate: boolean): void {
    const stage = stageStore.get();
    const w = Math.max(1, stage.width);
    const h = Math.max(1, stage.height);
    const insets = getStageFitViewportInsets(this.config.viewportWidth, this.config.viewportHeight);
    this.camera.fitToBounds(
      { x: 0, y: 0, width: w, height: h },
      { padding: 0.06, viewportInsets: insets, immediate },
    );
  }

  private onDockZoomReset() {
    this.cancelRotationSnapAnimation();
    this.fitStageInView(false);
    this.dismissFunctionsPanelForCameraChange();
  }

  // ============================================================
  // Tool Action Handlers (from UnifiedInputManager)
  // ============================================================

  private onToolStart(point: Point, tool: ToolId) {
    this.toolSession.onToolStart(point, tool);
  }

  private onToolMove(point: Point, tool: ToolId) {
    this.toolSession.onToolMove(point, tool);
  }

  private async onToolEnd(tool: ToolId) {
    await this.toolSession.onToolEnd(tool);
  }

  private onToolCancel(tool: ToolId) {
    this.toolSession.onToolCancel(tool);
  }

  private onPointerMove(point: Point) {
    this.feedbackLayer.updateCursor(point);

    const currentTool = toolStore.get();
    if (currentTool === "select" && this.selectionController.hasTransientUI()) {
      this.redrawActiveSelectionUI();
    }
    if (currentTool === "direct-select") {
      this.redrawActiveSelectionUI();
    }
    if (currentTool === "magic-move" && this.magicMoveController.hasTransientUI()) {
      this.redrawActiveSelectionUI();
    }
    if (currentTool === "magic-morph" && this.magicMorphController.hasTransientUI()) {
      this.redrawActiveSelectionUI();
    }
  }

  // ============================================================
  // Control Panel Handlers
  // ============================================================

  private onToolChange(tool: ToolId) {
    if (tool !== "select") {
      stageSelectedStore.set(false);
      this.selectionController.clearSelection();
    }
    if (tool !== "direct-select") {
      this.directSelectController.clearSelection();
      this.functionsPanel.close("hidden");
    }
    if (tool !== "magic-move") {
      this.magicMoveController.deactivate();
    }
    if (tool !== "magic-morph") {
      this.magicMorphController.deactivate();
    }
    if (tool !== "magnet" && this.magnetController.hasActiveStroke()) {
      this.magnetController.handleCancel();
    }
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
      this.feedbackLayer.setMaxBrushSize(brushSettings.sizeMax);
    }
    const magnetSettings = settings.magnet as { size?: number } | undefined;
    if (magnetSettings && typeof magnetSettings.size === "number") {
      this.feedbackLayer.setMagnetSize(magnetSettings.size);
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

  private buildFunctionContext(): ContextualActionContext {
    return {
      tool: toolStore.get(),
      items: selectionStore.get().items.filter((item) => item.parent),
      pickedAnchorCount: this.directSelectController.getPickedAnchorCount(),
    };
  }

  private getFunctionsPanelKey(context: ContextualActionContext, functionIds: string[]): string {
    const itemIds = context.items.map((item) => item.id).sort((a, b) => a - b);
    return [
      context.tool,
      itemIds.join(","),
      context.pickedAnchorCount,
      functionIds.join(","),
    ].join("|");
  }

  private getFunctionsPanelPosition(context: ContextualActionContext): { x: number; y: number } | null {
    if (context.tool === "select") {
      const bounds = this.paperRenderer.getSelectionFrameScreenBounds(context.items);
      if (!bounds) return null;
      return {
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height + 12,
      };
    }

    if (context.tool === "direct-select") {
      const bounds = this.directSelectController.getSelectionScreenBounds();
      if (bounds) {
        return {
          x: bounds.x + bounds.width / 2,
          y: bounds.y + bounds.height + 12,
        };
      }

      const singleBounds = this.directSelectController.getSinglePickedAnchorScreenBounds();
      if (singleBounds) {
        return {
          x: singleBounds.x + singleBounds.width / 2,
          y: singleBounds.y + singleBounds.height + 12,
        };
      }

      const point = this.directSelectController.getSinglePickedAnchorViewport()
        ?? this.directSelectController.getLastSelectionViewport();
      if (!point) return null;
      return { x: point.x, y: point.y + 12 };
    }

    return null;
  }

  private updateFunctionsPanel() {
    if (this.duplicateDragSession) {
      this.functionsPanel.close("hidden");
      return;
    }

    if (this.selectionGestureActive) {
      this.functionsPanel.close("hidden");
      return;
    }

    const context = this.buildFunctionContext();
    const functions = getAvailableContextualActions(context);
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

    const didKeyChange = nextKey !== this.lastFunctionsPanelKey;
    if (didKeyChange) {
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

    if (this.functionsPanel.open && !didKeyChange) {
      return;
    }

    if (this.functionsPanel.open) {
      this.functionsPanel.setPosition(position.x, position.y);
    } else {
      this.functionsPanel.show(position.x, position.y);
    }
  }

  private syncFunctionsPanelPosition() {
    // Intentionally do nothing: the panel should open near the cursor,
    // then stay put so the user can click its buttons.
  }

  private onColorPickerChange(color: string) {
    if (this.stageColorPickerSession || stageSelectedStore.get()) {
      stageStore.update((s) => ({ ...s, color }));
      return;
    }
    const items = selectionStore.get().items.filter((item) => item.parent);
    if (items.length === 0) return;
    for (const item of items) {
      this.paperRenderer.setItemFillColor(item, color);
    }
    if (toolStore.get() === "select") this.selectionController.drawUI();
    if (toolStore.get() === "direct-select") this.directSelectController.drawUI();
  }

  private onColorPickerChangeEnd(color: string) {
    if (this.stageColorPickerSession || stageSelectedStore.get()) {
      stageStore.update((s) => ({ ...s, color }));
      this.historyManager.snapshot();
      return;
    }
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
    this.requestRedraw();
    // Resizing #ui-canvas (via resizeCanvases -> feedbackLayer.updateConfig) can
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
      const stageRow = state.layers.find((l) => l.kind === "stage");

      if (survivingLayer && stageRow) {
        layerStore.set({
          layers: [
            { ...stageRow, visible: true, locked: false },
            {
              ...survivingLayer,
              visible: true,
              locked: survivingLayer.locked ?? false,
              kind: survivingLayer.kind ?? "regular",
            },
          ],
          activeLayerId: survivingLayer.id,
          soloLayerId: null,
        });
      } else if (survivingLayer) {
        layerStore.set({
          layers: [
            {
              ...survivingLayer,
              visible: true,
              locked: survivingLayer.locked ?? false,
              kind: survivingLayer.kind ?? "regular",
            },
          ],
          activeLayerId: survivingLayer.id,
          soloLayerId: null,
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
      this.selectionController.discardSelection();
      this.directSelectController.clearSelection();
      this.functionsPanel.close("hidden");
      this.requestRedraw();
    }
  }

  private onRedo() {
    if (this.historyManager.redo()) {
      this.selectionController.discardSelection();
      this.directSelectController.clearSelection();
      this.functionsPanel.close("hidden");
      this.requestRedraw();
    }
  }

  // ============================================================
  // Layer Handlers
  // ============================================================

  private onLayerAdd(id: string, name: string) {
    stageSelectedStore.set(false);
    // Create the layer in Paper.js (it lands at the top of z-order by default).
    this.paperRenderer.createLayer(id, name);

    // Insert the new layer directly above the currently active layer in the
    // store's bottom->top ordering. If there's no active layer, fall back to
    // appending on top.
    layerStore.update((state) => {
      const activeIndex = state.layers.findIndex(
        (layer) => layer.id === state.activeLayerId,
      );
      const insertAt = activeIndex < 0 ? state.layers.length : activeIndex + 1;
      const nextLayers = [...state.layers];
      nextLayers.splice(insertAt, 0, {
        id,
        name,
        visible: true,
        locked: false,
        kind: "regular",
      });
      return {
        ...state,
        layers: nextLayers,
        activeLayerId: id,
      };
    });

    // Sync Paper.js z-order to match the store.
    const orderedBottomToTop = layerStore.get().layers.map((layer) => layer.id);
    this.paperRenderer.reorderLayers(orderedBottomToTop);

    // Clear selection when switching layers
    this.selectionController.clearSelection();
    this.directSelectController.clearSelection();

    // Snapshot for undo/redo
    this.historyManager.snapshot();
  }

  private onLayerDelete(layerId: string) {
    if (layerId === STAGE_LAYER_ID) return;
    const state = layerStore.get();
    const nonStage = state.layers.filter((l) => l.kind !== "stage");
    if (nonStage.length <= 1) return;
    
    // Delete from Paper.js
    if (!this.paperRenderer.deleteLayer(layerId)) return;
    
    // Update the store
    const remainingLayers = state.layers.filter((l) => l.id !== layerId);
    const newActiveId = state.activeLayerId === layerId
      ? remainingLayers[remainingLayers.length - 1].id
      : state.activeLayerId;
    
    const soloLayerId =
      state.soloLayerId === layerId ? null : state.soloLayerId;
    layerStore.set({
      layers: remainingLayers,
      activeLayerId: newActiveId,
      soloLayerId,
    });
    this.documentManager.applyEffectiveVisibility(soloLayerId);

    // Keep Paper.js aligned with the store. PaperRenderer.deleteLayer() picks
    // an arbitrary survivor when the active layer is deleted.
    this.paperRenderer.setActiveLayer(newActiveId);
    
    // Clear selection when deleting layers
    this.selectionController.clearSelection();
    this.directSelectController.clearSelection();
    
    // Snapshot for undo/redo
    this.historyManager.snapshot();
  }

  private onLayerSelect(layerId: string) {
    // The Stage is not selectable from the layers panel anymore.
    if (layerId === STAGE_LAYER_ID) return;

    const state = layerStore.get();
    const layer = state.layers.find((l) => l.id === layerId);
    if (layer?.locked) return;

    stageSelectedStore.set(false);

    const isAlreadyActive = state.activeLayerId === layerId;

    if (
      isAlreadyActive &&
      (this.selectionController.hasSelection() || this.directSelectController.hasSelection())
    ) {
      this.selectionController.clearSelection();
      this.directSelectController.clearSelection();
      this.functionsPanel.close("hidden");
      return;
    }

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
    if (layerId === STAGE_LAYER_ID) return;
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
    if (layerId === STAGE_LAYER_ID) return;
    const state = layerStore.get();
    const layer = state.layers.find((l) => l.id === layerId);
    if (!layer) return;

    const newVisibility = !layer.visible;
    layerStore.update((s) => ({
      ...s,
      layers: s.layers.map((l) =>
        l.id === layerId ? { ...l, visible: newVisibility } : l
      ),
    }));
    // Solo + visibility → Paper; do not write Paper before effective pass.
    this.documentManager.applyEffectiveVisibility();
    // Content JSON can embed a stale visible:false from while the layer was
    // hidden; re-apply store visibility after any pending import path.
    if (newVisibility) {
      this.documentManager.invalidateLoadedLayer(layerId);
      this.documentManager.reloadVisibleFrame();
    }

    // Visibility is part of the layer-structure snapshot, so it participates
    // in undo/redo like every other layer operation.
    this.historyManager.snapshot();
    this.requestRedraw();
  }

  /**
   * Activate a layer from canvas select (click / marquee). Clears stage
   * selection but does not select-all on that layer.
   */
  private activateLayerFromSelect(layerId: string) {
    if (layerId === STAGE_LAYER_ID) return;
    const state = layerStore.get();
    const layer = state.layers.find((l) => l.id === layerId);
    if (!layer || layer.locked || layer.kind === "stage") return;
    stageSelectedStore.set(false);
    if (state.activeLayerId === layerId) return;
    if (!this.paperRenderer.setActiveLayer(layerId)) return;
    layerStore.update((s) => ({ ...s, activeLayerId: layerId }));
  }

  private onLayerLockToggle(layerId: string) {
    if (layerId === STAGE_LAYER_ID) return;
    const state = layerStore.get();
    const layer = state.layers.find((l) => l.id === layerId);
    if (!layer || layer.kind === "stage") return;

    const nextLocked = !layer.locked;
    layerStore.update((s) => ({
      ...s,
      layers: s.layers.map((l) =>
        l.id === layerId ? { ...l, locked: nextLocked } : l
      ),
    }));

    if (nextLocked && state.activeLayerId === layerId) {
      const unlocked = [...layerStore.get().layers]
        .reverse()
        .find(
          (l) =>
            l.kind !== "stage" &&
            !l.locked &&
            l.visible &&
            l.id !== layerId,
        );
      if (unlocked && this.paperRenderer.setActiveLayer(unlocked.id)) {
        layerStore.update((s) => ({ ...s, activeLayerId: unlocked.id }));
        stageSelectedStore.set(false);
      }
      this.selectionController.clearSelection();
      this.directSelectController.clearSelection();
    }

    this.historyManager.snapshot();
    this.requestRedraw();
  }

  private onLayerSoloToggle(layerId: string) {
    if (layerId === STAGE_LAYER_ID) return;
    const state = layerStore.get();
    if (!state.layers.some((l) => l.id === layerId && l.kind !== "stage")) return;

    const soloLayerId = state.soloLayerId === layerId ? null : layerId;
    layerStore.update((s) => ({ ...s, soloLayerId }));
    this.documentManager.applyEffectiveVisibility(soloLayerId);
    this.historyManager.snapshot();
    this.requestRedraw();
  }

  private onFunctionInvoke(functionId: string) {
    const didRun = runContextualAction(functionId, this.buildFunctionContext(), {
      paperRenderer: this.paperRenderer,
      selectionController: this.selectionController,
      directSelectController: this.directSelectController,
      historyManager: this.historyManager,
      camera: this.camera,
      closePanel: () => this.functionsPanel.close("hidden"),
    });
    if (didRun) {
      requestAnimationFrame(() => this.updateFunctionsPanel());
    }
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
    this.finalizeDuplicateDragSession({ dx, dy });
  }

  /**
   * Finalize an in-progress duplicate drag and keep the duplicates selected.
   * Optional `screenDelta` applies the final pointerup delta so the last
   * movement frame is not lost.
   */
  private finalizeDuplicateDragSession(screenDelta?: { dx: number; dy: number }) {
    if (!this.duplicateDragSession) return;

    if (screenDelta) {
      this.onFunctionDragMove("duplicate", screenDelta.dx, screenDelta.dy);
    }

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

  // ============================================================
  // Timeline / Animation Handlers (delegated to TimelineSession)
  // ============================================================

  private stepPlayback(dtMs: number) {
    this.timelineSession.stepPlayback(dtMs);
  }

  private onTimelineFrameSelect(
    frame: number,
    layerId?: string,
    options?: { navigateOnly?: boolean },
  ) {
    this.timelineSession.onTimelineFrameSelect(frame, layerId, options);
  }

  private onKeyframeAdd(blank: boolean) {
    this.timelineSession.onKeyframeAdd(blank);
  }

  private onKeyframeHoldToggle(layerId: string, frame: number) {
    this.timelineSession.onKeyframeHoldToggle(layerId, frame);
  }

  private onKeyframeRemove(
    range?: { layerId?: string; layerIds?: string[]; start: number; end: number },
  ) {
    this.timelineSession.onKeyframeRemove(range);
  }

  private onFramesMove(
    layerIds: string[] | undefined,
    layerId: string | undefined,
    start: number,
    end: number,
    delta: number,
  ) {
    this.timelineSession.onFramesMove(layerIds, layerId, start, end, delta);
  }

  private onFramesDuplicate(
    layerIds: string[] | undefined,
    layerId: string | undefined,
    start: number,
    end: number,
  ) {
    this.timelineSession.onFramesDuplicate(layerIds, layerId, start, end);
  }

  private onFramesDuplicateDragStart(
    layerIds: string[] | undefined,
    layerId: string | undefined,
    start: number,
    end: number,
  ) {
    this.timelineSession.onFramesDuplicateDragStart(layerIds, layerId, start, end);
  }

  private onFramesDuplicateDragEnd(
    layerIds: string[] | undefined,
    layerId: string | undefined,
    start: number,
    end: number,
    delta: number,
  ) {
    this.timelineSession.onFramesDuplicateDragEnd(layerIds, layerId, start, end, delta);
  }

  private onFramesReverse(
    layerIds: string[] | undefined,
    layerId: string | undefined,
    start: number,
    end: number,
  ) {
    this.timelineSession.onFramesReverse(layerIds, layerId, start, end);
  }

  private onEditMultipleFramesToggle(
    enabled: boolean,
    layerIds: string[] | undefined,
    layerId: string | undefined,
    start: number,
    end: number,
  ) {
    this.timelineSession.onEditMultipleFramesToggle(
      enabled,
      layerIds,
      layerId,
      start,
      end,
    );
  }

  private onOnionToggle() {
    this.timelineSession.onOnionToggle();
  }

  private onPlayToggle() {
    this.timelineSession.onPlayToggle();
  }

  // ============================================================
  // Document Save / Open / New (delegated to TimelineSession)
  // ============================================================

  private serializeDocument(): SerializedDocument {
    return this.timelineSession.serializeDocument();
  }

  private onDocSave() {
    this.timelineSession.onDocSave();
  }

  private async onDocOpen() {
    await this.timelineSession.onDocOpen();
  }

  private onDocNew() {
    this.timelineSession.onDocNew();
  }

  private applyLoadedDocument(doc: SerializedDocument) {
    this.timelineSession.applyLoadedDocument(doc);
  }

  private onLayerReorder(orderedTopToBottom: string[], movedId?: string) {
    const state = layerStore.get();
    const layersById = new Map(state.layers.map((layer) => [layer.id, layer]));

    // Store and renderer use bottom->top order; panel emits top->bottom.
    let orderedBottomToTop = [...orderedTopToBottom].reverse();
    if (orderedBottomToTop[0] !== STAGE_LAYER_ID) {
      orderedBottomToTop = [
        STAGE_LAYER_ID,
        ...orderedBottomToTop.filter((id) => id !== STAGE_LAYER_ID),
      ];
    }
    if (orderedBottomToTop.length !== state.layers.length) return;

    const reorderedLayers = orderedBottomToTop
      .map((id) => layersById.get(id))
      .filter((layer): layer is NonNullable<typeof layer> => Boolean(layer));

    if (reorderedLayers.length !== state.layers.length) return;

    this.paperRenderer.reorderLayers(orderedBottomToTop);

    // The layer just dragged becomes the active layer.
    let activeLayerId = state.activeLayerId;
    if (
      movedId &&
      movedId !== STAGE_LAYER_ID &&
      movedId !== activeLayerId &&
      this.paperRenderer.setActiveLayer(movedId)
    ) {
      activeLayerId = movedId;
      stageSelectedStore.set(false);
    }

    layerStore.set({
      layers: reorderedLayers,
      activeLayerId,
      soloLayerId: state.soloLayerId,
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
