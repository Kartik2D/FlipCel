/**
 * Chrome Overlay - Selection / Control UI Layer
 *
 * Owns the topmost canvas (#chrome-canvas) dedicated to transient selection UI:
 * - Selection outline + dashed bounding box (select tool)
 * - Transform handles (scale corners + rotation)
 * - Vertex handles (direct-select tool)
 * - Marquee rectangle + lasso preview
 * - Magic Move chart strokes (accent dashed + soft glow)
 *
 * This layer has no blend mode and does not receive input. Controllers paint here
 * without worrying about coordinating with the grid/origin/brush overlay below.
 *
 * Every draw begins by calling `clear()`; owners are responsible for painting a
 * complete frame of chrome on demand.
 */
import type { CanvasConfig, Point } from "../geometry/types";

export interface LassoPreviewOptions {
  /** Denser dash pattern (Magic Move). Default [6, 4]. */
  denseDash?: boolean;
  /** Semi-transparent fill. Default true. */
  fill?: boolean;
  /** Close the path before stroke/fill. Default true. */
  closed?: boolean;
  /**
   * Primary stroke color (inner line). Defaults to black.
   * Magic Move passes the theme accent.
   */
  strokeColor?: string;
  /** Soft fill tint when `fill` is on (defaults to black 10% or accent 12%). */
  fillColor?: string;
  /** Soft wide underglow behind the stroke (Magic Move). */
  glow?: boolean;
}

export class ChromeLayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: CanvasConfig;

  constructor(
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    config: CanvasConfig,
  ) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.config = config;
    this.syncResolution();
  }

  /** Raw 2D context; drawing is done directly by controllers. */
  getContext(): CanvasRenderingContext2D {
    return this.ctx;
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  updateConfig(config: CanvasConfig) {
    this.config = config;
    this.syncResolution();
  }

  /** Wipe the chrome layer. Called before each full repaint. */
  clear() {
    this.ctx.clearRect(0, 0, this.config.viewportWidth, this.config.viewportHeight);
  }

  drawMarqueeRect(start: Point, end: Point): void {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);

    this.ctx.save();
    this.ctx.fillStyle = "rgba(0, 0, 0, 0.1)";
    this.ctx.fillRect(x, y, width, height);
    this.ctx.setLineDash([6, 4]);
    this.ctx.lineJoin = "miter";
    this.ctx.strokeStyle = "#ffffff";
    this.ctx.lineWidth = 3;
    this.ctx.strokeRect(x, y, width, height);
    this.ctx.strokeStyle = "#000000";
    this.ctx.lineWidth = 1.5;
    this.ctx.strokeRect(x, y, width, height);
    this.ctx.setLineDash([]);
    this.ctx.restore();
  }

  drawLassoPreview(points: Point[], opts: LassoPreviewOptions = {}): void {
    if (points.length < 2) return;

    const denseDash = opts.denseDash === true;
    const fill = opts.fill !== false;
    const closed = opts.closed !== false;
    const dash = denseDash ? ([3, 2] as const) : ([6, 4] as const);
    const strokeColor = opts.strokeColor ?? "#000000";
    const fillColor =
      opts.fillColor ??
      (opts.strokeColor ? opts.strokeColor : "rgba(0, 0, 0, 0.1)");
    const glow = opts.glow === true && !!opts.strokeColor;

    this.ctx.save();
    this.ctx.lineJoin = "round";
    this.ctx.lineCap = "round";
    this.ctx.beginPath();
    this.ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      this.ctx.lineTo(points[i].x, points[i].y);
    }
    if (closed) this.ctx.closePath();

    if (glow) {
      this.ctx.save();
      this.ctx.setLineDash([]);
      this.ctx.strokeStyle = strokeColor;
      this.ctx.globalAlpha = 0.22;
      this.ctx.lineWidth = 10;
      this.ctx.stroke();
      this.ctx.globalAlpha = 0.35;
      this.ctx.lineWidth = 5;
      this.ctx.stroke();
      this.ctx.restore();
    }

    if (fill && closed) {
      this.ctx.fillStyle = fillColor;
      this.ctx.globalAlpha = opts.strokeColor ? 0.14 : 1;
      this.ctx.fill();
      this.ctx.globalAlpha = 1;
    }

    this.ctx.setLineDash([...dash]);
    this.ctx.strokeStyle = "#ffffff";
    this.ctx.lineWidth = 3;
    this.ctx.stroke();
    this.ctx.strokeStyle = strokeColor;
    this.ctx.lineWidth = 1.5;
    this.ctx.stroke();
    this.ctx.setLineDash([]);
    this.ctx.restore();
  }

  /** Open stroke-only chart polyline with optional accent glow. */
  drawChartStroke(points: Point[], strokeColor?: string): void {
    this.drawLassoPreview(points, {
      denseDash: true,
      fill: false,
      closed: false,
      strokeColor,
      glow: !!strokeColor,
    });
  }

  /** Retina-sharp drawing in CSS pixel coordinates. */
  private syncResolution() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.config.viewportWidth * dpr);
    this.canvas.height = Math.round(this.config.viewportHeight * dpr);
    this.canvas.style.width = `${this.config.viewportWidth}px`;
    this.canvas.style.height = `${this.config.viewportHeight}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}
