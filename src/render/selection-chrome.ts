import type { SelectionHandle } from "./selection-types";

/** Pure bbox + handle chrome given a screen-space rect. */
export function drawTransformChrome(
  screenBounds: { x: number; y: number; width: number; height: number },
  ctx: CanvasRenderingContext2D,
  rotating?: { cursor: { x: number; y: number }; pivot: { x: number; y: number } } | null,
  /** Screen position of a movable pivot (symbol instance); drawn as a crosshair handle. */
  pivotScreen?: { x: number; y: number } | null,
): SelectionHandle[] {
  const b = screenBounds;
  const controlFill = "#000000";
  const controlStroke = "#ffffff";

  ctx.save();

  const boxDash = [5, 5];
  ctx.setLineDash(boxDash);
  ctx.lineJoin = "miter";
  ctx.strokeStyle = controlStroke;
  ctx.lineWidth = 3;
  ctx.strokeRect(b.x, b.y, b.width, b.height);
  ctx.strokeStyle = controlFill;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(b.x, b.y, b.width, b.height);
  ctx.setLineDash([]);

  const nw = { x: b.x, y: b.y };
  const ne = { x: b.x + b.width, y: b.y };
  const se = { x: b.x + b.width, y: b.y + b.height };
  const sw = { x: b.x, y: b.y + b.height };
  const n = { x: b.x + b.width / 2, y: b.y };
  const s = { x: b.x + b.width / 2, y: b.y + b.height };
  const e = { x: b.x + b.width, y: b.y + b.height / 2 };
  const w = { x: b.x, y: b.y + b.height / 2 };

  const rotateOffset = 30;
  const rotate = { x: n.x, y: n.y - rotateOffset };

  const handles: SelectionHandle[] = [
    { id: "nw", x: nw.x, y: nw.y },
    { id: "n", x: n.x, y: n.y },
    { id: "ne", x: ne.x, y: ne.y },
    { id: "e", x: e.x, y: e.y },
    { id: "se", x: se.x, y: se.y },
    { id: "s", x: s.x, y: s.y },
    { id: "sw", x: sw.x, y: sw.y },
    { id: "w", x: w.x, y: w.y },
    { id: "rotate", x: rotate.x, y: rotate.y },
  ];

  const strokeLineWhiteBlack = (
    x0: number, y0: number, x1: number, y1: number,
  ) => {
    ctx.lineCap = "round";
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = controlStroke;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = controlFill;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  };

  if (rotating) {
    strokeLineWhiteBlack(
      rotating.pivot.x, rotating.pivot.y,
      rotating.cursor.x, rotating.cursor.y,
    );
    ctx.fillStyle = controlFill;
    ctx.strokeStyle = controlStroke;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(rotating.pivot.x, rotating.pivot.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    strokeLineWhiteBlack(n.x, n.y, rotate.x, rotate.y);
    ctx.fillStyle = controlFill;
    ctx.strokeStyle = controlStroke;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(rotate.x, rotate.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  const handleSize = 8;
  const half = handleSize / 2;
  for (const h of handles) {
    if (h.id === "rotate") continue;
    ctx.fillStyle = controlFill;
    ctx.strokeStyle = controlStroke;
    ctx.lineWidth = 2;
    ctx.fillRect(h.x - half, h.y - half, handleSize, handleSize);
    ctx.strokeRect(h.x - half, h.y - half, handleSize, handleSize);
  }

  if (pivotScreen) {
    const p = pivotScreen;
    const r = 6;
    handles.push({ id: "pivot", x: p.x, y: p.y });
    ctx.setLineDash([]);
    ctx.lineCap = "round";
    // Hollow ring with crosshair: white halo then black.
    for (const pass of [
      { style: controlStroke, width: 3.5 },
      { style: controlFill, width: 1.5 },
    ]) {
      ctx.strokeStyle = pass.style;
      ctx.lineWidth = pass.width;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x - r - 3, p.y);
      ctx.lineTo(p.x + r + 3, p.y);
      ctx.moveTo(p.x, p.y - r - 3);
      ctx.lineTo(p.x, p.y + r + 3);
      ctx.stroke();
    }
  }

  ctx.restore();
  return handles;
}
