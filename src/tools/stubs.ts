import type { ToolDefinition, SettingsSchema } from "./types";

// ============================================================
// Select Tool
// ============================================================

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
  settings: selectSettings,
  dockModeSetting: "shape",

  onStart() {},
  onMove() {},
  onEnd() {
    return null;
  },
};

// ============================================================
// Direct Select Tool
// ============================================================

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
  settings: directSelectSettings,
  dockModeSetting: "shape",

  onStart() {},
  onMove() {},
  onEnd() {
    return null;
  },
};

// ============================================================
// Magnet Tool
// ============================================================

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
  settings: magnetSettings,

  onStart() {},
  onMove() {},
  onEnd() {
    return null;
  },
};

// ============================================================
// Magic Move Tool
// ============================================================

const magicMoveSettings = {
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
    options: ["relative", "exact"] as const,
    default: "relative",
    label: "Position",
  },
  orient: {
    type: "toggle",
    options: ["fixed", "direction"] as const,
    default: "fixed",
    label: "Orient",
  },
} as const satisfies SettingsSchema;

export const magicMove: ToolDefinition<typeof magicMoveSettings> = {
  id: "magic-move",
  name: "Magic Move",
  hotkey: "g",
  settings: magicMoveSettings,
  dockModeSetting: "timing",

  onStart() {},
  onMove() {},
  onEnd() {
    return null;
  },
};

// ============================================================
// Pan Tool
// ============================================================

const panSettings = {} as const satisfies SettingsSchema;

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

// ============================================================
// Eyedropper Tool
// ============================================================

const eyedropperSettings = {} as const satisfies SettingsSchema;

export const eyedropper: ToolDefinition<typeof eyedropperSettings> = {
  id: "eyedropper",
  name: "Eyedropper",
  hotkey: "i",
  settings: eyedropperSettings,

  onStart() {},
  onMove() {},
  onEnd() {
    return null;
  },
};

