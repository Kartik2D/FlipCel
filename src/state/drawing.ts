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

export interface SelectionState {
  items: paper.PathItem[];
}

export const selectionStore = new Store<SelectionState>({
  items: [],
});
