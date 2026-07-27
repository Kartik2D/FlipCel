/**
 * Magic Move Controller
 *
 * Two-phase tool:
 * 1. Lasso-select artwork (dense dashed preview + soft accent glow)
 * 2. Draw timing-chart strokes (stroke-only + glow), then Apply via popup
 *
 * Apply bakes position keyframes along the Paper trajectory between ticks,
 * with Divisions subdividing each tick interval along the path arc.
 */
import type { Point, CanvasConfig } from "../geometry/types";
import type { PaperRenderer } from "../render/paper-renderer";
import type { Camera } from "../render/camera";
import type { ChromeLayer } from "../render/chrome-layer";
import type { DocumentManager } from "../document/document";
import type { HistoryManager } from "../document/history";
import {
  configStore,
  toolSettingsStore,
  selectionStore,
  magicMoveUiStore,
  layerStore,
} from "../state/index";
import { pixelToViewport } from "../geometry/coords";
import { MarqueeTracker } from "./marquee";
import {
  parseTimingChart,
  mapSamplesToFrames,
  type ChartStroke,
} from "./magic-move-graph";

type Phase = "select" | "chart";

interface MagicMoveSettings {
  timing: "step" | "duration";
  step: number;
  duration: number;
  divisions: number;
  position: "relative" | "exact";
  orient: "fixed" | "direction";
}

function readAccentColor(): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--inkwell-accent")
    .trim();
  return value || "#4d73d7";
}

/** Path tangent at sample index (forward difference, last uses backward). */
function tangentAtSample(
  samples: Array<{ x: number; y: number }>,
  index: number,
): { x: number; y: number } {
  if (samples.length < 2) return { x: 1, y: 0 };
  if (index < samples.length - 1) {
    const a = samples[index];
    const b = samples[index + 1];
    return { x: b.x - a.x, y: b.y - a.y };
  }
  const a = samples[index - 1];
  const b = samples[index];
  return { x: b.x - a.x, y: b.y - a.y };
}

function angleDegOf(v: { x: number; y: number }): number {
  if (v.x === 0 && v.y === 0) return 0;
  return (Math.atan2(v.y, v.x) * 180) / Math.PI;
}

/** Shortest-path lerp between degrees. */
function lerpAngleDeg(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return a + d * t;
}

/**
 * Rotation (degrees) relative to the path’s starting tangent so the first
 * sample keeps the drawn orientation and later samples follow the path.
 */
function orientRotationsDeg(
  samples: Array<{ x: number; y: number }>,
): number[] {
  if (samples.length === 0) return [];
  const base = angleDegOf(tangentAtSample(samples, 0));
  return samples.map((_, i) => angleDegOf(tangentAtSample(samples, i)) - base);
}

/** Interpolate a path sample for a frame between Magic Move bake frames. */
function sampleAtFrame(
  frame: number,
  frames: number[],
  samples: Array<{ x: number; y: number }>,
): { x: number; y: number } {
  if (samples.length === 0) return { x: 0, y: 0 };
  if (frames.length === 0) return { ...samples[0] };
  if (frame <= frames[0] || samples.length === 1) return { ...samples[0] };
  const last = frames.length - 1;
  if (frame >= frames[last]) return { ...samples[Math.min(last, samples.length - 1)] };

  let i = 0;
  while (i < last - 1 && frames[i + 1] < frame) i++;
  const f0 = frames[i];
  const f1 = frames[i + 1];
  const s0 = samples[Math.min(i, samples.length - 1)];
  const s1 = samples[Math.min(i + 1, samples.length - 1)];
  const span = Math.max(1, f1 - f0);
  const t = (frame - f0) / span;
  return {
    x: s0.x + (s1.x - s0.x) * t,
    y: s0.y + (s1.y - s0.y) * t,
  };
}

function rotationAtFrame(
  frame: number,
  frames: number[],
  rotations: number[],
): number {
  if (rotations.length === 0) return 0;
  if (frames.length === 0) return rotations[0];
  if (frame <= frames[0] || rotations.length === 1) return rotations[0];
  const last = frames.length - 1;
  if (frame >= frames[last]) {
    return rotations[Math.min(last, rotations.length - 1)];
  }
  let i = 0;
  while (i < last - 1 && frames[i + 1] < frame) i++;
  const f0 = frames[i];
  const f1 = frames[i + 1];
  const r0 = rotations[Math.min(i, rotations.length - 1)];
  const r1 = rotations[Math.min(i + 1, rotations.length - 1)];
  const span = Math.max(1, f1 - f0);
  return lerpAngleDeg(r0, r1, (frame - f0) / span);
}

export class MagicMoveController {
  private config: CanvasConfig;
  private paperRenderer: PaperRenderer;
  private camera: Camera;
  private chromeLayer: ChromeLayer;
  private chromeCtx: CanvasRenderingContext2D;
  private documentManager: DocumentManager | null = null;
  private historyManager: HistoryManager | null = null;

  private phase: Phase = "select";
  private selectedItems: paper.PathItem[] = [];
  private pendingExtractionSnapshot: Map<string, paper.PathItem[]> | null =
    null;
  private selectionNeedsPlacement = false;

  private marquee = new MarqueeTracker();
  /** Committed chart strokes in world/stage space. */
  private chartStrokesWorldPts: Point[][] = [];
  /** Live stroke being drawn in chart phase (viewport space). */
  private liveChartStroke: Point[] | null = null;

  constructor(
    paperRenderer: PaperRenderer,
    camera: Camera,
    chromeLayer: ChromeLayer,
  ) {
    this.paperRenderer = paperRenderer;
    this.camera = camera;
    this.chromeLayer = chromeLayer;
    this.chromeCtx = chromeLayer.getContext();
    this.config = configStore.get();
    configStore.subscribe((config) => {
      this.config = config;
    });
  }

  setDocumentManager(dm: DocumentManager): void {
    this.documentManager = dm;
  }

  setHistoryManager(hm: HistoryManager): void {
    this.historyManager = hm;
  }

  hasSelection(): boolean {
    return this.selectedItems.some((item) => item.parent);
  }

  hasTransientUI(): boolean {
    return (
      this.hasSelection() ||
      this.marquee.isTracking() ||
      this.chartStrokesWorldPts.length > 0 ||
      this.liveChartStroke !== null
    );
  }

  canApply(): boolean {
    if (!this.hasSelection() || this.phase !== "chart") return false;
    if (this.chartStrokesWorldPts.length < 2) return false;
    const settings = this.readSettings();
    const strokes: ChartStroke[] = this.chartStrokesWorldPts.map((points) => ({
      points,
    }));
    return parseTimingChart(strokes, settings.divisions).ok;
  }

  private publishUi(opts?: { openPopup?: boolean }): void {
    const canApply = this.canApply();
    const prev = magicMoveUiStore.get();
    let popupOpen = prev.popupOpen;
    let popupX = prev.popupX;
    let popupY = prev.popupY;

    if (!canApply) {
      popupOpen = false;
    } else if (opts?.openPopup || popupOpen) {
      const anchor = this.popupAnchorClient();
      if (anchor) {
        if (opts?.openPopup) popupOpen = true;
        popupX = anchor.x;
        popupY = anchor.y;
      }
    }

    magicMoveUiStore.set({ canApply, popupOpen, popupX, popupY });
  }

  /**
   * Union of selection + chart strokes in client (fixed) coordinates, padded
   * so the Apply popup can sit outside the artwork.
   */
  private contentAvoidRectClient(): {
    left: number;
    top: number;
    right: number;
    bottom: number;
  } | null {
    const canvasRect = this.chromeLayer.getCanvas().getBoundingClientRect();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let any = false;

    const includeScreen = (sx: number, sy: number) => {
      any = true;
      minX = Math.min(minX, sx);
      minY = Math.min(minY, sy);
      maxX = Math.max(maxX, sx);
      maxY = Math.max(maxY, sy);
    };

    const sel = this.paperRenderer.getSelectionFrameScreenBounds(
      this.selectedItems.filter((item) => item.parent),
    );
    if (sel) {
      includeScreen(sel.x, sel.y);
      includeScreen(sel.x + sel.width, sel.y + sel.height);
    }

    const includeViewportStroke = (pts: Point[]) => {
      for (const p of pts) includeScreen(p.x, p.y);
    };

    for (const stroke of this.chartStrokesWorldPts) {
      includeViewportStroke(this.worldStrokeToViewport(stroke));
    }
    if (this.liveChartStroke) {
      includeViewportStroke(this.liveChartStroke);
    }

    if (!any) return null;

    const pad = 16;
    return {
      left: canvasRect.left + minX - pad,
      top: canvasRect.top + minY - pad,
      right: canvasRect.left + maxX + pad,
      bottom: canvasRect.top + maxY + pad,
    };
  }

  /** Place popup outside selection+stroke bounds; prefer below, then above/right/left. */
  private popupAnchorClient(): { x: number; y: number } | null {
    const avoid = this.contentAvoidRectClient();
    if (!avoid) return null;

    const popupW = 150;
    const popupH = 78;
    const gap = 12;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const candidates: Array<{ x: number; y: number }> = [
      // Below center
      {
        x: (avoid.left + avoid.right) / 2,
        y: avoid.bottom + gap,
      },
      // Above center
      {
        x: (avoid.left + avoid.right) / 2,
        y: avoid.top - gap - popupH,
      },
      // Right middle
      {
        x: avoid.right + gap + popupW / 2,
        y: (avoid.top + avoid.bottom) / 2 - popupH / 2,
      },
      // Left middle
      {
        x: avoid.left - gap - popupW / 2,
        y: (avoid.top + avoid.bottom) / 2 - popupH / 2,
      },
    ];

    const fits = (x: number, y: number) => {
      const left = x - popupW / 2;
      const top = y;
      return (
        left >= margin &&
        top >= margin &&
        left + popupW <= vw - margin &&
        top + popupH <= vh - margin
      );
    };

    const overlapsAvoid = (x: number, y: number) => {
      const left = x - popupW / 2;
      const top = y;
      const right = left + popupW;
      const bottom = top + popupH;
      return !(
        right < avoid.left ||
        left > avoid.right ||
        bottom < avoid.top ||
        top > avoid.bottom
      );
    };

    for (const c of candidates) {
      if (fits(c.x, c.y) && !overlapsAvoid(c.x, c.y)) return c;
    }

    // Fallback: clamp preferred-below into the viewport, even if slightly tight.
    let x = (avoid.left + avoid.right) / 2;
    let y = avoid.bottom + gap;
    x = Math.min(Math.max(x, margin + popupW / 2), vw - margin - popupW / 2);
    y = Math.min(Math.max(y, margin), vh - margin - popupH);
    return { x, y };
  }

  // ============================================================
  // Pointer
  // ============================================================

  handleStart(point: Point): void {
    const viewportPoint = pixelToViewport(point, this.config);

    if (this.phase === "select" || !this.hasSelection()) {
      this.phase = "select";
      this.clearChart();
      this.revertPendingSelection();
      this.selectedItems = [];
      this.selectionNeedsPlacement = false;
      selectionStore.set({ items: [] });
      this.marquee.start(viewportPoint);
      this.drawUI();
      this.publishUi();
      return;
    }

    // Chart phase: start a new open stroke
    magicMoveUiStore.update((s) => ({ ...s, popupOpen: false }));
    this.liveChartStroke = [viewportPoint];
    this.drawUI();
  }

  handleMove(point: Point): void {
    const viewportPoint = pixelToViewport(point, this.config);

    if (this.marquee.isTracking()) {
      this.marquee.update(viewportPoint, "lasso");
      this.drawUI();
      return;
    }

    if (this.liveChartStroke) {
      this.liveChartStroke.push(viewportPoint);
      this.drawUI();
    }
  }

  handleEnd(): void {
    if (this.marquee.isTracking()) {
      const lassoPoints = this.marquee.getLassoPoints();
      if (this.marquee.hasActiveMarquee("lasso") && lassoPoints.length >= 3) {
        this.pendingExtractionSnapshot =
          this.paperRenderer.captureSelectableLayersSnapshot("all");
        this.selectedItems = this.paperRenderer.extractSelectionFromScreenLasso(
          lassoPoints,
          "all",
          this.activeFrameItemFilter(),
        );
        this.selectionNeedsPlacement = this.selectedItems.length > 0;
        if (!this.selectionNeedsPlacement) {
          this.pendingExtractionSnapshot = null;
          this.phase = "select";
        } else {
          this.phase = "chart";
          const layerId = this.paperRenderer.getTopmostSelectedLayerId(
            this.selectedItems,
          );
          if (layerId) {
            this.paperRenderer.setActiveLayer(layerId);
            layerStore.update((s) => ({ ...s, activeLayerId: layerId }));
          }
        }
        selectionStore.set({ items: [...this.selectedItems] });
      } else {
        this.selectedItems = [];
        this.pendingExtractionSnapshot = null;
        this.selectionNeedsPlacement = false;
        selectionStore.set({ items: [] });
        this.phase = "select";
      }
      this.marquee.reset();
      this.drawUI();
      this.publishUi();
      return;
    }

    if (this.liveChartStroke) {
      if (this.liveChartStroke.length >= 2) {
        this.chartStrokesWorldPts.push(
          this.liveChartStroke.map((p) => {
            const w = this.camera.screenToWorld(p.x, p.y);
            return { x: w.x, y: w.y };
          }),
        );
      }
      this.liveChartStroke = null;
      this.drawUI();
      this.publishUi({ openPopup: this.canApply() });
    }
  }

  handleCancel(): void {
    if (this.marquee.isTracking()) {
      this.marquee.reset();
      this.drawUI();
      this.publishUi();
      return;
    }
    if (this.liveChartStroke) {
      this.liveChartStroke = null;
      this.drawUI();
      this.publishUi();
      return;
    }
    if (this.chartStrokesWorldPts.length > 0) {
      this.clearChart();
      this.drawUI();
      this.publishUi();
      return;
    }
    if (this.hasSelection()) {
      this.revertPendingSelection();
      this.selectedItems = [];
      this.selectionNeedsPlacement = false;
      selectionStore.set({ items: [] });
      this.phase = "select";
      this.drawUI();
      this.publishUi();
    }
  }

  /** Leave the tool: place or revert selection, clear chart. */
  deactivate(): void {
    this.clearChart();
    if (this.selectionNeedsPlacement && this.hasSelection()) {
      this.placeSelection();
    } else if (this.selectionNeedsPlacement) {
      this.revertPendingSelection();
    }
    this.selectedItems = [];
    this.selectionNeedsPlacement = false;
    this.pendingExtractionSnapshot = null;
    this.marquee.reset();
    this.liveChartStroke = null;
    this.phase = "select";
    selectionStore.set({ items: [] });
    this.chromeLayer.clear();
    this.publishUi();
  }

  discardSelection(): void {
    this.revertPendingSelection();
    this.selectedItems = [];
    this.selectionNeedsPlacement = false;
    this.pendingExtractionSnapshot = null;
    this.clearChart();
    this.phase = "select";
    selectionStore.set({ items: [] });
    this.drawUI();
    this.publishUi();
  }

  // ============================================================
  // Apply
  // ============================================================

  apply(): { ok: true } | { ok: false; error: string } {
    if (!this.documentManager || !this.historyManager) {
      return { ok: false, error: "Magic Move is not wired up." };
    }
    if (!this.hasSelection()) {
      return { ok: false, error: "Lasso a selection first." };
    }

    // Persist any lasso carve (and EMF bucket edits) before reading document JSON.
    this.documentManager.commitDirtyLayerContent();

    const settings = this.readSettings();
    const strokes: ChartStroke[] = this.chartStrokesWorldPts.map((points) => ({
      points,
    }));
    const parsed = parseTimingChart(strokes, settings.divisions);
    if (!parsed.ok) return parsed;

    const { samples, tickCount } = parsed;
    const framesPerTick =
      settings.timing === "duration"
        ? Math.max(1, Math.ceil(settings.duration / Math.max(1, tickCount - 1)))
        : Math.max(1, Math.round(settings.step));

    const startFrame = this.documentManager.getCurrentFrame();
    const frames = mapSamplesToFrames(
      samples.length,
      tickCount,
      settings.divisions,
      startFrame,
      framesPerTick,
    );

    const lastFrame = frames[frames.length - 1] ?? startFrame;
    if (lastFrame >= this.documentManager.getDuration()) {
      this.documentManager.setDuration(lastFrame + 1);
    }

    const bounds = this.paperRenderer.getCombinedBounds(this.selectedItems);
    if (!bounds) {
      return { ok: false, error: "Selection has no bounds." };
    }

    const sample0 = samples[0];
    // Relative: offset from the first path sample. Exact snaps each frame’s
    // selected-content center onto the sample (ignores hand-drawn spacing).
    const relativeDeltas = samples.map((s) => ({
      x: s.x - sample0.x,
      y: s.y - sample0.y,
    }));
    const orientToDirection = settings.orient === "direction";
    const orientRotations = orientToDirection
      ? orientRotationsDeg(samples)
      : samples.map(() => 0);

    const byLayer = new Map<string, paper.PathItem[]>();
    for (const item of this.selectedItems) {
      if (!item.parent) continue;
      const layerId = this.paperRenderer.getLayerIdForPathItem(item);
      if (!layerId) continue;
      const list = byLayer.get(layerId) ?? [];
      list.push(item);
      byLayer.set(layerId, list);
    }
    if (byLayer.size === 0) {
      return { ok: false, error: "Selection is no longer on a layer." };
    }

    const layerIds = [...byLayer.keys()];
    const firstFrame = frames[0] ?? startFrame;
    const exactPosition = settings.position === "exact";
    const sampleFrameSet = new Set(frames);

    // Per layer: selection indices, playhead baseline, and every existing
    // keyframe in the bake range (samples + keys that will sit in hold gaps).
    const layerBake = new Map<
      string,
      {
        childIndices: number[];
        sourceJson: string;
        existingInRange: Map<number, string>;
      }
    >();

    for (const layerId of layerIds) {
      const layerItems = byLayer.get(layerId) ?? [];
      const childIndices =
        this.paperRenderer.getEmfBucketChildIndices(layerItems);
      const sourceJson = this.documentManager.getLayerContentAtFrame(
        layerId,
        startFrame,
      );
      const existingInRange = new Map<number, string>();
      for (const frame of this.documentManager.getKeyframeFramesInRange(
        layerId,
        firstFrame,
        lastFrame,
      )) {
        const exact = this.documentManager.getExactKeyframeContentAtFrame(
          layerId,
          frame,
        );
        if (exact !== null) existingInRange.set(frame, exact);
      }
      layerBake.set(layerId, { childIndices, sourceJson, existingInRange });
    }

    const positionedJson = (
      baseJson: string,
      childIndices: number[],
      sample: { x: number; y: number },
      relativeDelta: { x: number; y: number },
      rotateDeg: number,
    ): string => {
      if (!baseJson) return "";
      if (childIndices.length === 0) return baseJson;
      return this.paperRenderer.transformLayerJsonChildren(
        baseJson,
        childIndices,
        exactPosition
          ? { moveCenterTo: sample, rotateDeg }
          : { delta: relativeDelta, rotateDeg },
      );
    };

    // Write Magic Move sample keys. Existing keys keep their artwork; only
    // position is updated. Do not clear the range — keys in hold gaps stay.
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const frame = frames[i];

      for (const layerId of layerIds) {
        const bake = layerBake.get(layerId)!;
        const existing = bake.existingInRange.get(frame);
        const baseJson = existing !== undefined ? existing : bake.sourceJson;
        const json = positionedJson(
          baseJson,
          bake.childIndices,
          sample,
          relativeDeltas[i],
          orientRotations[i] ?? 0,
        );
        this.documentManager.writeLayerContentAtFrame(layerId, frame, json, {
          publish: false,
        });
      }
    }

    // Keyframes that sit inside a Magic Move hold span: keep content, only
    // move them onto the interpolated path position for that frame.
    for (const layerId of layerIds) {
      const bake = layerBake.get(layerId)!;
      for (const [frame, existing] of bake.existingInRange) {
        if (sampleFrameSet.has(frame)) continue;
        if (frame < firstFrame || frame > lastFrame) continue;
        const sample = sampleAtFrame(frame, frames, samples);
        const relativeDelta = {
          x: sample.x - sample0.x,
          y: sample.y - sample0.y,
        };
        const json = positionedJson(
          existing,
          bake.childIndices,
          sample,
          relativeDelta,
          rotationAtFrame(frame, frames, orientRotations),
        );
        this.documentManager.writeLayerContentAtFrame(layerId, frame, json, {
          publish: false,
        });
      }
    }

    // Hold each Magic Move step through the next sample, stopping before any
    // keyframe that remains in the gap.
    for (let i = 0; i < layerIds.length; i++) {
      this.documentManager.bridgeKeyframeHolds(layerIds[i], frames, {
        publish: i === layerIds.length - 1,
      });
    }

    this.selectionNeedsPlacement = false;
    this.pendingExtractionSnapshot = null;
    this.selectedItems = [];
    selectionStore.set({ items: [] });
    this.clearChart();
    this.phase = "select";

    for (const layerId of layerIds) {
      this.documentManager.invalidateLoadedLayer(layerId);
    }
    this.documentManager.reloadVisibleFrame();
    this.historyManager.snapshot();

    this.drawUI();
    this.publishUi();
    return { ok: true };
  }

  // ============================================================
  // Drawing
  // ============================================================

  drawUI(): void {
    this.chromeLayer.clear();
    const accent = readAccentColor();

    if (this.hasSelection()) {
      this.paperRenderer.drawAccentSelectionOutline(
        this.selectedItems,
        this.chromeCtx,
        accent,
      );
    }

    for (const stroke of this.chartStrokesWorldPts) {
      this.chromeLayer.drawChartStroke(
        this.worldStrokeToViewport(stroke),
        accent,
      );
    }
    if (this.liveChartStroke && this.liveChartStroke.length >= 2) {
      this.chromeLayer.drawChartStroke(this.liveChartStroke, accent);
    }

    if (this.marquee.isTracking()) {
      this.chromeLayer.drawLassoPreview(this.marquee.getLassoPoints(), {
        denseDash: true,
        fill: true,
        closed: true,
        strokeColor: accent,
        fillColor: accent,
        glow: true,
      });
    }
  }

  // ============================================================
  // Internals
  // ============================================================

  /**
   * While EMF is on, Magic Move may only lasso the active (playhead) frame’s
   * content — across all layers. Held content covering the playhead counts.
   */
  private activeFrameItemFilter():
    | ((item: paper.PathItem) => boolean)
    | undefined {
    const dm = this.documentManager;
    if (!dm?.isEditMultipleFrames()) return undefined;
    const playhead = dm.getCurrentFrame();
    return (item) => {
      const layerId = this.paperRenderer.getLayerIdForPathItem(item);
      if (!layerId) return false;
      const tag = this.paperRenderer.getEmfKeyframeFrame(item) ?? playhead;
      if (tag === playhead) return true;
      const covering = dm.getCoveringKeyframeFrame(layerId, playhead);
      return covering !== null && tag === covering;
    };
  }

  private readSettings(): MagicMoveSettings {
    const raw = toolSettingsStore.get()["magic-move"] as Partial<MagicMoveSettings> & {
      steps?: number;
    };
    const divisions =
      typeof raw.divisions === "number"
        ? raw.divisions
        : typeof raw.steps === "number"
          ? raw.steps
          : 1;
    return {
      timing: raw.timing === "duration" ? "duration" : "step",
      step: typeof raw.step === "number" ? raw.step : 1,
      duration: typeof raw.duration === "number" ? raw.duration : 48,
      divisions,
      position: raw.position === "exact" ? "exact" : "relative",
      orient: raw.orient === "direction" ? "direction" : "fixed",
    };
  }

  private worldStrokeToViewport(points: Point[]): Point[] {
    return points.map((p) => {
      const s = this.camera.worldToScreen(p.x, p.y);
      return { x: s.x, y: s.y };
    });
  }

  private clearChart(): void {
    this.chartStrokesWorldPts = [];
    this.liveChartStroke = null;
  }

  private placeSelection(): void {
    for (const item of this.selectedItems) {
      if (item.parent) this.paperRenderer.placeSelection(item);
    }
    this.selectionNeedsPlacement = false;
    this.pendingExtractionSnapshot = null;
  }

  private revertPendingSelection(): void {
    if (!this.pendingExtractionSnapshot) return;
    this.paperRenderer.restoreSelectableLayersSnapshot(
      this.pendingExtractionSnapshot,
    );
    this.pendingExtractionSnapshot = null;
    this.selectionNeedsPlacement = false;
  }
}
