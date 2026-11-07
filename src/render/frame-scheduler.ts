/**
 * Frame scheduler — the one place that decides what gets painted and when.
 *
 * Every canvas surface registers a painter. Anything that changes what a
 * surface shows calls `invalidate(mask)`; the scheduler coalesces those into
 * a single `requestAnimationFrame` and paints each dirty surface exactly
 * once, bottom to top. Surfaces that were not invalidated are not touched.
 *
 * Per-frame work that is not a paint (camera easing, playback stepping)
 * registers through `onFrame`. Callbacks return `true` while they still
 * need frames; once every callback is idle and nothing is dirty the loop
 * stops and the app costs nothing until the next `invalidate` / `wake`.
 *
 * `defer(key, fn)` runs `fn` once at the start of the next frame (before
 * painting), replacing any earlier `fn` queued under the same key. Use it to
 * coalesce bursty non-paint work (document color scans, thumbnails).
 *
 * The pixel canvas (live brush/lasso/shape) is deliberately not a scheduled
 * surface: those tools paint immediately for latency, and clearing the
 * whole surface per move is part of their effect.
 */

export const Surface = {
  /** #stage-canvas: artboard fill (StageLayer). */
  STAGE: 1,
  /** #paper-canvas: vector scene (StageRenderer). */
  PAPER: 2,
  /** #ui-canvas: grid, symmetry, snap guides, cursor ring (FeedbackLayer). */
  UI: 4,
  /** #chrome-canvas: selection chrome of the active controller. */
  CHROME: 8,
  ALL: 15,
} as const;
export type Surface = (typeof Surface)[keyof typeof Surface];

const ORDER = [Surface.STAGE, Surface.PAPER, Surface.UI, Surface.CHROME] as const;

const NAMES: Record<number, string> = {
  [Surface.STAGE]: "stage",
  [Surface.PAPER]: "paper",
  [Surface.UI]: "ui",
  [Surface.CHROME]: "chrome",
};

export type FrameCallback = (dtSeconds: number, nowMs: number) => boolean;

export class FrameScheduler {
  private dirty = 0;
  private painters = new Map<Surface, () => void>();
  private frameCallbacks = new Set<FrameCallback>();
  private deferred = new Map<string, () => void>();
  private rafId: number | null = null;
  private lastMs = 0;
  private painting = false;

  /** Dev counter: paints per surface since the last `resetStats()`. */
  readonly paints: Record<string, number> = { stage: 0, paper: 0, ui: 0, chrome: 0 };

  setPainter(surface: Surface, paint: () => void): void {
    this.painters.set(surface, paint);
  }

  /** Mark surfaces dirty; they repaint once on the next frame. */
  invalidate(mask: number): void {
    this.dirty |= mask;
    this.wake();
  }

  isDirty(surface: Surface): boolean {
    return (this.dirty & surface) !== 0;
  }

  /** Persistent per-frame hook. Returns `true` while it still needs frames. */
  onFrame(cb: FrameCallback): () => void {
    this.frameCallbacks.add(cb);
    this.wake();
    return () => this.frameCallbacks.delete(cb);
  }

  /** Run `fn` once at the start of the next frame; later calls with the same key replace it. */
  defer(key: string, fn: () => void): void {
    this.deferred.set(key, fn);
    this.wake();
  }

  /** Make sure a frame is scheduled (camera targets moved, playback started). */
  wake(): void {
    if (this.rafId !== null || this.painting) return;
    this.rafId =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(this.tick)
        : (setTimeout(() => this.tick(Date.now()), 16) as unknown as number);
  }

  /** Paint everything dirty right now (export, tests, resize handlers). */
  flushSync(): void {
    this.runDeferred();
    this.paintDirty();
  }

  resetStats(): void {
    for (const k of Object.keys(this.paints)) this.paints[k] = 0;
  }

  private tick = (now: number): void => {
    this.rafId = null;
    // First tick after idle has no previous timestamp; assume one 60Hz frame
    // so time-based callbacks (camera easing) make progress instead of
    // treating dt = 0 as "nothing to do" and letting the loop stop.
    const dt = this.lastMs ? Math.min(0.05, (now - this.lastMs) / 1000) : 1 / 60;
    this.lastMs = now;

    this.runDeferred();

    let keepTicking = false;
    for (const cb of this.frameCallbacks) {
      if (cb(dt, now)) keepTicking = true;
    }

    this.paintDirty();

    if (keepTicking || this.dirty !== 0 || this.deferred.size > 0) this.wake();
    else this.lastMs = 0;
  };

  private runDeferred(): void {
    if (this.deferred.size === 0) return;
    const jobs = [...this.deferred.values()];
    this.deferred.clear();
    for (const job of jobs) job();
  }

  private paintDirty(): void {
    if (this.dirty === 0) return;
    this.painting = true;
    try {
      for (const surface of ORDER) {
        if ((this.dirty & surface) === 0) continue;
        this.dirty &= ~surface;
        const paint = this.painters.get(surface);
        if (!paint) continue;
        this.paints[NAMES[surface]]++;
        paint();
      }
    } finally {
      this.painting = false;
    }
    // A painter may have invalidated something (e.g. chrome reading a
    // freshly re-laid-out selection); pick it up next frame, not now.
    if (this.dirty !== 0) this.wake();
  }
}

/** App-wide singleton. */
export const scheduler = new FrameScheduler();
