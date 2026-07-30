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
import { Store, stageStore, layerStore } from "../state/index";
import type { DocumentManager, DocumentState } from "./document";

interface HistoryEntry {
  doc: DocumentState;
  activeLayerId: string;
  soloLayerId: string | null;
  stageColor: string;
  timestamp: number;
  label: string;
}

/** Lightweight stack entry for the undo-history window. */
export interface HistoryListEntry {
  index: number;
  label: string;
  timestamp: number;
  isCurrent: boolean;
  /** True when this entry is ahead of the current index (redo branch). */
  isFuture: boolean;
}

/**
 * Observable state for UI components to subscribe to
 */
export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  currentIndex: number;
  entries: HistoryListEntry[];
}

/**
 * Store for history state (allows UI components to react to changes)
 */
export const historyStateStore = new Store<HistoryState>({
  canUndo: false,
  canRedo: false,
  currentIndex: -1,
  entries: [],
});

function defaultLabel(index: number): string {
  return index <= 0 ? "Document" : `Edit ${index}`;
}

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
  snapshot(label?: string): void {
    // Don't snapshot while restoring (prevents double-entries)
    if (this.isRestoring) return;

    // Pull the live editing state into the document model first:
    // layer list changes, then dirty Paper layer content.
    const layerState = layerStore.get();
    this.doc.syncFromLayerStore(layerState);
    this.doc.commitDirtyLayerContent();

    // Truncate any redo entries (we're starting a new branch)
    this.stack = this.stack.slice(0, this.index + 1);

    const nextIndex = this.stack.length;
    this.stack.push({
      doc: this.doc.captureState(),
      activeLayerId: layerState.activeLayerId,
      soloLayerId: layerState.soloLayerId,
      stageColor: stageStore.get().color,
      timestamp: Date.now(),
      label: label?.trim() || defaultLabel(nextIndex),
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

  /**
   * Jump to a specific history entry without truncating the stack.
   * New edits after a jump still truncate the redo branch via snapshot().
   */
  goTo(index: number): boolean {
    if (index < 0 || index >= this.stack.length || index === this.index) {
      return false;
    }

    this.index = index;
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
      this.doc.applyState(
        entry.doc,
        entry.activeLayerId,
        entry.soloLayerId ?? null,
      );
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
      currentIndex: this.index,
      entries: this.stack.map((entry, i) => ({
        index: i,
        label: entry.label,
        timestamp: entry.timestamp,
        isCurrent: i === this.index,
        isFuture: i > this.index,
      })),
    });
  }
}
