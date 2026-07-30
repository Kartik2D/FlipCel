import type { ToolDefinition, SettingsSchema } from "./types";

const eyedropperSettings = {
  scope: {
    type: "toggle",
    options: ["active", "all"] as const,
    default: "all",
    label: "Layers",
  },
} as const satisfies SettingsSchema;

export const eyedropper: ToolDefinition<typeof eyedropperSettings, "eyedropper"> = {
  id: "eyedropper",
  name: "Eyedropper",
  hotkey: "i",
  icon: "eye",
  settings: eyedropperSettings,

  onStart() {},
  onMove() {},
  onEnd() {
    return null;
  },
};
