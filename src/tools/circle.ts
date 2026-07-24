import type { ToolContext, ToolDefinition, SettingsSchema } from "./types";
import { paintModeSetting } from "./paint-mode";

// ============================================================
// Circle Tool
// ============================================================

const circleSettings = {
  mode: paintModeSetting,
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
