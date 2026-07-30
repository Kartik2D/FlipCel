/**
 * Staged item matching for Magic Morph (merge-aware hierarchy).
 *
 * 1. Build a containment tree per keyframe (outer contour contains child
 *    center — works for islands in holes where evenodd contains() is false)
 * 2. Match fill roots (no parent), preferring large same-color silhouettes
 * 3. From each matched root, build a shared frame and match its children
 *    (eyes / mouth / brows) in that frame
 * 4. Recurse: pupils / islands match only among children of a matched parent
 *
 * Scoring is centroid-first (travel), then blurred residual NCC in a local
 * patch (shape). Sketchy holes wash out under blur; big translations are
 * carried by the mass centroid, not by residual correlation.
 */
import paper from "paper";

const GRID = 128;
const MIN_PIXELS = 3;
const PATCH = 40;
const BLUR_SIGMA = 2;
/** Centroid+color gate before paying for blur/NCC. */
const CENTROID_GATE = 0.08;

export interface ItemMass {
  area: number;
  cx: number;
  cy: number;
  /** Pixel centroid in the layer grid (for patch crops). */
  cxPix: number;
  cyPix: number;
  bw: number;
  bh: number;
  minXPix: number;
  minYPix: number;
  maxXPix: number;
  maxYPix: number;
}

/** Cached raster sample for one item. */
interface MassSample {
  mass: ItemMass;
  mask: Uint8Array | null;
}

interface WorldFrame {
  minX: number;
  minY: number;
  cell: number;
  n: number;
}

function colorComponents(
  item: paper.PathItem,
): { r: number; g: number; b: number } | null {
  const c = (item.fillColor ?? item.strokeColor) as paper.Color | null;
  if (!c) return null;
  try {
    return { r: c.red, g: c.green, b: c.blue };
  } catch {
    return null;
  }
}

/** 1 = same color, ~0.3 = unrelated. */
function colorSimilarity(a: paper.PathItem, b: paper.PathItem): number {
  const ca = colorComponents(a);
  const cb = colorComponents(b);
  if (!ca && !cb) return 1;
  if (!ca || !cb) return 0.45;
  const d = Math.hypot(ca.r - cb.r, ca.g - cb.g, ca.b - cb.b);
  if (d < 0.04) return 1;
  if (d < 0.12) return 0.85;
  if (d < 0.28) return 0.55;
  return 0.3;
}

function layerFrame(items: paper.PathItem[]): WorldFrame | null {
  if (items.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const it of items) {
    const b = it.bounds;
    if (b.width < 1e-9 && b.height < 1e-9) continue;
    minX = Math.min(minX, b.left);
    minY = Math.min(minY, b.top);
    maxX = Math.max(maxX, b.right);
    maxY = Math.max(maxY, b.bottom);
  }
  if (!Number.isFinite(minX)) return null;
  const span = Math.max(maxX - minX, maxY - minY, 1e-3);
  const pad = span * 0.15 + 2;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  const w = maxX - minX;
  const h = maxY - minY;
  if (w > h) {
    const d = (w - h) / 2;
    minY -= d;
    maxY += d;
  } else if (h > w) {
    const d = (h - w) / 2;
    minX -= d;
    maxX += d;
  }
  const side = maxX - minX;
  return { minX, minY, cell: side / GRID, n: GRID };
}

function rasterItem(
  item: paper.PathItem,
  frame: WorldFrame,
): Uint8Array | null {
  let pathData: string;
  try {
    pathData = item.pathData;
  } catch {
    return null;
  }
  if (!pathData) return null;
  if (typeof document === "undefined") return null;

  const n = frame.n;
  const canvas = document.createElement("canvas");
  canvas.width = n;
  canvas.height = n;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  ctx.clearRect(0, 0, n, n);
  ctx.fillStyle = "#fff";
  ctx.setTransform(
    1 / frame.cell,
    0,
    0,
    1 / frame.cell,
    -frame.minX / frame.cell,
    -frame.minY / frame.cell,
  );
  try {
    ctx.fill(new Path2D(pathData), "evenodd");
  } catch {
    return null;
  }

  const img = ctx.getImageData(0, 0, n, n);
  const mask = new Uint8Array(n * n);
  let filled = 0;
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const on = img.data[p + 3] > 127 ? 1 : 0;
    mask[i] = on;
    filled += on;
  }
  if (filled < MIN_PIXELS) return null;
  return mask;
}

function extractMass(
  mask: Uint8Array,
  frame: WorldFrame,
): ItemMass | null {
  const n = frame.n;
  let area = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = n;
  let minY = n;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!mask[y * n + x]) continue;
      area++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (area < MIN_PIXELS) return null;

  const cxPix = sumX / area;
  const cyPix = sumY / area;

  return {
    area,
    cx: frame.minX + (cxPix + 0.5) * frame.cell,
    cy: frame.minY + (cyPix + 0.5) * frame.cell,
    cxPix,
    cyPix,
    bw: Math.max(1, maxX - minX + 1) * frame.cell,
    bh: Math.max(1, maxY - minY + 1) * frame.cell,
    minXPix: minX,
    minYPix: minY,
    maxXPix: maxX,
    maxYPix: maxY,
  };
}

function boundsMass(item: paper.PathItem, frame: WorldFrame): ItemMass {
  const b = item.bounds;
  const cell2 = frame.cell * frame.cell;
  const cxPix = (b.center.x - frame.minX) / frame.cell;
  const cyPix = (b.center.y - frame.minY) / frame.cell;
  const halfW = b.width / (2 * frame.cell);
  const halfH = b.height / (2 * frame.cell);
  return {
    area: Math.max(MIN_PIXELS, (b.width * b.height) / cell2),
    cx: b.center.x,
    cy: b.center.y,
    cxPix,
    cyPix,
    bw: Math.max(frame.cell, b.width),
    bh: Math.max(frame.cell, b.height),
    minXPix: Math.max(0, Math.floor(cxPix - halfW)),
    minYPix: Math.max(0, Math.floor(cyPix - halfH)),
    maxXPix: Math.min(frame.n - 1, Math.ceil(cxPix + halfW)),
    maxYPix: Math.min(frame.n - 1, Math.ceil(cyPix + halfH)),
  };
}

function sampleOf(item: paper.PathItem, frame: WorldFrame): MassSample {
  const mask = rasterItem(item, frame);
  if (!mask) return { mass: boundsMass(item, frame), mask: null };
  const mass = extractMass(mask, frame) ?? boundsMass(item, frame);
  return { mass, mask };
}

// ---------------------------------------------------------------------------
// Blurred residual NCC
// ---------------------------------------------------------------------------

function gaussianKernel(sigma: number): Float64Array {
  const radius = Math.max(1, Math.ceil(sigma * 2.5));
  const k = new Float64Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

function blurSeparable(
  src: Float64Array,
  w: number,
  h: number,
  sigma: number,
): Float64Array {
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) >> 1;
  const tmp = new Float64Array(w * h);
  const out = new Float64Array(w * h);

  // Horizontal
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i));
        acc += src[y * w + xx] * k[i + r];
      }
      tmp[y * w + x] = acc;
    }
  }
  // Vertical
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        acc += tmp[yy * w + x] * k[i + r];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

/**
 * Extract a PATCH×PATCH float patch centered on the mass centroid,
 * sampling the item mask (1 = ink). Missing mask → filled disk from bbox.
 */
function extractPatch(
  sample: MassSample,
  frame: WorldFrame,
): Float64Array {
  const patch = new Float64Array(PATCH * PATCH);
  const n = frame.n;
  const half = PATCH / 2;

  // Scale crop so the mass roughly fills ~70% of the patch.
  const massW = Math.max(4, sample.mass.maxXPix - sample.mass.minXPix + 1);
  const massH = Math.max(4, sample.mass.maxYPix - sample.mass.minYPix + 1);
  const span = Math.max(massW, massH) * 1.35;
  const scale = span / PATCH;

  const cx = sample.mass.cxPix;
  const cy = sample.mass.cyPix;
  const mask = sample.mask;

  for (let py = 0; py < PATCH; py++) {
    for (let px = 0; px < PATCH; px++) {
      const mx = cx + (px - half + 0.5) * scale;
      const my = cy + (py - half + 0.5) * scale;
      const ix = Math.round(mx);
      const iy = Math.round(my);
      let v = 0;
      if (mask && ix >= 0 && iy >= 0 && ix < n && iy < n) {
        v = mask[iy * n + ix];
      } else if (
        !mask &&
        ix >= sample.mass.minXPix &&
        ix <= sample.mass.maxXPix &&
        iy >= sample.mass.minYPix &&
        iy <= sample.mass.maxYPix
      ) {
        v = 1;
      }
      patch[py * PATCH + px] = v;
    }
  }
  return patch;
}

/** Zero-mean NCC mapped to [0, 1]. */
function ncc01(a: Float64Array, b: Float64Array): number {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;

  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  if (den < 1e-12) return 0.5; // empty/empty → neutral
  const ncc = num / den; // [-1, 1]
  return Math.max(0, Math.min(1, 0.5 + 0.5 * ncc));
}

function blurredResidualNcc(
  a: MassSample,
  b: MassSample,
  frame: WorldFrame,
): number {
  const pa = blurSeparable(extractPatch(a, frame), PATCH, PATCH, BLUR_SIGMA);
  const pb = blurSeparable(extractPatch(b, frame), PATCH, PATCH, BLUR_SIGMA);
  return ncc01(pa, pb);
}

// ---------------------------------------------------------------------------
// Containment tree (merge-aware: outer contour, not evenodd compound)
// ---------------------------------------------------------------------------

function itemArea(item: paper.PathItem): number {
  try {
    if (item instanceof paper.Path) return Math.abs(item.area);
    if (item instanceof paper.CompoundPath) {
      let sum = 0;
      for (const c of item.children) {
        if (c instanceof paper.Path) sum += Math.abs(c.area);
      }
      if (sum > 0) return sum;
    }
  } catch {
    // fall through
  }
  return Math.max(1, item.bounds.width * item.bounds.height);
}

/** Fill-root outer: the path itself, or the largest child of a compound. */
function itemOuter(item: paper.PathItem): paper.Path | null {
  if (item instanceof paper.Path) return item;
  if (item instanceof paper.CompoundPath) {
    let best: paper.Path | null = null;
    let bestA = -1;
    for (const c of item.children) {
      if (!(c instanceof paper.Path)) continue;
      const ar = Math.abs(c.area);
      if (ar > bestA) {
        bestA = ar;
        best = c;
      }
    }
    return best;
  }
  return null;
}

function itemAnchor(item: paper.PathItem): paper.Point {
  const outer = itemOuter(item);
  if (outer) {
    try {
      const ip = (
        outer as { getInteriorPoint?: () => paper.Point | null }
      ).getInteriorPoint?.();
      if (ip) return ip;
    } catch {
      // fall through
    }
  }
  return item.bounds.center;
}

/**
 * Tightest larger item whose *outer contour* contains `item`'s anchor.
 * Uses the outer path (not evenodd compound contains) so islands sitting
 * in holes still parent to the surrounding fill root — matching merge.
 */
function buildParents(items: paper.PathItem[]): Array<number | null> {
  const n = items.length;
  const areas = items.map(itemArea);
  const anchors = items.map(itemAnchor);
  const outers = items.map(itemOuter);
  const parents: Array<number | null> = new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    let best: number | null = null;
    let bestArea = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j || areas[j] <= areas[i]) continue;
      const outer = outers[j];
      if (!outer) continue;
      if (!outer.bounds.contains(anchors[i])) continue;
      try {
        if (!outer.contains(anchors[i])) continue;
      } catch {
        continue;
      }
      if (areas[j] < bestArea) {
        bestArea = areas[j];
        best = j;
      }
    }
    parents[i] = best;
  }
  return parents;
}

function childrenOf(
  parent: number | null,
  parents: Array<number | null>,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < parents.length; i++) {
    if (parents[i] === parent) out.push(i);
  }
  return out;
}

/** Local frame for normalizing child matches under a parent pair. */
interface NormFrame {
  c: paper.Point;
  s: number;
}

function normFrameOf(item: paper.PathItem): NormFrame {
  const b = item.bounds;
  return {
    c: b.center,
    s: Math.max(1e-6, Math.hypot(b.width, b.height) / 2),
  };
}

function toNorm(x: number, y: number, f: NormFrame): { x: number; y: number } {
  return { x: (x - f.c.x) / f.s, y: (y - f.c.y) / f.s };
}

// ---------------------------------------------------------------------------
// Pairing within a cohort
// ---------------------------------------------------------------------------

type Cand = { ai: number; bi: number; score: number };

/**
 * Centroid-first score, then blurred residual NCC.
 * Travel lives in the centroid term; shape in the residual.
 */
function scorePair(
  a: paper.PathItem,
  b: paper.PathItem,
  aSample: MassSample | null,
  bSample: MassSample | null,
  frame: WorldFrame | null,
  frameSpan: number,
  normA: NormFrame | null,
  normB: NormFrame | null,
): number {
  const col = colorSimilarity(a, b);
  if (col < 0.28) return 0;

  const aMass = aSample?.mass;
  const bMass = bSample?.mass;
  const aArea = aMass
    ? aMass.area
    : Math.max(1, a.bounds.width * a.bounds.height);
  const bArea = bMass
    ? bMass.area
    : Math.max(1, b.bounds.width * b.bounds.height);
  const areaRatio = Math.min(aArea, bArea) / Math.max(aArea, bArea);

  const ax = aMass?.cx ?? a.bounds.center.x;
  const ay = aMass?.cy ?? a.bounds.center.y;
  const bx = bMass?.cx ?? b.bounds.center.x;
  const by = bMass?.cy ?? b.bounds.center.y;

  let prox: number;
  if (normA && normB) {
    const ac = toNorm(ax, ay, normA);
    const bc = toNorm(bx, by, normB);
    const dist = Math.hypot(ac.x - bc.x, ac.y - bc.y);
    prox = 1 / (1 + dist);
  } else {
    const dist = Math.hypot(ax - bx, ay - by);
    // Soft falloff vs layer span so cross-screen travel still scores well.
    prox = 1 / (1 + dist / Math.max(frameSpan * 0.35, 1e-6));
  }

  // Centroid-heavy geometric term.
  const centroidScore = col * (areaRatio * 0.3 + prox * 0.7);
  if (centroidScore < CENTROID_GATE) return 0;

  // Blurred residual only after the cheap gate; needs a shared raster frame.
  let residual = 0.5;
  if (frame && aSample && bSample) {
    residual = blurredResidualNcc(aSample, bSample, frame);
  }

  return centroidScore * (0.45 + 0.55 * residual);
}

function pairCohort(
  aIdx: number[],
  bIdx: number[],
  aItems: paper.PathItem[],
  bItems: paper.PathItem[],
  aSamples: Array<MassSample | null>,
  bSamples: Array<MassSample | null>,
  frame: WorldFrame | null,
  frameSpan: number,
  normA: NormFrame | null,
  normB: NormFrame | null,
  usedA: Set<number>,
  usedB: Set<number>,
  minMutual: number,
  minGreedy: number,
): Array<{ ai: number; bi: number }> {
  const freeA = aIdx.filter((i) => !usedA.has(i));
  const freeB = bIdx.filter((i) => !usedB.has(i));
  if (freeA.length === 0 || freeB.length === 0) return [];

  // Prefer larger items first when building candidates (stable root bias).
  freeA.sort((i, j) => itemArea(aItems[j]) - itemArea(aItems[i]));
  freeB.sort((i, j) => itemArea(bItems[j]) - itemArea(bItems[i]));

  const cands: Cand[] = [];
  for (const ai of freeA) {
    for (const bi of freeB) {
      const s = scorePair(
        aItems[ai],
        bItems[bi],
        aSamples[ai],
        bSamples[bi],
        frame,
        frameSpan,
        normA,
        normB,
      );
      if (s < minGreedy * 0.5) continue;
      cands.push({ ai, bi, score: s });
    }
  }
  cands.sort((x, y) => y.score - x.score);

  const bestB = new Map<number, { bi: number; score: number }>();
  const bestA = new Map<number, { ai: number; score: number }>();
  for (const c of cands) {
    const bb = bestB.get(c.ai);
    if (!bb || c.score > bb.score) bestB.set(c.ai, { bi: c.bi, score: c.score });
    const ba = bestA.get(c.bi);
    if (!ba || c.score > ba.score) bestA.set(c.bi, { ai: c.ai, score: c.score });
  }

  const out: Array<{ ai: number; bi: number }> = [];
  for (const ai of freeA) {
    const bb = bestB.get(ai);
    if (!bb || bb.score < minMutual) continue;
    const ba = bestA.get(bb.bi);
    if (!ba || ba.ai !== ai) continue;
    if (usedA.has(ai) || usedB.has(bb.bi)) continue;
    usedA.add(ai);
    usedB.add(bb.bi);
    out.push({ ai, bi: bb.bi });
  }

  for (const c of cands) {
    if (c.score < minGreedy) break;
    if (usedA.has(c.ai) || usedB.has(c.bi)) continue;
    usedA.add(c.ai);
    usedB.add(c.bi);
    out.push({ ai: c.ai, bi: c.bi });
  }
  return out;
}

/**
 * Staged hierarchical match. Roots first, then children in each matched
 * parent's frame, recursively (islands under eyes, etc.).
 */
export function matchItemsWithMass(
  aItems: paper.PathItem[],
  bItems: paper.PathItem[],
): Array<{ a: paper.PathItem; b: paper.PathItem }> {
  if (aItems.length === 0 || bItems.length === 0) return [];

  const rasterFrame = layerFrame([...aItems, ...bItems]);
  const frameSpan = rasterFrame ? rasterFrame.cell * rasterFrame.n : 1;
  const aSamples: Array<MassSample | null> = rasterFrame
    ? aItems.map((it) => sampleOf(it, rasterFrame))
    : aItems.map(() => null);
  const bSamples: Array<MassSample | null> = rasterFrame
    ? bItems.map((it) => sampleOf(it, rasterFrame))
    : bItems.map(() => null);

  const aParents = buildParents(aItems);
  const bParents = buildParents(bItems);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const pairs: Array<{ a: paper.PathItem; b: paper.PathItem }> = [];

  const commit = (matched: Array<{ ai: number; bi: number }>) => {
    for (const { ai, bi } of matched) {
      pairs.push({ a: aItems[ai], b: bItems[bi] });
    }
  };

  // Recursively match a cohort, then match each pair's children in a
  // shared parent frame.
  const matchStage = (
    aCohort: number[],
    bCohort: number[],
    normA: NormFrame | null,
    normB: NormFrame | null,
    minMutual: number,
    minGreedy: number,
  ) => {
    const matched = pairCohort(
      aCohort,
      bCohort,
      aItems,
      bItems,
      aSamples,
      bSamples,
      rasterFrame,
      frameSpan,
      normA,
      normB,
      usedA,
      usedB,
      minMutual,
      minGreedy,
    );
    commit(matched);

    for (const { ai, bi } of matched) {
      const kidsA = childrenOf(ai, aParents);
      const kidsB = childrenOf(bi, bParents);
      if (kidsA.length === 0 && kidsB.length === 0) continue;
      const fA = normFrameOf(aItems[ai]);
      const fB = normFrameOf(bItems[bi]);
      // Children (eyes/mouth) and islands use the parent-local frame.
      matchStage(kidsA, kidsB, fA, fB, 0.12, 0.1);
    }
  };

  // Stage 1: fill roots (no containment parent) — large silhouettes.
  const rootsA = childrenOf(null, aParents);
  const rootsB = childrenOf(null, bParents);
  matchStage(rootsA, rootsB, null, null, 0.14, 0.12);

  // Orphans: parent existed but wasn't matched (or tree disagreed).
  // Match them flat in world space so they still morph when obvious.
  const orphanA: number[] = [];
  const orphanB: number[] = [];
  for (let i = 0; i < aItems.length; i++) {
    if (!usedA.has(i)) orphanA.push(i);
  }
  for (let i = 0; i < bItems.length; i++) {
    if (!usedB.has(i)) orphanB.push(i);
  }
  if (orphanA.length && orphanB.length) {
    const matched = pairCohort(
      orphanA,
      orphanB,
      aItems,
      bItems,
      aSamples,
      bSamples,
      rasterFrame,
      frameSpan,
      null,
      null,
      usedA,
      usedB,
      0.16,
      0.14,
    );
    commit(matched);
  }

  return pairs;
}
