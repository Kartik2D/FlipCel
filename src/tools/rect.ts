import type { ToolContext, ToolDefinition, SettingsSchema } from "./types";
import { paintModeSetting } from "./paint-mode";

// ============================================================
// Rectangle Tool
// ============================================================

const rectSettings = {
  mode: paintModeSetting,
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
