import type { CanvasConfig, Point } from "../geometry/types";
import { pixelToViewport } from "../geometry/coords";
import { polygonRing, rectRing, type Ring } from "../vector/kernel";
import { ellipseRing, roundRectRing } from "../vector/rings";
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
// Shape Tool — pixel-canvas preview, kernel rings on commit
// ============================================================

export const shapeKindSetting = {
  type: "select" as const,
  label: "Shape",
  options: [
    "circle",
    "rect",
    "roundRect",
    "poly",
    "star",
    "cross",
    "arrow",
    "heart",
  ] as const,
  default: "rect",
};

export type ShapeKind = (typeof shapeKindSetting.options)[number];

const shapeSettings = {
  mode: paintModeSetting,
  style: paintStyleSetting,
  width: strokeWidthSetting,
  simplify: traceSimplifySetting,
  shape: shapeKindSetting,
  points: {
    type: "range" as const,
    label: "Points",
    min: 3,
    max: 12,
    step: 1,
    default: 5,
  },
  from: {
    type: "toggle",
    label: "Draw from",
    options: ["corner", "center"] as const,
    default: "corner",
  },
  scaleWithStage: scaleWithStageSetting,
} as const satisfies SettingsSchema;

export type ShapeSettings = InferSettings<typeof shapeSettings>;

/** Points slider applies to n-gons and stars. */
export function shapeUsesPoints(kind: ShapeKind): boolean {
  return kind === "poly" || kind === "star";
}

interface ShapeBox {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

function shapeBox(
  a: Point,
  b: Point,
  fromCenter: boolean,
  constrain = false,
): ShapeBox | null {
  let x: number;
  let y: number;
  let w: number;
  let h: number;

  if (fromCenter) {
    let rx = Math.abs(b.x - a.x);
    let ry = Math.abs(b.y - a.y);
    if (constrain) {
      const r = Math.max(rx, ry);
      rx = r;
      ry = r;
    }
    x = a.x - rx;
    y = a.y - ry;
    w = rx * 2;
    h = ry * 2;
  } else {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    if (constrain) {
      const side = Math.max(Math.abs(dx), Math.abs(dy));
      dx = (dx < 0 ? -1 : 1) * side;
      dy = (dy < 0 ? -1 : 1) * side;
    }
    x = Math.min(a.x, a.x + dx);
    y = Math.min(a.y, a.y + dy);
    w = Math.abs(dx);
    h = Math.abs(dy);
  }

  if (w < 0.5 || h < 0.5) return null;
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 };
}

function roundCornerRadius(box: ShapeBox): number {
  return Math.min(box.w, box.h) * 0.22;
}

function clampPoints(points: number): number {
  return Math.max(3, Math.min(12, Math.round(points)));
}

/** Unit-space vertices in [-1, 1]; stretched by rx/ry in draw/build. */
function unitStar(points: number, inner = 0.45): Array<[number, number]> {
  const n = clampPoints(points);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? 1 : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    out.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return out;
}

function unitRegularPolygon(sides: number): Array<[number, number]> {
  const n = clampPoints(sides);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    out.push([Math.cos(a), Math.sin(a)]);
  }
  return out;
}

function unitCross(arm = 0.35): Array<[number, number]> {
  return [
    [-arm, -1],
    [arm, -1],
    [arm, -arm],
    [1, -arm],
    [1, arm],
    [arm, arm],
    [arm, 1],
    [-arm, 1],
    [-arm, arm],
    [-1, arm],
    [-1, -arm],
    [-arm, -arm],
  ];
}

function unitArrow(): Array<[number, number]> {
  return [
    [0, -1],
    [1, 0.05],
    [0.4, 0.05],
    [0.4, 1],
    [-0.4, 1],
    [-0.4, 0.05],
    [-1, 0.05],
  ];
}

/** Classic heart curve, normalized into the unit box. */
function unitHeart(steps = 48): Array<[number, number]> {
  const raw: Array<[number, number]> = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const x = 16 * Math.sin(t) ** 3;
    const y = -(
      13 * Math.cos(t) -
      5 * Math.cos(2 * t) -
      2 * Math.cos(3 * t) -
      Math.cos(4 * t)
    );
    raw.push([x, y]);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const sx = (maxX - minX) / 2 || 1;
  const sy = (maxY - minY) / 2 || 1;
  return raw.map(([x, y]) => [(x - cx) / sx, (y - cy) / sy]);
}

/** Unit outline in [-1, 1]. Circle, rect, and round-rect are not polylines. */
export function shapeUnitOutline(
  kind: ShapeKind,
  points = 5,
): Array<[number, number]> | null {
  return unitVerts(kind, points);
}

function unitVerts(kind: ShapeKind, points: number): Array<[number, number]> | null {
  switch (kind) {
    case "poly":
      return unitRegularPolygon(points);
    case "star":
      return unitStar(points);
    case "cross":
      return unitCross();
    case "arrow":
      return unitArrow();
    case "heart":
      return unitHeart();
    default:
      return null;
  }
}

function paintClosedPath(
  ctx: CanvasRenderingContext2D,
  style: PaintStyle,
  width: number,
): void {
  if (style === "stroke") {
    ctx.lineWidth = clampStrokeWidth(width);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
  } else {
    ctx.fill();
  }
}

function paintUnitPoly(
  ctx: CanvasRenderingContext2D,
  box: ShapeBox,
  verts: Array<[number, number]>,
  style: PaintStyle,
  width: number,
): void {
  ctx.beginPath();
  ctx.moveTo(box.cx + verts[0][0] * box.rx, box.cy + verts[0][1] * box.ry);
  for (let i = 1; i < verts.length; i++) {
    ctx.lineTo(box.cx + verts[i][0] * box.rx, box.cy + verts[i][1] * box.ry);
  }
  ctx.closePath();
  paintClosedPath(ctx, style, width);
}

function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  box: ShapeBox,
  style: PaintStyle,
  width: number,
): void {
  const r = roundCornerRadius(box);
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(box.x, box.y, box.w, box.h, r);
  } else {
    ctx.rect(box.x, box.y, box.w, box.h);
  }
  paintClosedPath(ctx, style, width);
}

function drawShapePreview(
  tc: ToolContext,
  kind: ShapeKind,
  fromCenter: boolean,
  points: number,
  style: PaintStyle,
  width: number,
): void {
  tc.clear();
  if (tc.stroke.length < 2) return;
  const box = shapeBox(
    tc.stroke[0],
    tc.stroke[tc.stroke.length - 1],
    fromCenter,
    tc.constrainScale,
  );
  if (!box) return;

  if (kind === "rect") {
    tc.ctx.beginPath();
    tc.ctx.rect(box.x, box.y, box.w, box.h);
    paintClosedPath(tc.ctx, style, width);
    return;
  }
  if (kind === "roundRect") {
    drawRoundRect(tc.ctx, box, style, width);
    return;
  }
  if (kind === "circle") {
    tc.ctx.beginPath();
    tc.ctx.ellipse(box.cx, box.cy, box.rx, box.ry, 0, 0, Math.PI * 2);
    paintClosedPath(tc.ctx, style, width);
    return;
  }

  const verts = unitVerts(kind, points);
  if (verts) paintUnitPoly(tc.ctx, box, verts, style, width);
}

/**
 * Build the primitive as kernel rings in viewport coords from pixel-canvas
 * anchors. The paint pipeline maps viewport → world.
 */
export function buildPrimitiveShape(
  config: CanvasConfig,
  kind: ShapeKind,
  pixelPoints: Point[],
  fromCenter: boolean,
  points = 5,
  constrain = false,
): Ring[] | null {
  if (pixelPoints.length < 2) return null;

  const a = pixelToViewport(pixelPoints[0], config);
  const b = pixelToViewport(pixelPoints[pixelPoints.length - 1], config);
  const box = shapeBox(a, b, fromCenter, constrain);
  if (!box) return null;

  if (kind === "rect") return [rectRing(box.x, box.y, box.w, box.h)];
  if (kind === "roundRect") {
    const r = roundCornerRadius(box);
    return [roundRectRing(box.x, box.y, box.w, box.h, r, r)];
  }
  if (kind === "circle") return [ellipseRing(box.cx, box.cy, box.rx, box.ry)];

  const verts = unitVerts(kind, points);
  if (!verts) return null;
  const ring = polygonRing(
    verts.map(([ux, uy]) => ({ x: box.cx + ux * box.rx, y: box.cy + uy * box.ry })),
  );
  return ring ? [ring] : null;
}

export function isShapeKind(value: unknown): value is ShapeKind {
  return (
    typeof value === "string" &&
    (shapeKindSetting.options as readonly string[]).includes(value)
  );
}

export const shape: ToolDefinition<typeof shapeSettings, "shape"> = {
  id: "shape",
  name: "Shape",
  hotkey: "u",
  icon: "08",
  settings: shapeSettings,
  dockModeSetting: "mode",

  onStart(tc, point, settings) {
    tc.stroke.length = 0;
    tc.stroke.push(point, point);
    drawShapePreview(
      tc,
      settings.shape,
      settings.from === "center",
      settings.points,
      settings.style,
      settings.width * tc.paintSizeScale,
    );
  },

  onMove(tc, point, settings) {
    if (tc.stroke.length === 0) {
      tc.stroke.push(point, point);
    } else {
      tc.stroke[1] = point;
      if (tc.stroke.length > 2) tc.stroke.length = 2;
    }
    drawShapePreview(
      tc,
      settings.shape,
      settings.from === "center",
      settings.points,
      settings.style,
      settings.width * tc.paintSizeScale,
    );
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
