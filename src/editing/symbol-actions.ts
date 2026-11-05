/**
 * Symbol creation / placement actions shared by the contextual functions
 * panel, the Library panel, and keyboard shortcuts.
 */
import type { DocumentManager } from "../document/document";
import type { HistoryManager } from "../document/history";
import type { PaperRenderer } from "../render/paper-renderer";
import type { SelectionController } from "./object-select";
import type { Camera } from "../render/camera";
import { newInstanceId, type SymbolTrack } from "../document/symbols";
import { configStore, generateLayerId, layerStore, STAGE_LAYER_ID } from "../state/index";
import { isSymbolInstance, readInstance } from "../render/paper/symbol-instances";

export interface SymbolActionServices {
  documentManager: DocumentManager;
  paperRenderer: PaperRenderer;
  selectionController: SelectionController;
  historyManager: HistoryManager;
  camera: Camera;
}

/** Active vector layer that can take an instance, or null. */
export function instanceTargetLayerId(paperRenderer: PaperRenderer): string | null {
  const state = layerStore.get();
  let id = state.activeLayerId;
  if (id === STAGE_LAYER_ID) id = paperRenderer.getActiveLayerId() ?? id;
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
  const { documentManager, paperRenderer, selectionController, historyManager } = services;
  const items = selectionController.getSelectedItems().filter((item) => item.parent);
  if (items.length === 0) return null;
  const editing = documentManager.getEditingSymbolId();
  if (editing) {
    for (const item of items) {
      if (!isSymbolInstance(item)) continue;
      const data = readInstance(item);
      if (data && documentManager.symbolWouldCycle(editing, data.symbol)) return null;
    }
  }
  const bounds = paperRenderer.getCombinedBounds(items);
  if (!bounds) return null;
  const origin = { x: bounds.center.x, y: bounds.center.y };

  // Bucket by layer, bottom → top (layerStore lists stage first, then tracks bottom → top).
  const rank = new Map(layerStore.get().layers.map((l, i) => [l.id, i] as const));
  const byLayer = new Map<string, paper.Item[]>();
  for (const item of items) {
    const layerId = paperRenderer.getLayerIdForPathItem(item);
    if (!layerId) continue;
    const bucket = byLayer.get(layerId);
    if (bucket) bucket.push(item);
    else byLayer.set(layerId, [item]);
  }
  if (byLayer.size === 0) return null;
  const layerIds = [...byLayer.keys()].sort(
    (a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0),
  );

  const tracks: SymbolTrack[] = layerIds.map((layerId) => {
    const json = paperRenderer.exportItemsAsLayerJSON(byLayer.get(layerId)!, origin);
    return {
      id: generateLayerId(),
      name: paperRenderer.getLayerName(layerId) ?? "Layer 1",
      visible: true,
      locked: false,
      kind: "vector",
      keyframes: [{ frameIndex: 0, contentId: documentManager.addContent(json), holdUntil: 0 }],
    };
  });
  const symbol = documentManager.createSymbol({ tracks, duration: 1, tags: [] });

  // Originals go away (extracted marquee selections already left their holes).
  selectionController.discardSelection();
  for (const item of items) paperRenderer.deleteItem(item);

  const targetLayerId = layerIds[layerIds.length - 1]!;
  const instance = paperRenderer.addInstanceToLayer(
    targetLayerId,
    { symbol: symbol.id, iid: newInstanceId(), mode: "loop", firstFrame: 0 },
    origin,
  );
  if (instance) selectionController.setSelectedItems([instance]);
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
  const { documentManager, paperRenderer, selectionController, historyManager, camera } =
    services;
  if (!documentManager.getSymbol(symbolId)) return false;
  const editing = documentManager.getEditingSymbolId();
  if (editing && documentManager.symbolWouldCycle(editing, symbolId)) return false;
  const layerId = instanceTargetLayerId(paperRenderer);
  if (!layerId) return false;

  let point = world;
  if (!point) {
    const config = configStore.get();
    const c = camera.screenToWorld(config.viewportWidth / 2, config.viewportHeight / 2);
    point = { x: Math.round(c.x), y: Math.round(c.y) };
  }
  selectionController.placeSelection();
  const instance = paperRenderer.addInstanceToLayer(
    layerId,
    { symbol: symbolId, iid: newInstanceId(), mode: "loop", firstFrame: 0 },
    point,
  );
  if (!instance) return false;
  selectionController.setSelectedItems([instance]);
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
