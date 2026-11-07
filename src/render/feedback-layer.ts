/**
 * UI Overlay - Visual Feedback Layer
 *
 * Draws UI elements and visual feedback on #ui-canvas.
 *
 * Key responsibilities:
 * - Optional brush-size ring (max brush diameter) while the brush tool is active
 * - Draws world-space grid at fixed spacing (pan/zoom/rotate with camera)
 * - Symmetry guides and live snap guides
 *
 * Nothing here paints directly: every setter marks the UI surface dirty on
 * the frame scheduler and `paint()` runs once per frame. The grid and
 * symmetry guides depend only on the camera and preferences, so they are
 * rendered into an offscreen bitmap that is re-rasterized only when one of
 * those inputs changes and blitted under the cursor ring otherwise.
 */
import type { Point, CanvasConfig } from "../geometry/types";
import type { Camera } from "./camera";
import {
  paintSizeScale,
  type SymmetrySettings,
  type ViewOverlaySettings,
} from "../state/index";
import { snapGuidesStore } from "../editing/snap";
import type { ToolId } from "../tools/registry";
import type { BrushTip } from "../tools/brush";
import { scheduler, Surface } from "./frame-scheduler";

export class FeedbackLayer {
  private ctx: CanvasRenderingContext2D;
  private config: CanvasConfig;
  private camera: Camera | null = null;
  private currentCursor: Point | null = null;
  private brushSizeIndicatorEnabled = true;
  private activeTool: ToolId = "brush";
  private gridEnabled = false;
  private gridSpacing = 100;
  private gridMajorEvery = 5;
  private gridMinorOpacity = 0.06;
  private gridMajorOpacity = 0.14;
  private symmetry: SymmetrySettings | null = null;
  private playbackActive = false;
  private isDrawing = false;
  private isMobile = false;
  private maxBrushSize = 12; // Default max brush size in pixel canvas units
  private brushTip: BrushTip = "circle";
  private brushTipAngle = 0;
  private magnetSize = 120; // Magnet brush diameter in viewport/screen pixels

  /** Cached grid + symmetry guides at the current camera/prefs. */
  private staticCanvas: HTMLCanvasElement | null = null;
  private staticKey = "";
  /** Whether the static bitmap has anything on it (skip the blit otherwise). */
  private staticHasContent = false;

  constructor(
    _canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    config: CanvasConfig,
  ) {
    this.ctx = ctx;
    this.config = config;
    this.detectMobile();
    snapGuidesStore.subscribe(() => this.invalidate());
  }

  private detectMobile() {
    // Detect mobile/touch devices
    this.isMobile = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  }

  private invalidate() {
    scheduler.invalidate(Surface.UI);
  }

  /**
   * Set the camera reference for world-to-screen transformations
   */
  setCamera(camera: Camera) {
    this.camera = camera;
    this.invalidate();
  }

  setBrushSizeIndicatorEnabled(enabled: boolean) {
    this.brushSizeIndicatorEnabled = enabled;
    this.invalidate();
  }

  setActiveTool(tool: ToolId) {
    this.activeTool = tool;
    this.invalidate();
  }

  setDrawingState(isDrawing: boolean) {
    if (this.isDrawing === isDrawing) return;
    this.isDrawing = isDrawing;
    this.invalidate();
  }

  updateConfig(config: CanvasConfig) {
    this.config = config;
    this.syncCanvasResolution();
    this.invalidate();
  }

  setMaxBrushSize(size: number) {
    this.maxBrushSize = size;
    this.invalidate();
  }

  setBrushTip(tip: BrushTip) {
    this.brushTip = tip;
    this.invalidate();
  }

  setBrushTipAngle(angleDeg: number) {
    this.brushTipAngle = angleDeg;
    this.invalidate();
  }

  /** Set magnet brush diameter in viewport/screen pixels. */
  setMagnetSize(size: number) {
    this.magnetSize = size;
    this.invalidate();
  }

  setViewOverlayPrefs(prefs: ViewOverlaySettings) {
    this.gridEnabled = prefs.gridEnabled;
    this.gridSpacing = prefs.gridSpacing;
    this.gridMajorEvery = prefs.gridMajorEvery;
    this.gridMinorOpacity = prefs.gridMinorOpacity;
    this.gridMajorOpacity = prefs.gridMajorOpacity;
    this.invalidate();
  }

  setSymmetryPrefs(prefs: SymmetrySettings) {
    this.symmetry = prefs;
    this.invalidate();
  }

  setPlaybackActive(playing: boolean) {
    if (this.playbackActive === playing) return;
    this.playbackActive = playing;
    this.invalidate();
  }

  /**
   * Track the pointer. Only tools that draw a ring under the cursor cost a
   * repaint; for everything else this is a field write.
   */
  setCursor(point: Point) {
    this.currentCursor = point;
    if (this.showsCursorRing()) this.invalidate();
  }

  clearCursor() {
    if (!this.currentCursor) return;
    const hadRing = this.showsCursorRing();
    this.currentCursor = null;
    if (hadRing) this.invalidate();
  }

  /**
   * Mark the overlay dirty (grid, brush ring). Camera motion goes through here.
   */
  redraw() {
    this.invalidate();
  }

  /**
   * Keep the UI canvas retina-sharp while drawing in CSS pixel coordinates.
   */
  private syncCanvasResolution() {
    const dpr = window.devicePixelRatio || 1;
    this.ctx.canvas.width = Math.round(this.config.viewportWidth * dpr);
    this.ctx.canvas.height = Math.round(this.config.viewportHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private showsCursorRing(): boolean {
    return this.shouldShowBrushSizeRing() || this.shouldShowMagnetRing();
  }

  private shouldShowBrushSizeRing(): boolean {
    if (!this.brushSizeIndicatorEnabled || this.activeTool !== "brush") return false;

    // On mobile, only show while actively drawing
    if (this.isMobile) return this.isDrawing;

    return true;
  }

  private shouldShowMagnetRing(): boolean {
    if (!this.brushSizeIndicatorEnabled || this.activeTool !== "magnet") return false;
    if (this.isMobile) return this.isDrawing;
    return true;
  }

  /**
   * Convert world coordinates to screen coordinates using camera
   */
  private worldToScreen(
    worldX: number,
    worldY: number,
  ): { x: number; y: number } {
    if (!this.camera) {
      return { x: worldX, y: worldY };
    }
    return this.camera.worldToScreen(worldX, worldY);
  }

  // ------------------------------------------------------------
  // Static bitmap: grid + symmetry guides
  // ------------------------------------------------------------

  private symmetryVisible(): boolean {
    return !!this.symmetry?.enabled && !this.playbackActive;
  }

  private staticCacheKey(dpr: number): string {
    const cam = this.camera ? this.camera.getTransformMatrix().join(",") : "";
    const s = this.symmetry;
    const sym = this.symmetryVisible() && s
      ? `${s.mode}|${s.originX}|${s.originY}|${s.radialCount}`
      : "";
    return [
      cam,
      dpr,
      this.config.viewportWidth,
      this.config.viewportHeight,
      this.gridEnabled ? 1 : 0,
      this.gridSpacing,
      this.gridMajorEvery,
      this.gridMinorOpacity,
      this.gridMajorOpacity,
      sym,
    ].join("|");
  }

  /** Re-rasterize the grid + symmetry bitmap if any of its inputs changed. */
  private ensureStatic(dpr: number): void {
    const key = this.staticCacheKey(dpr);
    if (key === this.staticKey && this.staticCanvas) return;
    this.staticKey = key;

    const w = this.ctx.canvas.width;
    const h = this.ctx.canvas.height;
    const show = (this.gridEnabled || this.symmetryVisible()) && !!this.camera;
    this.staticHasContent = show;
    if (!show) return;

    if (!this.staticCanvas) this.staticCanvas = document.createElement("canvas");
    const off = this.staticCanvas;
    if (off.width !== w || off.height !== h) {
      off.width = w;
      off.height = h;
    }
    const octx = off.getContext("2d")!;
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, w, h);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawGrid(octx);
    this.drawSymmetryGuide(octx);
  }

  /**
   * Fixed-spacing grid in world units (lines stay on the same world coordinates when zooming).
   */
  private drawGrid(ctx: CanvasRenderingContext2D) {
    if (!this.gridEnabled || !this.camera) return;

    const bounds = this.camera.getWorldBounds();
    const step = this.gridSpacing;
    const majorEvery = this.gridMajorEvery;

    const pad = step;
    const x0 = bounds.x - pad;
    const y0 = bounds.y - pad;
    const x1 = bounds.x + bounds.width + pad;
    const y1 = bounds.y + bounds.height + pad;

    const startX = Math.floor(x0 / step) * step;
    const endX = Math.ceil(x1 / step) * step;
    const startY = Math.floor(y0 / step) * step;
    const endY = Math.ceil(y1 / step) * step;

    ctx.save();
    ctx.lineWidth = 1;

    const drawLine = (sx: number, sy: number, ex: number, ey: number, major: boolean) => {
      const opacity = major ? this.gridMajorOpacity : this.gridMinorOpacity;
      const whiteA = Math.min(0.22, 0.06 + opacity * 0.85);
      const blackA = Math.min(0.28, 0.04 + opacity * 0.75);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = `rgba(255, 255, 255, ${whiteA})`;
      ctx.lineWidth = major ? 1.25 : 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = `rgba(0, 0, 0, ${blackA})`;
      ctx.lineWidth = major ? 0.75 : 0.5;
      ctx.stroke();
    };

    for (let wx = startX; wx <= endX + 1e-9; wx += step) {
      const major = Math.round(wx / step) % majorEvery === 0;
      const p0 = this.worldToScreen(wx, y0);
      const p1 = this.worldToScreen(wx, y1);
      drawLine(p0.x, p0.y, p1.x, p1.y, major);
    }

    for (let wy = startY; wy <= endY + 1e-9; wy += step) {
      const major = Math.round(wy / step) % majorEvery === 0;
      const p0 = this.worldToScreen(x0, wy);
      const p1 = this.worldToScreen(x1, wy);
      drawLine(p0.x, p0.y, p1.x, p1.y, major);
    }

    ctx.restore();
  }

  private drawSymmetryGuide(ctx: CanvasRenderingContext2D) {
    if (!this.symmetry || !this.symmetryVisible() || !this.camera) return;

    const { originX, originY, mode, radialCount } = this.symmetry;
    const bounds = this.camera.getWorldBounds();
    const pad = Math.max(bounds.width, bounds.height);
    const center = this.worldToScreen(originX, originY);

    if (mode === "vertical") {
      const p0 = this.worldToScreen(originX, bounds.y - pad);
      const p1 = this.worldToScreen(originX, bounds.y + bounds.height + pad);
      this.strokeGuideLine(ctx, p0.x, p0.y, p1.x, p1.y);
    } else if (mode === "horizontal") {
      const p0 = this.worldToScreen(bounds.x - pad, originY);
      const p1 = this.worldToScreen(bounds.x + bounds.width + pad, originY);
      this.strokeGuideLine(ctx, p0.x, p0.y, p1.x, p1.y);
    } else {
      const count = Math.max(2, radialCount);
      const reach = pad * 2;
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        const p1 = this.worldToScreen(
          originX + Math.cos(angle) * reach,
          originY + Math.sin(angle) * reach,
        );
        this.strokeGuideLine(ctx, center.x, center.y, p1.x, p1.y);
      }
    }

    // Draggable origin handle (visual size tracks the larger hit radius)
    const r = 9;
    ctx.beginPath();
    ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.fill();
    ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(center.x, center.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
    ctx.fill();
  }

  private strokeGuideLine(
    ctx: CanvasRenderingContext2D,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    dashed = true,
  ) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = dashed ? 1.5 : 2.25;
    ctx.setLineDash(dashed ? [6, 4] : []);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
    ctx.lineWidth = dashed ? 1 : 1.25;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ------------------------------------------------------------
  // Dynamic: snap guides + cursor ring
  // ------------------------------------------------------------

  private strokeSnapMark(x: number, y: number) {
    const ctx = this.ctx;
    const r = 4;
    ctx.beginPath();
    ctx.rect(x - r, y - r, r * 2, r * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.fill();
    ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
    ctx.lineWidth = 1.25;
    ctx.stroke();
  }

  private drawSnapGuides() {
    const guides = snapGuidesStore.get();
    if (guides.length === 0 || !this.camera) return;

    const ctx = this.ctx;
    const vw = this.config.viewportWidth;
    const vh = this.config.viewportHeight;
    const reach = Math.hypot(vw, vh) * 2;
    const marked = new Set<string>();

    for (const g of guides) {
      const p0 =
        g.axis === "x"
          ? this.worldToScreen(g.world, 0)
          : this.worldToScreen(0, g.world);
      const p1 =
        g.axis === "x"
          ? this.worldToScreen(g.world, 1)
          : this.worldToScreen(1, g.world);
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const len = Math.hypot(dx, dy) || 1;
      this.strokeGuideLine(
        ctx,
        p0.x - (dx / len) * reach,
        p0.y - (dy / len) * reach,
        p0.x + (dx / len) * reach,
        p0.y + (dy / len) * reach,
      );

      if (g.lo !== undefined && g.hi !== undefined) {
        const a =
          g.axis === "x"
            ? this.worldToScreen(g.world, g.lo)
            : this.worldToScreen(g.lo, g.world);
        const b =
          g.axis === "x"
            ? this.worldToScreen(g.world, g.hi)
            : this.worldToScreen(g.hi, g.world);
        this.strokeGuideLine(ctx, a.x, a.y, b.x, b.y, false);
      }

      if (g.at) {
        const key = `${g.at.x.toFixed(2)},${g.at.y.toFixed(2)}`;
        if (marked.has(key)) continue;
        marked.add(key);
        const p = this.worldToScreen(g.at.x, g.at.y);
        this.strokeSnapMark(p.x, p.y);
      }
    }
  }

  /** Dual-tone outline matching the active brush tip + angle. */
  private strokeBrushTipOutline(
    x: number,
    y: number,
    radius: number,
    tip: BrushTip,
    angleDeg: number,
  ) {
    const size = radius * 2;
    // Match stampBrushTip: diag is inherently 45°.
    const effectiveDeg = tip === "diag" ? angleDeg - 45 : angleDeg;
    const rad = (effectiveDeg * Math.PI) / 180;
    const scale = this.config.viewportWidth / this.config.pixelWidth;
    const diagHalf = Math.max(1, scale); // 2px tip → screen space

    const path = () => {
      this.ctx.beginPath();
      this.ctx.save();
      this.ctx.translate(x, y);
      if (rad !== 0) this.ctx.rotate(rad);
      switch (tip) {
        case "square":
          this.ctx.rect(-radius, -radius, size, size);
          break;
        case "ellipse":
          this.ctx.ellipse(0, 0, radius, radius * 0.55, 0, 0, Math.PI * 2);
          break;
        case "diag":
          this.ctx.rect(-radius, -diagHalf, size, diagHalf * 2);
          break;
        default:
          this.ctx.arc(0, 0, radius, 0, Math.PI * 2);
          break;
      }
      this.ctx.restore();
    };

    this.ctx.strokeStyle = "rgba(255, 255, 255, 1)";
    this.ctx.lineWidth = 2.5;
    path();
    this.ctx.stroke();
    this.ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
    this.ctx.lineWidth = 1.25;
    path();
    this.ctx.stroke();
  }

  /** Synchronous repaint — the scheduler's UI painter. */
  paint() {
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, this.config.viewportWidth, this.config.viewportHeight);

    this.ensureStatic(dpr);
    if (this.staticHasContent && this.staticCanvas) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.staticCanvas, 0, 0);
      ctx.restore();
    }

    this.drawSnapGuides();

    // Brush tip outline (brush tool only; crosshair is the CSS cursor)
    if (this.currentCursor && this.shouldShowBrushSizeRing()) {
      const viewportX =
        (this.currentCursor.x / this.config.pixelWidth) *
        this.config.viewportWidth;
      const viewportY =
        (this.currentCursor.y / this.config.pixelHeight) *
        this.config.viewportHeight;

      const scale = this.config.viewportWidth / this.config.pixelWidth;
      const stageScale = paintSizeScale(this.camera?.zoom ?? 1, "brush");
      const cursorRadius = (this.maxBrushSize / 2 - 0.5) * scale * stageScale;
      this.strokeBrushTipOutline(
        viewportX,
        viewportY,
        cursorRadius,
        this.brushTip,
        this.brushTipAngle,
      );
    }

    // Magnet brush ring (falloff radius in viewport pixels)
    if (this.currentCursor && this.shouldShowMagnetRing()) {
      const viewportX =
        (this.currentCursor.x / this.config.pixelWidth) *
        this.config.viewportWidth;
      const viewportY =
        (this.currentCursor.y / this.config.pixelHeight) *
        this.config.viewportHeight;

      const radius = this.magnetSize / 2;

      ctx.save();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(viewportX, viewportY, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(viewportX, viewportY, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }
}
