import type { Point } from "../geometry/types";
import type { ToolContext, ToolDefinition, SettingsSchema, InferSettings } from "./types";
import { paintModeSetting } from "./paint-mode";

// ============================================================
// Brush Tool
// ============================================================

export const brushTipSetting = {
  type: "select" as const,
  label: "Tip",
  options: ["circle", "square", "ellipse", "diag"] as const,
  default: "circle",
};

export type BrushTip = (typeof brushTipSetting.options)[number];

/** Diag tip thickness in pixel-canvas units. */
const DIAG_TIP_THICKNESS = 2;

const brushSettings = {
  mode: paintModeSetting,
  tip: brushTipSetting,
  sizeMin: { type: "range", min: 1, max: 100, step: 0.1, default: 1 },
  sizeMax: { type: "range", min: 1, max: 100, step: 0.1, default: 4 },
  angle: {
    type: "range" as const,
    label: "Angle",
    min: 0,
    max: 360,
    step: 1,
    default: 0,
  },
} as const satisfies SettingsSchema;

export type BrushSettings = InferSettings<typeof brushSettings>;

/** Stamp one tip at (x, y) with diameter `size`, rotated by `angleDeg`. */
export function stampBrushTip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  tip: BrushTip = "circle",
  angleDeg = 0,
): void {
  const r = size / 2;
  // Diag is inherently 45°; Angle still offsets it further.
  const effectiveDeg = tip === "diag" ? angleDeg - 45 : angleDeg;
  const rad = (effectiveDeg * Math.PI) / 180;
  ctx.save();
  ctx.translate(x, y);
  if (rad !== 0) ctx.rotate(rad);

  switch (tip) {
    case "square":
      ctx.fillRect(-r, -r, size, size);
      break;
    case "ellipse":
      ctx.beginPath();
      ctx.ellipse(0, 0, r, r * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "diag":
      // Thin bar along local X — baked -45° above makes Angle 0 read as diagonal.
      ctx.fillRect(-r, -DIAG_TIP_THICKNESS / 2, size, DIAG_TIP_THICKNESS);
      break;
    default:
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      break;
  }

  ctx.restore();
}

/** Stamp a single pressure-sized tip. */
export function stampBrushPoint(
  ctx: CanvasRenderingContext2D,
  point: Point,
  sizeMin: number,
  sizeMax: number,
  tip: BrushTip = "circle",
  angleDeg = 0,
): void {
  const pressure = point.pressure ?? 1;
  const size = sizeMin + pressure * (sizeMax - sizeMin);
  stampBrushTip(ctx, point.x, point.y, size, tip, angleDeg);
}

/** Stamp along a segment with interpolated pressure (overlapping tips). */
export function stampBrushSegment(
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  sizeMin: number,
  sizeMax: number,
  tip: BrushTip = "circle",
  angleDeg = 0,
): void {
  const p0 = from.pressure ?? 1;
  const p1 = to.pressure ?? 1;
  const size0 = sizeMin + p0 * (sizeMax - sizeMin);
  const size1 = sizeMin + p1 * (sizeMax - sizeMin);

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  // Stamp every pixel along the segment so fast strokes don't show tip gaps.
  const steps = Math.max(1, Math.ceil(dist));

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = from.x + dx * t;
    const y = from.y + dy * t;
    const size = size0 + (size1 - size0) * t;
    stampBrushTip(ctx, x, y, size, tip, angleDeg);
  }
}

/** Clear canvas and stamp an entire polyline with per-point pressure. */
export function stampBrushStroke(
  tc: ToolContext,
  points: Point[],
  sizeMin: number,
  sizeMax: number,
  tip: BrushTip = "circle",
  angleDeg = 0,
): void {
  tc.clear();
  if (points.length === 0) return;
  stampBrushPoint(tc.ctx, points[0], sizeMin, sizeMax, tip, angleDeg);
  for (let i = 1; i < points.length; i++) {
    stampBrushSegment(
      tc.ctx,
      points[i - 1],
      points[i],
      sizeMin,
      sizeMax,
      tip,
      angleDeg,
    );
  }
}

export function isBrushTip(value: unknown): value is BrushTip {
  return (
    value === "circle" ||
    value === "square" ||
    value === "ellipse" ||
    value === "diag"
  );
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
    stampBrushPoint(
      tc.ctx,
      point,
      settings.sizeMin,
      settings.sizeMax,
      settings.tip,
      settings.angle,
    );
  },

  onMove(tc, point, settings) {
    if (tc.stroke.length === 0) {
      tc.stroke.push(point);
      this.onStart(tc, point, settings);
      return;
    }

    const last = tc.stroke[tc.stroke.length - 1];
    tc.stroke.push(point);
    stampBrushSegment(
      tc.ctx,
      last,
      point,
      settings.sizeMin,
      settings.sizeMax,
      settings.tip,
      settings.angle,
    );
  },

  onEnd(tc) {
    if (tc.stroke.length === 0) return null;
    const result = { points: [...tc.stroke] };
    tc.stroke.length = 0;
    return result;
  },
};
