import type { ToolDefinition, SettingsSchema } from "./types";
import {
  paintModeSetting,
  paintStyleSetting,
  strokeWidthSetting,
  traceSimplifySetting,
  scaleWithStageSetting,
} from "./paint-mode";

const createPointsSettings = {
  mode: paintModeSetting,
  style: paintStyleSetting,
  width: strokeWidthSetting,
  simplify: traceSimplifySetting,
  curve: {
    type: "toggle",
    options: ["smooth", "straight"] as const,
    default: "smooth",
    label: "Curve",
  },
  scaleWithStage: scaleWithStageSetting,
} as const satisfies SettingsSchema;

export const createPoints: ToolDefinition<typeof createPointsSettings, "create-points"> = {
  id: "create-points",
  name: "Create Points",
  hotkey: "p",
  icon: "03",
  settings: createPointsSettings,
  // Dock / Ctrl stay on curve type — paint mode is settings-only.
  dockModeSetting: "curve",

  onStart() {},
  onMove() {},
  onEnd() {
    return null;
  },
};
