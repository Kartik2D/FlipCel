/** Shared painting mode toggle used by brush / lasso / create-points. */
export const paintModeSetting = {
  type: "toggle" as const,
  label: "Painting mode",
  options: ["add", "subtract", "inside"] as const,
  default: "add",
};

export type PaintMode = (typeof paintModeSetting.options)[number];

/** Fill vs pixel-canvas stroke (traced on commit). */
export const paintStyleSetting = {
  type: "toggle" as const,
  label: "Style",
  options: ["fill", "stroke"] as const,
  default: "fill",
};

export type PaintStyle = (typeof paintStyleSetting.options)[number];

/**
 * How far a traced outline may leave the bitmap, in screen pixels.
 * 0 keeps the trace. The kernel still stores that curve within one twip.
 */
export const traceSimplifySetting = {
  type: "range" as const,
  label: "Simplify (px)",
  min: 0,
  max: 8,
  step: 0.1,
  default: 0,
};

/** Pixel-canvas stroke width (traced tools). */
export const strokeWidthSetting = {
  type: "range" as const,
  label: "Width",
  min: 1,
  max: 20,
  step: 1,
  default: 2,
};

/** Size stays constant in stage space (grows/shrinks on screen with zoom). */
export const scaleWithStageSetting = {
  type: "checkbox" as const,
  label: "Scale with stage",
  default: false,
};

export function clampStrokeWidth(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return strokeWidthSetting.default;
  return Math.max(
    strokeWidthSetting.min,
    Math.min(strokeWidthSetting.max, Math.round(n)),
  );
}

/** Theme accent variant for a paint mode (add → positive, etc.). */
export type PaintModeAccent = "positive" | "negative" | "neutral";

export function paintModeAccent(mode: string): PaintModeAccent | null {
  switch (mode) {
    case "add":
      return "positive";
    case "subtract":
      return "negative";
    case "inside":
      return "neutral";
    default:
      return null;
  }
}
