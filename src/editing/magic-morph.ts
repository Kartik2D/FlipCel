/**
 * Magic Morph — chart-only tool.
 *
 * Draw a timing chart (trajectory + ticks), Apply morphs the covering hold
 * (pose A) toward the next keyframe (pose B) at Dedouze chart ratios.
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
  magicMorphUiStore,
  layerStore,
} from "../state/index";
import { pixelToViewport } from "../geometry/coords";
import {
  parseTimingChart,
  morphRatiosFromChart,
  evenFramesBetween,
  type ChartStroke,
} from "./magic-move-graph";
import { morphLayerJson } from "./magic-morph-blend";
import { timelineStore, layerJsonEquals } from "../document/document";

interface Settings {
  scope: "active" | "all";
  divisions: number;
  density: number;
  stickiness: number;
  simplify: number;
}

/**
 * Divisions slider max — at this value, Apply fills every frame of the span
 * (like Auto Morph's "Every frame") instead of packing `divisions` inbetweens.
 * Keep in sync with the `divisions` range max in `tools/stubs.ts`.
 */
const EVERY_FRAME_DIVISIONS = 12;

/**
 * Interpolate a morph-progress curve (intermediate ratios at even time steps,
 * endpoints implied at 0 and 1) at time fraction `u` in [0, 1].
 */
function sampleRatioCurve(curve: number[], u: number): number {
  const pts = [0, ...curve, 1];
  const pos = Math.max(0, Math.min(1, u)) * (pts.length - 1);
  const i = Math.min(pts.length - 2, Math.floor(pos));
  const frac = pos - i;
  const v = pts[i] + (pts[i + 1] - pts[i]) * frac;
  return Math.max(0, Math.min(1, v));
}

function accent(): string {
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue("--inkwell-accent")
      .trim() || "#4d73d7"
  );
}

function thinRatios(ratios: number[], keep: number): number[] {
  if (keep >= ratios.length) return ratios.slice();
  if (keep <= 0) return [];
  if (keep === 1) return [ratios[Math.floor(ratios.length / 2)]];
  const out: number[] = [];
  for (let i = 0; i < keep; i++) {
    out.push(ratios[Math.round((i * (ratios.length - 1)) / (keep - 1))]);
  }
  return out;
}

export class MagicMorphController {
  private config: CanvasConfig;
  private paperRenderer: PaperRenderer;
  private camera: Camera;
  private chromeLayer: ChromeLayer;
  private documentManager: DocumentManager | null = null;
  private historyManager: HistoryManager | null = null;

  private chartStrokesWorldPts: Point[][] = [];
  private liveChartStroke: Point[] | null = null;

  constructor(
    paperRenderer: PaperRenderer,
    camera: Camera,
    chromeLayer: ChromeLayer,
  ) {
    this.paperRenderer = paperRenderer;
    this.camera = camera;
    this.chromeLayer = chromeLayer;
    this.config = configStore.get();
    configStore.subscribe((c) => {
      this.config = c;
    });
    toolSettingsStore.subscribe(() => {
      this.publishUi();
      if (this.hasTransientUI()) this.drawUI();
    });
  }

  setDocumentManager(dm: DocumentManager): void {
    this.documentManager = dm;
  }

  setHistoryManager(hm: HistoryManager): void {
    this.historyManager = hm;
  }

  hasTransientUI(): boolean {
    return this.chartStrokesWorldPts.length > 0 || this.liveChartStroke !== null;
  }

  canApply(): boolean {
    if (!this.documentManager || this.chartStrokesWorldPts.length < 2) return false;
    const { divisions } = this.readSettings();
    const strokes = this.chartStrokes();
    if (!morphRatiosFromChart(strokes, divisions).ok) return false;
    return this.targetLayerIds().some(
      (id) => this.documentManager!.getMagicMorphSpan(id) !== null,
    );
  }

  handleStart(point: Point): void {
    this.liveChartStroke = [pixelToViewport(point, this.config)];
    this.drawUI();
  }

  handleMove(point: Point): void {
    if (!this.liveChartStroke) return;
    this.liveChartStroke.push(pixelToViewport(point, this.config));
    this.drawUI();
  }

  handleEnd(): void {
    if (this.liveChartStroke && this.liveChartStroke.length >= 2) {
      this.chartStrokesWorldPts.push(
        this.liveChartStroke.map((p) => {
          const w = this.camera.screenToWorld(p.x, p.y);
          return { x: w.x, y: w.y };
        }),
      );
    }
    this.liveChartStroke = null;
    this.drawUI();
    this.publishUi({ openPopup: true });
  }

  handleCancel(): void {
    if (this.liveChartStroke) {
      this.liveChartStroke = null;
    } else if (this.chartStrokesWorldPts.length > 0) {
      this.chartStrokesWorldPts = [];
    } else {
      this.deactivate();
      return;
    }
    this.drawUI();
    this.publishUi();
  }

  deactivate(): void {
    this.chartStrokesWorldPts = [];
    this.liveChartStroke = null;
    this.chromeLayer.clear();
    magicMorphUiStore.set({
      canApply: false,
      popupOpen: false,
      popupX: 0,
      popupY: 0,
    });
  }

  apply(): { ok: true } | { ok: false; error: string } {
    if (!this.documentManager || !this.historyManager) {
      return { ok: false, error: "Magic Morph is not wired up." };
    }

    this.documentManager.commitDirtyLayerContent();

    const { divisions, density, stickiness, simplify } = this.readSettings();
    const morphOpts = { density, stickiness, simplify };
    const ratioResult = morphRatiosFromChart(this.chartStrokes(), divisions);
    if (!ratioResult.ok) return ratioResult;

    const spans = this.targetLayerIds()
      .map((layerId) => {
        const span = this.documentManager!.getMagicMorphSpan(layerId);
        return span ? { layerId, ...span } : null;
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    if (spans.length === 0) {
      return {
        ok: false,
        error:
          "Place the playhead on a hold that has a next keyframe with space between them.",
      };
    }

    let packStart = spans[0].startFrame;
    let packEnd = spans[0].endFrame;
    for (const s of spans) {
      packStart = Math.max(packStart, s.startFrame);
      packEnd = Math.min(packEnd, s.endFrame);
    }
    if (packEnd - packStart < 2) {
      return { ok: false, error: "Not enough frames between poses." };
    }

    let ratios: number[];
    let frames: number[];
    if (divisions >= EVERY_FRAME_DIVISIONS) {
      // Slider maxed → inbetween on every frame of the span, with progress
      // still eased by the chart's timing curve.
      frames = [];
      ratios = [];
      const spanLen = packEnd - packStart;
      for (let f = packStart + 1; f < packEnd; f++) {
        frames.push(f);
        ratios.push(sampleRatioCurve(ratioResult.ratios, (f - packStart) / spanLen));
      }
    } else {
      ratios = ratioResult.ratios;
      frames = evenFramesBetween(packStart, packEnd, ratios.length);
      if (frames.length < ratios.length) ratios = thinRatios(ratios, frames.length);
      else if (frames.length > ratios.length) frames = frames.slice(0, ratios.length);
    }
    if (frames.length === 0) {
      return { ok: false, error: "Could not place inbetween frames." };
    }

    for (let li = 0; li < spans.length; li++) {
      const span = spans[li];
      const publish = li === spans.length - 1;
      for (let i = 0; i < frames.length; i++) {
        const json = morphLayerJson(
          span.startJson,
          span.endJson,
          ratios[i] ?? 0,
          morphOpts,
        );
        if (!json) continue;
        this.documentManager.writeLayerContentAtFrame(span.layerId, frames[i], json, {
          publish: false,
        });
      }
      this.documentManager.bridgeKeyframeHolds(span.layerId, frames, {
        publish: false,
        holdLast: true,
      });
      const last = frames[frames.length - 1];
      this.documentManager.extendKeyframeHoldThrough(
        span.layerId,
        last,
        span.endFrame - 1,
        { publish },
      );
    }

    for (const span of spans) {
      this.documentManager.invalidateLoadedLayer(span.layerId);
    }
    this.documentManager.reloadVisibleFrame();
    this.historyManager.snapshot();
    this.deactivate();
    return { ok: true };
  }

  /**
   * Auto Morph: for every hold in [start, end] on the given layers that has
   * a next keyframe, write morphed inbetweens toward that keyframe — on
   * every frame of the gap, or at `divisions` evenly spaced steps.
   */
  autoMorphRange(
    layerIds: string[],
    start: number,
    end: number,
    opts: { mode: "every" | "divisions"; divisions: number },
  ): { ok: true } | { ok: false; error: string } {
    if (!this.documentManager || !this.historyManager) {
      return { ok: false, error: "Magic Morph is not wired up." };
    }
    this.documentManager.commitDirtyLayerContent();

    const { density, stickiness, simplify } = this.readSettings();
    const morphOpts = { density, stickiness, simplify };
    // Snapshot before writing: morph inbetweens insert keyframes, and we
    // only want to process the holds that existed at click time.
    const tracks = timelineStore.get().tracks;

    const touched: string[] = [];
    for (const layerId of layerIds) {
      const track = tracks.find((t) => t.id === layerId);
      if (!track) continue;
      let changed = false;
      for (const kf of track.keyframes) {
        if (kf.frame < start || kf.frame > end || kf.blank) continue;
        const span = this.documentManager.getMagicMorphSpan(layerId, kf.frame);
        if (!span || span.startFrame !== kf.frame) continue;
        // Identical poses (moving hold / duplicated keyframe): morphing would
        // only write static frames — leave the hold alone.
        if (layerJsonEquals(span.startJson, span.endJson)) continue;

        const spanLen = span.endFrame - span.startFrame;
        const frames: number[] = [];
        const ratios: number[] = [];
        if (opts.mode === "every") {
          for (let f = span.startFrame + 1; f < span.endFrame; f++) {
            frames.push(f);
            ratios.push((f - span.startFrame) / spanLen);
          }
        } else {
          const d = Math.max(2, Math.round(opts.divisions));
          for (let i = 1; i < d; i++) {
            const ratio = i / d;
            const f = Math.round(span.startFrame + ratio * spanLen);
            if (f <= span.startFrame || f >= span.endFrame) continue;
            if (frames[frames.length - 1] === f) continue;
            frames.push(f);
            ratios.push(ratio);
          }
        }
        if (frames.length === 0) continue;

        for (let i = 0; i < frames.length; i++) {
          const json = morphLayerJson(
            span.startJson,
            span.endJson,
            ratios[i] ?? 0,
            morphOpts,
          );
          if (!json) continue;
          this.documentManager.writeLayerContentAtFrame(
            layerId,
            frames[i],
            json,
            { publish: false },
          );
        }
        this.documentManager.bridgeKeyframeHolds(layerId, frames, {
          publish: false,
          holdLast: true,
        });
        this.documentManager.extendKeyframeHoldThrough(
          layerId,
          frames[frames.length - 1],
          span.endFrame - 1,
          { publish: true },
        );
        changed = true;
      }
      if (changed) touched.push(layerId);
    }

    if (touched.length === 0) {
      return {
        ok: false,
        error: "No holds with a next keyframe in the selection.",
      };
    }
    for (const layerId of touched) {
      this.documentManager.invalidateLoadedLayer(layerId);
    }
    this.documentManager.reloadVisibleFrame();
    this.historyManager.snapshot();
    return { ok: true };
  }

  drawUI(): void {
    this.chromeLayer.clear();
    const color = accent();
    for (const stroke of this.chartStrokesWorldPts) {
      this.chromeLayer.drawChartStroke(this.toViewport(stroke), color);
    }
    this.drawDivisionMarks(color);
    if (this.liveChartStroke && this.liveChartStroke.length >= 2) {
      this.chromeLayer.drawChartStroke(this.liveChartStroke, color);
    }
  }

  // --- internals ---

  private chartStrokes(): ChartStroke[] {
    return this.chartStrokesWorldPts.map((points) => ({ points }));
  }

  private readSettings(): Settings {
    const settings = toolSettingsStore.get();
    const raw = (settings["magic-morph"] ??
      settings["shape-tween"]) as Partial<Settings>;
    return {
      scope: raw?.scope === "active" ? "active" : "all",
      divisions: typeof raw?.divisions === "number" ? raw.divisions : 1,
      density: typeof raw?.density === "number" ? raw.density : 1,
      stickiness: typeof raw?.stickiness === "number" ? raw.stickiness : 0,
      simplify: typeof raw?.simplify === "number" ? raw.simplify : 0,
    };
  }

  private targetLayerIds(): string[] {
    if (!this.documentManager) return [];
    if (this.readSettings().scope === "active") {
      const id =
        this.paperRenderer.getActiveLayerId() ?? layerStore.get().activeLayerId;
      return id ? [id] : [];
    }
    return this.documentManager.getSelectableLayerIds();
  }

  private toViewport(points: Point[]): Point[] {
    return points.map((p) => {
      const s = this.camera.worldToScreen(p.x, p.y);
      return { x: s.x, y: s.y };
    });
  }

  private drawDivisionMarks(color: string): void {
    const divisions = Math.max(1, Math.round(this.readSettings().divisions));
    if (divisions <= 1 || this.chartStrokesWorldPts.length < 2) return;
    const parsed = parseTimingChart(this.chartStrokes(), divisions);
    if (!parsed.ok) return;
    const marks: Array<{ x: number; y: number; tx: number; ty: number }> = [];
    for (const sample of parsed.samples) {
      if (sample.stepIndex <= 0 || sample.stepIndex >= divisions) continue;
      const screen = this.camera.worldToScreen(sample.x, sample.y);
      const tip = this.camera.worldToScreen(
        sample.x + sample.tx,
        sample.y + sample.ty,
      );
      let tx = tip.x - screen.x;
      let ty = tip.y - screen.y;
      const len = Math.hypot(tx, ty) || 1;
      marks.push({ x: screen.x, y: screen.y, tx: tx / len, ty: ty / len });
    }
    if (marks.length) this.chromeLayer.drawChartDivisionMarks(marks, color);
  }

  private publishUi(opts?: { openPopup?: boolean }): void {
    const canApply = this.canApply();
    const prev = magicMorphUiStore.get();
    let { popupOpen, popupX, popupY } = prev;
    if (!canApply) {
      popupOpen = false;
    } else if (opts?.openPopup || popupOpen) {
      const anchor = this.popupAnchor();
      if (anchor) {
        if (opts?.openPopup) popupOpen = true;
        popupX = anchor.x;
        popupY = anchor.y;
      }
    }
    magicMorphUiStore.set({ canApply, popupOpen, popupX, popupY });
  }

  private popupAnchor(): { x: number; y: number } | null {
    const canvasRect = this.chromeLayer.getCanvas().getBoundingClientRect();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let any = false;
    const add = (pts: Point[]) => {
      for (const p of pts) {
        any = true;
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    };
    for (const s of this.chartStrokesWorldPts) add(this.toViewport(s));
    if (this.liveChartStroke) add(this.liveChartStroke);
    if (!any) return null;
    return {
      x: canvasRect.left + (minX + maxX) / 2,
      y: canvasRect.top + maxY + 12,
    };
  }
}
