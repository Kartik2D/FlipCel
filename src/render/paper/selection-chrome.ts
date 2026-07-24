import paper from "paper";
import type { SelectionHandle } from "./types";

export type WorldToScreen = (x: number, y: number) => { x: number; y: number };

/** Trace each contour of a Path/CompoundPath in screen space. */
export function forEachOutlineContour(
  ctx: CanvasRenderingContext2D,
  item: paper.Item,
  worldToScreen: WorldToScreen,
  strokeContour: () => void,
): void {
  const paths: paper.Path[] = [];
  if (item instanceof paper.Path) {
    paths.push(item);
  } else if (item instanceof paper.CompoundPath) {
    for (const child of item.children) {
      if (child instanceof paper.Path) paths.push(child);
    }
  }
  if (paths.length === 0) return;

  for (const path of paths) {
    const segs = path.segments;
    if (segs.length < 2) continue;

    ctx.beginPath();
    const first = worldToScreen(segs[0].point.x, segs[0].point.y);
    ctx.moveTo(first.x, first.y);

    for (let i = 1; i < segs.length; i++) {
      const prev = segs[i - 1];
      const cur = segs[i];
      const sp = worldToScreen(cur.point.x, cur.point.y);
      if (prev.handleOut.isZero() && cur.handleIn.isZero()) {
        ctx.lineTo(sp.x, sp.y);
      } else {
        const cp1 = prev.point.add(prev.handleOut);
        const cp2 = cur.point.add(cur.handleIn);
        const s1 = worldToScreen(cp1.x, cp1.y);
        const s2 = worldToScreen(cp2.x, cp2.y);
        ctx.bezierCurveTo(s1.x, s1.y, s2.x, s2.y, sp.x, sp.y);
      }
    }

    if (path.closed && segs.length > 2) {
      const last = segs[segs.length - 1];
      const firstSeg = segs[0];
      const sp = worldToScreen(firstSeg.point.x, firstSeg.point.y);
      if (last.handleOut.isZero() && firstSeg.handleIn.isZero()) {
        ctx.lineTo(sp.x, sp.y);
      } else {
        const cp1 = last.point.add(last.handleOut);
        const cp2 = firstSeg.point.add(firstSeg.handleIn);
        const s1 = worldToScreen(cp1.x, cp1.y);
        const s2 = worldToScreen(cp2.x, cp2.y);
        ctx.bezierCurveTo(s1.x, s1.y, s2.x, s2.y, sp.x, sp.y);
      }
      ctx.closePath();
    }

    strokeContour();
  }
}

/** Dashed shape outline chrome for select / direct-select. */
export function strokeSelectionShapeOutline(
  ctx: CanvasRenderingContext2D,
  item: paper.Item,
  worldToScreen: WorldToScreen,
): void {
  const dash = [6, 5];
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "butt";

  const layers: Array<{ style: string; width: number }> = [
    { style: "rgba(0, 0, 0, 0.45)", width: 5 },
    { style: "#ffffff", width: 3.5 },
    { style: "#000000", width: 1.5 },
  ];

  for (const layer of layers) {
    ctx.strokeStyle = layer.style;
    ctx.lineWidth = layer.width;
    ctx.setLineDash(dash);
    forEachOutlineContour(ctx, item, worldToScreen, () => ctx.stroke());
  }

  ctx.setLineDash([]);
  ctx.restore();
}

/** Pure bbox + handle chrome given a screen-space rect. */
export function drawTransformChrome(
  screenBounds: { x: number; y: number; width: number; height: number },
  ctx: CanvasRenderingContext2D,
  rotating?: { cursor: { x: number; y: number }; pivot: { x: number; y: number } } | null,
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

  ctx.restore();
  return handles;
}
