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
import { STARTUP_DOCUMENT } from "../document/startup-document";
import { downloadDocument, pickDocumentFile, loadAutosave } from "../document/persistence";
import type { HistoryManager } from "../document/history";
import type { SelectionController } from "../editing/object-select";
import type { DirectSelectController } from "../editing/direct-select";
import type { MagicMoveController } from "../editing/magic-move";
import type { MagicMorphController } from "../editing/magic-morph";
import type { PaperRenderer } from "../render/paper-renderer";
import type { FlipCelLayersPanel } from "../ui/register";
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
  documentNameStore,
  DEFAULT_DOCUMENT_NAME,
  downloadDocumentName,
} from "../state/index";

/** Fresh empty document used for New File and app launch. */
export function createBlankSerializedDocument(): SerializedDocument {
  const layerId = generateLayerId();
  return {
    version: 1,
    stage: {
      width: DEFAULT_STAGE_WIDTH,
      height: DEFAULT_STAGE_HEIGHT,
      color: "#ffffff",
    },
    frameRate: DEFAULT_FRAME_RATE,
    duration: DEFAULT_DURATION,
    tracks: [
      {
        id: layerId,
        name: "Layer 1",
        visible: true,
        locked: false,
        keyframes: [{ frameIndex: 0, contentId: EMPTY_CONTENT_ID, holdUntil: 0 }],
      },
    ],
    content: { [EMPTY_CONTENT_ID]: "" },
  };
}

export interface TimelineSessionDeps {
  documentManager: DocumentManager;
  historyManager: HistoryManager;
  selectionController: SelectionController;
  directSelectController: DirectSelectController;
  magicMoveController: MagicMoveController;
  magicMorphController: MagicMorphController;
  paperRenderer: PaperRenderer;
  layersPanel: FlipCelLayersPanel;
  switchTool: (tool: ToolId) => void;
  requestRedraw: () => void;
  fitStageInView: (immediate: boolean) => void;
  closeFunctionsPanelHidden: () => void;
  closeSettingsPanel: () => void;
}

export class TimelineSession {
  private readonly deps: TimelineSessionDeps;
  /** Autosave captured at session start (before the blank launch doc overwrites IDB). */
  private sessionAutosaveCandidate: SerializedDocument | null = null;
  /** Accumulates wall-clock time between animation frame advances during playback. */
  private playbackAccumulatorMs = 0;

  constructor(deps: TimelineSessionDeps) {
    this.deps = deps;
  }

  /** Read IndexedDB autosave once at launch for "Restore previous file". */
  async captureSessionAutosaveCandidate(): Promise<void> {
    try {
      this.sessionAutosaveCandidate = await loadAutosave();
    } catch (error) {
      console.error("Failed to read autosave for restore:", error);
      this.sessionAutosaveCandidate = null;
    }
  }

  hasSessionAutosaveCandidate(): boolean {
    return this.sessionAutosaveCandidate !== null;
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
   * landed on another row). Selections are always confirmed first so pending
   * transforms commit to the frame they were made on, and selection chrome
   * is cleared before the new frame loads.
   *
   * Frame-cell clicks (with `layerId`, without `navigateOnly`) mirror the
   * layers panel: switch to the select tool and select every item on the
   * active layer. Playhead scrub / jog / navigateOnly only moves the
   * playhead after confirming selection.
   */
  onTimelineFrameSelect(
    frame: number,
    layerId?: string,
    options?: { navigateOnly?: boolean },
  ): void {
    const {
      documentManager,
      selectionController,
      directSelectController,
      magicMoveController,
      magicMorphController,
      paperRenderer,
      switchTool,
      requestRedraw,
      closeFunctionsPanelHidden,
    } = this.deps;

    const navigateOnly = options?.navigateOnly === true;

    // Commit EMF overlays before the playhead moves so rebuilds don't drop edits.
    if (documentManager.isEditMultipleFrames()) {
      this.commitLiveEdits();
    }

    const hasPendingSelection =
      selectionController.hasSelection() ||
      directSelectController.hasSelection() ||
      magicMoveController.hasSelection() ||
      magicMorphController.hasTransientUI();

    if (layerId) {
      if (layerId === STAGE_LAYER_ID) return;

      const state = layerStore.get();
      const isAlreadyActive = state.activeLayerId === layerId;
      const isSameFrame = documentManager.getCurrentFrame() === frame;

      if (
        !navigateOnly &&
        isAlreadyActive &&
        isSameFrame &&
        hasPendingSelection
      ) {
        selectionController.confirmAndClearSelection();
        directSelectController.confirmAndClearSelection();
        magicMoveController.deactivate();
        magicMorphController.deactivate();
        closeFunctionsPanelHidden();
        return;
      }
    }

    // Scrub/jog (navigateOnly): only confirm/clear when something is pending.
    // Re-doing this every tick made playhead scrub feel heavy on long timelines.
    // Full frame-cell clicks still always confirm + commit.
    if (!navigateOnly || hasPendingSelection) {
      selectionController.confirmAndClearSelection();
      directSelectController.confirmAndClearSelection();
      magicMoveController.deactivate();
      magicMorphController.deactivate();
      closeFunctionsPanelHidden();
      this.commitLiveEdits();
    }

    if (layerId && layerId !== layerStore.get().activeLayerId) {
      if (paperRenderer.setActiveLayer(layerId)) {
        stageSelectedStore.set(false);
        layerStore.update((s) => ({ ...s, activeLayerId: layerId }));
      }
    }

    documentManager.gotoFrame(frame);

    if (layerId && !navigateOnly) {
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
    this.deps.documentManager.commitDirtyLayerContent();
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
    if (layerStore.get().layers.some((l) => l.id === layerId && l.locked)) {
      return;
    }
    // Commit live edits first so extending a hold doesn't clobber an
    // in-progress drawing on the tapped span.
    this.commitLiveEdits();
    if (documentManager.toggleKeyframeHold(layerId, frame)) {
      historyManager.snapshot();
      requestRedraw();
    }
  }

  onTagAdd(start: number, end: number): void {
    const { documentManager, historyManager } = this.deps;
    if (documentManager.addFrameTag(start, end)) {
      historyManager.snapshot("Tag frames");
    }
  }

  onTagRename(id: string, name: string): void {
    const { documentManager, historyManager } = this.deps;
    if (documentManager.renameFrameTag(id, name)) {
      historyManager.snapshot("Rename tag");
    }
  }

  onTagRemove(id: string): void {
    const { documentManager, historyManager } = this.deps;
    if (documentManager.removeFrameTag(id)) {
      historyManager.snapshot("Delete tag");
    }
  }

  onTagResize(id: string, start: number, end: number): void {
    const { documentManager, historyManager } = this.deps;
    if (documentManager.resizeFrameTag(id, start, end)) {
      historyManager.snapshot("Resize tag");
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
    this.deps.magicMoveController.deactivate();
    this.deps.magicMorphController.deactivate();
    this.commitLiveEdits();
    if (documentManager.isEditMultipleFrames()) {
      documentManager.setEditMultipleFrames(false);
    }
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
    const locked = new Set(
      layerStore
        .get()
        .layers.filter((l) => l.locked)
        .map((l) => l.id),
    );
    const ids =
      layerIds && layerIds.length > 0
        ? layerIds
        : layerId
          ? [layerId]
          : [];
    return ids.filter((id) => !locked.has(id));
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
    if (documentManager.isEditMultipleFrames()) {
      documentManager.setEditMultipleFrames(false);
    }
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
    if (documentManager.isEditMultipleFrames()) {
      documentManager.setEditMultipleFrames(false);
    }
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

  onFramesMoveDragStart(
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
    if (documentManager.isEditMultipleFrames()) {
      documentManager.setEditMultipleFrames(false);
    }
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
    if (documentManager.isEditMultipleFrames()) {
      documentManager.setEditMultipleFrames(false);
    }
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

  /**
   * Flash-style Edit Multiple Frames: show range contents on stage for
   * select/transform/recolor. New drawing still targets the playhead.
   */
  onEditMultipleFramesToggle(
    enabled: boolean,
    layerIds: string[] | undefined,
    layerId: string | undefined,
    start: number,
    end: number,
  ): void {
    const { documentManager, selectionController, directSelectController, requestRedraw } =
      this.deps;
    this.commitLiveEdits();
    selectionController.clearSelection();
    directSelectController.clearSelection();

    if (!enabled) {
      documentManager.setEditMultipleFrames(false);
      requestRedraw();
      return;
    }

    const targets = this.frameActionTargets(layerIds, layerId);
    if (targets.length === 0) return;
    documentManager.setEditMultipleFrames(true, {
      layerIds: targets,
      start,
      end,
    });
    requestRedraw();
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
      // Confirm pending transforms, then drop selection UI for clean playback.
      selectionController.confirmAndClearSelection();
      directSelectController.confirmAndClearSelection();
      this.deps.magicMoveController.deactivate();
      this.deps.magicMorphController.deactivate();
      this.commitLiveEdits();
      closeFunctionsPanelHidden();
      this.playbackAccumulatorMs = 0;
    }
    documentManager.setPlaying(playing);
    requestRedraw();
  }

  // ============================================================
  // Document Export / Open / New
  // ============================================================

  serializeDocument(): SerializedDocument {
    return this.deps.documentManager.serialize(stageStore.get());
  }

  onDocSave(): void {
    // Commit any live Paper edits into the document model first.
    this.commitLiveEdits();
    downloadDocument(
      this.serializeDocument(),
      downloadDocumentName(documentNameStore.get()),
    );
  }

  async onDocOpen(): Promise<boolean> {
    const { historyManager, requestRedraw } = this.deps;
    try {
      const picked = await pickDocumentFile();
      if (!picked) return false;
      this.applyLoadedDocument(picked.doc);
      documentNameStore.set(picked.filename);
      historyManager.clear();
      historyManager.snapshot();
      requestRedraw();
      return true;
    } catch (error) {
      console.error("Failed to open document:", error);
      alert(`Could not open file: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** Restore the autosave snapshot from before this session's blank launch doc. */
  async restoreAutosaveDocument(): Promise<boolean> {
    const { historyManager, requestRedraw } = this.deps;
    const doc = this.sessionAutosaveCandidate;
    if (!doc) return false;
    try {
      this.applyLoadedDocument(doc);
      documentNameStore.set("Previous file");
      this.sessionAutosaveCandidate = null;
      historyManager.clear();
      historyManager.snapshot();
      requestRedraw();
      return true;
    } catch (error) {
      console.error("Failed to restore autosave:", error);
      alert(
        `Could not restore previous file: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /** Start a blank document. Returns false if the user cancels. */
  onDocNew(): boolean {
    const { historyManager, requestRedraw } = this.deps;
    if (!confirm("Start a new document? Unsaved changes will be lost.")) return false;
    // Keep the current doc available for startup "Restore previous file".
    this.commitLiveEdits();
    this.sessionAutosaveCandidate = this.serializeDocument();
    this.applyLoadedDocument(createBlankSerializedDocument());
    documentNameStore.set(DEFAULT_DOCUMENT_NAME);
    historyManager.clear();
    historyManager.snapshot();
    requestRedraw();
    return true;
  }

  /** Load the bundled demo document (startup example). */
  loadExampleDocument(): void {
    const { historyManager, requestRedraw } = this.deps;
    this.applyLoadedDocument(STARTUP_DOCUMENT);
    documentNameStore.set("Example");
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
      closeSettingsPanel,
    } = this.deps;

    selectionController.discardSelection();
    directSelectController.clearSelection();
    this.deps.magicMoveController.deactivate();
    this.deps.magicMorphController.deactivate();
    closeFunctionsPanelHidden();
    closeSettingsPanel();

    stageStore.set({ ...doc.stage });
    documentManager.loadSerialized(doc);
    fitStageInView(true);
    requestRedraw();
  }
}
