/**
 * Tool definition types — settings schemas and behavior hooks.
 */
import type { Point } from "../geometry/types";

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
  /** Shown instead of the numeric value when the slider is at `max`. */
  maxLabel?: string;
}

export interface ColorSetting {
  type: "color";
  default: string;
  label?: string;
}

export type SettingDef = ToggleSetting | RangeSetting | ColorSetting;

export type SettingsSchema = Record<string, SettingDef>;

export type InferSettings<T extends SettingsSchema> = {
  [K in keyof T]: T[K] extends { type: "toggle"; options: readonly (infer O)[] }
    ? O
    : T[K]["default"];
};

/** Context passed to tool behavior hooks. */
export interface ToolContext {
  ctx: CanvasRenderingContext2D;
  stroke: Point[];
  clear: () => void;
  config: { pixelWidth: number; pixelHeight: number };
}

/** Tool definition: metadata, settings schema, and pixel-canvas behavior. */
export interface ToolDefinition<
  T extends SettingsSchema = SettingsSchema,
  Id extends string = string,
> {
  id: Id;
  name: string;
  hotkey: string;
  /** Phosphor icon key for the tools rail (omit for dock-only tools). */
  icon?: string;
  settings: T;
  /** Settings key (must be a toggle) surfaced in the dock "mode" widget. */
  dockModeSetting?: string;

  onStart(tc: ToolContext, point: Point, settings: InferSettings<T>): void;
  onMove(tc: ToolContext, point: Point, settings: InferSettings<T>): void;
  onEnd(tc: ToolContext, settings: InferSettings<T>): { points: Point[] } | null;
}
