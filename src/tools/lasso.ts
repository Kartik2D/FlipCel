import type { Point } from "../geometry/types";
import type { ToolContext, ToolDefinition, SettingsSchema, InferSettings } from "./types";
import { paintModeSetting } from "./paint-mode";

// ============================================================
// Lasso Fill Tool
// ============================================================

const lassoSettings = {
  mode: paintModeSetting,
  preview: {
    type: "toggle",
    label: "Preview",
    options: ["fill", "stroke"] as const,
    default: "fill",
  },
} as const satisfies SettingsSchema;

export type LassoSettings = InferSettings<typeof lassoSettings>;

/** Draw the lasso shape (closed polyline) onto the pixel canvas. */
export function drawLassoShape(
  tc: ToolContext,
  preview: "fill" | "stroke",
  points?: Point[],
): void {
  tc.clear();
  const stroke = points ?? tc.stroke;

  if (stroke.length < 2) {
    if (stroke.length === 1) {
      tc.ctx.beginPath();
      tc.ctx.arc(stroke[0].x, stroke[0].y, 1, 0, Math.PI * 2);
      if (preview === "stroke") {
        tc.ctx.stroke();
      } else {
        tc.ctx.fill();
      }
    }
    return;
  }

  tc.ctx.beginPath();
  tc.ctx.moveTo(stroke[0].x, stroke[0].y);
  for (let i = 1; i < stroke.length; i++) {
    tc.ctx.lineTo(stroke[i].x, stroke[i].y);
  }
  tc.ctx.closePath();
  if (preview === "stroke") {
    tc.ctx.lineWidth = 1;
    tc.ctx.stroke();
  } else {
    tc.ctx.fill();
  }
}

/** Replace the live stroke and redraw the lasso preview. */
export function replaceLassoStroke(
  tc: ToolContext,
  points: Point[],
  preview: "fill" | "stroke",
): void {
  tc.stroke.length = 0;
  for (const p of points) tc.stroke.push({ ...p });
  drawLassoShape(tc, preview);
}

export const lasso: ToolDefinition<typeof lassoSettings, "lasso"> = {
  id: "lasso",
  name: "Lasso Fill",
  hotkey: "l",
  icon: "selection-simplify",
  settings: lassoSettings,
  dockModeSetting: "mode",

  onStart(tc, point, settings) {
    tc.stroke.length = 0;
    tc.stroke.push(point);
    drawLassoShape(tc, settings.preview);
  },

  onMove(tc, point, settings) {
    tc.stroke.push(point);
    drawLassoShape(tc, settings.preview);
  },

  onEnd(tc, settings) {
    if (tc.stroke.length < 3) {
      tc.stroke.length = 0;
      tc.clear();
      return null;
    }
    if (settings.preview === "stroke") {
      drawLassoShape(tc, "fill");
    }
    const result = { points: [...tc.stroke] };
    tc.stroke.length = 0;
    return result;
  },
};
