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

