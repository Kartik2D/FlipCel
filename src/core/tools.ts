/**
 * Centralized Tool Registry
 *
 * Single source of truth for all tools. Each tool definition includes:
 * - Metadata (id, name, hotkey)
 * - Settings schema (declarative, drives auto-generated UI)
 * - Behavior hooks (onStart, onMove, onEnd)
 *
 * To add a new tool: just add one object to this file.
 */
import type { Point } from "./types";

// ============================================================
// Settings Schema Types
// ============================================================

export interface ToggleSetting {
  type: "toggle";
  /** At least two options (e.g. add / subtract / inside) */
  options: readonly string[];
  default: string;
  /** Overrides auto-generated label from the settings key */
  label?: string;
}

export interface RangeSetting {
  type: "range";
  min: number;
  max: number;
  step: number;
  default: number;
  label?: string;
}

export interface ColorSetting {
  type: "color";
  default: string;
  label?: string;
}

export type SettingDef = ToggleSetting | RangeSetting | ColorSetting;

export type SettingsSchema = Record<string, SettingDef>;

// Infer runtime settings type from schema
export type InferSettings<T extends SettingsSchema> = {
  [K in keyof T]: T[K] extends { type: "toggle"; options: readonly (infer O)[] }
    ? O
    : T[K]["default"];
};

// ============================================================
// Tool Context & Definition
// ============================================================

/**
 * Context passed to tool behavior hooks.
 * Provides access to canvas context and shared stroke state.
 */
export interface ToolContext {
  ctx: CanvasRenderingContext2D;
  stroke: Point[];
  clear: () => void;
  config: { pixelWidth: number; pixelHeight: number };
}

/**
 * Tool definition interface.
 * Each tool defines its metadata, settings schema, and behavior.
 */
export interface ToolDefinition<T extends SettingsSchema = SettingsSchema> {
  id: string;
  name: string;
  hotkey: string;
  settings: T;
  /** Settings key (must be a toggle) surfaced in the dock "mode" widget. */
  dockModeSetting?: string;

  onStart(tc: ToolContext, point: Point, settings: InferSettings<T>): void;
  onMove(tc: ToolContext, point: Point, settings: InferSettings<T>): void;
  onEnd(tc: ToolContext, settings: InferSettings<T>): { points: Point[] } | null;
}

// ============================================================
// Brush Tool
// ============================================================

const brushSettings = {
  mode: {
    type: "toggle",
    label: "Painting mode",
    options: ["add", "subtract", "inside"] as const,
    default: "add",
  },
  sizeMin: { type: "range", min: 1, max: 100, step: 0.1, default: 1 },
  sizeMax: { type: "range", min: 1, max: 100, step: 0.1, default: 4 },
} as const satisfies SettingsSchema;

export const brush: ToolDefinition<typeof brushSettings> = {
  id: "brush",
  name: "Brush",
  hotkey: "b",
  settings: brushSettings,
  dockModeSetting: "mode",

  onStart(tc, point, settings) {
    tc.stroke.length = 0;
    tc.stroke.push(point);

    // Draw initial point
    const pressure = point.pressure ?? 1;
    const size = settings.sizeMin + pressure * (settings.sizeMax - settings.sizeMin);

    tc.ctx.beginPath();
    tc.ctx.arc(point.x, point.y, size / 2, 0, Math.PI * 2);
    tc.ctx.fill();
  },

  onMove(tc, point, settings) {
    if (tc.stroke.length === 0) {
      tc.stroke.push(point);
      this.onStart(tc, point, settings);
      return;
    }

    const last = tc.stroke[tc.stroke.length - 1];
    tc.stroke.push(point);

    const p0 = last.pressure ?? 1;
    const p1 = point.pressure ?? 1;
    const size0 = settings.sizeMin + p0 * (settings.sizeMax - settings.sizeMin);
    const size1 = settings.sizeMin + p1 * (settings.sizeMax - settings.sizeMin);

    // Subdivide segment and interpolate pressure for smooth strokes
    const dx = point.x - last.x;
    const dy = point.y - last.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // Step size scales with brush size so circles always overlap
    const minSize = Math.min(size0, size1);
    const stepSize = Math.max(0.5, minSize * 0.25);
    const steps = Math.max(1, Math.ceil(dist / stepSize));

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = last.x + dx * t;
      const y = last.y + dy * t;
      const size = size0 + (size1 - size0) * t;

      tc.ctx.beginPath();
      tc.ctx.arc(x, y, size / 2, 0, Math.PI * 2);
      tc.ctx.fill();
    }
  },

  onEnd(tc) {
    if (tc.stroke.length === 0) return null;
    const result = { points: [...tc.stroke] };
    tc.stroke.length = 0;
    return result;
  },
};

// ============================================================
// Lasso Tool
// ============================================================

const lassoSettings = {
  mode: {
    type: "toggle",
    label: "Painting mode",
    options: ["add", "subtract", "inside"] as const,
    default: "add",
  },
} as const satisfies SettingsSchema;

// Helper function to draw the lasso shape (closure to avoid adding to interface)
function drawLassoShape(tc: ToolContext) {
  tc.clear();

  if (tc.stroke.length < 2) {
    if (tc.stroke.length === 1) {
      tc.ctx.beginPath();
      tc.ctx.arc(tc.stroke[0].x, tc.stroke[0].y, 1, 0, Math.PI * 2);
      tc.ctx.fill();
    }
    return;
  }

  tc.ctx.beginPath();
  tc.ctx.moveTo(tc.stroke[0].x, tc.stroke[0].y);
  for (let i = 1; i < tc.stroke.length; i++) {
    tc.ctx.lineTo(tc.stroke[i].x, tc.stroke[i].y);
  }
  tc.ctx.closePath();
  tc.ctx.fill();
}

export const lasso: ToolDefinition<typeof lassoSettings> = {
  id: "lasso",
  name: "Lasso",
  hotkey: "l",
  settings: lassoSettings,
  dockModeSetting: "mode",

  onStart(tc, point) {
    tc.stroke.length = 0;
    tc.stroke.push(point);
    drawLassoShape(tc);
  },

  onMove(tc, point) {
    tc.stroke.push(point);
    drawLassoShape(tc);
  },

  onEnd(tc) {
    if (tc.stroke.length < 3) {
      tc.stroke.length = 0;
      tc.clear();
      return null;
    }
    const result = { points: [...tc.stroke] };
    tc.stroke.length = 0;
    return result;
  },
};

// ============================================================
// Rectangle Tool
// ============================================================

const rectSettings = {
  mode: {
    type: "toggle",
    label: "Painting mode",
    options: ["add", "subtract", "inside"] as const,
    default: "add",
  },
  from: {
    type: "toggle",
    label: "Draw from",
    options: ["corner", "center"] as const,
    default: "corner",
  },
} as const satisfies SettingsSchema;

function drawRectShape(tc: ToolContext, fromCenter: boolean) {
  tc.clear();
  if (tc.stroke.length < 2) return;

  const a = tc.stroke[0];
  const b = tc.stroke[tc.stroke.length - 1];

  let x: number;
  let y: number;
  let w: number;
  let h: number;

  if (fromCenter) {
    const rx = Math.abs(b.x - a.x);
    const ry = Math.abs(b.y - a.y);
    x = a.x - rx;
    y = a.y - ry;
    w = rx * 2;
    h = ry * 2;
  } else {
    x = Math.min(a.x, b.x);
    y = Math.min(a.y, b.y);
    w = Math.abs(b.x - a.x);
    h = Math.abs(b.y - a.y);
  }

  if (w < 0.5 || h < 0.5) return;

  tc.ctx.beginPath();
  tc.ctx.rect(x, y, w, h);
  tc.ctx.fill();
}

export const rect: ToolDefinition<typeof rectSettings> = {
  id: "rect",
  name: "Rectangle",
  hotkey: "r",
  settings: rectSettings,
  dockModeSetting: "mode",

  onStart(tc, point, settings) {
    tc.stroke.length = 0;
    tc.stroke.push(point, point);
    drawRectShape(tc, settings.from === "center");
  },

  onMove(tc, point, settings) {
    if (tc.stroke.length === 0) {
      tc.stroke.push(point, point);
    } else {
      tc.stroke[1] = point;
      if (tc.stroke.length > 2) tc.stroke.length = 2;
    }
    drawRectShape(tc, settings.from === "center");
  },

  onEnd(tc) {
    if (tc.stroke.length < 2) {
      tc.stroke.length = 0;
      tc.clear();
      return null;
    }
    const a = tc.stroke[0];
    const b = tc.stroke[1];
    if (Math.abs(b.x - a.x) < 0.5 || Math.abs(b.y - a.y) < 0.5) {
      tc.stroke.length = 0;
      tc.clear();
      return null;
    }
    const result = { points: [...tc.stroke] };
    tc.stroke.length = 0;
    return result;
  },
};

// ============================================================
// Circle Tool
// ============================================================

const circleSettings = {
  mode: {
    type: "toggle",
    label: "Painting mode",
    options: ["add", "subtract", "inside"] as const,
    default: "add",
  },
  from: {
    type: "toggle",
    label: "Draw from",
    options: ["corner", "center"] as const,
    default: "center",
  },
} as const satisfies SettingsSchema;

function drawCircleShape(tc: ToolContext, fromCenter: boolean) {
  tc.clear();
  if (tc.stroke.length < 2) return;

  const a = tc.stroke[0];
  const b = tc.stroke[tc.stroke.length - 1];

  let cx: number;
  let cy: number;
  let rx: number;
  let ry: number;

  if (fromCenter) {
    cx = a.x;
    cy = a.y;
    rx = Math.abs(b.x - a.x);
    ry = Math.abs(b.y - a.y);
  } else {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    rx = w / 2;
    ry = h / 2;
    cx = x + rx;
    cy = y + ry;
  }

  if (rx < 0.25 || ry < 0.25) return;

  tc.ctx.beginPath();
  tc.ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  tc.ctx.fill();
}

export const circle: ToolDefinition<typeof circleSettings> = {
  id: "circle",
  name: "Circle",
  hotkey: "c",
  settings: circleSettings,
  dockModeSetting: "mode",

  onStart(tc, point, settings) {
    tc.stroke.length = 0;
    tc.stroke.push(point, point);
    drawCircleShape(tc, settings.from === "center");
  },

  onMove(tc, point, settings) {
    if (tc.stroke.length === 0) {
      tc.stroke.push(point, point);
    } else {
      tc.stroke[1] = point;
      if (tc.stroke.length > 2) tc.stroke.length = 2;
    }
    drawCircleShape(tc, settings.from === "center");
  },

  onEnd(tc) {
    if (tc.stroke.length < 2) {
      tc.stroke.length = 0;
      tc.clear();
      return null;
    }
    const a = tc.stroke[0];
    const b = tc.stroke[1];
    if (Math.abs(b.x - a.x) < 0.5 && Math.abs(b.y - a.y) < 0.5) {
      tc.stroke.length = 0;
      tc.clear();
      return null;
    }
    const result = { points: [...tc.stroke] };
    tc.stroke.length = 0;
    return result;
  },
};

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

// ============================================================
// Tool Registry
// ============================================================

export const tools = [
  brush,
  lasso,
  rect,
  circle,
  select,
  directSelect,
  magnet,
  pan,
  eyedropper,
] as const;

export type ToolId = (typeof tools)[number]["id"];
export type DrawMode = "add" | "subtract" | "inside";

/**
 * Get a tool definition by id
 */
export function getTool(id: ToolId): ToolDefinition {
  return tools.find((t) => t.id === id)!;
}

/**
 * Get a tool by hotkey
 */
export function getToolByHotkey(key: string): ToolDefinition | undefined {
  return tools.find((t) => t.hotkey === key.toLowerCase());
}

/**
 * Cycle a tool's dock-mode toggle to its next option.
 * Returns the updated settings key/value, or null if the tool has no dock mode.
 */
export function cycleDockMode(
  toolId: ToolId,
  currentSettings: Record<string, unknown>,
): { key: string; value: string } | null {
  const tool = getTool(toolId);
  const key = tool.dockModeSetting;
  if (!key) return null;
  const def = tool.settings[key];
  if (!def || def.type !== "toggle") return null;
  const options = def.options as readonly string[];
  const current = String(currentSettings[key] ?? def.default);
  const next = options[(options.indexOf(current) + 1) % options.length];
  return { key, value: next };
}

/**
 * Build default settings object from all tools' schemas
 */
export function buildDefaultSettings(): Record<ToolId, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const tool of tools) {
    const toolSettings: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(tool.settings)) {
      toolSettings[key] = def.default;
    }
    result[tool.id] = toolSettings;
  }
  return result as Record<ToolId, Record<string, unknown>>;
}

/**
 * Type for the full settings store (all tools' settings)
 */
export type AllToolSettings = {
  [K in ToolId]: InferSettings<Extract<(typeof tools)[number], { id: K }>["settings"]>;
};

