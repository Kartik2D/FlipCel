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
import { Camera } from "./camera";
import { SelectionController } from "./selection-controller";
import { HistoryManager } from "./history";
import { bus, Events } from "./event-bus";
import type { CanvasConfig, Point, Modifiers } from "./types";
import type { ToolId, AllToolSettings } from "./tools";
import type {
  InkwellToolsPanel,
  InkwellUniversalPanel,
  InkwellLayersPanel,
} from "../ui/ui-lib";
import "../ui/ui-lib"; // Register Lit components
import {
  colorStore,
  prevColorStore,
  toolStore,
  configStore,
  modifiersStore,
  toolSettingsStore,
  layerStore,
  viewOverlayStore,
} from "./stores";

class App {
  private paperCanvas: HTMLCanvasElement;
  private pixelCanvas: HTMLCanvasElement;
  private uiCanvas: HTMLCanvasElement;
  private pixelCanvas2D: CanvasRenderingContext2D;
  private uiCanvas2D: CanvasRenderingContext2D;
  private config: CanvasConfig;
  private inputManager: UnifiedInputManager;
  private pixelCanvasManager: PixelCanvas;
  private tracer: Tracer;
  private paperRenderer: PaperRenderer;
  private uiOverlay: UIOverlay;
  private selectionController: SelectionController;
  private historyManager: HistoryManager;
  private toolsPanel: InkwellToolsPanel;
  private universalPanel: InkwellUniversalPanel;
  private layersPanel: InkwellLayersPanel;
  private camera: Camera;
  private isInitialized = false;
  private pixelResScale = 2;

  /** Inside mode only: clip to path under pointer, or null for full viewport ("paint behind"). */
  private insideClipForStroke: paper.PathItem | null | undefined = undefined;

  constructor() {
    // Get canvas elements
    this.paperCanvas = document.getElementById("paper-canvas") as HTMLCanvasElement;
    this.pixelCanvas = document.getElementById("pixel-canvas") as HTMLCanvasElement;
    this.uiCanvas = document.getElementById("ui-canvas") as HTMLCanvasElement;

    if (!this.paperCanvas || !this.pixelCanvas || !this.uiCanvas) {
      throw new Error("Canvas elements not found");
    }

    // Get 2D contexts
    const pixelCtx = this.pixelCanvas.getContext("2d");
    const uiCtx = this.uiCanvas.getContext("2d");

    if (!pixelCtx || !uiCtx) {
      throw new Error("Could not get 2D contexts");
    }

    this.pixelCanvas2D = pixelCtx;
    this.uiCanvas2D = uiCtx;

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
    this.selectionController = new SelectionController(
      this.paperRenderer,
      this.camera,
      this.uiOverlay,
      this.uiCanvas2D,
    );
    this.historyManager = new HistoryManager();
    this.selectionController.setSnapshotCallback(() => this.historyManager.snapshot());

    // Get panel Lit elements
    this.toolsPanel = document.getElementById("tools-panel") as InkwellToolsPanel;
    this.universalPanel = document.getElementById("universal-panel") as InkwellUniversalPanel;
    this.layersPanel = document.getElementById("layers-panel") as InkwellLayersPanel;
    this.setupPanelEvents();

    viewOverlayStore.subscribeImmediate((prefs) => {
      this.uiOverlay.setViewOverlayPrefs(prefs);
      this.selectionController.drawUI();
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
    bus.on(Events.TOOL_CHANGE, (tool: ToolId) => this.onInputToolChange(tool));
    bus.on(Events.MODIFIERS_CHANGE, (m: Modifiers) => this.onModifiersChange(m));
    bus.on(Events.UNDO, () => this.onUndo());
    bus.on(Events.REDO, () => this.onRedo());
  }

  private setupPanelEvents() {
    // Tools panel events - sync to inputManager and handle selection placement
    this.toolsPanel.addEventListener("tool-change", (e: Event) => {
      const tool = (e as CustomEvent<ToolId>).detail;
      this.onToolChange(tool);
      this.inputManager.setTool(tool);
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
    this.universalPanel.addEventListener("cursor-toggle", (e: Event) => {
      this.uiOverlay.setCursorEnabled((e as CustomEvent<boolean>).detail);
    });

    this.universalPanel.addEventListener("zoom-in", () => this.onZoomIn());
    this.universalPanel.addEventListener("zoom-out", () => this.onZoomOut());
    this.universalPanel.addEventListener("zoom-reset", () => this.onZoomReset());
    this.universalPanel.addEventListener("rotate-cw", () => this.onRotateCW());
    this.universalPanel.addEventListener("rotate-ccw", () => this.onRotateCCW());
    this.universalPanel.addEventListener("rotate-reset", () => this.onRotateReset());
    this.universalPanel.addEventListener("flatten", () => this.onFlatten());
    this.universalPanel.addEventListener("clear", () => this.onClear());
    this.universalPanel.addEventListener("undo", () => this.onUndo());
    this.universalPanel.addEventListener("redo", () => this.onRedo());
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

    // Set internal resolution
    this.pixelCanvas.width = this.config.pixelWidth;
    this.pixelCanvas.height = this.config.pixelHeight;
    this.uiOverlay.updateConfig(this.config);

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
    });

    // Take initial history snapshot (empty canvas state)
    this.historyManager.snapshot();

    console.log("App initialized with Lit UI components and stores");
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
    });

    // Tool store - sync with inputManager
    toolStore.subscribe((tool) => {
      this.inputManager.setTool(tool);
    });
  }

  // ============================================================
  // Display Updates
  // ============================================================

  private updateDisplays() {
    this.universalPanel.zoomLevel = this.camera.getZoomPercent();
    this.universalPanel.rotation = this.camera.getRotationDegrees();
  }

  // ============================================================
  // Camera Control Handlers
  // ============================================================

  private onCameraPan(deltaX: number, deltaY: number) {
    this.camera.pan(deltaX, deltaY);
    this.paperRenderer.applyCamera();
    this.selectionController.drawUI();
  }

  private onCameraZoom(factor: number, centerX: number, centerY: number) {
    this.camera.zoomAt(factor, centerX, centerY);
    this.paperRenderer.applyCamera();
    this.updateDisplays();
    this.selectionController.drawUI();
  }

  private onCameraRotate(deltaRadians: number, centerX: number, centerY: number) {
    this.camera.rotateAt(deltaRadians, centerX, centerY);
    this.paperRenderer.applyCamera();
    this.updateDisplays();
    this.selectionController.drawUI();
  }

  private onZoomIn() {
    this.camera.zoomCenter(1.25);
    this.paperRenderer.applyCamera();
    this.updateDisplays();
    this.selectionController.drawUI();
  }

  private onZoomOut() {
    this.camera.zoomCenter(0.8);
    this.paperRenderer.applyCamera();
    this.updateDisplays();
    this.selectionController.drawUI();
  }

  private onZoomReset() {
    this.camera.reset();
    this.paperRenderer.applyCamera();
    this.updateDisplays();
    this.selectionController.drawUI();
  }

  private onRotateCW() {
    this.camera.rotateCenterDegrees(15);
    this.paperRenderer.applyCamera();
    this.updateDisplays();
    this.selectionController.drawUI();
  }

  private onRotateCCW() {
    this.camera.rotateCenterDegrees(-15);
    this.paperRenderer.applyCamera();
    this.updateDisplays();
    this.selectionController.drawUI();
  }

  private onRotateReset() {
    this.camera.resetRotation();
    this.paperRenderer.applyCamera();
    this.updateDisplays();
    this.selectionController.drawUI();
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

    // Safety net: if a selection is still active when another tool starts,
    // place it before the new interaction mutates the layer.
    if (this.selectionController.hasSelection()) {
      this.selectionController.clearSelection();
    }

    if (tool === "eyedropper") {
      this.pickColorAt(point);
      return;
    }

    if (tool === "brush" || tool === "lasso") {
      if (this.getEffectiveMode(tool) === "inside") {
        const viewportPoint = this.pixelToViewport(point);
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

    if (toolStore.get() === "select" && this.selectionController.hasTransientUI()) {
      this.selectionController.drawUI();
    }
  }

  // ============================================================
  // Control Panel Handlers
  // ============================================================

  private onToolChange(tool: ToolId) {
    // Leaving the select tool should always finalize or cancel its transient UI state.
    if (tool !== "select") {
      this.selectionController.clearSelection();
    }
  }

  private onToolSettingsChange(settings: AllToolSettings) {
    // Update UI overlay with brush max size if available
    const brushSettings = settings.brush as { sizeMax?: number };
    if (brushSettings.sizeMax !== undefined) {
      this.uiOverlay.setMaxBrushSize(brushSettings.sizeMax);
    }
  }

  private pickColorAt(point: Point) {
    const viewportPoint = this.pixelToViewport(point);
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

  private pixelToViewport(point: Point): Point {
    return {
      x: (point.x / this.config.pixelWidth) * this.config.viewportWidth,
      y: (point.y / this.config.pixelHeight) * this.config.viewportHeight,
    };
  }

  private onPixelResChange(scale: number) {
    this.pixelResScale = scale;
    this.config = this.calculateConfig();
    this.resizeCanvases();
    this.pixelCanvasManager.clear();
    configStore.set(this.config); // Propagates to all subscribers
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
    this.historyManager.snapshot();
  }

  private onClear() {
    this.pixelCanvasManager.clear();
    this.paperRenderer.clearActiveLayer(); // Only clear the active layer
    this.historyManager.snapshot(); // Record as a history action (not clear history)
  }

  private onAliasFixToggle(enabled: boolean) {
    this.paperRenderer.setAliasFixEnabled(enabled);
  }

  // ============================================================
  // Input Manager Handlers
  // ============================================================

  private onInputToolChange(tool: ToolId) {
    // Keep hotkey-driven tool changes consistent with panel-driven changes.
    this.onToolChange(tool);
    toolStore.set(tool);
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
    }
  }

  private onRedo() {
    if (this.historyManager.redo()) {
      this.selectionController.clearSelection();
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
    
    // Clear selection when switching layers
    this.selectionController.clearSelection();
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
