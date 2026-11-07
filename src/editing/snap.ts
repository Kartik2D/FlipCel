/**
 * Affinity-style snapping: axis lines (grid / stage / boxes) plus optional
 * geometry points. Screen-space tolerance. Shift axis-lock is applied by
 * the caller before this runs.
 *
 * # ponytail: object-move geometry is node-to-node only. getNearestPoint is
 * for single-point drags (vertex, handle, create-points, shape corner).
 */
import type { Point } from "../geometry/types";
import type { StageRenderer } from "../render/stage-renderer";
import type { KernelEdge } from "../vector/kernel";
import {
  snapStore,
  viewOverlayStore,
  stageStore,
  Store,
  type SnapSettings,
} from "../state/index";

export type { SnapSettings };

export interface SnapSpace {
  worldToScreen(x: number, y: number): Point;
  screenToWorld(x: number, y: number): Point;
}

export interface SnapGuide {
  axis: "x" | "y";
  world: number;
  /** Span of the target feature on the other axis (box/stage edge). */
  lo?: number;
  hi?: number;
  /** World point on the feature being snapped to. */
  at?: Point;
}

export interface SnapLock {
  x?: boolean;
  y?: boolean;
}

export interface SnapResult {
  x: number;
  y: number;
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

export interface SnapSource {
  xs: number[];
  ys: number[];
  points: Point[];
}

/** Axis line at `value`; optional `lo`/`hi` is the span on the other axis. */
export interface AxisTarget {
  value: number;
  lo?: number;
  hi?: number;
}

export interface SnapTargets {
  xs: AxisTarget[];
  ys: AxisTarget[];
  points: Point[];
  gridSpacing: number;
  nearestOnPaths?: (p: Point) => Point | null;
}

/** Live snap-guide overlay; FeedbackLayer paints these on #ui-canvas. */
export const snapGuidesStore = new Store<SnapGuide[]>([]);

export function setSnapGuides(guides: SnapGuide[]): void {
  const cur = snapGuidesStore.get();
  if (cur.length === 0 && guides.length === 0) return;
  snapGuidesStore.set(guides);
}

const IGNORE_EPS = 1e-3;

function isIgnored(p: Point, ignore: Point[]): boolean {
  for (const i of ignore) {
    if (Math.abs(p.x - i.x) <= IGNORE_EPS && Math.abs(p.y - i.y) <= IGNORE_EPS) {
      return true;
    }
  }
  return false;
}

export function emptySnapResult(x: number, y: number): SnapResult {
  return { x, y, dx: 0, dy: 0, guides: [] };
}

export function snapLockFromConstrain(
  constrained: Point,
  constrain: boolean,
): SnapLock | undefined {
  if (!constrain) return undefined;
  return Math.abs(constrained.x) >= Math.abs(constrained.y)
    ? { y: true }
    : { x: true };
}

export function sourcesFromBounds(
  b: { x: number; y: number; width: number; height: number },
): SnapSource {
  const left = b.x;
  const right = b.x + b.width;
  const top = b.y;
  const bottom = b.y + b.height;
  return {
    xs: [left, (left + right) / 2, right],
    ys: [top, (top + bottom) / 2, bottom],
    points: [],
  };
}

export function collectTargets(
  renderer: StageRenderer,
  settings: SnapSettings,
  extras: { gridSpacing: number; stageWidth: number; stageHeight: number },
  ignorePoints: Point[] = [],
): SnapTargets {
  const xs: AxisTarget[] = [];
  const ys: AxisTarget[] = [];
  const points: Point[] = [];
  const edges: KernelEdge[] = [];

  const addX = (value: number, lo?: number, hi?: number) => {
    xs.push({ value, lo, hi });
  };
  const addY = (value: number, lo?: number, hi?: number) => {
    ys.push({ value, lo, hi });
  };

  const addGeometry = (layerId: string) => {
    for (const e of renderer.snapEdges(layerId)) {
      edges.push(e);
      for (const p of [e.a, e.b]) {
        if (isIgnored(p, ignorePoints)) continue;
        points.push(p);
        addX(p.x, p.y, p.y);
        addY(p.y, p.x, p.x);
      }
    }
  };

  if (settings.stage) {
    addX(0, 0, extras.stageHeight);
    addX(extras.stageWidth, 0, extras.stageHeight);
    addY(0, 0, extras.stageWidth);
    addY(extras.stageHeight, 0, extras.stageWidth);
    if (settings.stageMidpoints) {
      addX(extras.stageWidth / 2, 0, extras.stageHeight);
      addY(extras.stageHeight / 2, 0, extras.stageWidth);
    }
  }

  if (settings.bounds || settings.geometry) {
    for (const layerId of renderer.snapLayerIds()) {
      if (settings.bounds) {
        const b = renderer.getLayerBounds(layerId);
        if (!b) continue;
        const x0 = b.x;
        const x1 = b.x + b.width;
        const y0 = b.y;
        const y1 = b.y + b.height;
        addX(x0, y0, y1);
        addX(x1, y0, y1);
        addY(y0, x0, x1);
        addY(y1, x0, x1);
        if (settings.boundsMidpoints) {
          addX(x0 + b.width / 2, y0, y1);
          addY(y0 + b.height / 2, x0, x1);
        }
      }
      if (settings.geometry) addGeometry(layerId);
    }
  }

  return {
    xs,
    ys,
    points,
    gridSpacing: settings.grid ? extras.gridSpacing : 0,
    nearestOnPaths:
      settings.geometry && edges.length > 0
        ? (p) => nearestOnEdges(edges, p, ignorePoints)
        : undefined,
  };
}

function nearestOnSegment(a: Point, b: Point, p: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return a;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return { x: a.x + dx * t, y: a.y + dy * t };
}

function nearestOnEdges(edges: KernelEdge[], p: Point, ignore: Point[] = []): Point | null {
  let best: Point | null = null;
  let bestD = Infinity;
  const consider = (w: Point) => {
    if (isIgnored(w, ignore)) return;
    const d = (w.x - p.x) * (w.x - p.x) + (w.y - p.y) * (w.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = w;
    }
  };
  for (const e of edges) {
    if (!e.ctrl) {
      consider(nearestOnSegment(e.a, e.b, p));
      continue;
    }
    // Quadratic: sample the polyline.
    let prev = e.a;
    for (let i = 1; i <= 8; i++) {
      const t = i / 8;
      const u = 1 - t;
      const q = {
        x: u * u * e.a.x + 2 * u * t * e.ctrl.x + t * t * e.b.x,
        y: u * u * e.a.y + 2 * u * t * e.ctrl.y + t * t * e.b.y,
      };
      consider(nearestOnSegment(prev, q, p));
      prev = q;
    }
  }
  return best;
}

function screenDist(
  space: SnapSpace,
  x: number,
  y: number,
  nx: number,
  ny: number,
): number {
  const a = space.worldToScreen(x, y);
  const b = space.worldToScreen(nx, ny);
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function nearestGrid(value: number, spacing: number): number {
  return Math.round(value / spacing) * spacing;
}

function clampSpan(v: number, lo?: number, hi?: number): number {
  if (lo === undefined || hi === undefined) return v;
  return Math.max(Math.min(lo, hi), Math.min(Math.max(lo, hi), v));
}

/** Closer features win for the same axis error. # ponytail: 40px along-weight. */
function snapScore(snapErr: number, featureDist: number): number {
  return snapErr * (1 + Math.max(0, featureDist - snapErr) / 40);
}

function bestAxisSnap(
  sources: number[],
  desired: number,
  targets: AxisTarget[],
  gridSpacing: number,
  space: SnapSpace,
  sampleOther: number,
  axis: "x" | "y",
  tolerance: number,
): {
  adj: number;
  world: number;
  screen: number;
  lo?: number;
  hi?: number;
  at: Point;
} | null {
  let best: {
    adj: number;
    world: number;
    screen: number;
    score: number;
    lo?: number;
    hi?: number;
    at: Point;
  } | null = null;
  for (const src of sources) {
    const proposed = src + desired;
    const candidates: AxisTarget[] =
      gridSpacing > 0 ? [{ value: nearestGrid(proposed, gridSpacing) }] : [];
    for (const t of targets) candidates.push(t);
    for (const t of candidates) {
      const adj = t.value - proposed;
      const other = clampSpan(sampleOther, t.lo, t.hi);
      const snapErr =
        axis === "x"
          ? screenDist(space, proposed, sampleOther, t.value, sampleOther)
          : screenDist(space, sampleOther, proposed, sampleOther, t.value);
      if (snapErr > tolerance) continue;
      const featureDist =
        axis === "x"
          ? screenDist(space, proposed, sampleOther, t.value, other)
          : screenDist(space, sampleOther, proposed, other, t.value);
      const score = snapScore(snapErr, featureDist);
      if (!best || score < best.score) {
        best = {
          adj,
          world: t.value,
          screen: snapErr,
          score,
          lo: t.lo,
          hi: t.hi,
          at:
            axis === "x"
              ? { x: t.value, y: other }
              : { x: other, y: t.value },
        };
      }
    }
  }
  return best;
}

export function snapTranslation(
  sources: SnapSource,
  desired: Point,
  targets: SnapTargets,
  space: SnapSpace,
  settings: SnapSettings,
  lock?: SnapLock,
): SnapResult {
  if (!settings.enabled) {
    return {
      x: desired.x,
      y: desired.y,
      dx: desired.x,
      dy: desired.y,
      guides: [],
    };
  }

  const sampleX = sources.xs[0] ?? sources.points[0]?.x ?? 0;
  const sampleY = sources.ys[0] ?? sources.points[0]?.y ?? 0;
  const tol = settings.tolerancePx;
  const guides: SnapGuide[] = [];

  let adjX = 0;
  let adjY = 0;
  let xScreen = Infinity;
  let yScreen = Infinity;

  if (!lock?.x) {
    const hit = bestAxisSnap(
      sources.xs,
      desired.x,
      targets.xs,
      targets.gridSpacing,
      space,
      sampleY,
      "x",
      tol,
    );
    if (hit) {
      adjX = hit.adj;
      xScreen = hit.screen;
      guides.push({
        axis: "x",
        world: hit.world,
        lo: hit.lo,
        hi: hit.hi,
        at: hit.at,
      });
    }
  }
  if (!lock?.y) {
    const hit = bestAxisSnap(
      sources.ys,
      desired.y,
      targets.ys,
      targets.gridSpacing,
      space,
      sampleX,
      "y",
      tol,
    );
    if (hit) {
      adjY = hit.adj;
      yScreen = hit.screen;
      guides.push({
        axis: "y",
        world: hit.world,
        lo: hit.lo,
        hi: hit.hi,
        at: hit.at,
      });
    }
  }

  // 2D node-to-node: prefer when closer than the independent axis pair.
  // Skip when an axis is locked — axis snaps already cover the free axis.
  if (
    settings.geometry &&
    !lock?.x &&
    !lock?.y &&
    sources.points.length > 0 &&
    targets.points.length > 0
  ) {
    const axisScore = Math.hypot(
      xScreen === Infinity ? 0 : xScreen,
      yScreen === Infinity ? 0 : yScreen,
    );
    let best2: { adjX: number; adjY: number; screen: number; p: Point } | null =
      null;
    for (const src of sources.points) {
      const px = src.x + desired.x;
      const py = src.y + desired.y;
      for (const t of targets.points) {
        const ddx = t.x - px;
        const ddy = t.y - py;
        const sx = screenDist(space, px, py, px + ddx, py + ddy);
        if (sx > tol) continue;
        if (!best2 || sx < best2.screen) {
          best2 = { adjX: ddx, adjY: ddy, screen: sx, p: t };
        }
      }
    }
    if (best2 && best2.screen <= axisScore) {
      adjX = best2.adjX;
      adjY = best2.adjY;
      guides.length = 0;
      if (!lock?.x) guides.push({ axis: "x", world: best2.p.x, at: best2.p });
      if (!lock?.y) guides.push({ axis: "y", world: best2.p.y, at: best2.p });
    }
  }

  const dx = desired.x + adjX;
  const dy = desired.y + adjY;
  return { x: dx, y: dy, dx, dy, guides };
}

export function snapPoint(
  world: Point,
  targets: SnapTargets,
  space: SnapSpace,
  settings: SnapSettings,
  lock?: SnapLock,
): SnapResult {
  const sources: SnapSource = {
    xs: [world.x],
    ys: [world.y],
    points: [world],
  };
  const moved = snapTranslation(
    sources,
    { x: 0, y: 0 },
    targets,
    space,
    settings,
    lock,
  );

  let dx = moved.dx;
  let dy = moved.dy;
  let guides = moved.guides;

  if (settings.geometry && settings.enabled && targets.nearestOnPaths && !lock?.x && !lock?.y) {
    const proposed = { x: world.x + dx, y: world.y + dy };
    const near = targets.nearestOnPaths(proposed);
    if (near) {
      const sx = screenDist(space, proposed.x, proposed.y, near.x, near.y);
      if (sx <= settings.tolerancePx) {
        const axisScore = Math.hypot(
          guides.some((g) => g.axis === "x")
            ? screenDist(space, world.x, world.y, world.x + dx, world.y)
            : 0,
          guides.some((g) => g.axis === "y")
            ? screenDist(space, world.x, world.y, world.x, world.y + dy)
            : 0,
        );
        if (sx <= axisScore || guides.length === 0) {
          dx = near.x - world.x;
          dy = near.y - world.y;
          guides = [
            { axis: "x", world: near.x, at: near },
            { axis: "y", world: near.y, at: near },
          ];
        }
      }
    }
  }

  return {
    x: world.x + dx,
    y: world.y + dy,
    dx,
    dy,
    guides,
  };
}

export function collectLiveTargets(
  renderer: StageRenderer,
  ignorePoints: Point[] = [],
  allowSelf = true,
): { settings: SnapSettings; targets: SnapTargets } | null {
  const settings = snapStore.get();
  if (!settings.enabled) return null;
  const overlay = viewOverlayStore.get();
  const stage = stageStore.get();
  return {
    settings,
    targets: collectTargets(
      renderer,
      allowSelf ? settings : { ...settings, selfGeometry: false },
      {
        gridSpacing: overlay.gridSpacing,
        stageWidth: stage.width,
        stageHeight: stage.height,
      },
      ignorePoints,
    ),
  };
}

export function offsetPoints(points: Point[], delta: Point): Point[] {
  return points.map((p) => ({ x: p.x + delta.x, y: p.y + delta.y }));
}

export function snapWorldPoint(
  world: Point,
  space: SnapSpace,
  renderer: StageRenderer,
  lock?: SnapLock,
  ignorePoints: Point[] = [],
  allowSelf = true,
): SnapResult {
  const live = collectLiveTargets(renderer, ignorePoints, allowSelf);
  if (!live) return emptySnapResult(world.x, world.y);
  return snapPoint(world, live.targets, space, live.settings, lock);
}

export function snapWorldTranslation(
  sources: SnapSource,
  desired: Point,
  space: SnapSpace,
  renderer: StageRenderer,
  lock?: SnapLock,
  ignorePoints: Point[] = [],
  allowSelf = true,
): SnapResult {
  const live = collectLiveTargets(renderer, ignorePoints, allowSelf);
  if (!live) {
    return { x: desired.x, y: desired.y, dx: desired.x, dy: desired.y, guides: [] };
  }
  return snapTranslation(sources, desired, live.targets, space, live.settings, lock);
}

export function snapScreenPoint(
  screen: Point,
  space: SnapSpace,
  renderer: StageRenderer,
  lock?: SnapLock,
  ignorePoints: Point[] = [],
  allowSelf = true,
): SnapResult & { screen: Point } {
  const world = space.screenToWorld(screen.x, screen.y);
  const r = snapWorldPoint(
    world,
    space,
    renderer,
    lock,
    ignorePoints,
    allowSelf,
  );
  const s = space.worldToScreen(r.x, r.y);
  return { ...r, screen: { x: s.x, y: s.y } };
}
