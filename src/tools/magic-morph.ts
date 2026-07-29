import type { ToolDefinition, SettingsSchema } from "./types";

const magicMorphSettings = {
  scope: {
    type: "toggle",
    options: ["active", "all"] as const,
    default: "all",
    label: "Layers",
  },
  solver: {
    type: "toggle",
    options: ["vector", "sdf"] as const,
    default: "vector",
    label: "Solver",
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
  stickiness: {
    type: "range",
    min: 0,
    max: 1,
    step: 0.1,
    default: 0,
    label: "Corner Stick",
  },
  density: {
    type: "range",
    min: 1,
    max: 3,
    step: 0.25,
    default: 1,
    label: "Density",
  },
  simplify: {
    type: "range",
    min: 0,
    max: 10,
    step: 0.5,
    default: 0,
    label: "Simplify",
  },
} as const satisfies SettingsSchema;

export const magicMorph: ToolDefinition<typeof magicMorphSettings> = {
  id: "magic-morph",
  name: "Magic Morph",
  hotkey: "t",
  icon: "magic-wand",
  settings: magicMorphSettings,

  onStart() {},
  onMove() {},
  onEnd() {
    return null;
  },
};
