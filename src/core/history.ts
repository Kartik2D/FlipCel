/**
 * History Manager - Undo/Redo System
 *
 * Manages undo/redo functionality using Paper.js layer snapshots.
 * Each action that modifies the canvas (addPath, subtractPath, placeSelection, etc.)
 * creates a snapshot that can be restored.
 *
 * Uses JSON serialization of Paper.js layer state for efficient storage.
 */
import paper from "paper";
import { Store, stageStore } from "./stores";

interface HistoryEntry {
  layerJSON: string;
  timestamp: number;
  /** Stage fill color at this snapshot (undo/redo restores it). */
  stageColor: string;
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

  constructor() {
    // Take initial snapshot on first call to snapshot()
  }

  /**
   * Take a snapshot of the current layer state
   * Call this after any action that modifies the canvas
   */
  snapshot(): void {
    // Don't snapshot while restoring (prevents double-entries)
    if (this.isRestoring) return;

    const json = paper.project.activeLayer.exportJSON();
    const stageColor = stageStore.get().color;

    // Truncate any redo entries (we're starting a new branch)
    this.stack = this.stack.slice(0, this.index + 1);

    // Add new entry
    this.stack.push({
      layerJSON: json,
      timestamp: Date.now(),
      stageColor,
    });

    // Enforce max size (remove oldest entries)
    if (this.stack.length > this.maxSize) {
      this.stack.shift();
    } else {
      this.index++;
    }

    // Ensure index is valid
    this.index = this.stack.length - 1;

    this.updateState();
  }

  /**
   * Undo the last action
   * @returns true if undo was successful
   */
  undo(): boolean {
    if (!this.canUndo()) return false;

    this.index--;
    this.restore();
    this.updateState();
    return true;
  }

  /**
   * Redo the previously undone action
   * @returns true if redo was successful
   */
  redo(): boolean {
    if (!this.canRedo()) return false;

    this.index++;
    this.restore();
    this.updateState();
    return true;
  }

  /**
   * Check if undo is available
   */
  canUndo(): boolean {
    return this.index > 0;
  }

  /**
   * Check if redo is available
   */
  canRedo(): boolean {
    return this.index < this.stack.length - 1;
  }

  /**
   * Get the number of entries in the history
   */
  getStackSize(): number {
    return this.stack.length;
  }

  /**
   * Get the current position in the history
   */
  getCurrentIndex(): number {
    return this.index;
  }

  /**
   * Clear all history (e.g., when clearing the canvas)
   */
  clear(): void {
    this.stack = [];
    this.index = -1;
    this.updateState();
  }

  /**
   * Restore the layer state at the current index
   */
  private restore(): void {
    if (this.index < 0 || this.index >= this.stack.length) return;

    this.isRestoring = true;

    try {
      // Clear current layer
      paper.project.activeLayer.removeChildren();

      // Import the saved state
      const entry = this.stack[this.index];
      paper.project.activeLayer.importJSON(entry.layerJSON);
      stageStore.update((s) => ({ ...s, color: entry.stageColor ?? "#ffffff" }));

      // Update view
      paper.view.update();
    } finally {
      this.isRestoring = false;
    }
  }

  /**
   * Update the observable history state
   */
  private updateState(): void {
    historyStateStore.set({
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
    });
  }
}

