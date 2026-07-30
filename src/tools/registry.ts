/**
 * Centralized tool registry — metadata + pixel paint tools + stub tools.
 * Controllers (select / magnet / etc.) live under editing/; tool modules
 * register hotkeys, icons, and settings schemas for the UI.
 */
import type { InferSettings, SettingsSchema } from "./types";
import { brush } from "./brush";
import { lasso } from "./lasso";
import { select } from "./select";
import { directSelect } from "./direct-select";
import { magnet } from "./magnet";
import { magicMove } from "./magic-move";
import { magicMorph } from "./magic-morph";
import { pan } from "./pan";
import { eyedropper } from "./eyedropper";

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
export { select } from "./select";
export { directSelect } from "./direct-select";
export { magnet } from "./magnet";
export { magicMove } from "./magic-move";
export { magicMorph } from "./magic-morph";
export { pan } from "./pan";
export { eyedropper } from "./eyedropper";

// ============================================================
// Tool Registry
// ============================================================

export const tools = [
  brush,
  lasso,
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
export function getTool(id: ToolId): (typeof tools)[number] {
  return tools.find((t) => t.id === id)!;
}

/**
 * Get a tool by hotkey
 */
export function getToolByHotkey(key: string): (typeof tools)[number] | undefined {
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
  const def = (tool.settings as SettingsSchema)[key];
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
  [T in (typeof tools)[number] as T["id"]]: InferSettings<T["settings"]>;
};
