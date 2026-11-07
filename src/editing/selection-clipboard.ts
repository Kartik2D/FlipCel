/**
 * In-app clipboard for select-tool copy/paste.
 * Stores encoded v4 content strings (world coordinates) so paste works
 * across layers, frames and symbol edits.
 */
import { Store } from "../state";
import type { StageRenderer } from "../render/stage-renderer";
import { VectorLayer } from "../vector/kernel";
import { decodeContent, encodeLayerContent } from "../vector/content";
import { newInstanceId } from "../document/symbols";

let clipboard: string[] = [];

/** True when the in-app selection clipboard has content. */
export const selectionClipboardStore = new Store(false);

export function hasSelectionClipboard(): boolean {
  return clipboard.length > 0;
}

export function getSelectionClipboard(): readonly string[] {
  return clipboard;
}

/** Copy the renderer's floating selection (shapes + instances). */
export function setSelectionClipboardFromSelection(renderer: StageRenderer): boolean {
  const parts = renderer.selectionSnapshot();
  const jsons: string[] = [];
  for (const part of parts) {
    const json = encodeLayerContent(part.art, part.instances);
    part.art.free();
    if (json) jsons.push(json);
  }
  if (jsons.length === 0) return false;
  clipboard = jsons;
  selectionClipboardStore.set(true);
  return true;
}

/**
 * Float the clipboard content as a new selection on `layerId`.
 * Returns false when the clipboard is empty.
 */
export function pasteClipboardOntoLayer(renderer: StageRenderer, layerId: string): boolean {
  if (clipboard.length === 0) return false;
  let any = false;
  for (const json of clipboard) {
    const content = decodeContent(json);
    const art = content.map.length > 0 ? VectorLayer.fromBytes(content.map) : new VectorLayer();
    const instances = content.instances.map((i) => ({ ...i, iid: newInstanceId() }));
    if (art.isEmpty() && instances.length === 0) {
      art.free();
      continue;
    }
    renderer.liftContent(layerId, art, instances);
    any = true;
  }
  return any;
}

export function clearSelectionClipboard(): void {
  clipboard = [];
  selectionClipboardStore.set(false);
}
