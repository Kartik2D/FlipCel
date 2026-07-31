/**
 * Gas-pressure chamber fill (unified inside / outside).
 *
 * Rasterize the active layer as RGBA. The seed material under the click
 * (a fill color, or empty) defines the chamber. Non-seed pixels are walls.
 *
 * Gap > 0:
 * - Empty seed: MyPaint/Krita gap-distance gas (stop spill through openings).
 * - Colored seed: separate stroke *arms* at fat junction cores (EDT peaks at
 *   crossings). Plain gap-distance on ink wrongly treats thin strokes as the
 *   gap corridor and leaves squares at junctions.
 *
 * Commit: empty → tuck + paint-behind; colored → 1px outset + inside boolean.
 */
import paper from "paper";
import type { Camera } from "../render/camera";
import type { PaperRenderer } from "../render/paper-renderer";
import type { Tracer } from "../tracing/potrace-tracer";
import type { CanvasConfig } from "../geometry/types";
import { fillPocketAt } from "./fill-pocket";

const FILL_MASK_MAX_SIDE = 768;
const MATERIAL_ALPHA = 127;
/** Overfill into neighboring walls when filling empty space (paint-behind). */
const STROKE_TUCK_PX = 2;
/** Outset when replacing an existing fill, then inside-boolean to the shape. */
const COLOR_OUTSET_PX = 1;
/** Seal 1px AA pinholes in walls before empty-pocket gap flood. */
const WALL_SEAL_PX = 1;
/** Min arm half-width (mask px) before ray-junction splitting is attempted. */
const JUNCTION_MIN_ARM_HALF = 1;
/** How far along each ray (× arm half-width) we look for branch continuity. */
const JUNCTION_RAY_FACTOR = 2.25;
/** Medial pixels need at least this many of 8 directions still in-seed. */
const JUNCTION_MIN_RAYS = 3;
const DISTANCE_INFINITE = 0xffff;
/**
 * When allowExpand is false, only allow flat/descending distance steps.
 * (Krita's 1.3 tolerance lets the fill gently climb out of gaps on harsh
 * crossings; we keep ascent blocked once the membrane is entered.)
 */
const SPREAD_TOLERANCE = 1.0;

export interface FillRegionDeps {
  paperRenderer: PaperRenderer;
  tracer: Tracer;
  camera: Camera;
  getConfig: () => CanvasConfig;
}

export type FillAlgorithm = "vector" | "screen";

export interface FillOptions {
  /** Close openings up to this many viewport pixels (0 = contiguous only). */
  gapPx?: number;
  /** `vector` = morph-close sealed pocket; `screen` = raster gas-pressure. */
  algorithm?: FillAlgorithm;
}

interface SeedMaterial {
  empty: boolean;
  r: number;
  g: number;
  b: number;
}

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

function paperColorToCss(color: paper.Color | null | undefined): string | null {
  if (!color || color.alpha <= 0) return null;
  return color.toCSS(true);
}

/**
 * Rasterize active-layer paths with real fill colors into RGBA ImageData.
 */
function rasterizeActiveLayerRgba(
  camera: Camera,
  config: CanvasConfig,
  maskW: number,
  maskH: number,
): ImageData | null {
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

  for (const child of layer.children) {
    if (!(child instanceof paper.Path || child instanceof paper.CompoundPath)) {
      continue;
    }
    const css = paperColorToCss(child.fillColor as paper.Color | null);
    if (!css) continue;
    let pathData: string;
    try {
      pathData = child.pathData;
    } catch {
      continue;
    }
    if (!pathData) continue;
    try {
      ctx.fillStyle = css;
      // Compounds keep evenodd holes; simple paths use nonzero so overlaps
      // stay solid walls (evenodd on a lone self-overlapping stroke can punch holes).
      const rule =
        child instanceof paper.CompoundPath ? "evenodd" : "nonzero";
      ctx.fill(new Path2D(pathData), rule);
    } catch {
      /* skip unparseable path data */
    }
  }

  return ctx.getImageData(0, 0, maskW, maskH);
}

function sampleSeed(data: Uint8ClampedArray, index: number): SeedMaterial {
  const p = index * 4;
  const a = data[p + 3];
  if (a <= MATERIAL_ALPHA) {
    return { empty: true, r: 0, g: 0, b: 0 };
  }
  return { empty: false, r: data[p], g: data[p + 1], b: data[p + 2] };
}

function matchesSeed(
  data: Uint8ClampedArray,
  index: number,
  seed: SeedMaterial,
): boolean {
  const p = index * 4;
  const a = data[p + 3];
  const empty = a <= MATERIAL_ALPHA;
  if (seed.empty) return empty;
  if (empty) return false;
  return data[p] === seed.r && data[p + 1] === seed.g && data[p + 2] === seed.b;
}

/** Walls = not seed material. */
function buildWallMask(
  data: Uint8ClampedArray,
  seed: SeedMaterial,
  pixelCount: number,
): Uint8Array {
  const walls = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    walls[i] = matchesSeed(data, i, seed) ? 0 : 1;
  }
  return walls;
}

type OctantTransform = (
  x: number,
  y: number,
  xOffset: number,
  yOffset: number,
) => { x: number; y: number };

const TRANSFORM_NONE: OctantTransform = (x, y, xOffset, yOffset) => ({
  x: x + xOffset,
  y: y + yOffset,
});
const TRANSFORM_ROTATE_CW_MIRROR_H: OctantTransform = (x, y, xOffset, yOffset) => ({
  x: x - yOffset,
  y: y - xOffset,
});
const TRANSFORM_ROTATE_CW: OctantTransform = (x, y, xOffset, yOffset) => ({
  x: x - yOffset,
  y: y + xOffset,
});
const TRANSFORM_MIRROR_H: OctantTransform = (x, y, xOffset, yOffset) => ({
  x: x + xOffset,
  y: y - yOffset,
});

const OCTANT_TRANSFORMS: OctantTransform[] = [
  TRANSFORM_NONE,
  TRANSFORM_ROTATE_CW_MIRROR_H,
  TRANSFORM_ROTATE_CW,
  TRANSFORM_MIRROR_H,
];

function isWallAt(
  walls: Uint8Array,
  maskW: number,
  maskH: number,
  x: number,
  y: number,
): boolean {
  if (x < 0 || y < 0 || x >= maskW || y >= maskH) return false;
  return walls[y * maskW + x] !== 0;
}

function gapDistanceSearch(
  walls: Uint8Array,
  distance: Uint16Array,
  maskW: number,
  maskH: number,
  gapSize: number,
  x: number,
  y: number,
  op: OctantTransform,
): void {
  const a = op(x, y, 0, -1);
  const b = op(x, y, 1, -1);
  if (isWallAt(walls, maskW, maskH, a.x, a.y) || isWallAt(walls, maskW, maskH, b.x, b.y)) {
    return;
  }

  const gapLimit = 1 + gapSize * gapSize;
  for (let yoffs = 2; yoffs < gapSize + 2; yoffs++) {
    const yDistanceSq = (yoffs - 1) * (yoffs - 1);
    for (let xoffs = 0; xoffs <= yoffs; xoffs++) {
      const offsetDistance = yDistanceSq + xoffs * xoffs;
      if (offsetDistance >= gapLimit) break;

      const far = op(x, y, xoffs, -yoffs);
      if (!isWallAt(walls, maskW, maskH, far.x, far.y)) continue;

      const dx = xoffs / (yoffs - 1);
      let tx = 0;
      let cx = 0;
      for (let cy = 1; cy < yoffs; cy++) {
        updateDistance(distance, maskW, maskH, op(x, y, cx, -cy), offsetDistance);
        tx += dx;
        if (Math.floor(tx) > cx) {
          cx++;
          updateDistance(distance, maskW, maskH, op(x, y, cx, -cy), offsetDistance);
        }
        updateDistance(distance, maskW, maskH, op(x, y, cx + 1, -cy), offsetDistance);
      }
    }
  }
}

function updateDistance(
  distance: Uint16Array,
  maskW: number,
  maskH: number,
  p: { x: number; y: number },
  newDistance: number,
): void {
  if (p.x < 0 || p.y < 0 || p.x >= maskW || p.y >= maskH) return;
  const i = p.y * maskW + p.x;
  if (distance[i] > newDistance) distance[i] = newDistance;
}

/** Gap-distance map: smaller = closer to a constriction; INFINITE = open volume. */
function buildGapDistanceMap(
  walls: Uint8Array,
  maskW: number,
  maskH: number,
  gapSize: number,
): Uint16Array {
  const distance = new Uint16Array(maskW * maskH);
  distance.fill(DISTANCE_INFINITE);
  if (gapSize <= 0) return distance;

  for (let y = 0; y < maskH; y++) {
    for (let x = 0; x < maskW; x++) {
      if (!walls[y * maskW + x]) continue;
      for (const op of OCTANT_TRANSFORMS) {
        gapDistanceSearch(walls, distance, maskW, maskH, gapSize, x, y, op);
      }
    }
  }
  return distance;
}

interface GasPoint {
  x: number;
  y: number;
  distance: number;
  allowExpand: boolean;
}

/** Min-heap: prefer allowExpand=false, then smaller distance, then y, x. */
class GasHeap {
  private items: GasPoint[] = [];

  get size(): number {
    return this.items.length;
  }

  push(p: GasPoint): void {
    this.items.push(p);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): GasPoint | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }

  private less(a: GasPoint, b: GasPoint): boolean {
    const ae = a.allowExpand ? 1 : 0;
    const be = b.allowExpand ? 1 : 0;
    if (ae !== be) return ae < be;
    if (a.distance !== b.distance) return a.distance < b.distance;
    if (a.y !== b.y) return a.y < b.y;
    return a.x < b.x;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(this.items[i], this.items[parent])) break;
      [this.items[i], this.items[parent]] = [this.items[parent], this.items[i]];
      i = parent;
    }
  }

  private bubbleDown(i: number): void {
    const n = this.items.length;
    for (;;) {
      let best = i;
      const l = i * 2 + 1;
      const r = l + 1;
      if (l < n && this.less(this.items[l], this.items[best])) best = l;
      if (r < n && this.less(this.items[r], this.items[best])) best = r;
      if (best === i) break;
      [this.items[i], this.items[best]] = [this.items[best], this.items[i]];
      i = best;
    }
  }
}

function relativeDiff(current: number, previous: number): number {
  if (previous >= DISTANCE_INFINITE) {
    return current >= DISTANCE_INFINITE ? 1 : 0;
  }
  if (previous <= 0) return current >= DISTANCE_INFINITE ? Infinity : current;
  return current / previous;
}

/** True when the gas step is allowed under gap-membrane rules. */
function canStepGas(
  currentDistance: number,
  previousDistance: number,
  allowExpand: boolean,
): boolean {
  if (allowExpand) return true;
  // Entering / moving inside a gap: only flat or descending (no climb-out).
  return relativeDiff(currentDistance, previousDistance) <= SPREAD_TOLERANCE;
}

/** Nearest seed-material cell not marked blocked, within Chebyshev maxDist. */
function findNearestEnterable(
  data: Uint8ClampedArray,
  seed: SeedMaterial,
  blocked: Uint8Array,
  maskW: number,
  maskH: number,
  sx: number,
  sy: number,
  maxDist: number,
): { x: number; y: number } | null {
  const ok = (x: number, y: number): boolean => {
    const i = y * maskW + x;
    return !blocked[i] && matchesSeed(data, i, seed);
  };
  if (ok(sx, sy)) return { x: sx, y: sy };
  for (let dist = 1; dist <= maxDist; dist++) {
    for (let dy = -dist; dy <= dist; dy++) {
      for (let dx = -dist; dx <= dist; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== dist) continue;
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= maskW || y >= maskH) continue;
        if (ok(x, y)) return { x, y };
      }
    }
  }
  return null;
}

/**
 * Contiguous flood through seed material, optionally skipping `blocked` cells.
 */
function floodContiguous(
  data: Uint8ClampedArray,
  seed: SeedMaterial,
  maskW: number,
  maskH: number,
  seedX: number,
  seedY: number,
  blocked?: Uint8Array,
): Uint8Array | null {
  const seedIndex = seedY * maskW + seedX;
  if (!matchesSeed(data, seedIndex, seed)) return null;
  if (blocked?.[seedIndex]) return null;

  const region = new Uint8Array(maskW * maskH);
  const stackX = [seedX];
  const stackY = [seedY];
  region[seedIndex] = 1;

  while (stackX.length > 0) {
    const x = stackX.pop()!;
    const y = stackY.pop()!;
    const neighbors = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= maskW || ny >= maskH) continue;
      const ni = ny * maskW + nx;
      if (region[ni] || !matchesSeed(data, ni, seed)) continue;
      if (blocked?.[ni]) continue;
      region[ni] = 1;
      stackX.push(nx);
      stackY.push(ny);
    }
  }
  return region;
}

/**
 * Chebyshev distance-to-boundary inside seed material (0 outside seed).
 * Multi-source BFS from non-seed / image border neighbors.
 */
function seedInteriorEdt(
  data: Uint8ClampedArray,
  seed: SeedMaterial,
  maskW: number,
  maskH: number,
): Uint16Array {
  const n = maskW * maskH;
  const edt = new Uint16Array(n);
  const queueX: number[] = [];
  const queueY: number[] = [];

  for (let y = 0; y < maskH; y++) {
    for (let x = 0; x < maskW; x++) {
      const i = y * maskW + x;
      if (!matchesSeed(data, i, seed)) continue;
      let border = x === 0 || y === 0 || x === maskW - 1 || y === maskH - 1;
      if (!border) {
        const nbrs = [
          i - 1,
          i + 1,
          i - maskW,
          i + maskW,
        ];
        for (const ni of nbrs) {
          if (!matchesSeed(data, ni, seed)) {
            border = true;
            break;
          }
        }
      }
      if (border) {
        edt[i] = 1;
        queueX.push(x);
        queueY.push(y);
      }
    }
  }

  let head = 0;
  while (head < queueX.length) {
    const x = queueX[head];
    const y = queueY[head];
    head++;
    const i = y * maskW + x;
    const d = edt[i];
    const next = d + 1;
    const nbrs = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ];
    for (const [nx, ny] of nbrs) {
      if (nx < 0 || ny < 0 || nx >= maskW || ny >= maskH) continue;
      const ni = ny * maskW + nx;
      if (!matchesSeed(data, ni, seed)) continue;
      if (edt[ni] !== 0 && edt[ni] <= next) continue;
      edt[ni] = next;
      queueX.push(nx);
      queueY.push(ny);
    }
  }
  return edt;
}

const RAY_DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

/**
 * True when a ray from (x,y) stays inside seed for at least `reach` steps.
 */
function rayStaysInSeed(
  data: Uint8ClampedArray,
  seed: SeedMaterial,
  maskW: number,
  maskH: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
  reach: number,
): boolean {
  for (let t = 1; t <= reach; t++) {
    const nx = x + dx * t;
    const ny = y + dy * t;
    if (nx < 0 || ny < 0 || nx >= maskW || ny >= maskH) return false;
    if (!matchesSeed(data, ny * maskW + nx, seed)) return false;
  }
  return true;
}

/**
 * Count angular branch clusters: consecutive hit-rays (circular) form one
 * branch. A straight/curved arm has 2; a T/X junction has ≥3. Counting raw
 * hit rays false-positives on thick curves (a fan of adjacent directions).
 */
function countRayBranches(
  data: Uint8ClampedArray,
  seed: SeedMaterial,
  maskW: number,
  maskH: number,
  x: number,
  y: number,
  reach: number,
): number {
  const hits = new Array<boolean>(RAY_DIRS.length);
  for (let i = 0; i < RAY_DIRS.length; i++) {
    const [dx, dy] = RAY_DIRS[i];
    hits[i] = rayStaysInSeed(data, seed, maskW, maskH, x, y, dx, dy, reach);
  }
  let branches = 0;
  for (let i = 0; i < hits.length; i++) {
    const prev = hits[(i + hits.length - 1) % hits.length];
    if (hits[i] && !prev) branches++;
  }
  return branches;
}

/**
 * Block junction cores so one stroke arm can be filled alone.
 *
 * Same-width crossings barely get fatter (≈√2), so EDT thresholds miss them.
 * Instead: on near-medial pixels, cast 8 rays and require ≥3 *angular
 * branches* (not raw hit count — thick curves fan adjacent rays).
 */
function buildJunctionBlockMask(
  data: Uint8ClampedArray,
  seed: SeedMaterial,
  maskW: number,
  maskH: number,
  seedX: number,
  seedY: number,
  gapMaskPx: number,
): Uint8Array {
  const edt = seedInteriorEdt(data, seed, maskW, maskH);
  const seedIndex = seedY * maskW + seedX;
  let armHalf = edt[seedIndex];

  const samples: number[] = [];
  const sampleR = Math.max(2, Math.min(16, (armHalf || 2) * 3));
  for (let dy = -sampleR; dy <= sampleR; dy++) {
    for (let dx = -sampleR; dx <= sampleR; dx++) {
      if (dx * dx + dy * dy > sampleR * sampleR) continue;
      const x = seedX + dx;
      const y = seedY + dy;
      if (x < 0 || y < 0 || x >= maskW || y >= maskH) continue;
      const i = y * maskW + x;
      if (!matchesSeed(data, i, seed) || edt[i] === 0) continue;
      samples.push(edt[i]);
    }
  }
  if (samples.length > 0) {
    samples.sort((a, b) => a - b);
    // Prefer upper quartile — closer to true half-width than the median of
    // a disk that includes many near-edge pixels.
    armHalf = samples[Math.min(samples.length - 1, (samples.length * 3) >> 2)];
  }
  armHalf = Math.max(JUNCTION_MIN_ARM_HALF, armHalf);

  const reach = Math.max(2, Math.round(armHalf * JUNCTION_RAY_FACTOR));
  // Near-medial band; looser when gap is larger so hubs on soft brushes still match.
  const medialMin = Math.max(
    1,
    Math.ceil(armHalf * 0.65) - Math.max(0, Math.floor(gapMaskPx / 8)),
  );

  const blocked = new Uint8Array(maskW * maskH);
  let junctionCount = 0;
  for (let y = 0; y < maskH; y++) {
    for (let x = 0; x < maskW; x++) {
      const i = y * maskW + x;
      if (edt[i] < medialMin) continue;
      if (!matchesSeed(data, i, seed)) continue;
      if (
        countRayBranches(data, seed, maskW, maskH, x, y, reach) >=
        JUNCTION_MIN_RAYS
      ) {
        blocked[i] = 1;
        junctionCount++;
      }
    }
  }

  if (junctionCount === 0) return blocked;

  // Seal the hub so a 1px medial bridge cannot leak between arms.
  const sealR = Math.max(1, Math.min(armHalf, 1 + Math.floor(gapMaskPx / 6)));
  return dilateBinary(blocked, maskW, maskH, sealR);
}

/**
 * Fill one colored arm: contiguous through seed, stopped at junction cores.
 */
function floodColoredArm(
  data: Uint8ClampedArray,
  seed: SeedMaterial,
  maskW: number,
  maskH: number,
  seedX: number,
  seedY: number,
  gapMaskPx: number,
): Uint8Array | null {
  const junctions = buildJunctionBlockMask(
    data,
    seed,
    maskW,
    maskH,
    seedX,
    seedY,
    gapMaskPx,
  );
  let sx = seedX;
  let sy = seedY;
  if (junctions[sy * maskW + sx]) {
    const alt = findNearestEnterable(
      data,
      seed,
      junctions,
      maskW,
      maskH,
      sx,
      sy,
      Math.max(8, gapMaskPx + 4),
    );
    if (!alt) return null; // clicked on a hub — ask user to click an arm
    sx = alt.x;
    sy = alt.y;
  }
  const arm = floodContiguous(data, seed, maskW, maskH, sx, sy, junctions);
  if (!arm || !regionHasPixels(arm)) return null;

  // If we somehow got the whole component (no effective cut), keep it — but
  // never fall back from a failed hub click to "fill everything", which hid
  // broken junction detection behind a full-network fill.
  return arm;
}

/**
 * Gas-pressure flood with gap-distance separation membranes.
 * `blocked` (optional) marks sealed wall pixels that gas cannot enter —
 * used to close AA pinholes without painting those pixels.
 */
function floodGasPressure(
  data: Uint8ClampedArray,
  seed: SeedMaterial,
  distance: Uint16Array,
  maskW: number,
  maskH: number,
  seedX: number,
  seedY: number,
  blocked?: Uint8Array,
): Uint8Array | null {
  const seedIndex = seedY * maskW + seedX;
  if (!matchesSeed(data, seedIndex, seed)) return null;
  if (blocked?.[seedIndex]) return null;

  const canEnter = (index: number): boolean => {
    if (blocked?.[index]) return false;
    return matchesSeed(data, index, seed);
  };

  const region = new Uint8Array(maskW * maskH);
  const heap = new GasHeap();
  const seedDist = distance[seedIndex];
  heap.push({
    x: seedX,
    y: seedY,
    distance: seedDist,
    allowExpand: true,
  });

  while (heap.size > 0) {
    const p = heap.pop()!;
    const i = p.y * maskW + p.x;
    if (region[i]) continue;
    if (!canEnter(i)) continue;

    const previousDistance = p.distance;
    const currentDistance = distance[i];
    const allowExpand =
      p.allowExpand && currentDistance >= previousDistance;
    if (!canStepGas(currentDistance, previousDistance, allowExpand)) continue;

    region[i] = 1;

    const nextAllow = allowExpand;
    const nextDist = currentDistance;
    const neighbors = [
      [p.x - 1, p.y],
      [p.x + 1, p.y],
      [p.x, p.y - 1],
      [p.x, p.y + 1],
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= maskW || ny >= maskH) continue;
      const ni = ny * maskW + nx;
      if (region[ni] || !canEnter(ni)) continue;
      heap.push({
        x: nx,
        y: ny,
        distance: nextDist,
        allowExpand: nextAllow,
      });
    }
  }

  return regionHasPixels(region) ? region : null;
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

function colorsEqualCss(a: string, b: string): boolean {
  const ca = new paper.Color(a);
  const cb = new paper.Color(b);
  return (
    Math.round(ca.red * 255) === Math.round(cb.red * 255) &&
    Math.round(ca.green * 255) === Math.round(cb.green * 255) &&
    Math.round(ca.blue * 255) === Math.round(cb.blue * 255)
  );
}

/**
 * Fill at a viewport (screen) point with the current color.
 * Returns true when the document changed (caller should snapshot history).
 */
export async function fillAt(
  deps: FillRegionDeps,
  viewportPoint: { x: number; y: number },
  color: string,
  options: FillOptions = {},
): Promise<boolean> {
  if (options.algorithm === "vector") {
    return fillPocketAt(deps, viewportPoint, color, options.gapPx ?? 0);
  }
  return fillGasAt(deps, viewportPoint, color, options);
}

/** Gas-pressure chamber fill (default algorithm). */
async function fillGasAt(
  deps: FillRegionDeps,
  viewportPoint: { x: number; y: number },
  color: string,
  options: FillOptions,
): Promise<boolean> {
  const config = deps.getConfig();
  const { maskW, maskH } = maskSize(config.viewportWidth, config.viewportHeight);
  const image = rasterizeActiveLayerRgba(
    deps.camera,
    config,
    maskW,
    maskH,
  );
  if (!image) return false;

  const seedX = Math.min(
    maskW - 1,
    Math.max(0, Math.floor((viewportPoint.x / config.viewportWidth) * maskW)),
  );
  const seedY = Math.min(
    maskH - 1,
    Math.max(0, Math.floor((viewportPoint.y / config.viewportHeight) * maskH)),
  );
  const seed = sampleSeed(image.data, seedY * maskW + seedX);

  // Same material as tool color → nothing to do for colored chambers.
  if (
    !seed.empty &&
    colorsEqualCss(
      `rgb(${seed.r},${seed.g},${seed.b})`,
      color,
    )
  ) {
    return false;
  }

  const gapPx = Math.max(0, Math.round(options.gapPx ?? 0));
  const gapMaskPx = Math.round(
    (gapPx * maskW) / Math.max(config.viewportWidth, 1),
  );

  let region: Uint8Array | null;
  if (gapMaskPx > 0 && seed.empty) {
    // Lineart pocket: gap-distance membranes stop spill through openings.
    const walls = buildWallMask(image.data, seed, maskW * maskH);
    const sealedWalls = dilateBinary(walls, maskW, maskH, WALL_SEAL_PX);
    const distance = buildGapDistanceMap(
      sealedWalls,
      maskW,
      maskH,
      gapMaskPx,
    );
    let sx = seedX;
    let sy = seedY;
    if (sealedWalls[sy * maskW + sx]) {
      const alt = findNearestEnterable(
        image.data,
        seed,
        sealedWalls,
        maskW,
        maskH,
        sx,
        sy,
        Math.max(2, WALL_SEAL_PX + 1),
      );
      if (!alt) return false;
      sx = alt.x;
      sy = alt.y;
    }
    region = floodGasPressure(
      image.data,
      seed,
      distance,
      maskW,
      maskH,
      sx,
      sy,
      sealedWalls,
    );
  } else if (gapMaskPx > 0 && !seed.empty) {
    // Colored stroke: split arms at fat crossing hubs (not gap-distance).
    region = floodColoredArm(
      image.data,
      seed,
      maskW,
      maskH,
      seedX,
      seedY,
      gapMaskPx,
    );
  } else {
    region = floodContiguous(
      image.data,
      seed,
      maskW,
      maskH,
      seedX,
      seedY,
    );
  }
  if (!region || !regionHasPixels(region)) return false;

  // Empty: tuck into strokes + paint-behind.
  // Colored: 1px outset then inside-boolean so the fill meets the shape edge
  // (raw flood+potrace otherwise leaves a ~1px inset).
  const commitRegion = seed.empty
    ? dilateBinary(region, maskW, maskH, STROKE_TUCK_PX)
    : dilateBinary(region, maskW, maskH, COLOR_OUTSET_PX);

  const canvas = regionToCanvas(commitRegion, maskW, maskH);
  const svg = await deps.tracer.trace(canvas);
  if (!svg) return false;

  if (!seed.empty) {
    const hit = deps.paperRenderer.hitTest(viewportPoint);
    const clip = deps.paperRenderer.hitToClipPathItem(hit);
    if (clip) {
      // Outset ∩ original shape; mergeAdd cuts the old seed color underneath.
      await deps.paperRenderer.addPathIntersectClip(svg, color, clip);
    } else {
      await deps.paperRenderer.subtractPath(svg);
      await deps.paperRenderer.addPath(svg, color);
    }
  } else {
    // Paint behind existing ink so tuck does not cover strokes.
    await deps.paperRenderer.addPathIntersectClip(svg, color, null);
  }
  return true;
}
