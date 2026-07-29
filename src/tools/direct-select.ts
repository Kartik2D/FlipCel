import type { ToolDefinition, SettingsSchema } from "./types";

const directSelectSettings = {
  shape: {
    type: "toggle",
    options: ["rect", "lasso"] as const,
    default: "rect",
  },
} as const satisfies SettingsSchema;

export const directSelect: ToolDefinition<typeof directSelectSettings> = {
  id: "direct-select",
  name: "Direct Select",
  hotkey: "a",
  icon: "point-corner",
  settings: directSelectSettings,
  dockModeSetting: "shape",

  onStart() {},
  onMove() {},
  onEnd() {
    return null;
  },
};
