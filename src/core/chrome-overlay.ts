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
import type { CanvasConfig } from "./types";

export class ChromeOverlay {
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
