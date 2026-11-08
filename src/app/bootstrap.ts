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
import { UnifiedInputManager } from "../input/pointer-gestures";
import { PixelCanvas } from "../tools/pixel-canvas";
import { Tracer } from "../tracing/potrace-tracer";
import { StageRenderer } from "../render/stage-renderer";
import { initKernel } from "../vector/kernel";
import { setThumbnailRenderer } from "../render/symbol-thumbnail";
import { FeedbackLayer } from "../render/feedback-layer";
import { StageLayer } from "../render/stage-layer";
import { ChromeLayer } from "../render/chrome-layer";
import { scheduler, Surface } from "../render/frame-scheduler";
import { Camera } from "../render/camera";
import { SelectionController } from "../editing/object-select";
import { DirectSelectController } from "../editing/direct-select";
import { CreatePointsController } from "../editing/create-points";
import { ArtisticTextController } from "../editing/artistic-text";
import { MagnetController } from "../editing/magnet";
import { MagicMoveController } from "../editing/magic-move";
import { MagicMorphController } from "../editing/magic-morph";
import { HistoryManager } from "../document/history";
import {
  DocumentManager,
  timelineStore,
  type SerializedDocument,
} from "../document/document";
import { childFrameFor, type SymbolPlayMode } from "../document/symbols";
import type { PlacedInstance } from "../vector/content";
import { mulAffine, translation, type Affine } from "../vector/kernel";
import type {
  InstancePlaybackDetail,
  SymbolInstancePopupModel,
} from "../ui/panels/symbol-instance-popup";
import { composeContextToLocal } from "../render/stage-renderer";
import { bus, Events } from "../input/event-bus";
import type { CanvasConfig, Point, Modifiers } from "../geometry/types";
import { cycleDockMode, type ToolId, type AllToolSettings } from "../tools/registry";

import { pixelToViewport } from "../geometry/coords";
import {
  getAvailableContextualActions,
  runContextualAction,
  type ContextualActionContext,
} from "../editing/contextual-actions";
import {
  pasteClipboardOntoLayer,
  setSelectionClipboardFromSelection,
} from "../editing/selection-clipboard";
import {
  convertFrameRangeToSymbol,
  convertSelectionToSymbol,
  placeSymbolInstance,
  type SymbolActionServices,
} from "../editing/symbol-actions";
import type {
  FlipCelColorPanel,
  FlipCelColorPopup,
  FlipCelToolsPanel,
  FlipCelToolSettingsPanel,
  FlipCelUniversalPanel,
  FlipCelFilePanel,
  FlipCelHistoryPanel,
  FlipCelKeyboardShortcutsPanel,
  FlipCelStartupPanel,
  FlipCelViewPanel,
  FlipCelLibraryPanel,
  FlipCelTopBarPanel,
  FlipCelLayersPanel,
  FlipCelWheelPanel,
  FlipCelFunctionsPanel,
  FlipCelMagicMovePopup,
  FlipCelMagicMorphPopup,
  FlipCelAutoMorphPopup,
  FlipCelSymbolInstancePopup,
  FlipCelGodotExportPopup,
  FlipCelSvgExportPopup,
  FlipCelImageImportPopup,
  FlipCelGenerateImagePopup,
  FlipCelSvgImportPopup,
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
  type SelectionState,
  viewOverlayStore,
  normalizeViewOverlaySettings,
  symmetryStore,
  themeModeStore,
  stageStore,
  stageSelectedStore,
  documentColorsStore,
  STAGE_LAYER_ID,
  THEMES,
  generateLayerId,
  aliasFixStore,
  brushSizeIndicatorStore,
  pixelResScaleStore,
  paintSizeScale,
  type ThemeMode,
  type LayerKind,
} from "../state/index";
import { getStageFitViewportInsets } from "../render/stage-fit-insets";
import { bindPanelEvents } from "./panel-bridge";
import { ToolSession } from "./tool-session";
import { TimelineSession, createBlankSerializedDocument } from "./timeline-session";
import {
  exportGodotSpriteZip,
  type GodotExportOptions,
} from "../export/godot-sprite-export";
import {
  exportDocumentSvg,
  type SvgExportOptions,
} from "../export/svg-export";
import { downloadExportFiles } from "../export/download";
import {
  isImageFile,
  pickImageFile,
} from "../import/image-import";
import {
  fileToSvgText,
  importSvgOntoActiveLayer,
  isSvgFile,
  pickSvgFile,
} from "../import/svg-import";
import type { ImageImportDetail } from "../ui/panels/image-import-popup";
import type { GenerateImageReadyDetail } from "../ui/panels/generate-image-popup";
import type { SvgImportDetail } from "../ui/panels/svg-import-popup";
import { documentNameStore } from "../state/document-ui";
import { assetCache, isAudioFile, putAsset } from "../document/assets";
import { AudioPlayback } from "../audio/audio-playback";

/**
 * Snap to 0° when |view rotation| is strictly inside this bound (degrees), i.e. |θ| < 15°.
 * Uses strict inequality so a single 15° UI step from 0 does not immediately snap back.
 */
const SNAP_ROTATION_TO_ZERO_WITHIN_DEG = 15;

const ROTATION_SNAP_TO_ZERO_MS = 280;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function nextImportedImageName(): string {
  const used = new Set(layerStore.get().layers.map((layer) => layer.name));
  for (let n = 1; ; n += 1) {
    const name = `Imported image ${n}`;
    if (!used.has(name)) return name;
  }
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
  private renderer: StageRenderer;
  private feedbackLayer: FeedbackLayer;
  private stageLayer: StageLayer;
  private chromeLayer: ChromeLayer;
  private selectionController: SelectionController;
  private directSelectController: DirectSelectController;
  private createPointsController: CreatePointsController;
  private artisticTextController: ArtisticTextController;
  private magnetController: MagnetController;
  private magicMoveController: MagicMoveController;
  private magicMorphController: MagicMorphController;
  private historyManager: HistoryManager;
  private documentManager: DocumentManager;
  private audioPlayback: AudioPlayback;
  private colorPanel: FlipCelColorPanel;
  private colorPopup: FlipCelColorPopup;
  private toolsPanel: FlipCelToolsPanel;
  private toolSettingsPanel: FlipCelToolSettingsPanel;
  private universalPanel: FlipCelUniversalPanel;
  private filePanel: FlipCelFilePanel;
  private historyPanel: FlipCelHistoryPanel;
  private keyboardShortcutsPanel: FlipCelKeyboardShortcutsPanel;
  private startupPanel: FlipCelStartupPanel;
  private viewPanel: FlipCelViewPanel;
  private libraryPanel: FlipCelLibraryPanel;
  private topBarPanel: FlipCelTopBarPanel;
  private layersPanel: FlipCelLayersPanel;
  private wheelPanel: FlipCelWheelPanel;
  private functionsPanel: FlipCelFunctionsPanel;
  private magicMovePopup: FlipCelMagicMovePopup;
  private magicMorphPopup: FlipCelMagicMorphPopup;
  private autoMorphPopup: FlipCelAutoMorphPopup;
  private symbolInstancePopup: FlipCelSymbolInstancePopup;
  private godotExportPopup: FlipCelGodotExportPopup;
  private svgExportPopup: FlipCelSvgExportPopup;
  private imageImportPopup: FlipCelImageImportPopup;
  private generateImagePopup: FlipCelGenerateImagePopup;
  private svgImportPopup: FlipCelSvgImportPopup;
  private camera: Camera;
  private toolSession!: ToolSession;
  private timelineSession!: TimelineSession;

  private rotationSnapRaf: number | null = null;

  private functionsPanelDismissed = false;
  private lastFunctionsPanelKey = "";
  private colorPopupSession: "stage" | "onion-prev" | "onion-next" | null = null;
  private selectionGestureActive = false;
  /** Camera compensation currently applied for edit-in-place (see onEditContextChanged). */
  private contextOriginOffset = { x: 0, y: 0 };
  private duplicateDragSession:
    | {
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
    if (this.duplicateDragSession) {
      this.finalizeDuplicateDragSession();
      return;
    }
    if (this.directSelectController?.isPathEditDragActive()) {
      this.directSelectController.endPathEditDrag();
      requestAnimationFrame(() => this.updateFunctionsPanel());
    }
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
    this.pixelCanvasManager.setPaintSizeScaleGetter(() =>
      paintSizeScale(this.camera.zoom),
    );
    this.tracer = new Tracer(potrace, init);
    this.renderer = new StageRenderer(this.paperCanvas, this.config);
    this.renderer.setCamera(this.camera);
    this.renderer.setImageResolver((id) => assetCache.getImage(id));
    setThumbnailRenderer(this.renderer);
    this.audioPlayback = new AudioPlayback();
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
      this.renderer,
      this.camera,
      this.chromeLayer,
    );
    this.directSelectController = new DirectSelectController(
      this.renderer,
      this.camera,
      this.chromeLayer,
    );
    this.createPointsController = new CreatePointsController(
      this.renderer,
      this.camera,
      this.chromeLayer,
    );
    this.artisticTextController = new ArtisticTextController(
      this.renderer,
      this.camera,
      this.chromeLayer,
      this.tracer,
    );
    this.magnetController = new MagnetController(this.renderer, this.camera);
    this.magicMoveController = new MagicMoveController(
      this.renderer,
      this.camera,
      this.chromeLayer,
    );
    this.magicMorphController = new MagicMorphController(
      this.renderer,
      this.camera,
      this.chromeLayer,
    );
    this.documentManager = new DocumentManager(this.renderer);
    this.historyManager = new HistoryManager(this.documentManager);

    // One painter per canvas. Everything else only marks surfaces dirty.
    scheduler.setPainter(Surface.STAGE, () => this.stageLayer.paint());
    scheduler.setPainter(Surface.PAPER, () => this.renderer.render());
    scheduler.setPainter(Surface.UI, () => this.feedbackLayer.paint());
    scheduler.setPainter(Surface.CHROME, () => this.paintChrome());

    assetCache.onChange = (id) => {
      const decoded = assetCache.getAudio(id);
      if (decoded) {
        const prev = this.documentManager.getAssetMeta(id);
        this.documentManager.registerAsset(id, {
          name: prev?.name ?? id,
          mime: prev?.mime ?? "audio/*",
          size: prev?.size ?? 0,
          ...prev,
          durationMs: decoded.buffer.duration * 1000,
        });
      }
      this.documentManager.invalidateLayersUsingAsset(id);
      this.documentManager.reloadVisibleFrame();
      this.requestRedraw();
      if (this.documentManager.isPlaying()) this.timelineSession?.syncAudio();
    };
    this.renderer.setSelectableFilter((id) => this.documentManager.isTrackSelectable(id));
    this.documentManager.onContextChanged = () => this.onEditContextChanged();
    this.magicMoveController.setDocumentManager(this.documentManager);
    this.magicMoveController.setHistoryManager(this.historyManager);
    this.magicMorphController.setDocumentManager(this.documentManager);
    this.magicMorphController.setHistoryManager(this.historyManager);
    this.selectionController.setSnapshotCallback(() => this.historyManager.snapshot());
    this.selectionController.setLiveEditStartCallback(() =>
      this.documentManager.refreshOnionSkin(),
    );
    this.selectionController.setEnterInstanceCallback((instance, worldMatrix, layerId) => {
      void this.enterSymbol(instance.symbol, { instance, worldMatrix, layerId });
    });
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
    this.createPointsController.setSnapshotCallback(() => this.historyManager.snapshot());
    this.artisticTextController.setSnapshotCallback(() => this.historyManager.snapshot());
    this.magnetController.setSnapshotCallback(() => this.historyManager.snapshot());
    this.magnetController.setLiveEditStartCallback(() =>
      this.documentManager.refreshOnionSkin(),
    );

    // Get panel Lit elements
    this.colorPanel = document.getElementById("color-panel") as FlipCelColorPanel;
    this.colorPopup = document.getElementById("color-popup") as FlipCelColorPopup;
    this.toolsPanel = document.getElementById("tools-panel") as FlipCelToolsPanel;
    this.toolSettingsPanel = document.getElementById(
      "tool-settings-panel",
    ) as FlipCelToolSettingsPanel;
    this.universalPanel = document.getElementById("universal-panel") as FlipCelUniversalPanel;
    this.filePanel = document.getElementById("file-panel") as FlipCelFilePanel;
    this.historyPanel = document.getElementById("history-panel") as FlipCelHistoryPanel;
    this.keyboardShortcutsPanel = document.getElementById(
      "keyboard-shortcuts-panel",
    ) as FlipCelKeyboardShortcutsPanel;
    this.startupPanel = document.getElementById("startup-panel") as FlipCelStartupPanel;
    this.viewPanel = document.getElementById("view-panel") as FlipCelViewPanel;
    this.libraryPanel = document.getElementById("library-panel") as FlipCelLibraryPanel;
    this.topBarPanel = document.getElementById("top-bar") as FlipCelTopBarPanel;
    this.layersPanel = document.getElementById("layers-panel") as FlipCelLayersPanel;
    this.wheelPanel = document.getElementById("wheel-panel") as FlipCelWheelPanel;
    this.functionsPanel = document.getElementById("functions-panel") as FlipCelFunctionsPanel;
    this.magicMovePopup = document.getElementById(
      "magic-move-popup",
    ) as FlipCelMagicMovePopup;
    this.magicMorphPopup = document.getElementById(
      "magic-morph-popup",
    ) as FlipCelMagicMorphPopup;
    this.autoMorphPopup = document.getElementById(
      "auto-morph-popup",
    ) as FlipCelAutoMorphPopup;
    this.symbolInstancePopup = document.getElementById(
      "symbol-instance-popup",
    ) as FlipCelSymbolInstancePopup;
    this.symbolInstancePopup.addEventListener("instance-playback-change", (e: Event) => {
      const { mode, firstFrame } = (e as CustomEvent<InstancePlaybackDetail>).detail;
      this.updateSelectedInstance({ mode, firstFrame });
    });
    this.symbolInstancePopup.addEventListener("instance-swap", (e: Event) => {
      const { symbolId } = (e as CustomEvent<{ symbolId: string }>).detail;
      this.updateSelectedInstance({ symbol: symbolId });
    });
    this.symbolInstancePopup.addEventListener("instance-edit", () => {
      const sel = this.selectedInstance();
      this.symbolInstancePopup.hidePanel();
      if (sel) {
        void this.enterSymbol(sel.instance.symbol, {
          instance: sel.instance,
          worldMatrix: mulAffine(sel.part.xf, sel.instance.matrix),
          layerId: sel.part.layerId,
        });
      }
    });
    this.symbolInstancePopup.addEventListener("instance-reset-pivot", () => {
      if (!this.selectedInstance() || !this.renderer.resetInstancePivot()) return;
      this.selectionController.markSelectionAsModified();
      this.historyManager.snapshot();
      this.redrawActiveSelectionUI();
    });
    this.godotExportPopup = document.getElementById(
      "godot-export-popup",
    ) as FlipCelGodotExportPopup;
    this.godotExportPopup.addEventListener("godot-export", (e: Event) => {
      void this.onExportGodot((e as CustomEvent<GodotExportOptions>).detail);
    });
    this.svgExportPopup = document.getElementById(
      "svg-export-popup",
    ) as FlipCelSvgExportPopup;
    this.svgExportPopup.addEventListener("svg-export", (e: Event) => {
      void this.onExportSvg((e as CustomEvent<SvgExportOptions>).detail);
    });
    this.imageImportPopup = document.getElementById(
      "image-import-popup",
    ) as FlipCelImageImportPopup;
    this.imageImportPopup.addEventListener("image-import", (e: Event) => {
      void this.onImportImage((e as CustomEvent<ImageImportDetail>).detail);
    });
    this.generateImagePopup = document.getElementById(
      "generate-image-popup",
    ) as FlipCelGenerateImagePopup;
    this.generateImagePopup.addEventListener("generate-image-ready", (e: Event) => {
      void this.onGenerateImageReady(
        (e as CustomEvent<GenerateImageReadyDetail>).detail,
      );
    });
    this.svgImportPopup = document.getElementById(
      "svg-import-popup",
    ) as FlipCelSvgImportPopup;
    this.svgImportPopup.addEventListener("svg-import", (e: Event) => {
      void this.onImportSvg((e as CustomEvent<SvgImportDetail>).detail);
    });
    this.setupFileDrop();
    this.timelineSession = new TimelineSession({
      documentManager: this.documentManager,
      historyManager: this.historyManager,
      selectionController: this.selectionController,
      directSelectController: this.directSelectController,
      magicMoveController: this.magicMoveController,
      magicMorphController: this.magicMorphController,
      renderer: this.renderer,
      layersPanel: this.layersPanel,
      closeFunctionsPanelHidden: () => this.functionsPanel.close("hidden"),
      closeSettingsPanel: () => this.universalPanel.hidePanel(),
      closeFilePanel: () => this.filePanel.hidePanel(),
      switchTool: (tool) => this.switchTool(tool),
      requestRedraw: () => this.requestRedraw(),
      fitStageInView: (immediate) => this.fitStageInView(immediate),
      audioPlayback: this.audioPlayback,
    });
    this.setupPanelEvents();
    const onMagicMoveApply = () => {
      const result = this.magicMoveController.apply();
      if (!result.ok) {
        console.warn("Magic Move:", result.error);
      }
      this.requestRedraw();
    };
    this.toolSettingsPanel.addEventListener("magic-move-apply", onMagicMoveApply);
    this.magicMovePopup.addEventListener("magic-move-apply", onMagicMoveApply);
    this.toolSettingsPanel.addEventListener("select-copy", () => {
      setSelectionClipboardFromSelection(this.renderer);
    });
    this.toolSettingsPanel.addEventListener("select-paste", () => {
      const layerId = this.renderer.getActiveLayerId();
      if (!layerId) return;
      this.selectionController.placeSelection();
      if (!pasteClipboardOntoLayer(this.renderer, layerId)) return;
      this.selectionController.markSelectionAsModified();
      this.requestRedraw();
    });
    const onMagicMorphApply = () => {
      const result = this.magicMorphController.apply();
      if (!result.ok) {
        console.warn("Magic Morph:", result.error);
      }
      this.requestRedraw();
    };
    this.toolSettingsPanel.addEventListener("magic-morph-apply", onMagicMorphApply);
    this.magicMorphPopup.addEventListener("magic-morph-apply", onMagicMorphApply);
    this.autoMorphPopup.addEventListener("auto-morph-apply", (e: Event) => {
      const d = (
        e as CustomEvent<{
          layerIds: string[];
          start: number;
          end: number;
          mode: "every" | "divisions";
          divisions: number;
        }>
      ).detail;
      const result = this.magicMorphController.autoMorphRange(
        d.layerIds,
        d.start,
        d.end,
        { mode: d.mode, divisions: d.divisions },
      );
      if (!result.ok) {
        console.warn("Auto Morph:", result.error);
      }
      this.requestRedraw();
    });
    window.addEventListener("pointerup", this.globalDuplicateDragEndHandler);
    window.addEventListener("pointercancel", this.globalDuplicateDragEndHandler);
    window.addEventListener("blur", this.globalDuplicateDragEndHandler);

    viewOverlayStore.subscribeImmediate((prefs) => {
      this.feedbackLayer.setViewOverlayPrefs(prefs);
      this.redrawActiveSelectionUI();
    });

    // Symmetry guides live on #ui-canvas only (same as grid) — do not
    // request a full Paper redraw or the view-panel toggle feels laggy on iPad.
    symmetryStore.subscribeImmediate((prefs) => {
      this.feedbackLayer.setSymmetryPrefs(prefs);
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
      const paperActiveId = this.renderer.getActiveLayerId();
      if (paperActiveId) {
        layerStore.update((s) => ({ ...s, activeLayerId: paperActiveId }));
      }
    });

    selectionStore.subscribeImmediate((selection) => {
      if (stageSelectedStore.get() && selection.count > 0) {
        stageSelectedStore.set(false);
        const lid = selection.layerIds[selection.layerIds.length - 1];
        if (lid) {
          this.renderer.setActiveLayer(lid);
          layerStore.update((s) => ({ ...s, activeLayerId: lid }));
        }
      }
      this.onSelectionChange(selection);
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
      createPointsController: this.createPointsController,
      artisticTextController: this.artisticTextController,
      magnetController: this.magnetController,
      magicMoveController: this.magicMoveController,
      magicMorphController: this.magicMorphController,
      renderer: this.renderer,
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
    bus.on(Events.TOOL_START, (d: { point: Point; tool: ToolId }) =>
      this.onToolStart(d.point, d.tool),
    );
    bus.on(Events.TOOL_MOVE, (d: { point: Point; tool: ToolId }) => this.onToolMove(d.point, d.tool));
    bus.on(Events.TOOL_END, (tool: ToolId) => this.onToolEnd(tool));
    bus.on(Events.TOOL_CANCEL, (tool: ToolId) => this.onToolCancel(tool));
    bus.on(Events.TOOL_RESET, (tool: ToolId) => this.onToolReset(tool));
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
    bus.on(Events.PLAY_TOGGLE, () => this.onPlayToggle());
    bus.on(Events.DELETE_SELECTION, () => this.onDeleteSelection());
    bus.on(Events.CONVERT_TO_SYMBOL, () => this.convertSelectionToSymbol());
  }

  private setupPanelEvents() {
    bindPanelEvents({
      colorPanel: this.colorPanel,
      colorPopup: this.colorPopup,
      toolsPanel: this.toolsPanel,
      toolSettingsPanel: this.toolSettingsPanel,
      universalPanel: this.universalPanel,
      filePanel: this.filePanel,
      historyPanel: this.historyPanel,
      keyboardShortcutsPanel: this.keyboardShortcutsPanel,
      viewPanel: this.viewPanel,
      libraryPanel: this.libraryPanel,
      topBarPanel: this.topBarPanel,
      layersPanel: this.layersPanel,
      wheelPanel: this.wheelPanel,
      functionsPanel: this.functionsPanel,

      onColorPickerChange: (color) => this.onColorPickerChange(color),
      onColorPickerChangeEnd: (color) => this.onColorPickerChangeEnd(color),
      onDocumentRecolor: (from, to) => this.onDocumentRecolor(from, to),
      onDocumentRecolorEnd: (from, to) => this.onDocumentRecolorEnd(from, to),
      onDocumentRecolorCancel: () => this.documentManager.endDocumentRecolor(),
      onStageColorPickerHidden: () => {
        this.colorPopupSession = null;
      },
      switchTool: (tool) => this.switchTool(tool),
      onToolSettingsChange: (settings) => this.onToolSettingsChange(settings),
      onUndo: () => this.onUndo(),
      onRedo: () => this.onRedo(),
      onHistoryGoTo: (index) => this.onHistoryGoTo(index),
      onHistoryWindowToggle: (visible) => this.onHistoryWindowToggle(visible),
      onKeyboardShortcutsToggle: (visible) => this.onKeyboardShortcutsToggle(visible),
      onOnionToggle: () => this.onOnionToggle(),
      onDockZoomReset: () => this.onDockZoomReset(),
      onModeCycle: () => this.onModeCycle(),
      onPlayToggle: () => this.onPlayToggle(),
      openStageColorPicker: (anchor) => {
        const stageColor = stageStore.get().color;
        colorStore.set(stageColor);
        prevColorStore.set(stageColor);
        this.colorPopupSession = "stage";
        void this.colorPopup.showNearAnchor(anchor);
      },
      openOnionSkinColorPicker: (which, anchor) => {
        const overlay = viewOverlayStore.get();
        const color =
          which === "prev" ? overlay.onionSkinPrevColor : overlay.onionSkinNextColor;
        colorStore.set(color);
        prevColorStore.set(color);
        this.colorPopupSession = which === "prev" ? "onion-prev" : "onion-next";
        void this.colorPopup.showNearAnchor(anchor);
      },
      onStageSizeChange: () => {
        this.historyManager.snapshot();
      },
      onExportSvgOpen: (anchor) => {
        void this.svgExportPopup.showNearAnchor(anchor);
      },
      onExportGodotOpen: (anchor) => {
        void this.godotExportPopup.showNearAnchor(anchor);
      },
      onImportImageOpen: (anchor) => {
        void this.onImportImageOpen(anchor);
      },
      onGenerateImageOpen: (anchor) => {
        void this.generateImagePopup.open(anchor);
      },
      onImportSvgOpen: (anchor) => {
        void this.onImportSvgOpen(anchor);
      },
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
      onAutoMorphOpen: (layerIds, start, end, anchor) => {
        this.autoMorphPopup.openFor({ layerIds, start, end }, anchor);
      },
      onFramesDuplicateDragStart: (layerIds, layerId, start, end) =>
        this.onFramesDuplicateDragStart(layerIds, layerId, start, end),
      onFramesMoveDragStart: (layerIds, layerId, start, end) =>
        this.onFramesMoveDragStart(layerIds, layerId, start, end),
      onFramesDuplicateDragEnd: (layerIds, layerId, start, end, delta) =>
        this.onFramesDuplicateDragEnd(layerIds, layerId, start, end, delta),
      onFramesReverse: (layerIds, layerId, start, end) =>
        this.onFramesReverse(layerIds, layerId, start, end),
      onFramesToSymbol: (layerIds, layerId, start, end) =>
        this.onFramesToSymbol(layerIds, layerId, start, end),
      onEditMultipleFramesToggle: (enabled, layerIds, layerId, start, end) =>
        this.onEditMultipleFramesToggle(enabled, layerIds, layerId, start, end),
      onKeyframeHoldToggle: (layerId, frame) => this.onKeyframeHoldToggle(layerId, frame),
      onTagAdd: (start, end) => this.timelineSession.onTagAdd(start, end),
      onTagRename: (id, name) => this.timelineSession.onTagRename(id, name),
      onTagRemove: (id) => this.timelineSession.onTagRemove(id),
      onTagResize: (id, start, end) =>
        this.timelineSession.onTagResize(id, start, end),
      onDurationSet: (frames) => {
        if (this.documentManager.setDuration(frames)) {
          this.historyManager.snapshot();
          this.requestRedraw();
        }
      },
      onFrameRateChange: (rate) => {
        // Returns true when real-time lock retimed keyframes.
        if (this.documentManager.setFrameRate(rate)) {
          this.historyManager.snapshot();
          this.requestRedraw();
        }
      },
      onLayerAdd: (id, name, kind, file) => void this.onLayerAdd(id, name, kind, file),
      onImageFrameSet: (layerId, file) => void this.onImageFrameSet(layerId, file),
      onAudioClipMove: (layerId, startFrame) => this.onAudioClipMove(layerId, startFrame),
      onAssetRelink: (layerId, assetId, file) => void this.onAssetRelink(layerId, assetId, file),
      onLayerDelete: (layerId) => this.onLayerDelete(layerId),
      onLayerSelect: (layerId) => this.onLayerSelect(layerId),
      onLayerVisibilityToggle: (layerId) => this.onLayerVisibilityToggle(layerId),
      onLayerLockToggle: (layerId) => this.onLayerLockToggle(layerId),
      onLayerReorder: (order, movedId) => this.onLayerReorder(order, movedId),
      onLayerRename: (id, name) => this.onLayerRename(id, name),
      onLayerMergeDown: (layerId) => this.onLayerMergeDown(layerId),
      onSymbolPlace: (id, client) => void this.placeSymbolInstance(id, client),
      onSymbolEdit: (id) => void this.enterSymbol(id),
      onSymbolRename: (id, name) => this.onSymbolRename(id, name),
      onSymbolDuplicate: (id) => this.onSymbolDuplicate(id),
      onSymbolDelete: (id) => this.onSymbolDelete(id),
      onExitSymbolTo: (depth) => void this.exitSymbol(depth),
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

    const scale = pixelResScaleStore.get();
    const pixelWidth = Math.floor(viewportWidth / scale);
    const pixelHeight = Math.floor(viewportHeight / scale);

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
    // The chrome canvas has no store subscription; every other surface picks
    // the new config up from `configStore` (see setupStoreSubscriptions).
    this.chromeLayer.updateConfig(this.config);

    // Configure pixel canvas context
    this.pixelCanvas2D.imageSmoothingEnabled = false;
  }

  /** Viewport geometry changed: resize every canvas and repaint everything once. */
  private applyViewportConfig() {
    this.camera.updateViewport(this.config.viewportWidth, this.config.viewportHeight);
    this.resizeCanvases();
    configStore.set(this.config); // Propagates to all subscribers
    scheduler.invalidate(Surface.ALL);
  }

  async init() {
    // Initialize esm-potrace-wasm
    await init();

    // Initialize the DCEL kernel (wasm) before any vector work.
    await initKernel();

    // Initialize the default layer
    const initialLayerState = layerStore.get();
    const defaultLayer =
      initialLayerState.layers.find((l) => l.kind !== "stage") ?? initialLayerState.layers[0];
    this.renderer.initializeDefaultLayer(defaultLayer.id, defaultLayer.name);

    // Set up store subscriptions, then push the initial config through them
    // (sizes every canvas and queues the first paint of each surface).
    this.setupStoreSubscriptions();
    this.applyViewportConfig();

    // Apply initial brush color to pixel canvas from color store
    this.pixelCanvasManager.setBrushColor(colorStore.get());

    window.addEventListener("resize", () => {
      this.config = this.calculateConfig();
      this.applyViewportConfig();
    });

    // Always start on a blank document; startup can restore autosave from before launch.
    await this.timelineSession.captureSessionAutosaveCandidate();
    this.startupPanel.canRestoreAutosave = this.timelineSession.hasSessionAutosaveCandidate();
    this.applyLoadedDocument(createBlankSerializedDocument());

    // Take initial history snapshot (baseline for undo)
    this.historyManager.snapshot();

    this.startFrameLoop();
    this.setupStartupPanel();
    this.startupPanel.show();

    // Paint counters for profiling: `__scheduler.paints` / `__scheduler.resetStats()` in the console.
    (window as unknown as { __scheduler: typeof scheduler }).__scheduler = scheduler;

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
    this.startupPanel.addEventListener("startup-load-example", (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id) this.timelineSession.loadExampleDocument(id);
    });
  }

  /**
   * Document content or selection changed: repaint the vector scene and the
   * selection chrome on the next frame. Grid/stage surfaces have their own
   * triggers (camera, config, stage store) and are left alone.
   */
  requestRedraw(): void {
    scheduler.invalidate(Surface.PAPER | Surface.CHROME);
  }

  /**
   * The camera's present pose, or the viewport, changed: every surface draws
   * in camera space, so all four repaint.
   */
  private cameraChanged(): void {
    scheduler.invalidate(Surface.ALL);
  }

  /**
   * Per-frame work that is not a paint: camera easing and playback stepping.
   * Registered with the scheduler, which only ticks while this returns true
   * or something is dirty — an idle app runs no frames at all.
   */
  private startFrameLoop() {
    scheduler.onFrame((dt) => {
      this.stepPlayback(dt * 1000);
      const cameraMoved = this.camera.stepLerp(dt);
      if (cameraMoved) this.cameraChanged();
      return cameraMoved || this.documentManager.isPlaying();
    });
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
      this.renderer.updateConfig(config);
    });

    // Tool settings store - update UI overlay with brush tip + magnet size
    toolSettingsStore.subscribe((settings) => {
      const brushSettings = settings.brush as {
        sizeMax?: number;
        tip?: "circle" | "square" | "ellipse" | "diag";
        angle?: number;
      };
      if (brushSettings.sizeMax !== undefined) {
        this.feedbackLayer.setMaxBrushSize(brushSettings.sizeMax);
      }
      if (brushSettings.tip) {
        this.feedbackLayer.setBrushTip(brushSettings.tip);
      }
      if (typeof brushSettings.angle === "number") {
        this.feedbackLayer.setBrushTipAngle(brushSettings.angle);
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
      // Paint (or clear) the new tool's chrome now rather than on the next pointer move.
      this.redrawActiveSelectionUI();
    });

    themeModeStore.subscribeImmediate((mode) => {
      this.applyTheme(mode);
    });

    aliasFixStore.subscribeImmediate((enabled) => {
      this.renderer.setAliasFixEnabled(enabled);
    });
    brushSizeIndicatorStore.subscribeImmediate((enabled) => {
      this.feedbackLayer.setBrushSizeIndicatorEnabled(enabled);
    });
    pixelResScaleStore.subscribe((scale) => {
      this.onPixelResChange(scale);
    });
  }

  private applyTheme(mode: ThemeMode) {
    const { colorScheme } = THEMES[mode];
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = colorScheme;
    scheduler.invalidate(Surface.ALL);
  }

  /** Mark the selection chrome dirty; `paintChrome` runs once next frame. */
  private redrawActiveSelectionUI() {
    scheduler.invalidate(Surface.CHROME);
  }

  /**
   * The scheduler's CHROME painter: the only place #chrome-canvas is cleared
   * and painted. The active tool's controller paints its complete chrome;
   * tools without transient UI leave the canvas empty.
   */
  private paintChrome() {
    this.chromeLayer.clear();
    switch (toolStore.get()) {
      case "direct-select":
        this.directSelectController.paintUI();
        return;
      case "create-points":
        this.createPointsController.paintUI();
        return;
      case "artistic-text":
        this.artisticTextController.paintUI();
        return;
      case "select":
        if (this.selectionController.hasTransientUI()) this.selectionController.paintUI();
        return;
      case "magic-move":
        if (this.magicMoveController.hasTransientUI()) this.magicMoveController.paintUI();
        return;
      case "magic-morph":
        if (this.magicMorphController.hasTransientUI()) this.magicMorphController.paintUI();
        return;
      default:
        return;
    }
  }

  // ============================================================
  // Camera Control Handlers
  // ============================================================

  private onCameraPan(deltaX: number, deltaY: number) {
    this.camera.pan(deltaX, deltaY);
    scheduler.wake(); // target moved; the frame loop eases and repaints
    this.dismissFunctionsPanelForCameraChange();
  }

  private onCameraZoom(factor: number, centerX: number, centerY: number) {
    this.camera.zoomAt(factor, centerX, centerY);
    scheduler.wake();
    this.dismissFunctionsPanelForCameraChange();
  }

  private onCameraRotate(deltaRadians: number, centerX: number, centerY: number) {
    this.cancelRotationSnapAnimation();
    this.camera.rotateAt(deltaRadians, centerX, centerY);
    scheduler.wake();
    this.dismissFunctionsPanelForCameraChange();
  }

  /** Hide the select/direct-select popup when the view moves; sticky until selection changes. */
  private dismissFunctionsPanelForCameraChange() {
    if (toolStore.get() === "create-points" && this.createPointsController.hasDraft()) {
      this.createPointsController.drawUI();
    }
    if (toolStore.get() === "artistic-text" && this.artisticTextController.hasDraft()) {
      this.artisticTextController.drawUI();
    }
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
      // Present pose was mutated directly (bypassing stepLerp), so the frame
      // loop won't detect motion on its own.
      this.cameraChanged();

      if (t < 1) {
        this.rotationSnapRaf = requestAnimationFrame(tick);
      } else {
        this.rotationSnapRaf = null;
        this.camera.syncPresentPanRotationFromTarget();
        this.cameraChanged();
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
    // Immediate fits move the present pose directly; eased fits only need the
    // loop awake. Invalidating covers both.
    this.cameraChanged();
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
    // Drawing moves no longer emit POINTER_MOVE; the cursor is tracked here.
    this.feedbackLayer.setCursor(point);
    this.toolSession.onToolMove(point, tool);
  }

  private async onToolEnd(tool: ToolId) {
    await this.toolSession.onToolEnd(tool);
  }

  private onToolCancel(tool: ToolId) {
    this.toolSession.onToolCancel(tool);
  }

  /** Escape while idle — peel/clear the active tool’s transient state. */
  private onToolReset(tool: ToolId) {
    // Nothing transient to peel: Esc leaves the symbol being edited.
    const idle =
      !this.selectionController.hasTransientUI() &&
      !this.directSelectController.hasSelection() &&
      !this.createPointsController.hasDraft() &&
      !this.magicMoveController.hasTransientUI() &&
      !this.magicMorphController.hasTransientUI();
    if (idle && this.documentManager.isEditingSymbol()) {
      void this.exitSymbol();
      return;
    }
    this.toolSession.onToolCancel(tool);
    if (tool === "select") {
      this.selectionController.clearSelection();
      this.functionsPanelDismissed = false;
      this.functionsPanel.close("hidden");
      this.updateFunctionsPanel();
    } else if (tool === "direct-select") {
      this.directSelectController.clearSelection();
      this.functionsPanelDismissed = false;
      this.functionsPanel.close("hidden");
      this.updateFunctionsPanel();
    }
  }

  /**
   * Idle hover. Selection chrome is not touched here: controllers invalidate
   * it themselves when their state changes, so a mouse moving over an
   * unchanged selection costs nothing.
   */
  private onPointerMove(point: Point) {
    this.feedbackLayer.setCursor(point);
    if (toolStore.get() === "create-points" && this.createPointsController.hasDraft()) {
      this.createPointsController.handleHover(point);
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
    if (tool !== "create-points") {
      this.createPointsController.clearDraft();
    }
    if (tool !== "artistic-text") {
      void this.artisticTextController.flushOrClear();
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
    const brushSettings = settings.brush as {
      sizeMax?: number;
      tip?: "circle" | "square" | "ellipse" | "diag";
      angle?: number;
    };
    if (brushSettings.sizeMax !== undefined) {
      this.feedbackLayer.setMaxBrushSize(brushSettings.sizeMax);
    }
    if (brushSettings.tip) {
      this.feedbackLayer.setBrushTip(brushSettings.tip);
    }
    if (typeof brushSettings.angle === "number") {
      this.feedbackLayer.setBrushTipAngle(brushSettings.angle);
    }
    const magnetSettings = settings.magnet as { size?: number } | undefined;
    if (magnetSettings && typeof magnetSettings.size === "number") {
      this.feedbackLayer.setMagnetSize(magnetSettings.size);
    }
  }

  private onSelectionChange(selection: SelectionState) {
    // A single lifted shape with one fill adopts its color as the active color.
    if (selection.count === 1 && selection.hasShapes && selection.instances.length === 0) {
      const parts = this.renderer.getSelection();
      const fills = parts.length === 1 ? parts[0].base.fills().filter((f) => f !== 0) : [];
      const color = fills.length === 1 ? this.documentManager.palette.colorOf(fills[0]) : null;
      if (color) {
        colorStore.set(color);
        prevColorStore.set(color);
      }
    }

    this.updateFunctionsPanel();
  }

  private buildFunctionContext(): ContextualActionContext {
    return {
      tool: toolStore.get(),
      selection: selectionStore.get(),
      pickedAnchorCount: this.directSelectController.getPickedAnchorCount(),
    };
  }

  private getFunctionsPanelKey(context: ContextualActionContext, functionIds: string[]): string {
    const b = this.renderer.selectionBounds();
    return [
      context.tool,
      context.selection.count,
      context.selection.instances.map((i) => i.iid).join(","),
      b ? [b.x, b.y, b.width, b.height].map((v) => Math.round(v)).join(",") : "",
      context.pickedAnchorCount,
      functionIds.join(","),
    ].join("|");
  }

  private getFunctionsPanelPosition(context: ContextualActionContext): { x: number; y: number } | null {
    if (context.tool === "select") {
      const bounds = this.renderer.selectionScreenBounds();
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
    if (this.duplicateDragSession || this.directSelectController.isPathEditDragActive()) {
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

  private applyOnionPopupColor(color: string): boolean {
    if (
      this.colorPopupSession !== "onion-prev" &&
      this.colorPopupSession !== "onion-next"
    ) {
      return false;
    }
    const key =
      this.colorPopupSession === "onion-prev"
        ? "onionSkinPrevColor"
        : "onionSkinNextColor";
    viewOverlayStore.update((v) =>
      normalizeViewOverlaySettings({ ...v, [key]: color }),
    );
    return true;
  }

  /** One view paint for the whole selection. History and selection chrome wait until pointer-up. */
  private paintSelectionColor(color: string): boolean {
    if (!selectionStore.get().hasShapes) return false;
    const fill = this.documentManager.palette.fillFor(color);
    if (!this.renderer.recolorSelection(fill)) return false;
    this.selectionController.pinLiveEdit();
    return true;
  }

  private onColorPickerChange(color: string) {
    if (this.applyOnionPopupColor(color)) return;
    if (this.colorPopupSession === "stage" || stageSelectedStore.get()) {
      stageStore.update((s) => ({ ...s, color }));
      return;
    }
    this.paintSelectionColor(color);
  }

  private onColorPickerChangeEnd(color: string) {
    this.documentManager.endDocumentRecolor();
    if (this.applyOnionPopupColor(color)) return;
    if (this.colorPopupSession === "stage" || stageSelectedStore.get()) {
      stageStore.update((s) => ({ ...s, color }));
      this.historyManager.snapshot();
      return;
    }
    if (!this.paintSelectionColor(color)) return;
    // Keep marquee/EMF selections from reverting on deselect (same as flip/transform).
    this.selectionController.markSelectionAsModified();
    if (toolStore.get() === "direct-select") this.directSelectController.drawUI();
    this.historyManager.snapshot();
  }

  /** Live preview: remap a document color across all keyframe artwork. */
  private onDocumentRecolor(from: string, to: string) {
    if (!this.documentManager.recolorDocument(from, to)) return;
    // Discard, don't clear — clearSelection would restore the pre-recolor marquee snapshot.
    this.selectionController.discardSelection();
    this.directSelectController.clearSelection();
  }

  /** Commit a document-wide recolor into history. */
  private onDocumentRecolorEnd(from: string, to: string) {
    const changed = this.documentManager.recolorDocument(from, to);
    this.documentManager.endDocumentRecolor();
    this.selectionController.discardSelection();
    this.directSelectController.clearSelection();
    if (changed) this.historyManager.snapshot("Recolor");
  }

  private pickColorAt(point: Point) {
    const viewportPoint = pixelToViewport(point, this.config);
    const world = this.camera.screenToWorld(viewportPoint.x, viewportPoint.y);
    const scope =
      toolSettingsStore.get().eyedropper.scope === "active" ? "active" : "all";
    const pickedColor =
      scope === "active"
        ? this.documentManager.palette.colorOf(this.renderer.faceFillAt(world))
        : this.renderer.colorAt(world);
    if (!pickedColor) return;

    colorStore.set(pickedColor);
    prevColorStore.set(pickedColor);
  }

  private onPixelResChange(_scale: number) {
    this.config = this.calculateConfig();
    this.applyViewportConfig();
    this.pixelCanvasManager.clear();
    // Resizing #ui-canvas (via resizeCanvases -> feedbackLayer.updateConfig) can
    // invalidate in-flight pointer captures on some mobile browsers. Clear
    // any stale input state so the next pointerdown starts a clean stroke.
    this.inputManager.resetInputState();
  }


  // ============================================================
  // Input Manager Handlers
  // ============================================================

  private onInputToolChange(tool: ToolId) {
    this.switchTool(tool);
  }

  private switchTool(next: ToolId) {
    void this.switchToolAsync(next);
  }

  private async switchToolAsync(next: ToolId) {
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

  private async onUndo() {
    if (this.historyManager.undo()) {
      this.afterHistoryRestore();
    }
  }

  private async onRedo() {
    if (this.historyManager.redo()) {
      this.afterHistoryRestore();
    }
  }

  private async onHistoryGoTo(index: number) {
    if (this.historyManager.goTo(index)) {
      this.afterHistoryRestore();
    }
  }

  private afterHistoryRestore() {
    this.selectionController.discardSelection();
    this.directSelectController.clearSelection();
    this.functionsPanel.close("hidden");
    this.requestRedraw();
  }

  private onHistoryWindowToggle(visible: boolean) {
    this.universalPanel.historyWindowVisible = visible;
    if (visible) {
      void this.historyPanel.show(this.universalPanel);
      return;
    }
    if (this.historyPanel.style.display !== "none") {
      this.historyPanel.hidePanel();
    }
  }

  private onKeyboardShortcutsToggle(visible: boolean) {
    this.universalPanel.keyboardShortcutsVisible = visible;
    if (visible) {
      void this.keyboardShortcutsPanel.show(this.universalPanel);
      return;
    }
    if (this.keyboardShortcutsPanel.style.display !== "none") {
      this.keyboardShortcutsPanel.hidePanel();
    }
  }

  // ============================================================
  // Layer Handlers
  // ============================================================

  private async onLayerAdd(
    id: string,
    name: string,
    kind: LayerKind = "regular",
    file?: File,
  ) {
    // Symbols hold vector layers only.
    if (kind !== "regular" && this.documentManager.isEditingSymbol()) return;
    stageSelectedStore.set(false);
    // Create the layer in Paper.js (it lands at the top of z-order by default).
    this.renderer.createLayer(id, name);

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
        kind,
      });
      return {
        ...state,
        layers: nextLayers,
        activeLayerId: id,
      };
    });

    // Sync Paper.js z-order to match the store.
    const orderedBottomToTop = layerStore.get().layers.map((layer) => layer.id);
    this.renderer.reorderLayers(orderedBottomToTop);
    this.documentManager.syncFromLayerStore(layerStore.get());

    if (file && (kind === "image" || kind === "audio")) {
      await this.attachMediaToLayer(id, kind, file);
    }

    // Clear selection when switching layers
    this.selectionController.clearSelection();
    this.directSelectController.clearSelection();

    // Snapshot for undo/redo
    this.historyManager.snapshot();
  }

  private async attachMediaToLayer(
    layerId: string,
    kind: "image" | "audio",
    file: File,
  ): Promise<void> {
    const { id: assetId, meta } = await putAsset(file);
    this.documentManager.registerAsset(assetId, meta);
    if (kind === "image") {
      void assetCache.ensureImage(assetId);
      this.documentManager.setImageAtFrame(
        layerId,
        this.documentManager.getCurrentFrame(),
        assetId,
      );
      return;
    }
    void assetCache.ensureAudio(assetId);
    this.documentManager.setAudioClip(layerId, {
      assetId,
      startFrame: this.documentManager.getCurrentFrame(),
    });
  }

  private async onImageFrameSet(layerId: string, file: File): Promise<void> {
    await this.attachMediaToLayer(layerId, "image", file);
    this.historyManager.snapshot("Set image");
    this.requestRedraw();
  }

  private onAudioClipMove(layerId: string, startFrame: number): void {
    if (!this.documentManager.setAudioClip(layerId, { startFrame })) return;
    this.historyManager.snapshot("Move audio");
    if (this.documentManager.isPlaying()) this.timelineSession.syncAudio();
  }

  private async onAssetRelink(
    layerId: string,
    assetId: string,
    file: File,
  ): Promise<void> {
    const layer = layerStore.get().layers.find((l) => l.id === layerId);
    const kind = layer?.kind === "audio" ? "audio" : "image";
    const { id: nextId, meta } = await putAsset(file);
    this.documentManager.registerAsset(nextId, meta);
    if (kind === "audio") void assetCache.ensureAudio(nextId);
    else void assetCache.ensureImage(nextId);
    this.documentManager.relinkAsset(assetId, nextId);
    this.historyManager.snapshot("Relink asset");
    this.requestRedraw();
    if (this.documentManager.isPlaying()) this.timelineSession.syncAudio();
  }

  private onLayerDelete(layerId: string) {
    if (layerId === STAGE_LAYER_ID) return;
    const state = layerStore.get();
    const nonStage = state.layers.filter((l) => l.kind !== "stage");
    if (nonStage.length <= 1) return;
    
    // Delete from Paper.js
    if (!this.renderer.deleteLayer(layerId)) return;
    
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
    this.renderer.setActiveLayer(newActiveId);
    
    // Clear selection when deleting layers
    this.selectionController.clearSelection();
    this.directSelectController.clearSelection();
    
    // Snapshot for undo/redo
    this.historyManager.snapshot();
  }

  private async onLayerMergeDown(layerId: string) {
    if (layerId === STAGE_LAYER_ID) return;

    const targetId = this.documentManager.mergeLayerDown(layerId);
    if (!targetId) return;

    const state = layerStore.get();
    const remainingLayers = state.layers.filter((l) => l.id !== layerId);
    const soloLayerId =
      state.soloLayerId === layerId ? null : state.soloLayerId;

    layerStore.set({
      layers: remainingLayers,
      activeLayerId: targetId,
      soloLayerId,
    });

    this.renderer.deleteLayer(layerId);
    this.renderer.setActiveLayer(targetId);
    this.documentManager.applyEffectiveVisibility(soloLayerId);
    this.documentManager.invalidateLoadedLayer(targetId);
    this.documentManager.reloadVisibleFrame();

    this.selectionController.clearSelection();
    this.directSelectController.clearSelection();
    this.historyManager.snapshot();
    this.requestRedraw();
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
    if (!this.renderer.setActiveLayer(layerId)) return;

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
    this.selectionController.selectAll("active");
  }

  private onLayerRename(layerId: string, name: string) {
    if (layerId === STAGE_LAYER_ID) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const state = layerStore.get();
    const layer = state.layers.find((l) => l.id === layerId);
    if (!layer || layer.name === trimmed) return;
    if (!this.renderer.setLayerName(layerId, trimmed)) return;
    layerStore.update((s) => ({
      ...s,
      layers: s.layers.map((l) => (l.id === layerId ? { ...l, name: trimmed } : l)),
    }));
    // Rewrite stored keyframe JSON names immediately so a mid-hold commit
    // cannot treat the rename as an artwork edit and spawn phantom poses.
    this.documentManager.syncFromLayerStore(layerStore.get());
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
    // Solo + visibility → Paper. Lifted art stays selected and is not drawn while its layer is hidden.
    this.documentManager.applyEffectiveVisibility();

    // Visibility is part of the layer-structure snapshot, so it participates
    // in undo/redo like every other layer operation.
    this.historyManager.snapshot();
    if (this.documentManager.isPlaying()) this.timelineSession.syncAudio();
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
    if (!this.renderer.setActiveLayer(layerId)) return;
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
      if (unlocked && this.renderer.setActiveLayer(unlocked.id)) {
        layerStore.update((s) => ({ ...s, activeLayerId: unlocked.id }));
        stageSelectedStore.set(false);
      }
      this.selectionController.clearSelection();
      this.directSelectController.clearSelection();
    }

    this.historyManager.snapshot();
    this.requestRedraw();
  }

  /** Delete key: selected vertices, selected artwork, then a selected frame range. */
  private onDeleteSelection() {
    if (this.onFunctionInvoke("delete-vertices")) return;
    if (this.onFunctionInvoke("delete")) return;
    const sel = this.layersPanel.consumeFrameSelection();
    if (!sel) return;
    this.onKeyframeRemove({
      layerIds: sel.layerIds,
      start: sel.start,
      end: sel.end,
    });
  }

  private onFunctionInvoke(functionId: string): boolean {
    const didRun = runContextualAction(functionId, this.buildFunctionContext(), {
      renderer: this.renderer,
      selectionController: this.selectionController,
      directSelectController: this.directSelectController,
      historyManager: this.historyManager,
      camera: this.camera,
      closePanel: () => this.functionsPanel.close("hidden"),
      moveSelectionToNewLayer: () => this.moveSelectionToNewLayer(),
      convertSelectionToSymbol: () => this.convertSelectionToSymbol(),
      openSymbolInstancePopup: () => void this.openSymbolInstancePopup(),
    });
    if (didRun) {
      requestAnimationFrame(() => this.updateFunctionsPanel());
    }
    return didRun;
  }

  private symbolActionServices(): SymbolActionServices {
    return {
      documentManager: this.documentManager,
      renderer: this.renderer,
      selectionController: this.selectionController,
      historyManager: this.historyManager,
      camera: this.camera,
    };
  }

  /** Convert to Symbol (F8): selection → new library symbol + one instance. */
  private convertSelectionToSymbol(): void {
    if (toolStore.get() !== "select") return;
    if (!convertSelectionToSymbol(this.symbolActionServices())) return;
    this.updateFunctionsPanel();
  }

  /** Library Place, or a drag onto the stage (`client` is the drop point). */
  private async placeSymbolInstance(
    symbolId: string,
    client?: { x: number; y: number },
  ): Promise<void> {
    if (toolStore.get() !== "select") await this.switchToolAsync("select");
    await this.timelineSession.commitLiveEdits();
    let world: { x: number; y: number } | undefined;
    if (client) {
      const rect = this.uiCanvas.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const vx = ((client.x - rect.left) / rect.width) * this.config.viewportWidth;
      const vy = ((client.y - rect.top) / rect.height) * this.config.viewportHeight;
      world = this.camera.screenToWorld(vx, vy);
    }
    if (!placeSymbolInstance(this.symbolActionServices(), symbolId, world)) return;
    this.updateFunctionsPanel();
  }

  /** The single selected symbol instance (with its owning part), or null. */
  private selectedInstance(): { part: { xf: Affine; layerId: string }; instance: PlacedInstance } | null {
    return this.renderer.singleSelectedInstance();
  }

  private instancePopupModel(data: PlacedInstance): SymbolInstancePopupModel | null {
    const symbol = this.documentManager.getSymbol(data.symbol);
    if (!symbol) return null;
    const editing = this.documentManager.getEditingSymbolId();
    const swapCandidates = this.documentManager
      .listSymbols()
      .filter((s) => s.id !== symbol.id)
      .filter((s) => !editing || !this.documentManager.symbolWouldCycle(editing, s.id))
      .map((s) => ({ id: s.id, name: s.name }));
    return {
      symbolId: symbol.id,
      symbolName: symbol.name,
      duration: symbol.duration,
      tags: symbol.tags.map((t) => ({ ...t })),
      mode: data.mode,
      firstFrame: data.firstFrame,
      swapCandidates,
    };
  }

  private async openSymbolInstancePopup(): Promise<void> {
    const sel = this.selectedInstance();
    const model = sel ? this.instancePopupModel(sel.instance) : null;
    if (!model) return;
    await this.symbolInstancePopup.openFor(model, this.functionsPanel);
  }

  /** Apply a playback / swap change to the selected instance and record it. */
  private updateSelectedInstance(
    patch: Partial<{ symbol: string; mode: SymbolPlayMode; firstFrame: number }>,
  ): void {
    if (!this.selectedInstance()) return;
    if (!this.renderer.updateSelectedInstances(patch)) return;
    this.selectionController.markSelectionAsModified();
    this.historyManager.snapshot();
    const sel = this.selectedInstance();
    const model = sel ? this.instancePopupModel(sel.instance) : null;
    if (model) this.symbolInstancePopup.setModel(model);
    this.redrawActiveSelectionUI();
  }

  private onSymbolRename(id: string, name: string): void {
    if (!this.documentManager.renameSymbol(id, name)) return;
    this.historyManager.snapshot();
  }

  private onSymbolDuplicate(id: string): void {
    if (!this.documentManager.duplicateSymbol(id)) return;
    this.historyManager.snapshot();
  }

  private onSymbolDelete(id: string): void {
    if (!this.documentManager.deleteSymbol(id)) return;
    this.historyManager.snapshot();
  }

  /**
   * Enter a symbol for editing. With `instance`, the edit happens in place
   * (parent artwork stays visible behind); without, it is an isolated edit
   * from the Library. Entering is not a history entry.
   */
  private async enterSymbol(
    symbolId: string,
    instance?: { instance: PlacedInstance; worldMatrix: Affine; layerId: string },
  ): Promise<void> {
    if (toolStore.get() === "magic-move") return;
    let via: Parameters<DocumentManager["enterSymbol"]>[1];
    if (instance) {
      const symbol = this.documentManager.getSymbol(symbolId);
      if (!symbol) return;
      const { layerId } = instance;
      via = {
        layerId,
        instanceIid: instance.instance.iid,
        childFrame: childFrameFor(
          instance.instance,
          this.renderer.getLayerElapsed(layerId),
          symbol.duration,
        ),
        worldMatrix: [...instance.worldMatrix],
      };
    }
    await this.timelineSession.commitLiveEdits();
    this.selectionController.discardSelection();
    this.directSelectController.clearSelection();
    this.functionsPanel.close("hidden");
    if (!this.documentManager.enterSymbol(symbolId, via)) return;
    this.requestRedraw();
  }

  /**
   * Context stack changed (enter / exit / undo across contexts): keep the
   * symbol's local origin where the instance origin was on screen, and draw
   * the artboard in the symbol's local space.
   */
  private onEditContextChanged(): void {
    const next = this.documentManager.getContextOriginOffset();
    const dx = next.x - this.contextOriginOffset.x;
    const dy = next.y - this.contextOriginOffset.y;
    this.contextOriginOffset = next;
    if (dx !== 0 || dy !== 0) {
      const state = this.camera.getState();
      this.camera.setState({ ...state, x: state.x - dx, y: state.y - dy });
    }
    const toLocal = composeContextToLocal(
      this.documentManager.getEditContext().map((ref) => ({
        instanceIid: ref.instanceIid,
        matrix: ref.worldMatrix,
      })),
    );
    this.stageLayer.setLocalTransform(toLocal ? [...toLocal] : null);
    this.selectionController.discardSelection();
    this.directSelectController.clearSelection();
    this.functionsPanel.close("hidden");
    // The camera state was set directly above (no easing), so every
    // camera-space surface repaints.
    this.cameraChanged();
  }

  /** Leave the innermost symbol (Esc / breadcrumb). */
  private async exitSymbol(toDepth?: number): Promise<void> {
    if (!this.documentManager.isEditingSymbol()) return;
    await this.timelineSession.commitLiveEdits();
    this.selectionController.discardSelection();
    this.directSelectController.clearSelection();
    this.functionsPanel.close("hidden");
    if (toDepth === undefined) this.documentManager.exitSymbol();
    else this.documentManager.exitSymbolTo(toDepth);
    this.requestRedraw();
  }

  /** Quick option: lift the current selection onto a brand-new layer above it. */
  private moveSelectionToNewLayer() {
    if (!this.renderer.hasSelection()) return;

    const id = generateLayerId();
    const state = layerStore.get();
    const nonStage = state.layers.filter((layer) => layer.kind !== "stage");
    const name = `Layer ${nonStage.length + 1}`;
    const selectedIds = this.renderer.getSelectionLayerIds();
    const anchorId =
      selectedIds.length > 0
        ? selectedIds.reduce((best, cur) =>
            state.layers.findIndex((l) => l.id === cur) > state.layers.findIndex((l) => l.id === best) ? cur : best,
          )
        : state.activeLayerId;
    const anchorIndex = state.layers.findIndex((layer) => layer.id === anchorId);
    const insertAt = anchorIndex < 0 ? state.layers.length : anchorIndex + 1;

    stageSelectedStore.set(false);
    this.renderer.createLayer(id, name);
    layerStore.update((current) => {
      const nextLayers = [...current.layers];
      nextLayers.splice(insertAt, 0, {
        id,
        name,
        visible: true,
        locked: false,
        kind: "regular",
      });
      return { ...current, layers: nextLayers, activeLayerId: id };
    });
    this.renderer.reorderLayers(layerStore.get().layers.map((layer) => layer.id));
    this.renderer.moveSelectionToLayer(id);
    this.selectionController.markSelectionAsModified();
    this.requestRedraw();
  }

  private onFunctionDragStart(functionId: string) {
    if (functionId === "simplify") {
      if (!this.directSelectController.beginPathEditDrag(functionId)) return;
      this.functionsPanel.close("hidden");
      // Seed preview from the threshold distance that armed the drag.
      this.onFunctionDragMove(functionId, 5, 0);
      return;
    }

    if (functionId !== "duplicate") return;
    const context = this.buildFunctionContext();
    if (context.tool !== "select" || context.selection.count === 0) return;

    if (!this.selectionController.duplicateSelection(0, 0)) return;

    this.duplicateDragSession = {
      lastWorldDelta: { x: 0, y: 0 },
    };
    this.functionsPanel.close("hidden");
  }

  private onFunctionDragMove(functionId: string, dx: number, dy: number) {
    if (functionId === "simplify") {
      if (!this.directSelectController.isPathEditDragActive()) return;
      const world = this.camera.screenDeltaToWorld(dx, dy);
      // Distance only — X and Y are not separate controls.
      const amount = Math.max(0.05, Math.hypot(world.x, world.y));
      this.directSelectController.updatePathEditDrag(amount);
      return;
    }

    if (functionId !== "duplicate" || !this.duplicateDragSession) return;

    const worldDelta = this.camera.screenDeltaToWorld(dx, dy);
    const stepX = worldDelta.x - this.duplicateDragSession.lastWorldDelta.x;
    const stepY = worldDelta.y - this.duplicateDragSession.lastWorldDelta.y;
    if (stepX === 0 && stepY === 0) return;

    this.renderer.transformSelection(translation(stepX, stepY));
    this.duplicateDragSession.lastWorldDelta = worldDelta;
    this.selectionController.drawUI();
  }

  private onFunctionDragEnd(functionId: string, dx: number, dy: number) {
    if (functionId === "simplify") {
      if (!this.directSelectController.isPathEditDragActive()) return;
      this.onFunctionDragMove(functionId, dx, dy);
      this.directSelectController.endPathEditDrag();
      requestAnimationFrame(() => this.updateFunctionsPanel());
      return;
    }

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

    this.duplicateDragSession = null;
    this.selectionController.markSelectionAsModified();
  }

  private async onExportSvg(options: SvgExportOptions) {
    await this.timelineSession.commitLiveEdits();
    try {
      const { files } = exportDocumentSvg({
        documentManager: this.documentManager,
        stage: stageStore.get(),
        documentName: documentNameStore.get(),
        options,
      });
      await downloadExportFiles(files);
    } catch (err) {
      console.error("SVG export failed", err);
    } finally {
      this.svgExportPopup.exportFinished();
      this.filePanel.hidePanel();
    }
  }

  private async addAudioLayerFromDrop(file: File): Promise<void> {
    const name = file.name.replace(/\.[^.]+$/, "").trim() || "Audio";
    await this.onLayerAdd(generateLayerId(), name, "audio", file);
    this.requestRedraw();
  }

  private setupFileDrop() {
    const root = document.getElementById("canvas-container") ?? document.body;
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");

    root.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });

    root.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      if (isAudioFile(file)) {
        void this.addAudioLayerFromDrop(file);
        return;
      }
      if (isSvgFile(file)) {
        void this.svgImportPopup.openForFile(file);
        return;
      }
      if (!isImageFile(file)) return;
      const { layers, activeLayerId } = layerStore.get();
      const active = layers.find((l) => l.id === activeLayerId);
      if (active?.kind === "image") {
        void this.onImageFrameSet(active.id, file);
        return;
      }
      void this.imageImportPopup.openForFile(file);
    });
  }

  private async onImportImageOpen(anchor: HTMLElement) {
    const file = await pickImageFile();
    if (!file) return;
    if (!isImageFile(file)) {
      alert("Please choose an image file.");
      return;
    }
    await this.imageImportPopup.openForFile(file, anchor);
  }

  private async onGenerateImageReady(detail: GenerateImageReadyDetail) {
    await this.imageImportPopup.openForFile(detail.file, detail.anchor);
  }

  private async onImportSvgOpen(anchor: HTMLElement) {
    const file = await pickSvgFile();
    if (!file) return;
    if (!isSvgFile(file)) {
      alert("Please choose an SVG file.");
      return;
    }
    await this.svgImportPopup.openForFile(file, anchor);
  }

  private async onImportSvg(detail: SvgImportDetail) {
    await this.timelineSession.commitLiveEdits();
    try {
      const svg = await fileToSvgText(detail.file);
      if (!svg.trim()) {
        alert("That SVG file is empty.");
        return;
      }
      const stage = stageStore.get();
      const ok = importSvgOntoActiveLayer(this.renderer, svg, {
        stageWidth: stage.width,
        stageHeight: stage.height,
        snapColors: detail.options.snapToDocumentColors
          ? documentColorsStore.get()
          : undefined,
      });
      if (!ok) {
        alert("SVG produced no paths.");
        return;
      }
      this.historyManager.snapshot("Import SVG");
      this.requestRedraw();
    } catch (err) {
      console.error("SVG import failed", err);
      alert("SVG import failed.");
    } finally {
      this.svgImportPopup.importFinished();
      this.filePanel.hidePanel();
    }
  }

  private async onImportImage(detail: ImageImportDetail) {
    await this.timelineSession.commitLiveEdits();
    const id = generateLayerId();
    const name = nextImportedImageName();
    try {
      stageSelectedStore.set(false);
      this.renderer.createLayer(id, name);
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
        return { ...state, layers: nextLayers, activeLayerId: id };
      });
      this.renderer.reorderLayers(layerStore.get().layers.map((layer) => layer.id));
      this.documentManager.syncFromLayerStore(layerStore.get());
      this.selectionController.clearSelection();
      this.directSelectController.clearSelection();

      const stage = stageStore.get();
      const ok = importSvgOntoActiveLayer(this.renderer, detail.svg, {
        stageWidth: stage.width,
        stageHeight: stage.height,
      });
      if (!ok) {
        alert("Tracing produced no paths.");
        return;
      }
      this.historyManager.snapshot("Import Image");
      this.requestRedraw();
    } catch (err) {
      console.error("Image import failed", err);
      alert("Image import failed.");
    } finally {
      this.imageImportPopup.importFinished();
      this.filePanel.hidePanel();
    }
  }

  private async onExportGodot(options: GodotExportOptions) {
    await this.timelineSession.commitLiveEdits();
    try {
      const { files } = await exportGodotSpriteZip({
        documentManager: this.documentManager,
        stage: stageStore.get(),
        documentName: documentNameStore.get(),
        options,
      });
      await downloadExportFiles(files);
    } catch (err) {
      console.error("Godot export failed", err);
    } finally {
      this.godotExportPopup.exportFinished();
      this.filePanel.hidePanel();
    }
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

  private onFramesMoveDragStart(
    layerIds: string[] | undefined,
    layerId: string | undefined,
    start: number,
    end: number,
  ) {
    this.timelineSession.onFramesMoveDragStart(layerIds, layerId, start, end);
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

  private onFramesToSymbol(
    layerIds: string[] | undefined,
    layerId: string | undefined,
    start: number,
    end: number,
  ) {
    const ids = layerIds ?? (layerId ? [layerId] : []);
    const anchor = layerId ?? ids[0];
    if (!anchor || ids.length === 0) return;
    convertFrameRangeToSymbol(this.symbolActionServices(), ids, start, end, anchor);
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
  // Document Export / Open / New (delegated to TimelineSession)
  // ============================================================

  private onDocSave() {
    this.timelineSession.onDocSave();
  }

  private async onDocOpen() {
    await this.timelineSession.onDocOpen();
  }

  private async onDocNew() {
    if (!(await this.timelineSession.onDocNew())) return;
    this.startupPanel.canRestoreAutosave =
      this.timelineSession.hasSessionAutosaveCandidate();
    void this.startupPanel.show();
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

    this.renderer.reorderLayers(orderedBottomToTop);

    // The layer just dragged becomes the active layer.
    let activeLayerId = state.activeLayerId;
    if (
      movedId &&
      movedId !== STAGE_LAYER_ID &&
      movedId !== activeLayerId &&
      this.renderer.setActiveLayer(movedId)
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
