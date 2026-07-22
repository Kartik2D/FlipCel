/**
 * UI Overlay - Visual Feedback Layer
 *
 * Draws UI elements and visual feedback on the top canvas layer.
 *
 * Key responsibilities:
 * - Optional brush-size ring (max brush diameter) while the brush tool is active
 * - Draws world-space grid at fixed spacing (pan/zoom/rotate with camera)
 * - Maps pixel coordinates back to viewport for display
 */
import type { Point, CanvasConfig } from "./types";
import type { Camera } from "./camera";
import type { ViewOverlaySettings } from "./stores";
import type { ToolId } from "./tools";

export class UIOverlay {
  private ctx: CanvasRenderingContext2D;
  private config: CanvasConfig;
  private camera: Camera | null = null;
  private currentCursor: Point | null = null;
  private brushSizeIndicatorEnabled = true;
  private activeTool: ToolId = "brush";
  private gridEnabled = true;
  private gridSpacing = 100;
  private gridMajorEvery = 5;
  private gridMinorOpacity = 0.06;
  private gridMajorOpacity = 0.14;
  private isDrawing = false;
  private isMobile = false;
  private maxBrushSize = 4; // Default max brush size in pixel canvas units
  private magnetSize = 120; // Magnet brush diameter in viewport/screen pixels

  constructor(
    _canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    config: CanvasConfig,
  ) {
    this.ctx = ctx;
    this.config = config;
    this.detectMobile();
  }

  private detectMobile() {
    // Detect mobile/touch devices
    this.isMobile = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  }

  /**
   * Set the camera reference for world-to-screen transformations
   */
  setCamera(camera: Camera) {
    this.camera = camera;
  }

  setBrushSizeIndicatorEnabled(enabled: boolean) {
    this.brushSizeIndicatorEnabled = enabled;
    this.draw();
  }

  setActiveTool(tool: ToolId) {
    this.activeTool = tool;
    this.draw();
  }

  setDrawingState(isDrawing: boolean) {
    this.isDrawing = isDrawing;
    this.draw();
  }

  updateConfig(config: CanvasConfig) {
    this.config = config;
    this.syncCanvasResolution();
    this.draw();
  }

  setMaxBrushSize(size: number) {
    this.maxBrushSize = size;
    this.draw();
  }

  /** Set magnet brush diameter in viewport/screen pixels. */
  setMagnetSize(size: number) {
    this.magnetSize = size;
    this.draw();
  }

  setViewOverlayPrefs(prefs: ViewOverlaySettings) {
    this.gridEnabled = prefs.gridEnabled;
    this.gridSpacing = prefs.gridSpacing;
    this.gridMajorEvery = prefs.gridMajorEvery;
    this.gridMinorOpacity = prefs.gridMinorOpacity;
    this.gridMajorOpacity = prefs.gridMajorOpacity;
    this.draw();
  }

  updateCursor(point: Point) {
    this.currentCursor = point;
    this.draw();
  }

  clearCursor() {
    this.currentCursor = null;
    this.draw();
  }

  /**
   * Force a full overlay redraw (grid, brush ring).
   */
  redraw() {
    this.draw();
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

  /**
   * Fixed-spacing grid in world units (lines stay on the same world coordinates when zooming).
   */
  private drawGrid() {
    if (!this.gridEnabled || !this.camera) return;

    const ctx = this.ctx;
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

  private draw() {
    // Clear overlay
    this.ctx.clearRect(
      0,
      0,
      this.config.viewportWidth,
      this.config.viewportHeight,
    );

    this.drawGrid();

    // Brush size ring (brush tool only; crosshair is the CSS cursor)
    if (this.currentCursor && this.shouldShowBrushSizeRing()) {
      const viewportX =
        (this.currentCursor.x / this.config.pixelWidth) *
        this.config.viewportWidth;
      const viewportY =
        (this.currentCursor.y / this.config.pixelHeight) *
        this.config.viewportHeight;

      const scale = this.config.viewportWidth / this.config.pixelWidth;
      const cursorRadius = (this.maxBrushSize / 2 - 0.5) * scale;

      this.ctx.strokeStyle = "rgba(255, 255, 255, 1)";
      this.ctx.lineWidth = 2.5;
      this.ctx.beginPath();
      this.ctx.arc(viewportX, viewportY, cursorRadius, 0, Math.PI * 2);
      this.ctx.stroke();
      this.ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
      this.ctx.lineWidth = 1.25;
      this.ctx.beginPath();
      this.ctx.arc(viewportX, viewportY, cursorRadius, 0, Math.PI * 2);
      this.ctx.stroke();
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

      this.ctx.save();
      this.ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
      this.ctx.lineWidth = 1.5;
      this.ctx.beginPath();
      this.ctx.arc(viewportX, viewportY, radius, 0, Math.PI * 2);
      this.ctx.stroke();
      this.ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
      this.ctx.lineWidth = 1;
      this.ctx.setLineDash([4, 3]);
      this.ctx.beginPath();
      this.ctx.arc(viewportX, viewportY, radius, 0, Math.PI * 2);
      this.ctx.stroke();
      this.ctx.setLineDash([]);
      this.ctx.restore();
    }
  }
}
