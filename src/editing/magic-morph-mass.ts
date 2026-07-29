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
 * Scoring is vector proximity/area with a soft raster mass factor.
 */
import paper from "paper";

const GRID = 128;
const MIN_PIXELS = 3;

export interface ItemMass {
  area: number;
  cx: number;
  cy: number;
  bw: number;
  bh: number;
  hu1: number;
  hu2: number;
  holes: number;
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

function countHoles(mask: Uint8Array, n: number): number {
  const seen = new Uint8Array(n * n);
  const qx = new Int32Array(n * n);
  const qy = new Int32Array(n * n);

  const flood = (sx: number, sy: number): boolean => {
    let head = 0;
    let tail = 0;
    let touches = false;
    qx[tail] = sx;
    qy[tail] = sy;
    tail++;
    seen[sy * n + sx] = 1;
    while (head < tail) {
      const x = qx[head];
      const y = qy[head];
      head++;
      if (x === 0 || y === 0 || x === n - 1 || y === n - 1) touches = true;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const i = ny * n + nx;
        if (seen[i] || mask[i]) continue;
        seen[i] = 1;
        qx[tail] = nx;
        qy[tail] = ny;
        tail++;
      }
    }
    return touches;
  };

  for (let x = 0; x < n; x++) {
    if (!mask[x] && !seen[x]) flood(x, 0);
    const bi = (n - 1) * n + x;
    if (!mask[bi] && !seen[bi]) flood(x, n - 1);
  }
  for (let y = 0; y < n; y++) {
    if (!mask[y * n] && !seen[y * n]) flood(0, y);
    const ri = y * n + n - 1;
    if (!mask[ri] && !seen[ri]) flood(n - 1, y);
  }

  let holes = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (mask[i] || seen[i]) continue;
      if (!flood(x, y)) holes++;
    }
  }
  return holes;
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
  let mu20 = 0;
  let mu02 = 0;
  let mu11 = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!mask[y * n + x]) continue;
      const dx = x - cxPix;
      const dy = y - cyPix;
      mu20 += dx * dx;
      mu02 += dy * dy;
      mu11 += dx * dy;
    }
  }
  const a2 = area * area;
  const n20 = mu20 / a2;
  const n02 = mu02 / a2;
  const n11 = mu11 / a2;

  return {
    area,
    cx: frame.minX + (cxPix + 0.5) * frame.cell,
    cy: frame.minY + (cyPix + 0.5) * frame.cell,
    bw: Math.max(1, maxX - minX + 1) * frame.cell,
    bh: Math.max(1, maxY - minY + 1) * frame.cell,
    hu1: n20 + n02,
    hu2: (n20 - n02) * (n20 - n02) + 4 * n11 * n11,
    holes: countHoles(mask, n),
  };
}

function boundsMass(item: paper.PathItem, frame: WorldFrame): ItemMass {
  const b = item.bounds;
  const cell2 = frame.cell * frame.cell;
  return {
    area: Math.max(MIN_PIXELS, (b.width * b.height) / cell2),
    cx: b.center.x,
    cy: b.center.y,
    bw: Math.max(frame.cell, b.width),
    bh: Math.max(frame.cell, b.height),
    hu1: 0,
    hu2: 0,
    holes: 0,
  };
}

function massOf(item: paper.PathItem, frame: WorldFrame): ItemMass {
  const mask = rasterItem(item, frame);
  if (!mask) return boundsMass(item, frame);
  return extractMass(mask, frame) ?? boundsMass(item, frame);
}

/** Raster agreement in [0, 1] — soft, never used alone. */
function massAgreement(
  a: ItemMass,
  b: ItemMass,
  frameSpan: number,
): number {
  const areaRatio =
    Math.min(a.area, b.area) / Math.max(a.area, b.area);
  const dist =
    Math.hypot(a.cx - b.cx, a.cy - b.cy) / Math.max(frameSpan, 1e-6);
  const prox = 1 / (1 + dist * 1.6);

  const aspA = a.bw / Math.max(a.bh, 1e-6);
  const aspB = b.bw / Math.max(b.bh, 1e-6);
  const aspRatio =
    Math.min(aspA, aspB) / Math.max(aspA, aspB);

  let shape = aspRatio;
  if (a.hu1 > 1e-6 && b.hu1 > 1e-6) {
    const hu1Sim =
      1 -
      Math.min(1, Math.abs(a.hu1 - b.hu1) / Math.max(a.hu1, b.hu1, 1e-9));
    const hu2Sim =
      1 -
      Math.min(1, Math.abs(a.hu2 - b.hu2) / Math.max(a.hu2, b.hu2, 1e-9));
    shape = hu1Sim * 0.35 + hu2Sim * 0.15 + aspRatio * 0.5;
  }

  let holeMul = 1;
  if (a.holes !== b.holes && Math.min(a.area, b.area) >= 40) {
    holeMul = a.holes === 0 || b.holes === 0 ? 0.7 : 0.85;
  }

  return holeMul * (areaRatio * 0.35 + prox * 0.45 + shape * 0.2);
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

function toNorm(p: paper.Point, f: NormFrame): paper.Point {
  return p.subtract(f.c).divide(f.s);
}

// ---------------------------------------------------------------------------
// Pairing within a cohort
// ---------------------------------------------------------------------------

type Cand = { ai: number; bi: number; score: number };

function scorePair(
  a: paper.PathItem,
  b: paper.PathItem,
  aMass: ItemMass | null,
  bMass: ItemMass | null,
  frameSpan: number,
  normA: NormFrame | null,
  normB: NormFrame | null,
): number {
  const col = colorSimilarity(a, b);
  if (col < 0.28) return 0;

  const aArea = Math.max(1, a.bounds.width * a.bounds.height);
  const bArea = Math.max(1, b.bounds.width * b.bounds.height);
  const areaRatio = Math.min(aArea, bArea) / Math.max(aArea, bArea);

  let prox: number;
  if (normA && normB) {
    const ac = toNorm(a.bounds.center, normA);
    const bc = toNorm(b.bounds.center, normB);
    const dist = ac.getDistance(bc);
    prox = 1 / (1 + dist);
  } else {
    const dist = a.bounds.center.getDistance(b.bounds.center);
    const size = Math.sqrt(Math.max(aArea, bArea));
    prox = 1 / (1 + dist / Math.max(size, 1e-6));
  }

  let vector = areaRatio * 0.35 + prox * 0.65;
  if (aMass && bMass) {
    vector *= 0.55 + 0.45 * massAgreement(aMass, bMass, frameSpan);
  }
  return col * vector;
}

function pairCohort(
  aIdx: number[],
  bIdx: number[],
  aItems: paper.PathItem[],
  bItems: paper.PathItem[],
  aMass: Array<ItemMass | null>,
  bMass: Array<ItemMass | null>,
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
        aMass[ai],
        bMass[bi],
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
  const aMass: Array<ItemMass | null> = rasterFrame
    ? aItems.map((it) => massOf(it, rasterFrame))
    : aItems.map(() => null);
  const bMass: Array<ItemMass | null> = rasterFrame
    ? bItems.map((it) => massOf(it, rasterFrame))
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
      aMass,
      bMass,
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
      aMass,
      bMass,
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
