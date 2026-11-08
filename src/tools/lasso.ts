import type { Point } from "../geometry/types";
import type { ToolContext, ToolDefinition, SettingsSchema, InferSettings } from "./types";
import {
  paintModeSetting,
  paintStyleSetting,
  strokeWidthSetting,
  traceSimplifySetting,
  scaleWithStageSetting,
  clampStrokeWidth,
  type PaintStyle,
} from "./paint-mode";

// ============================================================
// Lasso Fill Tool
// ============================================================

const lassoSettings = {
  mode: paintModeSetting,
  style: paintStyleSetting,
  width: strokeWidthSetting,
  simplify: traceSimplifySetting,
  scaleWithStage: scaleWithStageSetting,
} as const satisfies SettingsSchema;

export type LassoSettings = InferSettings<typeof lassoSettings>;

/** Draw the lasso shape (closed polyline) onto the pixel canvas. */
export function drawLassoShape(
  tc: ToolContext,
  style: PaintStyle,
  points?: Point[],
  width = strokeWidthSetting.default,
): void {
  tc.clear();
  const stroke = points ?? tc.stroke;
  const lineWidth = clampStrokeWidth(width);

  if (stroke.length < 2) {
    if (stroke.length === 1) {
      tc.ctx.beginPath();
      tc.ctx.arc(stroke[0].x, stroke[0].y, Math.max(1, lineWidth / 2), 0, Math.PI * 2);
      if (style === "stroke") {
        tc.ctx.lineWidth = lineWidth;
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
  if (style === "stroke") {
    tc.ctx.lineWidth = lineWidth;
    tc.ctx.lineJoin = "round";
    tc.ctx.lineCap = "round";
    tc.ctx.stroke();
  } else {
    tc.ctx.fill();
  }
}

/** Replace the live stroke and redraw the lasso preview. */
export function replaceLassoStroke(
  tc: ToolContext,
  points: Point[],
  style: PaintStyle,
  width = strokeWidthSetting.default,
): void {
  tc.stroke.length = 0;
  for (const p of points) tc.stroke.push({ ...p });
  drawLassoShape(tc, style, undefined, width);
}

export const lasso: ToolDefinition<typeof lassoSettings, "lasso"> = {
  id: "lasso",
  name: "Lasso Fill",
  hotkey: "l",
  icon: "07",
  settings: lassoSettings,
  dockModeSetting: "mode",

  onStart(tc, point, settings) {
    tc.stroke.length = 0;
    tc.stroke.push(point);
    drawLassoShape(
      tc,
      settings.style,
      undefined,
      settings.width * tc.paintSizeScale,
    );
  },

  onMove(tc, point, settings) {
    tc.stroke.push(point);
    drawLassoShape(
      tc,
      settings.style,
      undefined,
      settings.width * tc.paintSizeScale,
    );
  },

  onEnd(tc) {
    if (tc.stroke.length < 3) {
      tc.stroke.length = 0;
      tc.clear();
      return null;
    }
    const result = { points: [...tc.stroke] };
    tc.stroke.length = 0;
    return result;
  },
};
