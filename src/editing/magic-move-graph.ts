/**
 * Magic Move timing-chart parsing (Paper-native).
 *
 * Longest stroke → trajectory path; shorter strokes that cross it → timing ticks.
 * Dense samples follow the bezier/polyline arc between ticks (Steps subdivisions).
 */
import paper from "paper";
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
  /** Index of the timing-tick interval this sample ends (0-based). */
  tickInterval: number;
  /** 0..steps within that interval (steps means the end tick). */
  stepIndex: number;
}

export type GraphParseResult =
  | { ok: true; samples: PathSample[]; tickCount: number }
  | { ok: false; error: string };

function strokeLength(points: Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    len += Math.hypot(dx, dy);
  }
  return len;
}

function pathFromPoints(points: Point[]): paper.Path {
  const path = new paper.Path({
    segments: points.map((p) => new paper.Point(p.x, p.y)),
    insert: false,
  });
  return path;
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

  const trajectory = pathFromPoints(usable[trajIndex].points);
  const tickOffsets: number[] = [];

  try {
    for (let i = 0; i < usable.length; i++) {
      if (i === trajIndex) continue;
      const tick = pathFromPoints(usable[i].points);
      try {
        const hits = trajectory.getIntersections(tick);
        if (hits.length === 0) continue;
        // Prefer the hit closest to the tick midpoint (first intersection is fine).
        let best = hits[0];
        let bestDist = Infinity;
        const mid =
          usable[i].points[Math.floor(usable[i].points.length / 2)] ??
          usable[i].points[0];
        for (const hit of hits) {
          const d = hit.point.getDistance(new paper.Point(mid.x, mid.y));
          if (d < bestDist) {
            bestDist = d;
            best = hit;
          }
        }
        tickOffsets.push(best.offset);
      } finally {
        tick.remove();
      }
    }

    if (tickOffsets.length < 2) {
      return {
        ok: false,
        error: "Need at least two timing ticks intersecting the trajectory.",
      };
    }

    tickOffsets.sort((a, b) => a - b);
    // Deduplicate near-identical offsets
    const unique: number[] = [tickOffsets[0]];
    for (let i = 1; i < tickOffsets.length; i++) {
      if (tickOffsets[i] - unique[unique.length - 1] > 1e-4) {
        unique.push(tickOffsets[i]);
      }
    }
    if (unique.length < 2) {
      return {
        ok: false,
        error: "Need at least two distinct timing ticks on the trajectory.",
      };
    }

    const subdiv = Math.max(1, Math.round(steps));
    const samples: PathSample[] = [];

    const pushAt = (offset: number, tickInterval: number, stepIndex: number) => {
      const clamped = Math.max(0, Math.min(trajectory.length, offset));
      const pt = trajectory.getPointAt(clamped);
      samples.push({
        x: pt.x,
        y: pt.y,
        offset: clamped,
        tickInterval,
        stepIndex,
      });
    };

    pushAt(unique[0], 0, 0);
    for (let t = 0; t < unique.length - 1; t++) {
      const oA = unique[t];
      const oB = unique[t + 1];
      for (let k = 1; k <= subdiv; k++) {
        const offset = oA + ((oB - oA) * k) / subdiv;
        pushAt(offset, t, k);
      }
    }

    return { ok: true, samples, tickCount: unique.length };
  } finally {
    trajectory.remove();
  }
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
