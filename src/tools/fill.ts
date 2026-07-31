import type { ToolDefinition, SettingsSchema } from "./types";

const fillSettings = {
  algorithm: {
    type: "toggle",
    options: ["vector", "screen"] as const,
    default: "vector",
    label: "Algorithm",
  },
  gap: {
    type: "range",
    min: 0,
    max: 20,
    step: 1,
    default: 0,
    label: "Fill gap (px)",
  },
} as const satisfies SettingsSchema;

/** Click tool — vector (morph-close pocket) or screen (raster gas-pressure) fill. */
export const fill: ToolDefinition<typeof fillSettings, "fill"> = {
  id: "fill",
  name: "Fill",
  hotkey: "f",
  icon: "paint-bucket",
  settings: fillSettings,

  onStart() {},
  onMove() {},
  onEnd() {
    return null;
  },
};
