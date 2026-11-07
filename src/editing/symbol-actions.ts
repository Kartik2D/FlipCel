/**
 * Symbol creation / placement actions shared by the contextual functions
 * panel, the Library panel, and keyboard shortcuts.
 */
import type { DocumentManager } from "../document/document";
import type { HistoryManager } from "../document/history";
import type { StageRenderer } from "../render/stage-renderer";
import type { SelectionController } from "./object-select";
import type { Camera } from "../render/camera";
import { newInstanceId, type SymbolTrack } from "../document/symbols";
import { configStore, generateLayerId, layerStore, STAGE_LAYER_ID } from "../state/index";
import { encodeLayerContent } from "../vector/content";
import { translation } from "../vector/kernel";
import { publishSelection } from "./object-select";

export interface SymbolActionServices {
  documentManager: DocumentManager;
  renderer: StageRenderer;
  selectionController: SelectionController;
  historyManager: HistoryManager;
  camera: Camera;
}

/** Active vector layer that can take an instance, or null. */
export function instanceTargetLayerId(renderer: StageRenderer): string | null {
  const state = layerStore.get();
  let id = state.activeLayerId;
  if (id === STAGE_LAYER_ID) id = renderer.getActiveLayerId() ?? id;
  const layer = state.layers.find((l) => l.id === id);
  if (!layer || layer.kind !== "regular" || layer.locked) return null;
  return layer.id;
}

/**
 * Convert the current stage selection into a new symbol and replace it with
 * one instance (pivot at the selection's center). Items from several layers
 * become several symbol layers, preserving order. Returns the new symbol id.
 */
export function convertSelectionToSymbol(services: SymbolActionServices): string | null {
  const { documentManager, renderer, selectionController, historyManager } = services;
  if (!renderer.hasSelection()) return null;
  const editing = documentManager.getEditingSymbolId();
  if (editing) {
    for (const inst of renderer.selectionInstances()) {
      if (documentManager.symbolWouldCycle(editing, inst.symbol)) return null;
    }
  }
  const bounds = renderer.selectionBounds();
  if (!bounds) return null;
  const origin = {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  };

  // Bucket by layer, bottom → top (layerStore lists stage first, then tracks bottom → top).
  const rank = new Map(layerStore.get().layers.map((l, i) => [l.id, i] as const));
  const parts = renderer.selectionSnapshot();
  const byLayer = new Map<string, typeof parts>();
  for (const part of parts) {
    const bucket = byLayer.get(part.layerId);
    if (bucket) bucket.push(part);
    else byLayer.set(part.layerId, [part]);
  }
  if (byLayer.size === 0) return null;
  const layerIds = [...byLayer.keys()].sort(
    (a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0),
  );

  const tracks: SymbolTrack[] = layerIds.map((layerId) => {
    const bucket = byLayer.get(layerId)!;
    // Merge all parts on this layer into one map, re-based on `origin`.
    const merged = bucket[0].art;
    for (let i = 1; i < bucket.length; i++) {
      merged.stamp(bucket[i].art);
      bucket[i].art.free();
    }
    merged.transform(translation(-origin.x, -origin.y));
    const instances = bucket.flatMap((p) => p.instances).map((inst) => ({
      ...inst,
      matrix: [...inst.matrix] as typeof inst.matrix,
    }));
    for (const inst of instances) {
      inst.matrix[4] -= origin.x;
      inst.matrix[5] -= origin.y;
    }
    const json = encodeLayerContent(merged, instances);
    merged.free();
    return {
      id: generateLayerId(),
      name: renderer.getLayerName(layerId) ?? "Layer 1",
      visible: true,
      locked: false,
      kind: "vector",
      keyframes: [{ frameIndex: 0, contentId: documentManager.addContent(json), holdUntil: 0 }],
    };
  });
  const symbol = documentManager.createSymbol({ tracks, duration: 1, tags: [] });

  // Originals go away (lifting already removed them from their layers).
  renderer.deleteSelection();
  selectionController.discardSelection();

  const targetLayerId = layerIds[layerIds.length - 1]!;
  renderer.addInstanceToLayer(
    targetLayerId,
    { symbol: symbol.id, iid: newInstanceId(), mode: "loop", firstFrame: 0 },
    origin,
  );
  selectionController.selectAtWorld(origin);
  historyManager.snapshot();
  return symbol.id;
}

/**
 * Drop a new instance of `symbolId` on the active layer at the viewport
 * center (or `world`). Refuses cycles while editing a symbol.
 */
export function placeSymbolInstance(
  services: SymbolActionServices,
  symbolId: string,
  world?: { x: number; y: number },
): boolean {
  const { documentManager, renderer, selectionController, historyManager, camera } =
    services;
  if (!documentManager.getSymbol(symbolId)) return false;
  const editing = documentManager.getEditingSymbolId();
  if (editing && documentManager.symbolWouldCycle(editing, symbolId)) return false;
  const layerId = instanceTargetLayerId(renderer);
  if (!layerId) return false;

  let point = world;
  if (!point) {
    const config = configStore.get();
    const c = camera.screenToWorld(config.viewportWidth / 2, config.viewportHeight / 2);
    point = { x: Math.round(c.x), y: Math.round(c.y) };
  }
  selectionController.placeSelection();
  const instance = renderer.addInstanceToLayer(
    layerId,
    { symbol: symbolId, iid: newInstanceId(), mode: "loop", firstFrame: 0 },
    point,
  );
  if (!instance) return false;
  selectionController.selectAtWorld(point);
  publishSelection(renderer);
  historyManager.snapshot();
  return true;
}

/**
 * Convert a timeline frame range into a looping symbol and replace the
 * range on the anchor layer with one instance. Refuses a cycle while
 * editing a symbol.
 */
export function convertFrameRangeToSymbol(
  services: SymbolActionServices,
  layerIds: string[],
  start: number,
  end: number,
  anchorLayerId: string,
): string | null {
  const { documentManager, historyManager } = services;
  const id = documentManager.convertFrameRangeToSymbol(
    layerIds,
    start,
    end,
    anchorLayerId,
  );
  if (!id) return null;
  historyManager.snapshot();
  return id;
}
