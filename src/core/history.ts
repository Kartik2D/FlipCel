/**
 * History Manager - Undo/Redo System
 *
 * Each snapshot captures the complete layer structure (order, names,
 * visibility, active layer) plus per-layer content JSON, so undo/redo
 * restores layer operations (add/delete/reorder/rename/visibility) as well
 * as drawing edits.
 *
 * Memory: only the active layer is re-exported on each snapshot; all other
 * layers reuse the cached JSON string from their last export by reference.
 * Fifty entries therefore cost roughly "one copy of the document plus one
 * string per edit", not fifty copies of everything.
 */
import paper from "paper";
import {
  Store,
  stageStore,
  layerStore,
  stageSelectedStore,
  STAGE_LAYER_ID,
  type Layer,
} from "./stores";
import type { PaperRenderer } from "./paper-renderer";

interface HistoryLayer extends Layer {
  /** Content JSON for regular layers; undefined for the stage row. */
  json?: string;
}

interface HistoryEntry {
  /** Bottom-to-top, includes the stage row (mirrors layerStore). */
  layers: HistoryLayer[];
  activeLayerId: string;
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
  /** Last-known content JSON per layer id (kept in sync at every snapshot/restore). */
  private jsonCache = new Map<string, string>();
  private renderer: PaperRenderer;

  constructor(renderer: PaperRenderer) {
    this.renderer = renderer;
  }

  /**
   * Take a snapshot of the current document state.
   * Call this after any action that modifies the canvas or the layer list.
   */
  snapshot(): void {
    // Don't snapshot while restoring (prevents double-entries)
    if (this.isRestoring) return;

    const state = layerStore.get();
    const activePaperLayerId = this.renderer.getActiveLayerId();

    const layers: HistoryLayer[] = state.layers.map((layer) => {
      if (layer.kind === "stage") return { ...layer };

      // Only the active layer can have changed since the last snapshot; every
      // other layer reuses its cached export by reference.
      let json = this.jsonCache.get(layer.id);
      if (layer.id === activePaperLayerId || json === undefined) {
        json = this.renderer.exportLayerJSON(layer.id) ?? "";
        this.jsonCache.set(layer.id, json);
      }
      return { ...layer, json };
    });

    // Drop cache entries for layers that no longer exist.
    const liveIds = new Set(state.layers.map((l) => l.id));
    for (const id of [...this.jsonCache.keys()]) {
      if (!liveIds.has(id)) this.jsonCache.delete(id);
    }

    // Truncate any redo entries (we're starting a new branch)
    this.stack = this.stack.slice(0, this.index + 1);

    this.stack.push({
      layers,
      activeLayerId: state.activeLayerId,
      timestamp: Date.now(),
      stageColor: stageStore.get().color,
    });

    // Enforce max size (remove oldest entries)
    if (this.stack.length > this.maxSize) {
      this.stack.shift();
    }
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
   * Clear all history (e.g., when clearing the canvas)
   */
  clear(): void {
    this.stack = [];
    this.index = -1;
    this.jsonCache.clear();
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
      const regularLayers = entry.layers.filter((l) => l.kind !== "stage");

      // Only reimport layers whose content actually differs from what is on
      // canvas right now (the cache always mirrors live content at history
      // boundaries, and restores only happen at history boundaries).
      this.renderer.restoreLayersSnapshot(
        regularLayers.map((layer) => ({
          id: layer.id,
          name: layer.name,
          visible: layer.visible,
          json:
            this.jsonCache.get(layer.id) === layer.json ? undefined : layer.json,
        })),
        entry.activeLayerId,
      );

      // Sync the cache to the restored state.
      this.jsonCache = new Map(
        regularLayers.map((layer) => [layer.id, layer.json ?? ""]),
      );

      layerStore.set({
        layers: entry.layers.map(({ json: _json, ...rest }) => rest),
        activeLayerId: entry.activeLayerId,
      });
      stageSelectedStore.set(entry.activeLayerId === STAGE_LAYER_ID);
      stageStore.update((s) => ({ ...s, color: entry.stageColor ?? "#ffffff" }));

      paper.view.update();
    } finally {
      this.isRestoring = false;
    }
  }

  private updateState(): void {
    historyStateStore.set({
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
    });
  }
}
