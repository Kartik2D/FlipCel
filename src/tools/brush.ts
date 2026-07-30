import type { Point } from "../geometry/types";
import type { ToolContext, ToolDefinition, SettingsSchema, InferSettings } from "./types";
import { paintModeSetting } from "./paint-mode";

// ============================================================
// Brush Tool
// ============================================================

const brushSettings = {
  mode: paintModeSetting,
  sizeMin: { type: "range", min: 1, max: 100, step: 0.1, default: 1 },
  sizeMax: { type: "range", min: 1, max: 100, step: 0.1, default: 4 },
} as const satisfies SettingsSchema;

export type BrushSettings = InferSettings<typeof brushSettings>;

/** Stamp a single pressure-sized circle. */
export function stampBrushPoint(
  ctx: CanvasRenderingContext2D,
  point: Point,
  sizeMin: number,
  sizeMax: number,
): void {
  const pressure = point.pressure ?? 1;
  const size = sizeMin + pressure * (sizeMax - sizeMin);
  ctx.beginPath();
  ctx.arc(point.x, point.y, size / 2, 0, Math.PI * 2);
  ctx.fill();
}

/** Stamp along a segment with interpolated pressure (overlapping circles). */
export function stampBrushSegment(
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  sizeMin: number,
  sizeMax: number,
): void {
  const p0 = from.pressure ?? 1;
  const p1 = to.pressure ?? 1;
  const size0 = sizeMin + p0 * (sizeMax - sizeMin);
  const size1 = sizeMin + p1 * (sizeMax - sizeMin);

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const minSize = Math.min(size0, size1);
  const stepSize = Math.max(0.5, minSize * 0.25);
  const steps = Math.max(1, Math.ceil(dist / stepSize));

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = from.x + dx * t;
    const y = from.y + dy * t;
    const size = size0 + (size1 - size0) * t;

    ctx.beginPath();
    ctx.arc(x, y, size / 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Clear canvas and stamp an entire polyline with per-point pressure. */
export function stampBrushStroke(
  tc: ToolContext,
  points: Point[],
  sizeMin: number,
  sizeMax: number,
): void {
  tc.clear();
  if (points.length === 0) return;
  stampBrushPoint(tc.ctx, points[0], sizeMin, sizeMax);
  for (let i = 1; i < points.length; i++) {
    stampBrushSegment(tc.ctx, points[i - 1], points[i], sizeMin, sizeMax);
  }
}

export const brush: ToolDefinition<typeof brushSettings, "brush"> = {
  id: "brush",
  name: "Brush",
  hotkey: "b",
  icon: "paint-brush",
  settings: brushSettings,
  dockModeSetting: "mode",

  onStart(tc, point, settings) {
    tc.stroke.length = 0;
    tc.stroke.push(point);
    stampBrushPoint(tc.ctx, point, settings.sizeMin, settings.sizeMax);
  },

  onMove(tc, point, settings) {
    if (tc.stroke.length === 0) {
      tc.stroke.push(point);
      this.onStart(tc, point, settings);
      return;
    }

    const last = tc.stroke[tc.stroke.length - 1];
    tc.stroke.push(point);
    stampBrushSegment(tc.ctx, last, point, settings.sizeMin, settings.sizeMax);
  },

  onEnd(tc) {
    if (tc.stroke.length === 0) return null;
    const result = { points: [...tc.stroke] };
    tc.stroke.length = 0;
    return result;
  },
};
