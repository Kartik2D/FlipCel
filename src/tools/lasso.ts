import type { ToolContext, ToolDefinition, SettingsSchema } from "./types";
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

// Helper function to draw the lasso shape (closure to avoid adding to interface)
function drawLassoShape(tc: ToolContext, preview: "fill" | "stroke") {
  tc.clear();

  if (tc.stroke.length < 2) {
    if (tc.stroke.length === 1) {
      tc.ctx.beginPath();
      tc.ctx.arc(tc.stroke[0].x, tc.stroke[0].y, 1, 0, Math.PI * 2);
      if (preview === "stroke") {
        tc.ctx.stroke();
      } else {
        tc.ctx.fill();
      }
    }
    return;
  }

  tc.ctx.beginPath();
  tc.ctx.moveTo(tc.stroke[0].x, tc.stroke[0].y);
  for (let i = 1; i < tc.stroke.length; i++) {
    tc.ctx.lineTo(tc.stroke[i].x, tc.stroke[i].y);
  }
  tc.ctx.closePath();
  if (preview === "stroke") {
    tc.ctx.lineWidth = 1;
    tc.ctx.stroke();
  } else {
    tc.ctx.fill();
  }
}

export const lasso: ToolDefinition<typeof lassoSettings> = {
  id: "lasso",
  name: "Lasso Fill",
  hotkey: "l",
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
