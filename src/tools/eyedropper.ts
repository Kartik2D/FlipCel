import type { ToolDefinition, SettingsSchema } from "./types";

const eyedropperSettings = {} as const satisfies SettingsSchema;

export const eyedropper: ToolDefinition<typeof eyedropperSettings> = {
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
