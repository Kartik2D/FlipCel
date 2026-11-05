/**
 * Drawing runtime state: color, tool, selection, canvas config, modifiers.
 */
import type { CanvasConfig, Modifiers } from "../geometry/types";
import { type ToolId, type AllToolSettings, buildDefaultSettings } from "../tools/registry";
import { Store } from "./store";

export const colorStore = new Store<string>("#037ffc");
export const prevColorStore = new Store<string>("#000000");
export const documentColorsStore = new Store<string[]>([]);

export const toolStore = new Store<ToolId>("brush");
export const prevToolStore = new Store<ToolId>("select");

export const configStore = new Store<CanvasConfig>({
  pixelWidth: 0,
  pixelHeight: 0,
  viewportWidth: 0,
  viewportHeight: 0,
});

export const modifiersStore = new Store<Modifiers>({
  shift: false,
  alt: false,
  ctrl: false,
  meta: false,
});

export const toolSettingsStore = new Store<AllToolSettings>(
  buildDefaultSettings() as AllToolSettings,
);

/** Multiply user paint sizes by this before stamping on the pixel canvas. */
export function paintSizeScale(zoom: number, toolId: ToolId = toolStore.get()): number {
  const settings = toolSettingsStore.get()[toolId] as
    | { scaleWithStage?: unknown }
    | undefined;
  if (settings?.scaleWithStage !== true) return 1;
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

/**
 * Select-tool selection: merge shapes (`Path` / `CompoundPath`) and symbol
 * instance groups. Path-only consumers filter with `pathItemsOf`.
 */
export interface SelectionState {
  items: paper.Item[];
}

export const selectionStore = new Store<SelectionState>({
  items: [],
});

export function isPathItem(item: paper.Item | null | undefined): item is paper.PathItem {
  return !!item && (item.className === "Path" || item.className === "CompoundPath");
}

/** Merge shapes in a selection (symbol instances excluded). */
export function pathItemsOf(items: readonly paper.Item[]): paper.PathItem[] {
  return items.filter(isPathItem);
}

/** Symbol instance groups in a selection. */
export function instanceItemsOf(items: readonly paper.Item[]): paper.Group[] {
  return items.filter(
    (item): item is paper.Group =>
      item.className === "Group" &&
      typeof (item.data as { symbol?: unknown } | null)?.symbol === "string",
  );
}

/** Magic Move panel: Apply availability + floating Apply popup. */
export interface MagicMoveUiState {
  canApply: boolean;
  popupOpen: boolean;
  /** Client (fixed) coordinates for the Apply popup. */
  popupX: number;
  popupY: number;
}

export const magicMoveUiStore = new Store<MagicMoveUiState>({
  canApply: false,
  popupOpen: false,
  popupX: 0,
  popupY: 0,
});

/** Magic Morph panel: Apply availability + floating Apply popup. */
export interface MagicMorphUiState {
  canApply: boolean;
  popupOpen: boolean;
  popupX: number;
  popupY: number;
}

export const magicMorphUiStore = new Store<MagicMorphUiState>({
  canApply: false,
  popupOpen: false,
  popupX: 0,
  popupY: 0,
});
