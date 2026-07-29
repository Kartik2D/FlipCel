/**
 * Magic Morph blend — keep this small.
 *
 * 1. Match top-level Path / CompoundPath items (color + centroid)
 * 2. Factor out a shared per-item frame (centroid + size); everything below
 *    happens on the residual inside that frame, so fast moves don't shear
 *    contours apart
 * 3. Match contours in frame space (area + centroid), preferring same
 *    fill/hole role (evenodd parity). Merge-normalized items only keep one
 *    fill root + its holes in a compound — islands are separate layer items.
 * 4. Sample each matched pair at even arc length, align cyclically
 *    (phase-anchored so band edges share one phase), then pin matched
 *    corner features with soft falloff and lerp the residual
 * 5. Topology changes: unmatched holes collapse in place about an interior
 *    point; births grow from a speck seeded on the matched fill of A
 * 6. CompoundPath uses evenodd; fill only on the parent
 */
import paper from "paper";
import { getContainmentPoint } from "../render/paper/path-geometry";
import { morphItemSdf } from "./magic-morph-sdf";

const SAMPLE_MIN = 16;
const SAMPLE_MAX = 64;
const TANGENT_WEIGHT = 4;

/** User-tunable morph knobs (wired to the Magic Morph tool settings). */
export interface MorphOptions {
  /** Sample density multiplier for generated vertices (1–3, default 1). */
  density: number;
  /** Corner pinning strength: 0 = uniform correspondence, 1 = full pin. */
  stickiness: number;
  /** Paper `Path.simplify` tolerance; 0 = off. */
  simplify: number;
  /** Blend backend: vector contour morph, or SDF level-set morph. */
  solver: "vector" | "sdf";
}

export const DEFAULT_MORPH_OPTIONS: MorphOptions = {
  density: 1,
  stickiness: 0,
  simplify: 0,
  solver: "vector",
};

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

function colorKey(item: paper.PathItem): string {
  const c = (item.fillColor ?? item.strokeColor) as paper.Color | null;
  if (!c) return "none";
  try {
    return c.toCSS(true);
  } catch {
    return "none";
  }
}

function mixColor(
  a: paper.Color | null | undefined,
  b: paper.Color | null | undefined,
  t: number,
): paper.Color | null {
  if (!a && !b) return null;
  if (!a) return b!.clone();
  if (!b) return a.clone();
  const out = a.clone();
  out.red = a.red + (b.red - a.red) * t;
  out.green = a.green + (b.green - a.green) * t;
  out.blue = a.blue + (b.blue - a.blue) * t;
  out.alpha = a.alpha + (b.alpha - a.alpha) * t;
  return out;
}

function applyItemStyle(
  dest: paper.PathItem,
  a: paper.PathItem,
  b: paper.PathItem,
  t: number,
): void {
  dest.fillColor = mixColor(
    a.fillColor as paper.Color | null,
    b.fillColor as paper.Color | null,
    t,
  );
  dest.strokeColor = mixColor(
    a.strokeColor as paper.Color | null,
    b.strokeColor as paper.Color | null,
    t,
  );
  dest.strokeWidth =
    (a.strokeWidth ?? 0) + ((b.strokeWidth ?? 0) - (a.strokeWidth ?? 0)) * t;
}

function clearContourStyle(path: paper.Path): void {
  path.fillColor = null;
  path.strokeColor = null;
  path.strokeWidth = 0;
}

// ---------------------------------------------------------------------------
// Contours + matching
// ---------------------------------------------------------------------------

function pathArea(path: paper.Path): number {
  try {
    return Math.abs(path.area);
  } catch {
    return Math.abs(path.bounds.width * path.bounds.height);
  }
}

/** Flat list of path contours, largest first. */
function contoursOf(item: paper.PathItem): paper.Path[] {
  let paths: paper.Path[] = [];
  if (item instanceof paper.Path) {
    paths = [item];
  } else if (item instanceof paper.CompoundPath) {
    paths = item.children.filter(
      (c): c is paper.Path => c instanceof paper.Path,
    );
  }
  return [...paths].sort((a, b) => pathArea(b) - pathArea(a));
}

function topItems(layer: paper.Layer): paper.PathItem[] {
  const out: paper.PathItem[] = [];
  for (const child of layer.children) {
    if (child instanceof paper.Path || child instanceof paper.CompoundPath) {
      out.push(child);
    }
  }
  return out;
}

function greedyMatch(
  scores: Array<{ ai: number; bi: number; score: number }>,
  aLen: number,
  bLen: number,
  minScore = 0,
): Array<{ ai: number; bi: number }> {
  scores.sort((x, y) => y.score - x.score);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const pairs: Array<{ ai: number; bi: number }> = [];
  for (const c of scores) {
    if (c.score < minScore) break;
    if (usedA.has(c.ai) || usedB.has(c.bi)) continue;
    usedA.add(c.ai);
    usedB.add(c.bi);
    pairs.push({ ai: c.ai, bi: c.bi });
    if (pairs.length >= Math.min(aLen, bLen)) break;
  }
  return pairs;
}

function matchItems(
  aItems: paper.PathItem[],
  bItems: paper.PathItem[],
): Array<{ a: paper.PathItem; b: paper.PathItem }> {
  const scores: Array<{ ai: number; bi: number; score: number }> = [];
  for (let ai = 0; ai < aItems.length; ai++) {
    const a = aItems[ai];
    const ac = a.bounds.center;
    const aKey = colorKey(a);
    const aArea = Math.max(1, a.bounds.width * a.bounds.height);
    for (let bi = 0; bi < bItems.length; bi++) {
      const b = bItems[bi];
      const bc = b.bounds.center;
      const bArea = Math.max(1, b.bounds.width * b.bounds.height);
      const dist = ac.getDistance(bc);
      const size = Math.sqrt(Math.max(aArea, bArea));
      const areaRatio = Math.min(aArea, bArea) / Math.max(aArea, bArea);
      const colorBoost = aKey === colorKey(b) ? 1 : 0.55;
      scores.push({
        ai,
        bi,
        score:
          colorBoost *
          (areaRatio * 0.35 + (1 / (1 + dist / size)) * 0.65),
      });
    }
  }
  return greedyMatch(scores, aItems.length, bItems.length, 0.12).map(
    ({ ai, bi }) => ({ a: aItems[ai], b: bItems[bi] }),
  );
}

/**
 * Match contours inside each keyframe's item frame (translation/scale
 * removed) so a moving shape can't pair its holes by absolute position —
 * e.g. the regions above/below a teeth line stay with their counterparts.
 * Same fill/hole role (evenodd parity) is heavily preferred — matches the
 * merge system's outer+holes compound layout.
 */
function matchContours(
  aPaths: paper.Path[],
  bPaths: paper.Path[],
  fA: Frame,
  fB: Frame,
  aDepth: number[],
  bDepth: number[],
): Array<{ a: paper.Path; b: paper.Path }> {
  const scores: Array<{ ai: number; bi: number; score: number }> = [];
  for (let ai = 0; ai < aPaths.length; ai++) {
    const ac = aPaths[ai].bounds.center.subtract(fA.c).divide(fA.s);
    const aArea = Math.max(1e-6, pathArea(aPaths[ai]) / (fA.s * fA.s));
    for (let bi = 0; bi < bPaths.length; bi++) {
      const bc = bPaths[bi].bounds.center.subtract(fB.c).divide(fB.s);
      const bArea = Math.max(1e-6, pathArea(bPaths[bi]) / (fB.s * fB.s));
      const dist = ac.getDistance(bc);
      const areaRatio = Math.min(aArea, bArea) / Math.max(aArea, bArea);
      const base = areaRatio * 0.4 + (1 / (1 + dist)) * 0.6;
      // Parity (fill vs hole), not exact depth: merge splits islands into
      // separate items, so within one compound depth is usually 0 or 1.
      const roleBoost =
        aDepth[ai] % 2 === bDepth[bi] % 2 ? 1 : 0.08;
      scores.push({
        ai,
        bi,
        score: base * roleBoost,
      });
    }
  }
  return greedyMatch(scores, aPaths.length, bPaths.length).map(
    ({ ai, bi }) => ({ a: aPaths[ai], b: bPaths[bi] }),
  );
}

// ---------------------------------------------------------------------------
// Sample + align + lerp
// ---------------------------------------------------------------------------

interface Sample {
  point: paper.Point;
  tangent: paper.Point;
  /** Corner strength in [0, 1]: 0 = straight/smooth, 1 = sharp corner. */
  saliency: number;
}

function sampleArc(path: paper.Path, count: number): Sample[] {
  const n = Math.max(2, count);
  const len = Math.max(path.length, 1e-9);
  const samples: Sample[] = [];
  for (let i = 0; i < n; i++) {
    const u = path.closed ? i / n : i / (n - 1);
    const offset = Math.min(len * (1 - 1e-9), u * len);
    const point = path.getPointAt(offset);
    const tangent = path.getTangentAt(offset);
    const tl = Math.hypot(tangent.x, tangent.y) || 1;
    samples.push({
      point: point.clone(),
      tangent: new paper.Point(tangent.x / tl, tangent.y / tl),
      saliency: 0,
    });
  }
  if (n >= 8) computeSaliency(samples, !!path.closed);
  return samples;
}

/**
 * Turning-angle saliency over a +-w window. Uses tangent dot products so
 * hand-drawn jitter within the window is averaged out. Mutates samples.
 *
 * The window scales with the sample count so saliency measures turning over
 * a fixed *fraction of the contour*, not a fixed number of samples —
 * otherwise changing the sampling density changes every saliency value and
 * corner detection becomes density-dependent.
 */
function computeSaliency(samples: Sample[], closed: boolean): void {
  const n = samples.length;
  const w = Math.max(2, Math.round(n / 32));
  for (let i = 0; i < n; i++) {
    if (!closed && (i < w || i >= n - w)) continue;
    const ta = samples[(i - w + n) % n].tangent;
    const tb = samples[(i + w) % n].tangent;
    const dot = Math.max(-1, Math.min(1, ta.x * tb.x + ta.y * tb.y));
    // angle 0 -> 0; angle >= ~100deg -> 1
    samples[i].saliency = Math.min(1, Math.acos(dot) / (Math.PI * 0.55));
  }
}

interface Feature {
  index: number; // sample index
  strength: number; // saliency at that sample
}

/**
 * Local maxima of saliency above threshold, with non-max suppression so a
 * rough stroke yields one corner, not five. Returns at most 8 features,
 * sorted by index (cyclic order).
 */
function detectFeatures(samples: Sample[], closed: boolean): Feature[] {
  const n = samples.length;
  const THRESH = 0.35;
  const cands: Feature[] = [];
  for (let i = 0; i < n; i++) {
    const s = samples[i].saliency;
    if (s < THRESH) continue;
    const prev = samples[(i - 1 + n) % n].saliency;
    const next = samples[(i + 1) % n].saliency;
    if (!closed && (i === 0 || i === n - 1)) continue;
    if (s >= prev && s > next) cands.push({ index: i, strength: s });
  }
  // Non-max suppression: keep strongest, drop anything within n/16 samples.
  cands.sort((a, b) => b.strength - a.strength);
  const minGap = Math.max(2, Math.round(n / 16));
  const kept: Feature[] = [];
  for (const c of cands) {
    const clash = kept.some((k) => {
      const d = Math.abs(k.index - c.index);
      return Math.min(d, n - d) < minGap;
    });
    if (!clash) kept.push(c);
    if (kept.length >= 8) break;
  }
  return kept.sort((a, b) => a.index - b.index);
}

interface FeaturePair {
  ai: number; // index into A samples
  bi: number; // index into B samples (post-alignment ring)
  confidence: number; // min of the two strengths, scaled by proximity
}

/**
 * Greedy mutual-best matching of corner features, order legality enforced.
 * Cost combines normalized-space distance and index (phase) distance.
 * Features that do not find a confident partner are dropped (span falls
 * back to uniform correspondence).
 */
function matchFeatures(
  fa: Feature[],
  fb: Feature[],
  na: Sample[],
  nb: Sample[],
): FeaturePair[] {
  const n = na.length;
  const cands: Array<FeaturePair & { cost: number }> = [];
  for (const a of fa) {
    for (const b of fb) {
      const pd = na[a.index].point.getDistance(nb[b.index].point);
      const di = Math.abs(a.index - b.index);
      const id = Math.min(di, n - di) / n; // cyclic index distance in [0, 0.5]
      if (pd > 0.6 || id > 0.15) continue; // too far apart to be the same corner
      const cost = pd + id * 2;
      cands.push({
        ai: a.index,
        bi: b.index,
        confidence: Math.min(a.strength, b.strength) * (1 - id / 0.15),
        cost,
      });
    }
  }
  cands.sort((x, y) => x.cost - y.cost);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const pairs: FeaturePair[] = [];
  for (const c of cands) {
    if (usedA.has(c.ai) || usedB.has(c.bi)) continue;
    usedA.add(c.ai);
    usedB.add(c.bi);
    pairs.push({ ai: c.ai, bi: c.bi, confidence: c.confidence });
  }
  pairs.sort((x, y) => x.ai - y.ai);
  // Enforce cyclic order legality: bi must also be (cyclically) increasing.
  const legal: FeaturePair[] = [];
  for (const p of pairs) {
    if (legal.length === 0) {
      legal.push(p);
      continue;
    }
    const prev = legal[legal.length - 1];
    const fwd = (p.bi - prev.bi + n) % n;
    if (fwd > 0 && fwd < n / 2) legal.push(p);
  }
  return legal;
}

/**
 * Per-sample fractional index offsets from matched corner features.
 * offset[i] = how far (in samples) the B index for A sample i shifts away
 * from the uniform mapping. Shepard-style blend with cyclic distance decay:
 * a strong corner pins hard nearby, quiet spans decay to uniform (0).
 */
function featureOffsets(pairs: FeaturePair[], n: number): Float64Array {
  const out = new Float64Array(n); // zeros = uniform
  if (pairs.length === 0) return out;
  const falloff = n / 8; // samples over which pinning fades
  for (let i = 0; i < n; i++) {
    let sw = 1e-3; // bias toward 0 so far-away samples stay uniform
    let sv = 0;
    for (const p of pairs) {
      let delta = ((p.bi - p.ai) % n + n) % n;
      if (delta > n / 2) delta -= n; // shortest signed offset
      const di = Math.abs(i - p.ai);
      const d = Math.min(di, n - di);
      const w = p.confidence * Math.exp(-(d * d) / (2 * falloff * falloff));
      sw += w;
      sv += w * delta;
    }
    out[i] = sv / sw;
  }
  // Keep the warped mapping monotonic so the contour can't self-intersect.
  for (let i = 1; i < n; i++) {
    const minOff = out[i - 1] - 0.9; // (i + out[i]) - ((i-1) + out[i-1]) >= 0.1
    if (out[i] < minOff) out[i] = minOff;
  }
  return out;
}

function alignCost(
  a: Sample[],
  b: Sample[],
  start: number,
  reverse: boolean,
): number {
  const n = a.length;
  let sumPt = 0;
  let sumTan = 0;
  let cx = 0;
  let cy = 0;
  for (const s of a) {
    cx += s.point.x;
    cy += s.point.y;
  }
  cx /= n;
  cy /= n;
  let rad = 0;
  for (const s of a) rad += Math.hypot(s.point.x - cx, s.point.y - cy);
  rad = Math.max(1, rad / n);

  for (let i = 0; i < n; i++) {
    const bi = reverse ? b[(start - i + n * 8) % n] : b[(start + i) % n];
    const dx = a[i].point.x - bi.point.x;
    const dy = a[i].point.y - bi.point.y;
    sumPt += dx * dx + dy * dy;
    const tx = reverse ? -bi.tangent.x : bi.tangent.x;
    const ty = reverse ? -bi.tangent.y : bi.tangent.y;
    const dot = a[i].tangent.x * tx + a[i].tangent.y * ty;
    const d = 1 - Math.max(-1, Math.min(1, dot));
    sumTan += d * d;
  }
  return sumPt + TANGENT_WEIGHT * rad * rad * sumTan;
}

/**
 * Rotate a closed contour's sample ring so index 0 sits at the point whose
 * angle around the item center (normalized origin) is closest to 0 ("east").
 * Applying the same geometric anchor to both keyframes gives every contour
 * of an item a shared phase, so an inner edge can never pick a rotated
 * correspondence relative to the outer edge.
 *
 * Deliberately NOT saliency-based: a corner anchor flips between corners as
 * sampling density (and thus saliency) changes, and outer/hole contours can
 * anchor differently, tearing band edges apart. The geometric anchor is
 * density-independent; corner correspondence is handled downstream by the
 * feature-pinning warp.
 */
function rotateToPhase(samples: Sample[]): Sample[] {
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i].point;
    const d = Math.abs(Math.atan2(p.y, p.x));
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  return samples.slice(bi).concat(samples.slice(0, bi));
}

/**
 * Closed contours are canonical clockwise + phase-anchored, so only a small
 * start window is searched and reversal is never needed. Open contours keep
 * the reverse search.
 */
function bestAlign(
  a: Sample[],
  b: Sample[],
  closed: boolean,
): { start: number; reverse: boolean } {
  const n = a.length;
  let best = { start: 0, reverse: false };
  let bestCost = Infinity;

  const starts: number[] = [];
  if (!closed) {
    starts.push(0);
  } else {
    const w = Math.max(2, Math.round(n * 0.25));
    for (let d = -w; d <= w; d++) starts.push(((d % n) + n) % n);
  }

  for (const reverse of closed ? [false] : [false, true]) {
    for (const start of starts) {
      const cost = alignCost(a, b, start, reverse);
      if (cost < bestCost) {
        bestCost = cost;
        best = { start, reverse };
      }
    }
  }
  return best;
}

/** Shared motion frame for one item: centroid + mean radius (size). */
interface Frame {
  c: paper.Point;
  s: number;
}

function frameOf(sets: Sample[][]): Frame {
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (const set of sets) {
    for (const s of set) {
      cx += s.point.x;
      cy += s.point.y;
      n++;
    }
  }
  if (n === 0) return { c: new paper.Point(0, 0), s: 1 };
  cx /= n;
  cy /= n;
  let rad = 0;
  for (const set of sets) {
    for (const s of set) rad += Math.hypot(s.point.x - cx, s.point.y - cy);
  }
  return { c: new paper.Point(cx, cy), s: Math.max(1e-6, rad / n) };
}

function normalize(samples: Sample[], f: Frame): Sample[] {
  return samples.map((s) => ({
    point: s.point.subtract(f.c).divide(f.s),
    tangent: s.tangent,
    saliency: s.saliency,
  }));
}

/**
 * Map raw saliency to a handle-shortening factor. Smoothstep with a dead
 * zone below 0.45: gentle curvature keeps full bezier handles; only
 * genuinely sharp corners tighten slightly (never to zero).
 */
function cornerPin(saliency: number): number {
  const u = Math.max(0, Math.min(1, (saliency - 0.45) / 0.4));
  const base = u * u * (3 - 2 * u);
  return Math.min(1, base * 0.35);
}

function finishHandles(out: paper.Path, saliency?: number[]): void {
  const n = out.segments.length;
  for (let i = 0; i < n; i++) {
    if (!out.closed && (i === 0 || i === n - 1)) continue;
    const prev = out.segments[(i - 1 + n) % n].point;
    const next = out.segments[(i + 1) % n].point;
    const pin = saliency ? cornerPin(saliency[i]) : 0;
    const handle = next.subtract(prev).multiply(0.28 * (1 - pin));
    out.segments[i].handleIn = handle.multiply(-1);
    out.segments[i].handleOut = handle;
  }
}


/**
 * Morph one contour pair inside the shared item frames: samples are
 * normalized (frame removed), aligned cyclically, corner-pinned with soft
 * falloff, and lerped; the interpolated frame (centroid + size) is
 * reapplied on output. Global motion lives entirely in the frame, so band
 * edges travel together.
 */
function morphContourSamples(
  na: Sample[],
  nb: Sample[],
  closed: boolean,
  t: number,
  fA: Frame,
  fB: Frame,
  opts: MorphOptions,
): paper.Path {
  const cT = fA.c.add(fB.c.subtract(fA.c).multiply(t));
  const sT = fA.s + (fB.s - fA.s) * t;

  const align = bestAlign(na, nb, closed);
  const n = na.length;
  const out = new paper.Path();
  out.closed = closed;
  const outSaliency: number[] = new Array(n);

  if (closed) {
    const bRing = Array.from({ length: n }, (_, k) => nb[(align.start + k) % n]);
    const pairs =
      opts.stickiness > 0
        ? matchFeatures(
            detectFeatures(na, true),
            detectFeatures(bRing, true),
            na,
            bRing,
          )
        : [];
    const offsets = featureOffsets(pairs, n);
    // Stickiness scales the pinning warp: 0 = uniform, 1 = full pin.
    // (Scaling by <= 1 preserves the monotonicity clamp.)
    if (opts.stickiness < 1) {
      for (let i = 0; i < n; i++) offsets[i] *= opts.stickiness;
    }

    for (let i = 0; i < n; i++) {
      const fj = i + offsets[i];
      const j0 = ((Math.floor(fj) % n) + n) % n;
      const j1 = (j0 + 1) % n;
      const frac = fj - Math.floor(fj);
      const p0 = bRing[j0].point;
      const p1 = bRing[j1].point;
      const qb = new paper.Point(
        p0.x + (p1.x - p0.x) * frac,
        p0.y + (p1.y - p0.y) * frac,
      );
      const qa = na[i].point;
      const x = qa.x + t * (qb.x - qa.x);
      const y = qa.y + t * (qb.y - qa.y);
      out.add(cT.add(new paper.Point(x, y).multiply(sT)));
      const jr = ((Math.round(fj) % n) + n) % n;
      outSaliency[i] = Math.max(na[i].saliency, bRing[jr].saliency);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const j = align.reverse
        ? (align.start - i + n * 8) % n
        : (align.start + i) % n;
      const qa = na[i].point;
      const qb = nb[j].point;
      const x = qa.x + t * (qb.x - qa.x);
      const y = qa.y + t * (qb.y - qa.y);
      out.add(cT.add(new paper.Point(x, y).multiply(sT)));
      outSaliency[i] = Math.max(na[i].saliency, nb[j].saliency);
    }
  }

  finishHandles(out, outSaliency);
  if (opts.simplify > 0) out.simplify(opts.simplify);
  clearContourStyle(out);
  return out;
}

/**
 * Unmatched contour (topology birth/death): uniformly scale about an
 * *interior* point (never an exterior guessed point — that inverts the
 * contour and self-intersects), then translate so the collapse point sits
 * at `targetWorld` when provided.
 */
function rideFrame(
  c: paper.Path,
  f: Frame,
  grow: number,
  cT: paper.Point,
  sT: number,
  targetWorld?: paper.Point,
): paper.Path {
  const ns = normalize(sampleArc(c, 32), f);
  // Interior shrink center — sample centroid can lie outside crescents/arcs.
  const ip = getContainmentPoint(c) ?? c.bounds.center;
  const ax = (ip.x - f.c.x) / f.s;
  const ay = (ip.y - f.c.y) / f.s;

  const g = Math.max(0.02, grow);
  const centerWorld = cT.add(new paper.Point(ax, ay).multiply(sT));
  const dest = targetWorld ?? centerWorld;
  const ox = dest.x - centerWorld.x;
  const oy = dest.y - centerWorld.y;

  const out = new paper.Path();
  out.closed = !!c.closed;
  for (const s of ns) {
    const q = new paper.Point(
      ax + (s.point.x - ax) * g,
      ay + (s.point.y - ay) * g,
    );
    out.add(cT.add(q.multiply(sT)).add(new paper.Point(ox, oy)));
  }
  finishHandles(out);
  clearContourStyle(out);
  return out;
}

/**
 * Containment parent tree + evenodd depths — same model as
 * `PaperRenderer.splitDisconnectedItems`: tightest larger container is the
 * parent; depth walks that chain. Under merge normalization a compound is
 * one fill root (depth 0) plus its holes (depth 1); islands live as separate
 * layer items, so morph never expects nested fills inside one compound.
 */
function contourNesting(paths: paper.Path[]): {
  depths: number[];
  parents: Array<paper.Path | null>;
} {
  const n = paths.length;
  const parents: Array<paper.Path | null> = new Array(n).fill(null);
  const parentIdx: Array<number | null> = new Array(n).fill(null);
  const areas = paths.map((p) => pathArea(p));
  const interiors = paths.map((p) =>
    p.closed ? (getContainmentPoint(p) ?? p.bounds.center) : null,
  );

  for (let i = 0; i < n; i++) {
    if (!paths[i].closed || !interiors[i]) continue;
    let best: number | null = null;
    let bestArea = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j || areas[j] <= areas[i]) continue;
      if (!paths[j].bounds.contains(paths[i].bounds)) continue;
      try {
        if (!paths[j].contains(interiors[i]!)) continue;
      } catch {
        continue;
      }
      if (areas[j] < bestArea) {
        bestArea = areas[j];
        best = j;
      }
    }
    parentIdx[i] = best;
    parents[i] = best == null ? null : paths[best];
  }

  const depths = new Array(n).fill(0);
  const computeDepth = (i: number): number => {
    const p = parentIdx[i];
    if (p == null) return 0;
    const d = computeDepth(p) + 1;
    depths[i] = d;
    return d;
  };
  for (let i = 0; i < n; i++) computeDepth(i);

  return { depths, parents };
}

/**
 * Owning fill for a contour: nearest even-depth ancestor (the fill root that
 * owns a hole), matching merge's `nearestEven` grouping.
 */
function owningFill(
  p: paper.Path,
  paths: paper.Path[],
  depths: number[],
  parents: Array<paper.Path | null>,
): paper.Path | null {
  const i = paths.indexOf(p);
  if (i < 0) return null;
  let cur: number | null = i;
  while (cur != null) {
    if (depths[cur] % 2 === 0) return paths[cur] === p ? null : paths[cur];
    const ancestor: paper.Path | null = parents[cur];
    cur = ancestor ? paths.indexOf(ancestor) : null;
  }
  return null;
}

/** Contour interior point in an item frame's normalized space. */
function contourInteriorNorm(c: paper.Path, f: Frame): paper.Point {
  const ip = getContainmentPoint(c) ?? c.bounds.center;
  return ip.subtract(f.c).divide(f.s);
}

/**
 * World-space seed for an unmatched contour birth (B side only).
 *
 * Remaps the hole's interior through its owning fill onto the matched
 * counterpart fill so the speck appears in the solid band — not in a void
 * where evenodd would flip it into a filled island. Death collapses
 * in-place (no translation); sliding a mid-sized hole into another hole
 * crosses evenodd parity and self-intersects.
 */
function guessBirthWorld(
  unmatched: paper.Path,
  paths: paper.Path[],
  depths: number[],
  parents: Array<paper.Path | null>,
  fSelf: Frame,
  fOther: Frame,
  pairs: Array<{ a: paper.Path; b: paper.Path }>,
  t: number,
): paper.Point {
  const ownNorm = contourInteriorNorm(unmatched, fSelf);
  const ownAbs = fSelf.c.add(ownNorm.multiply(fSelf.s));

  const fill = owningFill(unmatched, paths, depths, parents);
  if (!fill) return ownAbs;

  const pair = pairs.find((p) => p.b === fill);
  if (!pair) return ownAbs;

  const fillSelfC = contourInteriorNorm(fill, fSelf);
  const fillSelfS = Math.max(
    1e-6,
    Math.hypot(fill.bounds.width, fill.bounds.height) / (2 * fSelf.s),
  );
  const local = ownNorm.subtract(fillSelfC).divide(fillSelfS);

  const fillOtherC = contourInteriorNorm(pair.a, fOther);
  const fillOtherS = Math.max(
    1e-6,
    Math.hypot(pair.a.bounds.width, pair.a.bounds.height) / (2 * fOther.s),
  );
  const otherNorm = fillOtherC.add(local.multiply(fillOtherS));
  const otherAbs = fOther.c.add(otherNorm.multiply(fOther.s));

  // Speck starts on A (t→0), settles at B's own interior (t→1).
  const w = 1 - t;
  return new paper.Point(
    ownAbs.x + (otherAbs.x - ownAbs.x) * w,
    ownAbs.y + (otherAbs.y - ownAbs.y) * w,
  );
}

function morphItem(
  a: paper.PathItem,
  b: paper.PathItem,
  t: number,
  opts: MorphOptions,
): paper.PathItem {
  const aContours = contoursOf(a);
  const bContours = contoursOf(b);
  if (aContours.length === 0) return a.clone();

  // Canonical traversal direction: correspondences never need reversal.
  for (const p of [...aContours, ...bContours]) {
    if (p.closed) p.clockwise = true;
  }

  // One shared frame per keyframe, from every contour (coarse samples are
  // enough for a centroid + mean radius).
  const fA = frameOf(aContours.map((p) => sampleArc(p, 24)));
  const fB = frameOf(bContours.map((p) => sampleArc(p, 24)));

  const aNest = contourNesting(aContours);
  const bNest = contourNesting(bContours);
  const pairs = matchContours(
    aContours,
    bContours,
    fA,
    fB,
    aNest.depths,
    bNest.depths,
  );
  const usedA = new Set(pairs.map((p) => p.a));
  const usedB = new Set(pairs.map((p) => p.b));

  // Density scales generated vertex counts (0.5 = coarse, 2 = fine).
  const maxSamples = Math.round(SAMPLE_MAX * opts.density);
  const sampleCountFor = (ca: paper.Path, cb: paper.Path): number =>
    Math.max(
      SAMPLE_MIN,
      Math.min(
        maxSamples,
        Math.round(
          Math.max(ca.segments.length, cb.segments.length, 8) *
            2 *
            opts.density,
        ),
      ),
    );

  const children: paper.Path[] = [];
  for (const { a: ca, b: cb } of pairs) {
    const closed = !!(ca.closed || cb.closed);
    let na = normalize(sampleArc(ca, sampleCountFor(ca, cb)), fA);
    let nb = normalize(sampleArc(cb, na.length), fB);
    if (closed) {
      na = rotateToPhase(na);
      nb = rotateToPhase(nb);
    }
    children.push(morphContourSamples(na, nb, closed, t, fA, fB, opts));
  }

  // Topology birth/death: always scale about an interior point.
  // Death collapses in place (keeps the hole in the fill band). Birth seeds
  // a speck on the matched fill of A, then grows into B's hole.
  const cT = fA.c.add(fB.c.subtract(fA.c).multiply(t));
  const sT = fA.s + (fB.s - fA.s) * t;
  for (const c of aContours) {
    if (!usedA.has(c)) {
      children.push(rideFrame(c, fA, 1 - t, cT, sT));
    }
  }
  for (const c of bContours) {
    if (!usedB.has(c)) {
      const target = guessBirthWorld(
        c,
        bContours,
        bNest.depths,
        bNest.parents,
        fB,
        fA,
        pairs,
        t,
      );
      children.push(rideFrame(c, fB, t, cT, sT, target));
    }
  }

  if (children.length === 0) return a.clone();
  if (children.length === 1) {
    applyItemStyle(children[0], a, b, t);
    return children[0];
  }

  const compound = new paper.CompoundPath({ children });
  compound.fillRule = "evenodd";
  applyItemStyle(compound, a, b, t);
  return compound;
}

export function morphLayerJson(
  aJson: string,
  bJson: string,
  t: number,
  options?: Partial<MorphOptions>,
): string {
  if (!aJson) return "";
  if (t <= 0) return aJson;
  if (t >= 1) return bJson || aJson;
  const opts: MorphOptions = { ...DEFAULT_MORPH_OPTIONS, ...options };

  const layerA = new paper.Layer();
  const layerB = new paper.Layer();
  const result = new paper.Layer();
  try {
    layerA.importJSON(aJson);
    layerB.importJSON(bJson);

    const aItems = topItems(layerA);
    const bItems = topItems(layerB);
    if (aItems.length === 0) return aJson;

    const pairs = matchItems(aItems, bItems);
    for (const a of aItems) {
      const pair = pairs.find((p) => p.a === a);
      if (pair) {
        let blended: paper.PathItem | null = null;
        if (opts.solver === "sdf") {
          blended = morphItemSdf(pair.a, pair.b, t, opts);
        }
        result.addChild(blended ?? morphItem(pair.a, pair.b, t, opts));
      } else {
        // Item death: shrink about an interior point (bounds center can lie
        // outside crescents and invert the path).
        const gone = a.clone();
        const pivot =
          a instanceof paper.Path
            ? (getContainmentPoint(a) ?? a.bounds.center)
            : a.bounds.center;
        gone.scale(Math.max(0.02, 1 - t), pivot);
        result.addChild(gone);
      }
    }
    // Item birth: unmatched B items grow in instead of popping at t=1.
    const usedB = new Set(pairs.map((p) => p.b));
    for (const b of bItems) {
      if (usedB.has(b)) continue;
      const born = b.clone();
      const pivot =
        b instanceof paper.Path
          ? (getContainmentPoint(b) ?? b.bounds.center)
          : b.bounds.center;
      born.scale(Math.max(0.02, t), pivot);
      result.addChild(born);
    }

    return (result.exportJSON() as string) ?? aJson;
  } finally {
    result.remove();
    layerA.remove();
    layerB.remove();
  }
}
