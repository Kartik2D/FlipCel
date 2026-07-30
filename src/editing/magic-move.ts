/**
 * Magic Move Controller
 *
 * Multi-group tool:
 * 1. Lasso-select artwork (first lasso via marquee)
 * 2. Draw timing-chart strokes for that lasso
 * 3. Draw an almost-circle stroke to start another lasso (color-coded)
 * 4. Apply bakes each lasso along its own chart
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
  scalesForSamples,
  type ChartStroke,
} from "./magic-move-graph";

type Phase = "select" | "chart";

interface MagicMoveSettings {
  scope: "active" | "all";
  timing: "step" | "duration";
  step: number;
  duration: number;
  divisions: number;
  position: "off" | "relative" | "exact";
  scale: "off" | "on";
  orient: "fixed" | "direction";
}

/** One lasso selection + its timing chart, sharing a chrome color. */
interface MagicMoveGroup {
  color: string;
  items: paper.PathItem[];
  chartStrokesWorldPts: Point[][];
  /** Closed lasso outline in world space (for color-coded chrome). */
  lassoWorldPts: Point[] | null;
}

const GROUP_COLORS = [
  "#4d73d7",
  "#e07a3d",
  "#3daa7a",
  "#c44d8a",
  "#8b6bc7",
  "#d4a017",
] as const;

function readAccentColor(): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--flipcel-accent")
    .trim();
  return value || GROUP_COLORS[0];
}

function groupColorAt(index: number): string {
  return GROUP_COLORS[index % GROUP_COLORS.length] ?? GROUP_COLORS[0];
}

function strokeLength(points: Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y,
    );
  }
  return len;
}

/**
 * Near-closed, roughly circular stroke → treat as a new Magic Move lasso
 * (viewport/screen space). Short ticks and open trajectories stay charts.
 */
function isAlmostCircleStroke(points: Point[]): boolean {
  if (points.length < 10) return false;
  const perim = strokeLength(points);
  if (perim < 48) return false;

  const start = points[0];
  const end = points[points.length - 1];
  const gap = Math.hypot(end.x - start.x, end.y - start.y);
  if (gap / perim > 0.22) return false;

  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= points.length;
  cy /= points.length;

  const radii = points.map((p) => Math.hypot(p.x - cx, p.y - cy));
  const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
  if (mean < 14) return false;

  let variance = 0;
  for (const r of radii) variance += (r - mean) ** 2;
  variance /= radii.length;
  const cv = Math.sqrt(variance) / mean;
  return cv < 0.28;
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
  if (frame >= frames[last]) {
    return { ...samples[Math.min(last, samples.length - 1)] };
  }

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

function scaleAtFrame(
  frame: number,
  frames: number[],
  scales: number[],
): number {
  if (scales.length === 0) return 1;
  if (frames.length === 0) return scales[0];
  if (frame <= frames[0] || scales.length === 1) return scales[0];
  const last = frames.length - 1;
  if (frame >= frames[last]) {
    return scales[Math.min(last, scales.length - 1)];
  }
  let i = 0;
  while (i < last - 1 && frames[i + 1] < frame) i++;
  const f0 = frames[i];
  const f1 = frames[i + 1];
  const s0 = scales[Math.min(i, scales.length - 1)];
  const s1 = scales[Math.min(i + 1, scales.length - 1)];
  const span = Math.max(1, f1 - f0);
  return s0 + (s1 - s0) * ((frame - f0) / span);
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
  private groups: MagicMoveGroup[] = [];
  private pendingExtractionSnapshot: Map<string, paper.PathItem[]> | null =
    null;
  private selectionNeedsPlacement = false;

  private marquee = new MarqueeTracker();
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
    toolSettingsStore.subscribe(() => {
      if (!this.hasTransientUI()) return;
      this.publishUi();
      this.drawUI();
    });
  }

  setDocumentManager(dm: DocumentManager): void {
    this.documentManager = dm;
  }

  setHistoryManager(hm: HistoryManager): void {
    this.historyManager = hm;
  }

  private liveItems(group: MagicMoveGroup): paper.PathItem[] {
    return group.items.filter((item) => item.parent);
  }

  private allLiveItems(): paper.PathItem[] {
    const out: paper.PathItem[] = [];
    for (const group of this.groups) {
      out.push(...this.liveItems(group));
    }
    return out;
  }

  private activeGroup(): MagicMoveGroup | null {
    return this.groups.length > 0 ? this.groups[this.groups.length - 1] : null;
  }

  private syncSelectionStore(): void {
    selectionStore.set({ items: [...this.allLiveItems()] });
  }

  hasSelection(): boolean {
    return this.allLiveItems().length > 0;
  }

  hasTransientUI(): boolean {
    return (
      this.hasSelection() ||
      this.marquee.isTracking() ||
      this.groups.some((g) => g.chartStrokesWorldPts.length > 0) ||
      this.liveChartStroke !== null
    );
  }

  private groupChartOk(group: MagicMoveGroup, divisions: number): boolean {
    if (this.liveItems(group).length === 0) return false;
    const strokes: ChartStroke[] = group.chartStrokesWorldPts.map((points) => ({
      points,
    }));
    return parseTimingChart(strokes, divisions).ok;
  }

  canApply(): boolean {
    if (this.phase !== "chart" || this.groups.length === 0) return false;
    const settings = this.readSettings();
    const withItems = this.groups.filter((g) => this.liveItems(g).length > 0);
    if (withItems.length === 0) return false;
    return withItems.every((g) => this.groupChartOk(g, settings.divisions));
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
   * Union of selections + chart strokes in client (fixed) coordinates, padded
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
      this.allLiveItems(),
    );
    if (sel) {
      includeScreen(sel.x, sel.y);
      includeScreen(sel.x + sel.width, sel.y + sel.height);
    }

    const includeViewportStroke = (pts: Point[]) => {
      for (const p of pts) includeScreen(p.x, p.y);
    };

    for (const group of this.groups) {
      if (group.lassoWorldPts) {
        includeViewportStroke(this.worldStrokeToViewport(group.lassoWorldPts));
      }
      for (const stroke of group.chartStrokesWorldPts) {
        includeViewportStroke(this.worldStrokeToViewport(stroke));
      }
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
      {
        x: (avoid.left + avoid.right) / 2,
        y: avoid.bottom + gap,
      },
      {
        x: (avoid.left + avoid.right) / 2,
        y: avoid.top - gap - popupH,
      },
      {
        x: avoid.right + gap + popupW / 2,
        y: (avoid.top + avoid.bottom) / 2 - popupH / 2,
      },
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
      this.resetGroups();
      this.marquee.start(viewportPoint);
      this.drawUI();
      this.publishUi();
      return;
    }

    // Chart phase: start a free stroke (chart tick/path, or almost-circle lasso).
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
        this.beginGroupFromLasso(lassoPoints);
      } else {
        this.resetGroups();
        this.phase = "select";
      }
      this.marquee.reset();
      this.drawUI();
      this.publishUi();
      return;
    }

    if (this.liveChartStroke) {
      const viewportStroke = this.liveChartStroke;
      this.liveChartStroke = null;

      if (viewportStroke.length >= 10 && isAlmostCircleStroke(viewportStroke)) {
        this.beginGroupFromLasso(viewportStroke);
      } else if (viewportStroke.length >= 2) {
        const active = this.activeGroup();
        if (active) {
          active.chartStrokesWorldPts.push(
            viewportStroke.map((p) => {
              const w = this.camera.screenToWorld(p.x, p.y);
              return { x: w.x, y: w.y };
            }),
          );
        }
      }

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
    const active = this.activeGroup();
    if (active && active.chartStrokesWorldPts.length > 0) {
      active.chartStrokesWorldPts = [];
      this.drawUI();
      this.publishUi();
      return;
    }
    if (this.groups.length > 1) {
      // Drop the newest lasso group; keep earlier ones.
      this.groups.pop();
      this.selectionNeedsPlacement = this.groups.length > 0;
      this.pendingExtractionSnapshot = null;
      this.syncSelectionStore();
      this.drawUI();
      this.publishUi();
      return;
    }
    if (this.hasSelection()) {
      this.revertPendingSelection();
      this.resetGroups();
      this.phase = "select";
      this.drawUI();
      this.publishUi();
    }
  }

  /** Leave the tool: place or revert selection, clear charts. */
  deactivate(): void {
    this.liveChartStroke = null;
    if (this.selectionNeedsPlacement && this.hasSelection()) {
      this.placeSelection();
    } else if (this.selectionNeedsPlacement) {
      this.revertPendingSelection();
    }
    this.resetGroups();
    this.marquee.reset();
    this.phase = "select";
    this.chromeLayer.clear();
    this.publishUi();
  }

  discardSelection(): void {
    this.revertPendingSelection();
    this.resetGroups();
    this.phase = "select";
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
    const bakeGroups = this.groups.filter((g) => this.liveItems(g).length > 0);
    if (bakeGroups.length === 0) {
      return { ok: false, error: "Lasso a selection first." };
    }

    const layerIds = new Set<string>();
    type BakeResult = {
      layerIds: string[];
      lastFrame: number;
      positionMode: "off" | "relative" | "exact";
      finalSample: { x: number; y: number };
      finalRelativeDelta: { x: number; y: number };
      finalRotateDeg: number;
      finalScale: number;
      childIndicesByLayer: Map<string, number[]>;
      frame1JsonByLayer: Map<string, string>;
      frame1SizeByLayer: Map<string, number>;
      scaleEnabled: boolean;
    };
    const bakeResults: BakeResult[] = [];

    for (let gi = 0; gi < bakeGroups.length; gi++) {
      const group = bakeGroups[gi];
      const result = this.bakeGroup(group, settings, {
        publish: false,
      });
      if (!result.ok) {
        return {
          ok: false,
          error:
            bakeGroups.length > 1
              ? `Lasso ${gi + 1}: ${result.error}`
              : result.error,
        };
      }
      for (const id of result.layerIds) layerIds.add(id);
      bakeResults.push(result);
    }

    // Shorter lassos hold their final pose through the longest group's end.
    const maxLastFrame = bakeResults.reduce(
      (max, r) => Math.max(max, r.lastFrame),
      0,
    );
    if (maxLastFrame >= this.documentManager.getDuration()) {
      this.documentManager.setDuration(maxLastFrame + 1);
    }
    for (const result of bakeResults) {
      if (result.lastFrame >= maxLastFrame) continue;
      this.holdGroupFinalPoseThrough(result, maxLastFrame);
    }

    this.selectionNeedsPlacement = false;
    this.pendingExtractionSnapshot = null;
    this.resetGroups();
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

  private bakeGroup(
    group: MagicMoveGroup,
    settings: MagicMoveSettings,
    options: { publish: boolean },
  ):
    | {
        ok: true;
        layerIds: string[];
        lastFrame: number;
        positionMode: "off" | "relative" | "exact";
        finalSample: { x: number; y: number };
        finalRelativeDelta: { x: number; y: number };
        finalRotateDeg: number;
        finalScale: number;
        childIndicesByLayer: Map<string, number[]>;
        frame1JsonByLayer: Map<string, string>;
        frame1SizeByLayer: Map<string, number>;
        scaleEnabled: boolean;
      }
    | { ok: false; error: string } {
    if (!this.documentManager) {
      return { ok: false, error: "Magic Move is not wired up." };
    }

    const selectedItems = this.liveItems(group);
    const strokes: ChartStroke[] = group.chartStrokesWorldPts.map((points) => ({
      points,
    }));
    const parsed = parseTimingChart(strokes, settings.divisions);
    if (!parsed.ok) return parsed;

    const { samples, tickCount, tickScales } = parsed;
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

    const bounds = this.paperRenderer.getCombinedBounds(selectedItems);
    if (!bounds) {
      return { ok: false, error: "Selection has no bounds." };
    }

    const sample0 = samples[0];
    const relativeDeltas = samples.map((s) => ({
      x: s.x - sample0.x,
      y: s.y - sample0.y,
    }));
    const orientToDirection = settings.orient === "direction";
    const orientRotations = orientToDirection
      ? orientRotationsDeg(samples)
      : samples.map(() => 0);
    const scaleEnabled = settings.scale === "on";
    const sampleScales = scaleEnabled
      ? scalesForSamples(samples, tickScales, settings.divisions)
      : samples.map(() => 1);

    const byLayer = new Map<string, paper.PathItem[]>();
    for (const item of selectedItems) {
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
    const positionMode = settings.position;
    const exactPosition = positionMode === "exact";
    const positionEnabled = positionMode !== "off";
    const sampleFrameSet = new Set(frames);
    const childIndicesByLayer = new Map<string, number[]>();

    const layerBake = new Map<
      string,
      {
        childIndices: number[];
        /** Artwork at the first Magic Move sample (scale baseline). */
        frame1Json: string;
        sourceJson: string;
        existingInRange: Map<number, string>;
        frame1Size: number;
      }
    >();

    for (const layerId of layerIds) {
      const layerItems = byLayer.get(layerId) ?? [];
      const childIndices =
        this.paperRenderer.getEmfBucketChildIndices(layerItems);
      childIndicesByLayer.set(layerId, childIndices);
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
      const frame1Json =
        existingInRange.get(firstFrame) ??
        this.documentManager.getExactKeyframeContentAtFrame(
          layerId,
          firstFrame,
        ) ??
        sourceJson;
      const frame1Size = this.paperRenderer.getLayerJsonChildrenSize(
        frame1Json,
        childIndices,
      );
      layerBake.set(layerId, {
        childIndices,
        frame1Json,
        sourceJson,
        existingInRange,
        frame1Size,
      });
    }

    const positionedJson = (
      baseJson: string,
      childIndices: number[],
      sample: { x: number; y: number },
      relativeDelta: { x: number; y: number },
      rotateDeg: number,
      tickScale: number,
      frame1Size: number,
    ): string => {
      if (!baseJson) return "";
      if (childIndices.length === 0) return baseJson;
      // Tick scale is relative to frame 1: targetSize = frame1Size * tickScale.
      // Convert to a multiplier on whatever artwork we're transforming now.
      let scale = tickScale;
      if (scaleEnabled && frame1Size > 1e-6) {
        const currentSize = this.paperRenderer.getLayerJsonChildrenSize(
          baseJson,
          childIndices,
        );
        if (currentSize > 1e-6) {
          scale = (frame1Size * tickScale) / currentSize;
        }
      }
      return this.paperRenderer.transformLayerJsonChildren(
        baseJson,
        childIndices,
        !positionEnabled
          ? { rotateDeg, scale }
          : exactPosition
            ? { moveCenterTo: sample, rotateDeg, scale }
            : { delta: relativeDelta, rotateDeg, scale },
      );
    };

    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const frame = frames[i];

      for (const layerId of layerIds) {
        const bake = layerBake.get(layerId)!;
        // Scale is always relative to frame 1 artwork. With scale on, bake from
        // frame 1 content so later ticks don't compound off other keyframes.
        // Position-only (scale off) still preserves per-frame existing art.
        const existing = bake.existingInRange.get(frame);
        const baseJson = scaleEnabled
          ? bake.frame1Json
          : existing !== undefined
            ? existing
            : bake.sourceJson;
        const json = positionedJson(
          baseJson,
          bake.childIndices,
          sample,
          relativeDeltas[i],
          orientRotations[i] ?? 0,
          sampleScales[i] ?? 1,
          bake.frame1Size,
        );
        this.documentManager.writeLayerContentAtFrame(layerId, frame, json, {
          publish: false,
        });
      }
    }

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
        const tickScale = scaleAtFrame(frame, frames, sampleScales);
        const baseJson = scaleEnabled ? bake.frame1Json : existing;
        const json = positionedJson(
          baseJson,
          bake.childIndices,
          sample,
          relativeDelta,
          rotationAtFrame(frame, frames, orientRotations),
          tickScale,
          bake.frame1Size,
        );
        this.documentManager.writeLayerContentAtFrame(layerId, frame, json, {
          publish: false,
        });
      }
    }

    for (let i = 0; i < layerIds.length; i++) {
      const isLast = i === layerIds.length - 1;
      this.documentManager.bridgeKeyframeHolds(layerIds[i], frames, {
        publish: options.publish && isLast,
      });
    }

    const lastIdx = samples.length - 1;
    return {
      ok: true,
      layerIds,
      lastFrame,
      positionMode,
      finalSample: samples[lastIdx] ?? sample0,
      finalRelativeDelta: relativeDeltas[lastIdx] ?? { x: 0, y: 0 },
      finalRotateDeg: orientRotations[lastIdx] ?? 0,
      finalScale: sampleScales[lastIdx] ?? 1,
      childIndicesByLayer,
      frame1JsonByLayer: new Map(
        [...layerBake.entries()].map(([id, b]) => [id, b.frame1Json]),
      ),
      frame1SizeByLayer: new Map(
        [...layerBake.entries()].map(([id, b]) => [id, b.frame1Size]),
      ),
      scaleEnabled,
    };
  }

  /**
   * Keep a shorter lasso’s final pose through `throughFrame`: extend the last
   * sample’s hold, and patch any later keyframes (e.g. from a longer lasso on
   * the same layer) so this group’s shapes stay put.
   */
  private holdGroupFinalPoseThrough(
    result: {
      layerIds: string[];
      lastFrame: number;
      positionMode: "off" | "relative" | "exact";
      finalSample: { x: number; y: number };
      finalRelativeDelta: { x: number; y: number };
      finalRotateDeg: number;
      finalScale: number;
      childIndicesByLayer: Map<string, number[]>;
      frame1JsonByLayer: Map<string, string>;
      frame1SizeByLayer: Map<string, number>;
      scaleEnabled: boolean;
    },
    throughFrame: number,
  ): void {
    if (!this.documentManager) return;

    for (const layerId of result.layerIds) {
      this.documentManager.extendKeyframeHoldThrough(
        layerId,
        result.lastFrame,
        throughFrame,
        { publish: false },
      );

      const childIndices = result.childIndicesByLayer.get(layerId) ?? [];
      if (childIndices.length === 0) continue;

      const laterKeys = this.documentManager.getKeyframeFramesInRange(
        layerId,
        result.lastFrame + 1,
        throughFrame,
      );
      for (const frame of laterKeys) {
        const existing =
          this.documentManager.getExactKeyframeContentAtFrame(layerId, frame);
        if (existing === null || !existing) continue;
        const frame1Json = result.frame1JsonByLayer.get(layerId) ?? existing;
        const frame1Size = result.frame1SizeByLayer.get(layerId) ?? 0;
        const baseJson = result.scaleEnabled ? frame1Json : existing;
        let scale = result.finalScale;
        if (result.scaleEnabled && frame1Size > 1e-6) {
          const currentSize = this.paperRenderer.getLayerJsonChildrenSize(
            baseJson,
            childIndices,
          );
          if (currentSize > 1e-6) {
            scale = (frame1Size * result.finalScale) / currentSize;
          }
        }
        const positionEnabled = result.positionMode !== "off";
        const json = this.paperRenderer.transformLayerJsonChildren(
          baseJson,
          childIndices,
          !positionEnabled
            ? {
                rotateDeg: result.finalRotateDeg,
                scale,
              }
            : result.positionMode === "exact"
              ? {
                  moveCenterTo: result.finalSample,
                  rotateDeg: result.finalRotateDeg,
                  scale,
                }
              : {
                  delta: result.finalRelativeDelta,
                  rotateDeg: result.finalRotateDeg,
                  scale,
                },
        );
        this.documentManager.writeLayerContentAtFrame(layerId, frame, json, {
          publish: false,
        });
      }
    }
  }

  // ============================================================
  // Drawing
  // ============================================================

  drawUI(): void {
    this.chromeLayer.clear();
    const nextColor = groupColorAt(this.groups.length);

    for (const group of this.groups) {
      const items = this.liveItems(group);
      if (items.length > 0) {
        this.paperRenderer.drawAccentSelectionOutline(
          items,
          this.chromeCtx,
          group.color,
        );
      }
      if (group.lassoWorldPts && group.lassoWorldPts.length >= 3) {
        this.chromeLayer.drawLassoPreview(
          this.worldStrokeToViewport(group.lassoWorldPts),
          {
            denseDash: true,
            fill: true,
            closed: true,
            strokeColor: group.color,
            fillColor: group.color,
            glow: true,
          },
        );
      }
      for (const stroke of group.chartStrokesWorldPts) {
        this.chromeLayer.drawChartStroke(
          this.worldStrokeToViewport(stroke),
          group.color,
        );
      }
      this.drawGroupDivisionMarks(group);
    }

    if (this.liveChartStroke && this.liveChartStroke.length >= 2) {
      const active = this.activeGroup();
      const liveIsLasso = isAlmostCircleStroke(this.liveChartStroke);
      const color = liveIsLasso
        ? nextColor
        : (active?.color ?? readAccentColor());
      if (liveIsLasso) {
        this.chromeLayer.drawLassoPreview(this.liveChartStroke, {
          denseDash: true,
          fill: true,
          closed: true,
          strokeColor: color,
          fillColor: color,
          glow: true,
        });
      } else {
        this.chromeLayer.drawChartStroke(this.liveChartStroke, color);
      }
    }

    if (this.marquee.isTracking()) {
      const color = groupColorAt(0);
      this.chromeLayer.drawLassoPreview(this.marquee.getLassoPoints(), {
        denseDash: true,
        fill: true,
        closed: true,
        strokeColor: color,
        fillColor: color,
        glow: true,
      });
    }
  }

  /** Short hashes on the trajectory for Divisions > 1 intermediates. */
  private drawGroupDivisionMarks(group: MagicMoveGroup): void {
    const divisions = Math.max(1, Math.round(this.readSettings().divisions));
    if (divisions <= 1 || group.chartStrokesWorldPts.length < 2) return;

    const strokes: ChartStroke[] = group.chartStrokesWorldPts.map((points) => ({
      points,
    }));
    const parsed = parseTimingChart(strokes, divisions);
    if (!parsed.ok) return;

    const marks: Array<{ x: number; y: number; tx: number; ty: number }> = [];
    for (const sample of parsed.samples) {
      // Intermediate subdivision samples only (not the user-drawn tick hits).
      if (sample.stepIndex <= 0 || sample.stepIndex >= divisions) continue;
      const screen = this.camera.worldToScreen(sample.x, sample.y);
      const tip = this.camera.worldToScreen(
        sample.x + sample.tx,
        sample.y + sample.ty,
      );
      let tx = tip.x - screen.x;
      let ty = tip.y - screen.y;
      const len = Math.hypot(tx, ty) || 1;
      tx /= len;
      ty /= len;
      marks.push({ x: screen.x, y: screen.y, tx, ty });
    }
    if (marks.length === 0) return;
    this.chromeLayer.drawChartDivisionMarks(marks, group.color);
  }

  // ============================================================
  // Internals
  // ============================================================

  private beginGroupFromLasso(lassoViewportPts: Point[]): void {
    // Commit prior group carves before cutting a new selection.
    if (this.selectionNeedsPlacement && this.hasSelection()) {
      this.placeSelection();
      this.documentManager?.commitDirtyLayerContent();
    }

    const scope = this.readSettings().scope;
    this.pendingExtractionSnapshot =
      this.paperRenderer.captureSelectableLayersSnapshot(scope);
    const items = this.paperRenderer.extractSelectionFromScreenLasso(
      lassoViewportPts,
      scope,
      this.activeFrameItemFilter(),
    );

    if (items.length === 0) {
      this.pendingExtractionSnapshot = null;
      if (this.groups.length === 0) this.phase = "select";
      this.syncSelectionStore();
      return;
    }

    const color = groupColorAt(this.groups.length);
    const lassoWorldPts = lassoViewportPts.map((p) => {
      const w = this.camera.screenToWorld(p.x, p.y);
      return { x: w.x, y: w.y };
    });

    this.groups.push({
      color,
      items,
      chartStrokesWorldPts: [],
      lassoWorldPts,
    });
    this.selectionNeedsPlacement = true;
    this.phase = "chart";

    const layerId = this.paperRenderer.getTopmostSelectedLayerId(items);
    if (layerId) {
      this.paperRenderer.setActiveLayer(layerId);
      layerStore.update((s) => ({ ...s, activeLayerId: layerId }));
    }
    this.syncSelectionStore();
  }

  private resetGroups(): void {
    this.groups = [];
    this.selectionNeedsPlacement = false;
    this.pendingExtractionSnapshot = null;
    this.liveChartStroke = null;
    selectionStore.set({ items: [] });
  }

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
      scope: raw.scope === "active" ? "active" : "all",
      timing: raw.timing === "duration" ? "duration" : "step",
      step: typeof raw.step === "number" ? raw.step : 1,
      duration: typeof raw.duration === "number" ? raw.duration : 48,
      divisions,
      position:
        raw.position === "exact"
          ? "exact"
          : raw.position === "off"
            ? "off"
            : "relative",
      scale: raw.scale === "on" ? "on" : "off",
      orient: raw.orient === "direction" ? "direction" : "fixed",
    };
  }

  private worldStrokeToViewport(points: Point[]): Point[] {
    return points.map((p) => {
      const s = this.camera.worldToScreen(p.x, p.y);
      return { x: s.x, y: s.y };
    });
  }

  private placeSelection(): void {
    for (const item of this.allLiveItems()) {
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
