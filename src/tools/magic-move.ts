import type { ToolDefinition, SettingsSchema } from "./types";

const magicMoveSettings = {
  scope: {
    type: "toggle",
    options: ["active", "all"] as const,
    default: "all",
    label: "Layers",
  },
  timing: {
    type: "toggle",
    options: ["step", "duration"] as const,
    default: "step",
    label: "Timing",
  },
  step: {
    type: "range",
    min: 1,
    max: 48,
    step: 1,
    default: 1,
    label: "Frame Step",
  },
  duration: {
    type: "range",
    min: 1,
    max: 240,
    step: 1,
    default: 48,
    label: "Duration",
  },
  divisions: {
    type: "range",
    min: 1,
    max: 12,
    step: 1,
    default: 1,
    label: "Divisions",
  },
  position: {
    type: "toggle",
    options: ["off", "relative", "exact"] as const,
    default: "relative",
    label: "Position",
  },
  scale: {
    type: "toggle",
    options: ["off", "on"] as const,
    default: "off",
    label: "Scale",
  },
  orient: {
    type: "toggle",
    options: ["fixed", "direction"] as const,
    default: "fixed",
    label: "Orient",
  },
} as const satisfies SettingsSchema;

export const magicMove: ToolDefinition<typeof magicMoveSettings, "magic-move"> = {
  id: "magic-move",
  name: "Magic Move",
  hotkey: "g",
  icon: "arrows-left-right",
  settings: magicMoveSettings,
  dockModeSetting: "timing",

  onStart() {},
  onMove() {},
  onEnd() {
    return null;
  },
};
