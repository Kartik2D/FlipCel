import type { ToolDefinition, SettingsSchema } from "./types";

const magnetSettings = {
  size: {
    type: "range",
    min: 20,
    max: 400,
    step: 1,
    default: 120,
    label: "Size",
  },
} as const satisfies SettingsSchema;

export const magnet: ToolDefinition<typeof magnetSettings> = {
  id: "magnet",
  name: "Magnet",
  hotkey: "m",
  icon: "point-asymmetric",
  settings: magnetSettings,

  onStart() {},
  onMove() {},
  onEnd() {
    return null;
  },
};
