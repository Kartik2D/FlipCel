import type { ToolDefinition, SettingsSchema } from "./types";
import { paintModeSetting } from "./paint-mode";

// ============================================================
// Brush Tool
// ============================================================

const brushSettings = {
  mode: paintModeSetting,
  sizeMin: { type: "range", min: 1, max: 100, step: 0.1, default: 1 },
  sizeMax: { type: "range", min: 1, max: 100, step: 0.1, default: 4 },
} as const satisfies SettingsSchema;

export const brush: ToolDefinition<typeof brushSettings> = {
  id: "brush",
  name: "Brush",
  hotkey: "b",
  icon: "paint-brush",
  settings: brushSettings,
  dockModeSetting: "mode",

  onStart(tc, point, settings) {
    tc.stroke.length = 0;
    tc.stroke.push(point);

    // Draw initial point
    const pressure = point.pressure ?? 1;
    const size = settings.sizeMin + pressure * (settings.sizeMax - settings.sizeMin);

    tc.ctx.beginPath();
    tc.ctx.arc(point.x, point.y, size / 2, 0, Math.PI * 2);
    tc.ctx.fill();
  },

  onMove(tc, point, settings) {
    if (tc.stroke.length === 0) {
      tc.stroke.push(point);
      this.onStart(tc, point, settings);
      return;
    }

    const last = tc.stroke[tc.stroke.length - 1];
    tc.stroke.push(point);

    const p0 = last.pressure ?? 1;
    const p1 = point.pressure ?? 1;
    const size0 = settings.sizeMin + p0 * (settings.sizeMax - settings.sizeMin);
    const size1 = settings.sizeMin + p1 * (settings.sizeMax - settings.sizeMin);

    // Subdivide segment and interpolate pressure for smooth strokes
    const dx = point.x - last.x;
    const dy = point.y - last.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // Step size scales with brush size so circles always overlap
    const minSize = Math.min(size0, size1);
    const stepSize = Math.max(0.5, minSize * 0.25);
    const steps = Math.max(1, Math.ceil(dist / stepSize));

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = last.x + dx * t;
      const y = last.y + dy * t;
      const size = size0 + (size1 - size0) * t;

      tc.ctx.beginPath();
      tc.ctx.arc(x, y, size / 2, 0, Math.PI * 2);
      tc.ctx.fill();
    }
  },

  onEnd(tc) {
    if (tc.stroke.length === 0) return null;
    const result = { points: [...tc.stroke] };
    tc.stroke.length = 0;
    return result;
  },
};
