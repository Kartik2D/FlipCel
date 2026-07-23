/**
 * Stage canvas — world-space artboard rectangle drawn below Paper.js.
 * Uses the same camera matrix as Paper so pan/zoom/rotate match the vector layer.
 */
import type { CanvasConfig } from "./types";
import type { Camera } from "./camera";
import { stageStore } from "./stores";

export class StageCanvas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: CanvasConfig;
  private camera: Camera | null = null;
  private unsubStage?: () => void;

  constructor(
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    config: CanvasConfig,
  ) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.config = config;
    this.syncResolution();
    this.unsubStage = stageStore.subscribe(() => this.redraw());
  }

  setCamera(camera: Camera) {
    this.camera = camera;
    this.redraw();
  }

  updateConfig(config: CanvasConfig) {
    this.config = config;
    this.syncResolution();
    this.redraw();
  }

  redraw() {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const dpr = window.devicePixelRatio || 1;
    if (!this.camera) {
      this.ctx.restore();
      return;
    }

    const [a, b, c, d, tx, ty] = this.camera.getTransformMatrix();
    this.ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, tx * dpr, ty * dpr);

    const stage = stageStore.get();
    this.ctx.fillStyle = stage.color;
    this.ctx.fillRect(0, 0, stage.width, stage.height);

    this.ctx.restore();
  }

  dispose() {
    this.unsubStage?.();
    this.unsubStage = undefined;
  }

  private syncResolution() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.config.viewportWidth * dpr);
    this.canvas.height = Math.round(this.config.viewportHeight * dpr);
    this.canvas.style.width = `${this.config.viewportWidth}px`;
    this.canvas.style.height = `${this.config.viewportHeight}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}
