import type { ToolDefinition, SettingsSchema } from "./types";

const selectSettings = {
  shape: {
    type: "toggle",
    options: ["rect", "lasso"] as const,
    default: "rect",
  },
  scope: {
    type: "toggle",
    options: ["active", "all"] as const,
    default: "all",
    label: "Layers",
  },
} as const satisfies SettingsSchema;

export const select: ToolDefinition<typeof selectSettings> = {
  id: "select",
  name: "Select",
  hotkey: "v",
  icon: "cursor",
  settings: selectSettings,
  dockModeSetting: "shape",

  onStart() {},
  onMove() {},
  onEnd() {
    return null;
  },
};
