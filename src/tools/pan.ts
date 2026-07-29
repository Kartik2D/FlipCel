import type { ToolDefinition, SettingsSchema } from "./types";

const panSettings = {} as const satisfies SettingsSchema;

/** Dock / hotkey only — not shown in the tools rail. */
export const pan: ToolDefinition<typeof panSettings> = {
  id: "pan",
  name: "Pan",
  hotkey: "h",
  settings: panSettings,

  onStart() {},
  onMove() {},
  onEnd() {
    return null;
  },
};
