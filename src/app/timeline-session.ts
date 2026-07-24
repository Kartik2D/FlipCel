/**
 * Timeline / animation + document IO session.
 *
 * Owns playhead, keyframe, onion-skin, playback, and save/open/new handlers
 * extracted from App so bootstrap stays focused on wiring.
 */
import type { DocumentManager, SerializedDocument } from "../document/document";
import {
  EMPTY_CONTENT_ID,
  DEFAULT_FRAME_RATE,
  DEFAULT_DURATION,
} from "../document/document";
import { downloadDocument, pickDocumentFile } from "../document/persistence";
import type { HistoryManager } from "../document/history";
import type { SelectionController } from "../editing/object-select";
import type { DirectSelectController } from "../editing/direct-select";
import type { PaperRenderer } from "../render/paper-renderer";
import type { InkwellLayersPanel } from "../ui/register";
import type { ToolId } from "../tools/registry";
import type { FrameRangeDetail } from "./panel-bridge";
import {
  layerStore,
  stageStore,
  stageSelectedStore,
  toolStore,
  STAGE_LAYER_ID,
  generateLayerId,
  DEFAULT_STAGE_WIDTH,
  DEFAULT_STAGE_HEIGHT,
} from "../state/index";

export interface TimelineSessionDeps {
  documentManager: DocumentManager;
  historyManager: HistoryManager;
  selectionController: SelectionController;
  directSelectController: DirectSelectController;
  paperRenderer: PaperRenderer;
  layersPanel: InkwellLayersPanel;
  switchTool: (tool: ToolId) => void;
  requestRedraw: () => void;
  fitStageInView: (immediate: boolean) => void;
  closeFunctionsPanelHidden: () => void;
}

export class TimelineSession {
  private readonly deps: TimelineSessionDeps;
  /** Accumulates wall-clock time between animation frame advances during playback. */
  private playbackAccumulatorMs = 0;

  constructor(deps: TimelineSessionDeps) {
    this.deps = deps;
  }

  /** Advance the animation playhead during playback (driven by the frame loop). */
  stepPlayback(dtMs: number): void {
    const { documentManager, requestRedraw } = this.deps;
    if (!documentManager.isPlaying()) {
      this.playbackAccumulatorMs = 0;
      return;
    }
    this.playbackAccumulatorMs += dtMs;
    const frameMs = 1000 / documentManager.getFrameRate();
    if (this.playbackAccumulatorMs < frameMs) return;
    // Advance one frame per repaint at most; drop backlog to avoid spiraling.
    this.playbackAccumulatorMs = this.playbackAccumulatorMs % frameMs;
    const next =
      (documentManager.getCurrentFrame() + 1) % documentManager.getDuration();
    documentManager.gotoFrame(next);
    requestRedraw();
  }

  /**
   * Move the playhead (optionally also activating a layer, when the click
   * landed on another row). Selections are placed first so pending edits
   * commit to the frame they were made on.
   *
   * Frame-cell clicks (with `layerId`) mirror the layers panel: switch to the
   * select tool and select every item on the active layer. Playhead scrub /
   * jog (no `layerId`) only moves the playhead and clears selection.
   */
  onTimelineFrameSelect(frame: number, layerId?: string): void {
    const {
      documentManager,
      selectionController,
      directSelectController,
      paperRenderer,
      switchTool,
      requestRedraw,
      closeFunctionsPanelHidden,
    } = this.deps;

    if (layerId) {
      if (layerId === STAGE_LAYER_ID) return;

      const state = layerStore.get();
      const isAlreadyActive = state.activeLayerId === layerId;
      const isSameFrame = documentManager.getCurrentFrame() === frame;

      if (
        isAlreadyActive &&
        isSameFrame &&
        (selectionController.hasSelection() || directSelectController.hasSelection())
      ) {
        selectionController.clearSelection();
        directSelectController.clearSelection();
        closeFunctionsPanelHidden();
        return;
      }
    }

    selectionController.clearSelection();
    directSelectController.clearSelection();
    closeFunctionsPanelHidden();

    if (layerId && layerId !== layerStore.get().activeLayerId) {
      if (paperRenderer.setActiveLayer(layerId)) {
        stageSelectedStore.set(false);
        layerStore.update((s) => ({ ...s, activeLayerId: layerId }));
      }
    }

    documentManager.gotoFrame(frame);

    if (layerId) {
      if (toolStore.get() !== "select") {
        switchTool("select");
      }
      const allItems = paperRenderer.getAllPaths();
      selectionController.setSelectedItems(allItems);
    }

    requestRedraw();
  }

  timelineTargetLayerId(): string | null {
    const active = layerStore.get().activeLayerId;
    if (active !== STAGE_LAYER_ID) return active;
    return this.deps.paperRenderer.getActiveLayerId();
  }

  /** Pull live Paper edits into the document model without a history entry. */
  commitLiveEdits(): void {
    this.deps.documentManager.syncFromLayerStore(layerStore.get());
    this.deps.documentManager.commitActiveLayerContent();
  }

  onKeyframeAdd(blank: boolean): void {
    const { documentManager, historyManager, requestRedraw } = this.deps;
    const layerId = this.timelineTargetLayerId();
    if (!layerId) return;
    // Commit live edits first so a copied keyframe captures what's on screen.
    this.commitLiveEdits();
    if (documentManager.addKeyframe(layerId, documentManager.getCurrentFrame(), blank)) {
      historyManager.snapshot();
      requestRedraw();
    }
  }

  onKeyframeHoldToggle(layerId: string, frame: number): void {
    const { documentManager, historyManager, requestRedraw } = this.deps;
    // Commit live edits first so extending a hold doesn't clobber an
    // in-progress drawing on the tapped span.
    this.commitLiveEdits();
    if (documentManager.toggleKeyframeHold(layerId, frame)) {
      historyManager.snapshot();
      requestRedraw();
    }
  }

  /** Delete a frame range; without one, the playhead frame on the active layer. */
  onKeyframeRemove(range?: FrameRangeDetail): void {
    const {
      documentManager,
      historyManager,
      selectionController,
      directSelectController,
      requestRedraw,
    } = this.deps;
    const fallbackLayerId = this.timelineTargetLayerId();
    const targets = this.frameActionTargets(
      range?.layerIds,
      range?.layerId ?? fallbackLayerId ?? undefined,
    );
    if (targets.length === 0) return;
    selectionController.clearSelection();
    directSelectController.clearSelection();
    const frame = documentManager.getCurrentFrame();
    const start = range?.start ?? frame;
    const end = range?.end ?? frame;
    let changed = false;
    for (const id of targets) {
      if (documentManager.removeFrameRange(id, start, end)) {
        changed = true;
      }
    }
    if (changed) {
      historyManager.snapshot();
      requestRedraw();
    }
  }

  frameActionTargets(
    layerIds: string[] | undefined,
    layerId: string | undefined,
  ): string[] {
    if (layerIds && layerIds.length > 0) return layerIds;
    if (layerId) return [layerId];
    return [];
  }

  onFramesMove(
    layerIds: string[] | undefined,
    layerId: string | undefined,
    start: number,
    end: number,
    delta: number,
  ): void {
    const {
      documentManager,
      historyManager,
      selectionController,
      directSelectController,
      requestRedraw,
    } = this.deps;
    const targets = this.frameActionTargets(layerIds, layerId);
    if (targets.length === 0) return;
    // Commit live edits first so an in-progress drawing travels with its frame.
    this.commitLiveEdits();
    selectionController.clearSelection();
    directSelectController.clearSelection();
    let changed = false;
    for (const id of targets) {
      if (documentManager.moveFrameRange(id, start, end, delta)) {
        changed = true;
      }
    }
    if (changed) {
      historyManager.snapshot();
      requestRedraw();
    }
  }

  onFramesDuplicate(
    layerIds: string[] | undefined,
    layerId: string | undefined,
    start: number,
    end: number,
  ): void {
    const { documentManager, historyManager, layersPanel, requestRedraw } = this.deps;
    const targets = this.frameActionTargets(layerIds, layerId);
    if (targets.length === 0) return;
    this.commitLiveEdits();
    let changed = false;
    let destStart: number | null = null;
    let destEnd: number | null = null;
    for (const id of targets) {
      const result = documentManager.duplicateFrameRange(id, start, end);
      if (!result) continue;
      changed = true;
      destStart = result.start;
      destEnd = result.end;
    }
    if (!changed || destStart === null || destEnd === null) return;
    layersPanel.setFrameSelection({
      layerIds: targets,
      start: destStart,
      end: destEnd,
    });
    historyManager.snapshot();
    requestRedraw();
  }

  onFramesDuplicateDragStart(
    _layerIds: string[] | undefined,
    _layerId: string | undefined,
    _start: number,
    _end: number,
  ): void {
    this.commitLiveEdits();
  }

  onFramesDuplicateDragEnd(
    layerIds: string[] | undefined,
    layerId: string | undefined,
    start: number,
    end: number,
    delta: number,
  ): void {
    const { documentManager, historyManager, layersPanel, requestRedraw } = this.deps;
    const targets = this.frameActionTargets(layerIds, layerId);
    if (targets.length === 0) return;
    this.commitLiveEdits();
    if (delta === 0) {
      this.onFramesDuplicate(layerIds, layerId, start, end);
      return;
    }
    const destStart = start + delta;
    let changed = false;
    let resultStart: number | null = null;
    let resultEnd: number | null = null;
    for (const id of targets) {
      const result = documentManager.duplicateFrameRange(
        id,
        start,
        end,
        destStart,
      );
      if (!result) continue;
      changed = true;
      resultStart = result.start;
      resultEnd = result.end;
    }
    if (!changed || resultStart === null || resultEnd === null) return;
    layersPanel.setFrameSelection({
      layerIds: targets,
      start: resultStart,
      end: resultEnd,
    });
    historyManager.snapshot();
    requestRedraw();
  }

  onFramesReverse(
    layerIds: string[] | undefined,
    layerId: string | undefined,
    start: number,
    end: number,
  ): void {
    const { documentManager, historyManager, requestRedraw } = this.deps;
    const targets = this.frameActionTargets(layerIds, layerId);
    if (targets.length === 0) return;
    this.commitLiveEdits();
    let changed = false;
    for (const id of targets) {
      if (documentManager.reverseFrameRange(id, start, end)) {
        changed = true;
      }
    }
    if (changed) {
      historyManager.snapshot();
      requestRedraw();
    }
  }

  onOnionToggle(): void {
    const { documentManager, requestRedraw } = this.deps;
    // Commit live edits first so the ghosts compare against what's on screen.
    this.commitLiveEdits();
    documentManager.setOnionSkin(!documentManager.isOnionSkinEnabled());
    requestRedraw();
  }

  onPlayToggle(): void {
    const {
      documentManager,
      selectionController,
      directSelectController,
      requestRedraw,
      closeFunctionsPanelHidden,
    } = this.deps;
    const playing = !documentManager.isPlaying();
    if (playing) {
      // Commit pending edits, then drop selection UI for clean playback.
      this.commitLiveEdits();
      selectionController.clearSelection();
      directSelectController.clearSelection();
      closeFunctionsPanelHidden();
      this.playbackAccumulatorMs = 0;
    }
    documentManager.setPlaying(playing);
    requestRedraw();
  }

  // ============================================================
  // Document Save / Open / New
  // ============================================================

  serializeDocument(): SerializedDocument {
    return this.deps.documentManager.serialize(stageStore.get());
  }

  onDocSave(): void {
    // Commit any live Paper edits into the document model first.
    this.commitLiveEdits();
    downloadDocument(this.serializeDocument());
  }

  async onDocOpen(): Promise<void> {
    const { historyManager, requestRedraw } = this.deps;
    try {
      const doc = await pickDocumentFile();
      if (!doc) return;
      this.applyLoadedDocument(doc);
      historyManager.clear();
      historyManager.snapshot();
      requestRedraw();
    } catch (error) {
      console.error("Failed to open document:", error);
      alert(`Could not open file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  onDocNew(): void {
    const { historyManager, requestRedraw } = this.deps;
    if (!confirm("Start a new document? Unsaved changes will be lost.")) return;
    const layerId = generateLayerId();
    this.applyLoadedDocument({
      version: 1,
      stage: { width: DEFAULT_STAGE_WIDTH, height: DEFAULT_STAGE_HEIGHT, color: "#ffffff" },
      frameRate: DEFAULT_FRAME_RATE,
      duration: DEFAULT_DURATION,
      tracks: [
        {
          id: layerId,
          name: "Layer 1",
          visible: true,
          keyframes: [{ frameIndex: 0, contentId: EMPTY_CONTENT_ID, holdUntil: 0 }],
        },
      ],
      content: { [EMPTY_CONTENT_ID]: "" },
    });
    historyManager.clear();
    historyManager.snapshot();
    requestRedraw();
  }

  /** Swap in a document (from file or autosave) and reset editor state. */
  applyLoadedDocument(doc: SerializedDocument): void {
    const {
      selectionController,
      directSelectController,
      documentManager,
      fitStageInView,
      requestRedraw,
      closeFunctionsPanelHidden,
    } = this.deps;

    selectionController.discardSelection();
    directSelectController.clearSelection();
    closeFunctionsPanelHidden();

    stageStore.set({ ...doc.stage });
    documentManager.loadSerialized(doc);
    fitStageInView(true);
    requestRedraw();
  }
}
