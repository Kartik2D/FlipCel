/**
 * Chrome Overlay - Selection / Control UI Layer
 *
 * Owns the topmost canvas (#chrome-canvas) dedicated to transient selection UI:
 * - Selection outline + dashed bounding box (select tool)
 * - Transform handles (scale corners + rotation)
 * - Vertex handles (direct-select tool)
 * - Marquee rectangle + lasso preview
 *
 * This layer has no blend mode and does not receive input. Controllers paint here
 * without worrying about coordinating with the grid/origin/brush overlay below.
 *
 * Every draw begins by calling `clear()`; owners are responsible for painting a
 * complete frame of chrome on demand.
 */
import type { CanvasConfig, Point } from "../geometry/types";

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

  drawLassoPreview(points: Point[]): void {
    if (points.length < 2) return;

    this.ctx.save();
    this.ctx.setLineDash([6, 4]);
    this.ctx.lineJoin = "round";
    this.ctx.beginPath();
    this.ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      this.ctx.lineTo(points[i].x, points[i].y);
    }
    this.ctx.closePath();
    this.ctx.fillStyle = "rgba(0, 0, 0, 0.1)";
    this.ctx.fill();
    this.ctx.strokeStyle = "#ffffff";
    this.ctx.lineWidth = 3;
    this.ctx.stroke();
    this.ctx.strokeStyle = "#000000";
    this.ctx.lineWidth = 1.5;
    this.ctx.stroke();
    this.ctx.setLineDash([]);
    this.ctx.restore();
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
