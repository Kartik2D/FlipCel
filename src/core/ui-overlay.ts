/**
 * UI Overlay - Visual Feedback Layer
 *
 * Draws UI elements and visual feedback on the top canvas layer.
 *
 * Key responsibilities:
 * - Optional brush-size ring (max brush diameter) while the brush tool is active
 * - Draws world-space alignment grid (pan/zoom/rotate with camera)
 * - Draws world origin axes (X/Y at 0,0)
 * - Optionally highlights the left and bottom viewport edges
 * - Maps pixel coordinates back to viewport for display
 *
 * Visual elements:
 * - World grid (spacing either follows zoom or stays fixed in world units; see view prefs)
 * - Brush size ring only (crosshair is a CSS custom cursor on the UI canvas)
 * - X-axis and Y-axis at world origin
 * - Optional bottom/right screen-size guides in world space
 * - All drawn in viewport coordinates (not pixel coordinates)
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
  private originEnabled = true;
  private screenSizeEnabled = false;
  private gridLiveWhileZooming = false;
  /** When live zoom is off, grid uses this world step until live is turned on or grid is hidden. */
  private lockedGridStep: number | null = null;
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
    const wasLive = this.gridLiveWhileZooming;
    this.gridEnabled = prefs.gridEnabled;
    this.originEnabled = prefs.originEnabled;
    this.screenSizeEnabled = prefs.screenSizeEnabled;
    this.gridLiveWhileZooming = prefs.gridLiveWhileZooming;

    if (!this.gridEnabled) {
      this.lockedGridStep = null;
    } else if (this.gridLiveWhileZooming) {
      this.lockedGridStep = null;
    } else if (wasLive) {
      // Live off: lock world step to whatever zoom shows on the next draw
      this.lockedGridStep = null;
    }
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
   * Force a full overlay redraw (grid, brush ring, guides, axes).
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
   * Round to a “nice” step in world units (1–2–5 × 10^n) for grid spacing.
   */
  private niceWorldStep(approx: number): number {
    if (!Number.isFinite(approx) || approx <= 0) return 1;
    const exp = Math.floor(Math.log10(approx));
    const pow = 10 ** exp;
    const f = approx / pow;
    const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return nf * pow;
  }

  /**
   * World-aligned grid: when “grid follows zoom” is on, spacing retargets ~48px on screen;
   * when off, world step stays locked until that option or visibility changes.
   */
  private drawGrid() {
    if (!this.gridEnabled || !this.camera) return;

    const ctx = this.ctx;
    const bounds = this.camera.getWorldBounds();
    const midY = this.config.viewportHeight / 2;

    const a = this.camera.screenToWorld(0, midY);
    const b = this.camera.screenToWorld(48, midY);
    const approx = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let step = this.niceWorldStep(approx);

    const maxLinePairs = 100;
    while (
      bounds.width / step + bounds.height / step > maxLinePairs * 2 &&
      step < 1e15
    ) {
      step *= 2;
    }

    if (!this.gridLiveWhileZooming) {
      if (this.lockedGridStep !== null) {
        step = this.lockedGridStep;
      } else {
        this.lockedGridStep = step;
      }
    } else {
      this.lockedGridStep = null;
    }

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
      ctx.strokeStyle = major ? "rgba(255, 255, 255, 0.14)" : "rgba(255, 255, 255, 0.06)";
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    };

    for (let wx = startX; wx <= endX + 1e-9; wx += step) {
      const major = Math.round(wx / step) % 5 === 0;
      const p0 = this.worldToScreen(wx, y0);
      const p1 = this.worldToScreen(wx, y1);
      drawLine(p0.x, p0.y, p1.x, p1.y, major);
    }

    for (let wy = startY; wy <= endY + 1e-9; wy += step) {
      const major = Math.round(wy / step) % 5 === 0;
      const p0 = this.worldToScreen(x0, wy);
      const p1 = this.worldToScreen(x1, wy);
      drawLine(p0.x, p0.y, p1.x, p1.y, major);
    }

    ctx.restore();
  }

  /**
   * Draw an infinite world-space line clipped to the viewport.
   */
  private drawInfiniteWorldLine(
    worldX: number,
    worldY: number,
    dirX: number,
    dirY: number,
    color: string,
    lineWidth: number,
  ) {
    const screenW = this.config.viewportWidth;
    const screenH = this.config.viewportHeight;
    const point = this.worldToScreen(worldX, worldY);
    const directionPoint = this.worldToScreen(worldX + dirX, worldY + dirY);
    const line = this.lineScreenIntersection(
      point,
      { x: directionPoint.x - point.x, y: directionPoint.y - point.y },
      screenW,
      screenH,
    );

    if (!line) return;

    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = lineWidth;
    this.ctx.beginPath();
    this.ctx.moveTo(line.start.x, line.start.y);
    this.ctx.lineTo(line.end.x, line.end.y);
    this.ctx.stroke();
  }

  /**
   * Draw the X and Y axes at world origin (0,0)
   * Lines extend infinitely by calculating screen edge intersections
   */
  private drawAxes() {
    if (!this.camera || !this.originEnabled) return;

    const origin = this.worldToScreen(0, 0);

    this.ctx.save();

    // Draw X axis - line through origin with direction (xDir - origin)
    this.drawInfiniteWorldLine(0, 0, 1, 0, "rgba(0, 255, 255, 0.5)", 2);

    // Draw Y axis - line through origin with direction (yDir - origin)
    this.drawInfiniteWorldLine(0, 0, 0, 1, "rgba(255, 255, 0, 0.55)", 2);

    // Draw origin circle if visible on screen
    if (
      origin.x >= -10 &&
      origin.x <= this.config.viewportWidth + 10 &&
      origin.y >= -10 &&
      origin.y <= this.config.viewportHeight + 10
    ) {
      this.ctx.fillStyle = "rgba(100, 100, 100, 0.5)";
      this.ctx.beginPath();
      this.ctx.arc(origin.x, origin.y, 5, 0, Math.PI * 2);
      this.ctx.fill();
    }

    this.ctx.restore();
  }

  /**
   * Draw bottom/right guides for a viewport-sized world-space rectangle from the origin.
   * With the default camera, these coincide with the current screen bounds.
   */
  private drawScreenSizeGuides() {
    if (!this.screenSizeEnabled) return;

    this.ctx.save();
    // UI layer is drawn with difference blending, so magenta renders as green on white.
    this.drawInfiniteWorldLine(
      this.config.viewportWidth,
      0,
      0,
      1,
      "rgba(255, 0, 255, 0.65)",
      2,
    );
    this.drawInfiniteWorldLine(
      0,
      this.config.viewportHeight,
      1,
      0,
      "rgba(255, 0, 255, 0.65)",
      2,
    );
    this.ctx.restore();
  }

  /**
   * Calculate where an infinite line intersects the screen edges
   * Returns start and end points clamped to screen bounds, or null if line doesn't cross screen
   */
  private lineScreenIntersection(
    point: { x: number; y: number },
    direction: { x: number; y: number },
    screenW: number,
    screenH: number,
  ): { start: { x: number; y: number }; end: { x: number; y: number } } | null {
    // Handle degenerate case
    if (direction.x === 0 && direction.y === 0) return null;

    const intersections: { x: number; y: number }[] = [];

    // Check intersection with all 4 screen edges
    // Left edge (x = 0)
    if (direction.x !== 0) {
      const t = -point.x / direction.x;
      const y = point.y + t * direction.y;
      if (y >= 0 && y <= screenH) {
        intersections.push({ x: 0, y });
      }
    }

    // Right edge (x = screenW)
    if (direction.x !== 0) {
      const t = (screenW - point.x) / direction.x;
      const y = point.y + t * direction.y;
      if (y >= 0 && y <= screenH) {
        intersections.push({ x: screenW, y });
      }
    }

    // Top edge (y = 0)
    if (direction.y !== 0) {
      const t = -point.y / direction.y;
      const x = point.x + t * direction.x;
      if (x >= 0 && x <= screenW) {
        intersections.push({ x, y: 0 });
      }
    }

    // Bottom edge (y = screenH)
    if (direction.y !== 0) {
      const t = (screenH - point.y) / direction.y;
      const x = point.x + t * direction.x;
      if (x >= 0 && x <= screenW) {
        intersections.push({ x, y: screenH });
      }
    }

    // Need at least 2 intersections to draw a line
    if (intersections.length < 2) return null;

    // Return the two most distant points
    return {
      start: intersections[0],
      end: intersections[1],
    };
  }

  private draw() {
    // Clear overlay
    this.ctx.clearRect(
      0,
      0,
      this.config.viewportWidth,
      this.config.viewportHeight,
    );

    // World grid (behind axes)
    this.drawGrid();

    // Visible viewport extents
    this.drawScreenSizeGuides();

    // Draw world axes
    this.drawAxes();

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

      this.ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
      this.ctx.lineWidth = 1;
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
