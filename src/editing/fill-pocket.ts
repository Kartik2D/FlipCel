/**
 * Pocket fill (Flash-style): recolor a hit path, or flood-fill an enclosed
 * empty pocket after morphological gap-close (dilate then erode).
 *
 * Openings larger than the gap won’t fill (region must not touch the view
 * border). Narrow alleys sealed by gap-close fall back to exact walls.
 */
import paper from "paper";
import type { Camera } from "../render/camera";
import type { PaperRenderer } from "../render/paper-renderer";
import type { Tracer } from "../tracing/potrace-tracer";
import type { CanvasConfig } from "../geometry/types";

export interface FillPocketDeps {
  paperRenderer: PaperRenderer;
  tracer: Tracer;
  camera: Camera;
  getConfig: () => CanvasConfig;
}

const FILL_MASK_MAX_SIDE = 768;
const OCCUPANCY_ALPHA = 127;
const STROKE_TUCK_PX = 2;

function maskSize(viewportWidth: number, viewportHeight: number): {
  maskW: number;
  maskH: number;
} {
  const vw = Math.max(1, viewportWidth);
  const vh = Math.max(1, viewportHeight);
  if (vw >= vh) {
    const maskW = Math.min(FILL_MASK_MAX_SIDE, Math.round(vw));
    const maskH = Math.max(1, Math.round((maskW * vh) / vw));
    return { maskW, maskH };
  }
  const maskH = Math.min(FILL_MASK_MAX_SIDE, Math.round(vh));
  const maskW = Math.max(1, Math.round((maskH * vw) / vh));
  return { maskW, maskH };
}

function rasterizeActiveLayerOccupancy(
  camera: Camera,
  config: CanvasConfig,
  maskW: number,
  maskH: number,
): Uint8Array | null {
  const layer = paper.project.activeLayer;
  if (!layer) return null;

  const canvas = document.createElement("canvas");
  canvas.width = maskW;
  canvas.height = maskH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  ctx.clearRect(0, 0, maskW, maskH);
  ctx.imageSmoothingEnabled = false;

  const sx = maskW / Math.max(config.viewportWidth, 1);
  const sy = maskH / Math.max(config.viewportHeight, 1);
  const [a, b, c, d, tx, ty] = camera.getTransformMatrix();
  ctx.setTransform(a * sx, b * sy, c * sx, d * sy, tx * sx, ty * sy);

  ctx.fillStyle = "#ffffff";
  for (const child of layer.children) {
    if (!(child instanceof paper.Path || child instanceof paper.CompoundPath)) {
      continue;
    }
    let pathData: string;
    try {
      pathData = child.pathData;
    } catch {
      continue;
    }
    if (!pathData) continue;
    try {
      const rule =
        child instanceof paper.CompoundPath ? "evenodd" : "nonzero";
      ctx.fill(new Path2D(pathData), rule);
    } catch {
      /* skip unparseable path data */
    }
  }

  const img = ctx.getImageData(0, 0, maskW, maskH);
  const mask = new Uint8Array(maskW * maskH);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    mask[i] = img.data[p + 3] > OCCUPANCY_ALPHA ? 1 : 0;
  }
  return mask;
}

function dilateBinary(
  src: Uint8Array,
  maskW: number,
  maskH: number,
  radius: number,
): Uint8Array {
  if (radius <= 0) return src;
  const out = new Uint8Array(src.length);
  for (let y = 0; y < maskH; y++) {
    for (let x = 0; x < maskW; x++) {
      if (!src[y * maskW + x]) continue;
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(maskH - 1, y + radius);
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(maskW - 1, x + radius);
      for (let ny = y0; ny <= y1; ny++) {
        const row = ny * maskW;
        for (let nx = x0; nx <= x1; nx++) {
          out[row + nx] = 1;
        }
      }
    }
  }
  return out;
}

function erodeBinary(
  src: Uint8Array,
  maskW: number,
  maskH: number,
  radius: number,
): Uint8Array {
  if (radius <= 0) return src;
  const out = new Uint8Array(src.length);
  for (let y = 0; y < maskH; y++) {
    for (let x = 0; x < maskW; x++) {
      if (y - radius < 0 || y + radius >= maskH) continue;
      if (x - radius < 0 || x + radius >= maskW) continue;
      let ok = true;
      outer: for (let ny = y - radius; ny <= y + radius; ny++) {
        const row = ny * maskW;
        for (let nx = x - radius; nx <= x + radius; nx++) {
          if (!src[row + nx]) {
            ok = false;
            break outer;
          }
        }
      }
      if (ok) out[y * maskW + x] = 1;
    }
  }
  return out;
}

function morphCloseBinary(
  src: Uint8Array,
  maskW: number,
  maskH: number,
  radius: number,
): Uint8Array {
  if (radius <= 0) return src;
  return erodeBinary(
    dilateBinary(src, maskW, maskH, radius),
    maskW,
    maskH,
    radius,
  );
}

function floodWhere(
  maskW: number,
  maskH: number,
  seedX: number,
  seedY: number,
  canEnter: (index: number) => boolean,
): { region: Uint8Array; touchesBorder: boolean } | null {
  if (seedX < 0 || seedY < 0 || seedX >= maskW || seedY >= maskH) return null;
  const seedIndex = seedY * maskW + seedX;
  if (!canEnter(seedIndex)) return null;

  const region = new Uint8Array(maskW * maskH);
  const stackX = [seedX];
  const stackY = [seedY];
  region[seedIndex] = 1;
  let touchesBorder = false;

  while (stackX.length > 0) {
    const x = stackX.pop()!;
    const y = stackY.pop()!;
    if (x === 0 || y === 0 || x === maskW - 1 || y === maskH - 1) {
      touchesBorder = true;
    }

    const neighbors = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= maskW || ny >= maskH) continue;
      const ni = ny * maskW + nx;
      if (region[ni] || !canEnter(ni)) continue;
      region[ni] = 1;
      stackX.push(nx);
      stackY.push(ny);
    }
  }

  return { region, touchesBorder };
}

function findNearestCell(
  maskW: number,
  maskH: number,
  sx: number,
  sy: number,
  maxDist: number,
  pred: (index: number) => boolean,
): { x: number; y: number } | null {
  if (pred(sy * maskW + sx)) return { x: sx, y: sy };
  for (let dist = 1; dist <= maxDist; dist++) {
    for (let dy = -dist; dy <= dist; dy++) {
      for (let dx = -dist; dx <= dist; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== dist) continue;
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= maskW || y >= maskH) continue;
        if (pred(y * maskW + x)) return { x, y };
      }
    }
  }
  return null;
}

function regionToCanvas(
  region: Uint8Array,
  maskW: number,
  maskH: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = maskW;
  canvas.height = maskH;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(maskW, maskH);
  const data = img.data;
  for (let i = 0; i < region.length; i++) {
    if (!region[i]) continue;
    const p = i * 4;
    data[p] = 0;
    data[p + 1] = 0;
    data[p + 2] = 0;
    data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function regionHasPixels(region: Uint8Array): boolean {
  for (let i = 0; i < region.length; i++) {
    if (region[i]) return true;
  }
  return false;
}

function floodClosedPocket(
  walls: Uint8Array,
  occupancy: Uint8Array,
  maskW: number,
  maskH: number,
  seedX: number,
  seedY: number,
  searchRadius: number,
): Uint8Array | null {
  let sx = seedX;
  let sy = seedY;
  const seedIndex = sy * maskW + sx;

  if (walls[seedIndex]) {
    const alt = findNearestCell(
      maskW,
      maskH,
      sx,
      sy,
      Math.max(1, searchRadius),
      (i) => !walls[i],
    );
    if (!alt) return null;
    sx = alt.x;
    sy = alt.y;
  }

  const flooded = floodWhere(maskW, maskH, sx, sy, (i) => !walls[i]);
  if (!flooded || flooded.touchesBorder) return null;

  const region = flooded.region;
  for (let i = 0; i < region.length; i++) {
    if (occupancy[i]) region[i] = 0;
  }
  return regionHasPixels(region) ? region : null;
}

/** Pocket / morph-close fill. Returns true when the document changed. */
export async function fillPocketAt(
  deps: FillPocketDeps,
  viewportPoint: { x: number; y: number },
  color: string,
  gapPx = 0,
): Promise<boolean> {
  const config = deps.getConfig();
  const { maskW, maskH } = maskSize(config.viewportWidth, config.viewportHeight);
  const occupancy = rasterizeActiveLayerOccupancy(
    deps.camera,
    config,
    maskW,
    maskH,
  );
  if (!occupancy) return false;

  const seedX = Math.min(
    maskW - 1,
    Math.max(0, Math.floor((viewportPoint.x / config.viewportWidth) * maskW)),
  );
  const seedY = Math.min(
    maskH - 1,
    Math.max(0, Math.floor((viewportPoint.y / config.viewportHeight) * maskH)),
  );
  const seedIndex = seedY * maskW + seedX;

  if (occupancy[seedIndex]) {
    const hit = deps.paperRenderer.hitTest(viewportPoint);
    const item = deps.paperRenderer.hitToClipPathItem(hit);
    if (!item) return false;
    return deps.paperRenderer.recolorItem(item, color);
  }

  const gap = Math.max(0, Math.round(gapPx));
  const gapMaskPx = Math.round(
    (gap * maskW) / Math.max(config.viewportWidth, 1),
  );

  const closedWalls =
    gapMaskPx > 0
      ? morphCloseBinary(occupancy, maskW, maskH, gapMaskPx)
      : occupancy;

  let region = floodClosedPocket(
    closedWalls,
    occupancy,
    maskW,
    maskH,
    seedX,
    seedY,
    gapMaskPx,
  );

  if (!region && gapMaskPx > 0) {
    region = floodClosedPocket(
      occupancy,
      occupancy,
      maskW,
      maskH,
      seedX,
      seedY,
      0,
    );
  }
  if (!region) return false;

  const tucked = dilateBinary(region, maskW, maskH, STROKE_TUCK_PX);
  const canvas = regionToCanvas(tucked, maskW, maskH);
  const svg = await deps.tracer.trace(canvas);
  if (!svg) return false;

  await deps.paperRenderer.addPathIntersectClip(svg, color, null);
  return true;
}
