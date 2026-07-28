/**
 * Centralized tool registry — metadata + pixel paint tools + stub tools.
 * Controllers (select / magnet / etc.) live under editing/; stubs only
 * register hotkeys and settings schemas for the UI.
 */
import type { ToolDefinition, InferSettings } from "./types";
import { brush } from "./brush";
import { lasso } from "./lasso";
import { rect } from "./rect";
import { circle } from "./circle";
import { select, directSelect, magnet, magicMove, magicMorph, pan, eyedropper } from "./stubs";

export type {
  ToggleSetting,
  RangeSetting,
  ColorSetting,
  SettingDef,
  SettingsSchema,
  InferSettings,
  ToolContext,
  ToolDefinition,
} from "./types";

export { brush } from "./brush";
export { lasso } from "./lasso";
export { rect } from "./rect";
export { circle } from "./circle";
export { select, directSelect, magnet, magicMove, magicMorph, pan, eyedropper } from "./stubs";

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
  magicMove,
  magicMorph,
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


