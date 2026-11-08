/**
 * Magic Move timing-chart parsing.
 *
 * Longest stroke → trajectory; shorter strokes that cross it → timing ticks.
 * Dense samples follow the polyline between ticks (Steps subdivisions).
 */
import type { Point } from "../geometry/types";

export interface ChartStroke {
  /** World/stage-space points. */
  points: Point[];
}

export interface PathSample {
  x: number;
  y: number;
  /** Arc offset along the trajectory. */
  offset: number;
  /** Unit tangent at the sample (for chrome / orient). */
  tx: number;
  ty: number;
  /** Index of the timing-tick interval this sample ends (0-based). */
  tickInterval: number;
  /** 0..steps within that interval (steps means the end tick). */
  stepIndex: number;
}

export type GraphParseResult =
  | {
      ok: true;
      samples: PathSample[];
      tickCount: number;
      /**
       * Uniform scale at each timing tick, relative to the first tick’s length
       * (tickScales[0] === 1). Used when Magic Move Scale is on.
       */
      tickScales: number[];
    }
  | { ok: false; error: string };

function strokeLength(points: Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return len;
}

/** Crossings of two polylines. `offset` is arc length along `traj`. */
function polylineHits(
  traj: Point[],
  tick: Point[],
): Array<{ x: number; y: number; offset: number }> {
  const hits: Array<{ x: number; y: number; offset: number }> = [];
  let walked = 0;
  for (let i = 1; i < traj.length; i++) {
    const a = traj[i - 1];
    const b = traj[i];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abLen = Math.hypot(abx, aby);
    for (let j = 1; j < tick.length; j++) {
      const c = tick[j - 1];
      const d = tick[j];
      const cdx = d.x - c.x;
      const cdy = d.y - c.y;
      const den = abx * cdy - aby * cdx;
      if (Math.abs(den) < 1e-12) continue;
      const acx = c.x - a.x;
      const acy = c.y - a.y;
      const t = (acx * cdy - acy * cdx) / den;
      const u = (acx * aby - acy * abx) / den;
      if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) continue;
      hits.push({
        x: a.x + abx * t,
        y: a.y + aby * t,
        offset: walked + abLen * Math.max(0, Math.min(1, t)),
      });
    }
    walked += abLen;
  }
  return hits;
}

/** Point and unit tangent of the segment that contains `offset`. */
function pointOnPolyline(
  points: Point[],
  offset: number,
): { x: number; y: number; tx: number; ty: number } {
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (walked + len >= offset - 1e-9 || i === points.length - 1) {
      const u = len < 1e-9 ? 0 : Math.max(0, Math.min(1, (offset - walked) / len));
      const n = len || 1;
      return { x: a.x + dx * u, y: a.y + dy * u, tx: dx / n, ty: dy / n };
    }
    walked += len;
  }
  const a = points[0] ?? { x: 0, y: 0 };
  return { x: a.x, y: a.y, tx: 1, ty: 0 };
}

interface ParseMemo {
  strokes: readonly Point[][];
  steps: number;
  result: GraphParseResult;
}
const PARSE_MEMO_SIZE = 8;
const parseMemo: ParseMemo[] = [];

/**
 * `parseTimingChart` over a controller's stroke list, memoized by stroke
 * identity. Strokes are appended as whole arrays and never mutated after,
 * so comparing each inner array by reference is exact. Lets the chrome
 * painter and `canApply()` re-ask every frame without refitting the chart.
 */
export function parseTimingChartMemo(strokes: readonly Point[][], steps: number): GraphParseResult {
  for (let i = 0; i < parseMemo.length; i++) {
    const m = parseMemo[i];
    if (m.steps !== steps || m.strokes.length !== strokes.length) continue;
    let same = true;
    for (let j = 0; j < strokes.length; j++) {
      if (m.strokes[j] !== strokes[j]) {
        same = false;
        break;
      }
    }
    if (!same) continue;
    if (i !== 0) {
      parseMemo.splice(i, 1);
      parseMemo.unshift(m);
    }
    return m.result;
  }
  const result = parseTimingChart(
    strokes.map((points) => ({ points })),
    steps,
  );
  parseMemo.unshift({ strokes: [...strokes], steps, result });
  if (parseMemo.length > PARSE_MEMO_SIZE) parseMemo.pop();
  return result;
}

/**
 * Build dense path samples from chart strokes.
 *
 * @param steps Subdivisions per tick interval (≥1). steps=1 → tick points only.
 */
export function parseTimingChart(
  strokes: ChartStroke[],
  steps: number,
): GraphParseResult {
  const usable = strokes.filter((s) => s.points.length >= 2);
  if (usable.length < 2) {
    return {
      ok: false,
      error: "Draw a trajectory and at least two timing ticks that cross it.",
    };
  }

  let trajIndex = 0;
  let maxLen = -1;
  for (let i = 0; i < usable.length; i++) {
    const len = strokeLength(usable[i].points);
    if (len > maxLen) {
      maxLen = len;
      trajIndex = i;
    }
  }

  if (maxLen < 1e-3) {
    return { ok: false, error: "Trajectory is too short." };
  }

  const trajectory = usable[trajIndex].points;
  const tickHits: Array<{ offset: number; length: number }> = [];

  for (let i = 0; i < usable.length; i++) {
    if (i === trajIndex) continue;
    const hits = polylineHits(trajectory, usable[i].points);
    if (hits.length === 0) continue;
    // Prefer the hit closest to the tick midpoint.
    const mid =
      usable[i].points[Math.floor(usable[i].points.length / 2)] ?? usable[i].points[0];
    let best = hits[0];
    let bestDist = Infinity;
    for (const hit of hits) {
      const d = Math.hypot(hit.x - mid.x, hit.y - mid.y);
      if (d < bestDist) {
        bestDist = d;
        best = hit;
      }
    }
    tickHits.push({
      offset: best.offset,
      length: Math.max(1e-6, strokeLength(usable[i].points)),
    });
  }

  if (tickHits.length < 2) {
    return {
      ok: false,
      error: "Need at least two timing ticks intersecting the trajectory.",
    };
  }

  tickHits.sort((a, b) => a.offset - b.offset);
  // Deduplicate near-identical offsets (keep the first tick’s length).
  const unique: Array<{ offset: number; length: number }> = [tickHits[0]];
  for (let i = 1; i < tickHits.length; i++) {
    if (tickHits[i].offset - unique[unique.length - 1].offset > 1e-4) {
      unique.push(tickHits[i]);
    }
  }
  if (unique.length < 2) {
    return {
      ok: false,
      error: "Need at least two distinct timing ticks on the trajectory.",
    };
  }

  const baseLen = unique[0].length;
  const tickScales = unique.map((t) => t.length / baseLen);

  const subdiv = Math.max(1, Math.round(steps));
  const samples: PathSample[] = [];

  const pushAt = (offset: number, tickInterval: number, stepIndex: number) => {
    const clamped = Math.max(0, Math.min(maxLen, offset));
    const pt = pointOnPolyline(trajectory, clamped);
    samples.push({
      x: pt.x,
      y: pt.y,
      offset: clamped,
      tx: pt.tx,
      ty: pt.ty,
      tickInterval,
      stepIndex,
    });
  };

  pushAt(unique[0].offset, 0, 0);
  for (let t = 0; t < unique.length - 1; t++) {
    const oA = unique[t].offset;
    const oB = unique[t + 1].offset;
    for (let k = 1; k <= subdiv; k++) {
      const offset = oA + ((oB - oA) * k) / subdiv;
      pushAt(offset, t, k);
    }
  }

  return { ok: true, samples, tickCount: unique.length, tickScales };
}

/**
 * Map dense samples onto integer frame indices starting at `startFrame`.
 *
 * Tick intervals are `D` frames apart (from step or duration settings).
 * Each interval’s frame span is subdivided across `steps` samples.
 */
export function mapSamplesToFrames(
  sampleCount: number,
  tickCount: number,
  steps: number,
  startFrame: number,
  framesPerTickInterval: number,
): number[] {
  if (sampleCount <= 0) return [];
  const subdiv = Math.max(1, Math.round(steps));
  const intervals = Math.max(1, tickCount - 1);
  const D = Math.max(1, Math.round(framesPerTickInterval));

  const frames: number[] = [startFrame];
  let cursor = startFrame;

  // samples layout: [tick0, then for each interval: steps samples ending at next tick]
  let idx = 1;
  for (let t = 0; t < intervals && idx < sampleCount; t++) {
    const intervalSamples: number[] = [];
    for (let k = 0; k < subdiv && idx < sampleCount; k++, idx++) {
      intervalSamples.push(idx);
    }
    // Place unique frames across [cursor+1 .. cursor+D], landing on cursor+D for last.
    const n = intervalSamples.length;
    if (n === 0) continue;

    const used = new Set<number>([cursor]);
    for (let k = 0; k < n; k++) {
      const target =
        k === n - 1
          ? cursor + D
          : cursor + Math.max(1, Math.round(((k + 1) * D) / n));
      let frame = target;
      // Ensure strictly increasing unique frames
      while (used.has(frame)) frame += 1;
      used.add(frame);
      frames.push(frame);
    }
    cursor = frames[frames.length - 1];
  }

  // If we somehow have fewer frames than samples, pad forward by 1.
  while (frames.length < sampleCount) {
    frames.push(frames[frames.length - 1] + 1);
  }

  return frames.slice(0, sampleCount);
}

/**
 * Per-sample uniform scale from tick lengths. First tick is 1; later ticks are
 * length_i / length_0. Subdivided samples lerp between neighboring ticks.
 */
export function scalesForSamples(
  samples: PathSample[],
  tickScales: number[],
  steps: number,
): number[] {
  if (samples.length === 0) return [];
  if (tickScales.length === 0) return samples.map(() => 1);
  const subdiv = Math.max(1, Math.round(steps));
  return samples.map((s) => {
    const a = tickScales[Math.min(s.tickInterval, tickScales.length - 1)] ?? 1;
    const b =
      tickScales[Math.min(s.tickInterval + 1, tickScales.length - 1)] ?? a;
    if (subdiv <= 0) return a;
    const t = Math.max(0, Math.min(1, s.stepIndex / subdiv));
    return a + (b - a) * t;
  });
}

/**
 * Dedouze pose-to-pose morph ratios from a timing chart.
 *
 * Intermediate samples (ticks + Divisions) between the first and last tick,
 * remapped to t ∈ (0, 1) along the trajectory arc. Endpoints excluded.
 */
export function morphRatiosFromChart(
  strokes: ChartStroke[],
  divisions: number,
): { ok: true; ratios: number[] } | { ok: false; error: string } {
  const parsed = parseTimingChart(strokes, divisions);
  if (!parsed.ok) return parsed;
  const { samples } = parsed;
  if (samples.length < 3) {
    return {
      ok: false,
      error:
        "Need intermediate timing ticks (or Divisions > 1) between the first and last tick.",
    };
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  const span = last.offset - first.offset;
  if (Math.abs(span) < 1e-6) {
    return { ok: false, error: "Timing ticks are too close together." };
  }
  const ratios: number[] = [];
  for (let i = 1; i < samples.length - 1; i++) {
    const t = (samples[i].offset - first.offset) / span;
    ratios.push(Math.max(0, Math.min(1, t)));
  }
  if (ratios.length === 0) {
    return {
      ok: false,
      error:
        "Need intermediate timing ticks (or Divisions > 1) between the first and last tick.",
    };
  }
  return { ok: true, ratios };
}

/**
 * Evenly space `count` integer frames strictly between `start` and `end`
 * (Dedouze pose-to-pose frame packing).
 */
export function evenFramesBetween(
  start: number,
  end: number,
  count: number,
): number[] {
  if (count <= 0 || end - start < 2) return [];
  const frames: number[] = [];
  const range = end - start;
  for (let i = 1; i <= count; i++) {
    let frame = Math.round(start + (range * i) / (count + 1));
    if (frame <= start) frame = start + 1;
    if (frame >= end) frame = end - 1;
    if (frames.length > 0 && frame <= frames[frames.length - 1]) {
      frame = frames[frames.length - 1] + 1;
    }
    if (frame >= end) break;
    frames.push(frame);
  }
  return frames;
}
