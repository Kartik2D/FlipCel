import type { ToolDefinition, SettingsSchema } from "./types";

const magicMorphSettings = {
  scope: {
    type: "toggle",
    options: ["active", "all"] as const,
    default: "all",
    label: "Layers",
  },
  divisions: {
    type: "range",
    min: 1,
    max: 12,
    step: 1,
    default: 1,
    label: "Divisions",
    maxLabel: "Every frame",
  },
} as const satisfies SettingsSchema;

export const magicMorph: ToolDefinition<typeof magicMorphSettings, "magic-morph"> = {
  id: "magic-morph",
  name: "Magic Morph",
  hotkey: "t",
  icon: "05",
  settings: magicMorphSettings,

  onStart() {},
  onMove() {},
  onEnd() {
    return null;
  },
};
