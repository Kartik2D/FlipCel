/**
 * Drawing runtime state: color, tool, selection, canvas config, modifiers.
 */
import type { CanvasConfig, Modifiers } from "../geometry/types";
import { type ToolId, type AllToolSettings, buildDefaultSettings } from "../tools/registry";
import { Store } from "./store";
import type { PlacedInstance } from "../vector/content";

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

/** Select-tool selection summary (renderer owns the floating geometry). */
export interface SelectionState {
  /** Lifted vector parts (non-empty) + instances. */
  count: number;
  /** At least one lifted part has fill geometry. */
  hasShapes: boolean;
  instances: PlacedInstance[];
  layerIds: string[];
}

export const EMPTY_SELECTION: SelectionState = {
  count: 0,
  hasShapes: false,
  instances: [],
  layerIds: [],
};

export const selectionStore = new Store<SelectionState>(EMPTY_SELECTION);

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
