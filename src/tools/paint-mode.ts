/** Shared painting mode toggle used by brush / lasso / rect / circle. */
export const paintModeSetting = {
  type: "toggle" as const,
  label: "Painting mode",
  options: ["add", "subtract", "inside"] as const,
  default: "add",
};
