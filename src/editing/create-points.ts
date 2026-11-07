/**
 * Create Points — Moho-style click-to-place vertices.
 * Click places points; click near the first (≥3) closes a shape.
 * Fill commits a kernel ring; stroke rasters to the pixel canvas
 * (traced like brush/lasso). Curve is per vertex (dock / Ctrl). Shift
 * constrains the rubber-band to H/V.
 */
import type { Point, CanvasConfig } from "../geometry/types";
import { pixelToViewport, viewportToPixel } from "../geometry/coords";
import type { StageRenderer } from "../render/stage-renderer";
import type { Px, Ring } from "../vector/kernel";
import { flattenRing } from "../vector/rings";
import { commitPaint, viewportToWorldAffine, worldRings } from "../vector/paint";
import type { ChromeLayer } from "../render/chrome-layer";
import type { Camera } from "../render/camera";
import {
  configStore,
  colorStore,
  toolSettingsStore,
  modifiersStore,
} from "../state/index";
import {
  isPaintModeModifierHeld,
  isConstrainMoveModifierHeld,
} from "../input/shortcuts";
import { constrainAxisScreenDelta } from "./transform-gizmo";
import { setSnapGuides, snapWorldPoint, type SnapGuide } from "./snap";
import type { PaintMode, PaintStyle } from "../tools/paint-mode";

const CLOSE_HIT_PX = 12;

type CurveKind = "smooth" | "straight";

interface DraftVertex {
  x: number;
  y: number;
  curve: CurveKind;
}

export class CreatePointsController {
  private config: CanvasConfig;
  private renderer: StageRenderer;
  private camera: Camera;
  private chromeLayer: ChromeLayer;
  private onSnapshot?: () => void;
  /** Stroke style: pixel-space polyline for the usual trace pipeline. */
  private onRasterStroke?: (
    pixelPoints: Point[],
    paint: PaintMode,
    insideClip: Px | null | undefined,
  ) => void;

  /** Draft vertices in world space, each with its own curve kind. */
  private points: DraftVertex[] = [];
  private hoverWorld: Point | null = null;
  private snapGuides: SnapGuide[] = [];
  /** Inside mode: clip target captured on the first click. */
  private insideClip: Px | null | undefined = undefined;

  constructor(
    renderer: StageRenderer,
    camera: Camera,
    chromeLayer: ChromeLayer,
  ) {
    this.renderer = renderer;
    this.camera = camera;
    this.chromeLayer = chromeLayer;
    this.config = configStore.get();
    configStore.subscribe((config) => {
      this.config = config;
    });

    toolSettingsStore.subscribe(() => {
      // Persisted mode → straight: sharpen the open end (current vert).
      if (this.points.length > 0 && this.storedCurveMode() === "straight") {
        this.sharpenCurrent();
      }
      if (this.points.length > 0) this.drawUI();
    });
    // Ctrl only previews both ends as straight until a click commits it.
    modifiersStore.subscribe(() => {
      if (this.points.length > 0) this.drawUI();
    });
  }

  setSnapshotCallback(callback: () => void): void {
    this.onSnapshot = callback;
  }

  setRasterStrokeCallback(
    callback: (
      pixelPoints: Point[],
      paint: PaintMode,
      insideClip: Px | null | undefined,
    ) => void,
  ): void {
    this.onRasterStroke = callback;
  }

  hasDraft(): boolean {
    return this.points.length > 0;
  }

  handleStart(point: Point): void {
    const raw = this.toWorld(point);

    if (this.points.length >= 3 && this.isNearFirstScreen(this.camera.worldToScreen(raw.x, raw.y))) {
      this.snapGuides = [];
      this.commitClosed();
      return;
    }

    const world = this.snapDraftPoint(this.constrainWorldFromLast(raw));

    if (this.points.length === 0 && this.paintMode() === "inside") {
      const vp = pixelToViewport(point, this.config);
      const w = this.camera.screenToWorld(vp.x, vp.y);
      const hit = this.renderer.hitTest(w, "active");
      this.insideClip = hit && hit.kind === "face" ? w : null;
    }

    const mode = this.effectiveCurveMode();
    // Straight segment: current (last) + next both sharp.
    if (mode === "straight") this.sharpenCurrent();
    this.points.push({ ...world, curve: mode });
    this.hoverWorld = world;
    this.drawUI();
  }

  handleMove(point: Point): void {
    this.hoverWorld = this.snapDraftHover(this.toWorld(point));
    this.drawUI();
  }

  /** Rubber-band while idle (no button down). */
  handleHover(point: Point): void {
    if (this.points.length === 0) {
      this.hoverWorld = null;
      this.snapGuides = [];
      setSnapGuides([]);
      return;
    }
    this.hoverWorld = this.snapDraftHover(this.toWorld(point));
    this.drawUI();
  }

  handleEnd(): void {
    // Point is placed on start; nothing to commit per-gesture.
  }

  handleCancel(): void {
    this.clearDraft();
  }

  clearDraft(): void {
    this.insideClip = undefined;
    this.snapGuides = [];
    setSnapGuides([]);
    if (this.points.length === 0 && !this.hoverWorld) {
      this.chromeLayer.clear();
      return;
    }
    this.points = [];
    this.hoverWorld = null;
    this.chromeLayer.clear();
  }

  drawUI(): void {
    this.chromeLayer.clear();
    if (this.points.length === 0) {
      setSnapGuides([]);
      return;
    }

    const ctx = this.chromeLayer.getContext();
    const color = colorStore.get();
    const straightPending = this.effectiveCurveMode() === "straight";
    const screenVerts = this.points.map((p, i) => {
      const screen = this.camera.worldToScreen(p.x, p.y);
      // While straight is active, show current (last) vert as sharp too.
      const curve =
        straightPending && i === this.points.length - 1 ? "straight" : p.curve;
      return { x: screen.x, y: screen.y, curve };
    });
    const hoverScreen = this.hoverWorld
      ? this.camera.worldToScreen(this.hoverWorld.x, this.hoverWorld.y)
      : null;
    const closing =
      hoverScreen != null &&
      this.points.length >= 3 &&
      this.isNearFirstScreen(hoverScreen);

    const previewVerts: DraftVertex[] = screenVerts.map((v) => ({
      x: v.x,
      y: v.y,
      curve: v.curve,
    }));
    if (hoverScreen && !closing) {
      previewVerts.push({
        x: hoverScreen.x,
        y: hoverScreen.y,
        curve: this.effectiveCurveMode(),
      });
    } else if (closing && straightPending) {
      // Closing segment: first + last both sharp.
      previewVerts[0].curve = "straight";
      previewVerts[previewVerts.length - 1].curve = "straight";
    }

    if (previewVerts.length >= 2) {
      const preview = sampleMixedPath(previewVerts, closing);
      const strokeStyle = this.paintStyle() === "stroke";
      this.chromeLayer.drawLassoPreview(preview, {
        closed: closing,
        fill: closing && !strokeStyle,
        fillColor: color,
        strokeColor: "#000000",
      });
    }

    setSnapGuides(this.snapGuides);

    const r = 4;
    for (let i = 0; i < screenVerts.length; i++) {
      const p = screenVerts[i];
      const isFirst = i === 0;
      ctx.fillStyle = closing && isFirst ? color : "#000000";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (p.curve === "smooth") {
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      } else {
        ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
      }
      ctx.fill();
      ctx.stroke();
    }
  }

  private sharpenCurrent(): void {
    const last = this.points[this.points.length - 1];
    if (last) last.curve = "straight";
  }

  private storedCurveMode(): CurveKind {
    return (toolSettingsStore.get()["create-points"] as { curve?: string } | undefined)
      ?.curve === "straight"
      ? "straight"
      : "smooth";
  }

  /** Stored curve, flipped while dock modifier (Ctrl) is held. */
  private effectiveCurveMode(): CurveKind {
    const stored = this.storedCurveMode();
    if (!isPaintModeModifierHeld(modifiersStore.get())) return stored;
    return stored === "smooth" ? "straight" : "smooth";
  }

  private paintMode(): PaintMode {
    const mode = (toolSettingsStore.get()["create-points"] as { mode?: string } | undefined)
      ?.mode;
    if (mode === "subtract" || mode === "inside") return mode;
    return "add";
  }

  private paintStyle(): PaintStyle {
    return (toolSettingsStore.get()["create-points"] as { style?: string } | undefined)
      ?.style === "stroke"
      ? "stroke"
      : "fill";
  }

  private toWorld(point: Point): Point {
    const vp = pixelToViewport(point, this.config);
    const w = this.camera.screenToWorld(vp.x, vp.y);
    return { x: w.x, y: w.y };
  }

  /** Snap next point to H/V from the last placed vertex (screen-space). */
  private constrainWorldFromLast(world: Point): Point {
    if (
      this.points.length === 0 ||
      !isConstrainMoveModifierHeld(modifiersStore.get())
    ) {
      return world;
    }
    const last = this.points[this.points.length - 1];
    const lastScreen = this.camera.worldToScreen(last.x, last.y);
    const curScreen = this.camera.worldToScreen(world.x, world.y);
    const d = constrainAxisScreenDelta(
      curScreen.x - lastScreen.x,
      curScreen.y - lastScreen.y,
      true,
    );
    const snapped = this.camera.screenToWorld(
      lastScreen.x + d.x,
      lastScreen.y + d.y,
    );
    return { x: snapped.x, y: snapped.y };
  }

  /** Axis-lock rubber-band, but don't fight the close-shape hotspot. */
  private constrainHover(world: Point): Point {
    if (
      this.points.length >= 3 &&
      this.isNearFirstScreen(this.camera.worldToScreen(world.x, world.y))
    ) {
      return world;
    }
    return this.constrainWorldFromLast(world);
  }

  private snapDraftHover(world: Point): Point {
    const constrained = this.constrainHover(world);
    if (
      this.points.length >= 3 &&
      this.isNearFirstScreen(this.camera.worldToScreen(constrained.x, constrained.y))
    ) {
      this.snapGuides = [];
      return constrained;
    }
    return this.snapDraftPoint(constrained);
  }

  private snapDraftPoint(world: Point): Point {
    const snapped = snapWorldPoint(world, this.camera, this.renderer);
    this.snapGuides = snapped.guides;
    return { x: snapped.x, y: snapped.y };
  }

  private isNearFirstScreen(screen: Point): boolean {
    const first = this.points[0];
    if (!first) return false;
    const fs = this.camera.worldToScreen(first.x, first.y);
    const dx = screen.x - fs.x;
    const dy = screen.y - fs.y;
    return dx * dx + dy * dy <= CLOSE_HIT_PX * CLOSE_HIT_PX;
  }

  private commitClosed(): void {
    if (this.points.length < 3) return;

    // Closing while straight: sharpen both ends of the closing segment.
    if (this.effectiveCurveMode() === "straight") {
      this.sharpenCurrent();
      this.points[0].curve = "straight";
    }

    // Shape APIs expect viewport/screen coords.
    const screenVerts = this.points.map((p) => ({
      ...this.camera.worldToScreen(p.x, p.y),
      curve: p.curve,
    }));
    const paint = this.paintMode();

    if (this.paintStyle() === "stroke" && this.onRasterStroke) {
      const samples = sampleMixedPath(screenVerts, true);
      const pixelPoints = samples.map((p) => viewportToPixel(p, this.config));
      const clip = this.insideClip;
      this.points = [];
      this.hoverWorld = null;
      this.insideClip = undefined;
      this.snapGuides = [];
      setSnapGuides([]);
      this.chromeLayer.clear();
      this.onRasterStroke(pixelPoints, paint, clip);
      return;
    }

    this.commitFillPath(screenVerts, paint);
    this.points = [];
    this.snapGuides = [];
    setSnapGuides([]);
    this.hoverWorld = null;
    this.insideClip = undefined;
    this.chromeLayer.clear();
  }

  private commitFillPath(screenVerts: DraftVertex[], paint: PaintMode): void {
    const ring = buildMixedRing(screenVerts);
    if (!ring) return;
    const rings = worldRings([ring], viewportToWorldAffine(this.camera));
    const changed = commitPaint(this.renderer, rings, paint, colorStore.get(), this.insideClip ?? null);
    if (changed) this.onSnapshot?.();
  }
}

/** Closed ring: Catmull-Rom cubics through smooth verts, straight lines at sharp verts. */
function buildMixedRing(verts: DraftVertex[]): Ring | null {
  const n = verts.length;
  if (n < 3) return null;
  const smooth = verts.some((v) => v.curve === "smooth");
  if (!smooth) {
    return { start: { x: verts[0].x, y: verts[0].y }, segs: verts.slice(1).map((v) => ({ kind: "L" as const, to: { x: v.x, y: v.y } })) };
  }
  const tangent = (i: number): Px => {
    if (verts[i].curve !== "smooth") return { x: 0, y: 0 };
    const prev = verts[(i - 1 + n) % n];
    const next = verts[(i + 1) % n];
    return { x: (next.x - prev.x) / 6, y: (next.y - prev.y) / 6 };
  };
  const segs: Ring["segs"] = [];
  for (let i = 0; i < n; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    const ta = tangent(i);
    const tb = tangent((i + 1) % n);
    if (ta.x === 0 && ta.y === 0 && tb.x === 0 && tb.y === 0) {
      segs.push({ kind: "L", to: { x: b.x, y: b.y } });
    } else {
      segs.push({
        kind: "C",
        c1: { x: a.x + ta.x, y: a.y + ta.y },
        c2: { x: b.x - tb.x, y: b.y - tb.y },
        to: { x: b.x, y: b.y },
      });
    }
  }
  return { start: { x: verts[0].x, y: verts[0].y }, segs };
}

function sampleMixedPath(verts: DraftVertex[], _closed: boolean): Point[] {
  if (!verts.some((v) => v.curve === "smooth") || verts.length < 3) {
    return verts.map((v) => ({ x: v.x, y: v.y }));
  }
  const ring = buildMixedRing(verts);
  if (!ring) return verts.map((v) => ({ x: v.x, y: v.y }));
  const pts = flattenRing(ring, 10);
  return pts.length >= 2 ? pts : verts.map((v) => ({ x: v.x, y: v.y }));
}
