/** Shared painting mode toggle used by brush / lasso. */
export const paintModeSetting = {
  type: "toggle" as const,
  label: "Painting mode",
  options: ["add", "subtract", "inside"] as const,
  default: "add",
};

export type PaintMode = (typeof paintModeSetting.options)[number];

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
