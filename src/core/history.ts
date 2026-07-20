/**
 * History Manager - Document-Level Undo/Redo
 *
 * Every snapshot captures the full document state: layer tracks (order,
 * names, visibility, keyframes), the playhead, duration/frame rate, the
 * active layer, and the stage color. Restoring an entry rebuilds all of it,
 * so undo works across layer operations AND timeline operations.
 *
 * Memory: artwork content lives in the DocumentManager's content-addressed
 * store; history entries only hold content *ids*, so entries are tiny.
 * Content garbage collection runs after the stack is trimmed.
 */
import { Store, stageStore, layerStore } from "./stores";
import type { DocumentManager, DocumentState } from "./document";

interface HistoryEntry {
  doc: DocumentState;
  activeLayerId: string;
  stageColor: string;
  timestamp: number;
}

/**
 * Observable state for UI components to subscribe to
 */
export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * Store for history state (allows UI components to react to changes)
 */
export const historyStateStore = new Store<HistoryState>({
  canUndo: false,
  canRedo: false,
});

export class HistoryManager {
  private stack: HistoryEntry[] = [];
  private index = -1;
  private maxSize = 50;
  private isRestoring = false;
  private doc: DocumentManager;
  /** Notified after every snapshot (used for debounced autosave). */
  private onChangeCallback: (() => void) | null = null;

  constructor(doc: DocumentManager) {
    this.doc = doc;
  }

  setOnChange(callback: (() => void) | null): void {
    this.onChangeCallback = callback;
  }

  /**
   * Take a snapshot of the current document state.
   * Call this after any action that modifies the canvas, the layer list,
   * or the timeline.
   */
  snapshot(): void {
    // Don't snapshot while restoring (prevents double-entries)
    if (this.isRestoring) return;

    // Pull the live editing state into the document model first:
    // layer list changes, then the active Paper layer's content.
    const layerState = layerStore.get();
    this.doc.syncFromLayerStore(layerState);
    this.doc.commitActiveLayerContent();

    // Truncate any redo entries (we're starting a new branch)
    this.stack = this.stack.slice(0, this.index + 1);

    this.stack.push({
      doc: this.doc.captureState(),
      activeLayerId: layerState.activeLayerId,
      stageColor: stageStore.get().color,
      timestamp: Date.now(),
    });

    // Enforce max size (remove oldest entries)
    if (this.stack.length > this.maxSize) {
      this.stack.shift();
      this.gcContent();
    }
    this.index = this.stack.length - 1;

    this.updateState();
    this.onChangeCallback?.();
  }

  undo(): boolean {
    if (!this.canUndo()) return false;

    this.index--;
    this.restore();
    this.updateState();
    return true;
  }

  redo(): boolean {
    if (!this.canRedo()) return false;

    this.index++;
    this.restore();
    this.updateState();
    return true;
  }

  canUndo(): boolean {
    return this.index > 0;
  }

  canRedo(): boolean {
    return this.index < this.stack.length - 1;
  }

  getStackSize(): number {
    return this.stack.length;
  }

  getCurrentIndex(): number {
    return this.index;
  }

  /**
   * Clear all history (e.g. after loading or creating a document).
   */
  clear(): void {
    this.stack = [];
    this.index = -1;
    this.gcContent();
    this.updateState();
  }

  /**
   * Restore the document state at the current index.
   */
  private restore(): void {
    if (this.index < 0 || this.index >= this.stack.length) return;

    this.isRestoring = true;
    try {
      const entry = this.stack[this.index];
      this.doc.applyState(entry.doc, entry.activeLayerId);
      stageStore.update((s) => ({ ...s, color: entry.stageColor ?? "#ffffff" }));
    } finally {
      this.isRestoring = false;
    }
    this.onChangeCallback?.();
  }

  /** Sweep content not referenced by any history entry (or the live doc). */
  private gcContent(): void {
    const referenced = new Set<string>();
    for (const entry of this.stack) {
      for (const track of entry.doc.tracks) {
        for (const kf of track.keyframes) referenced.add(kf.contentId);
      }
    }
    this.doc.gcContent(referenced);
  }

  private updateState(): void {
    historyStateStore.set({
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
    });
  }
}
