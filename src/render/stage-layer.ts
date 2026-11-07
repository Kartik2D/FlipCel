/**
 * Stage canvas — world-space artboard rectangle drawn below the vector stage.
 * Uses the same camera matrix as the renderer so pan/zoom/rotate match.
 */
import type { CanvasConfig } from "../geometry/types";
import type { Camera } from "./camera";
import { stageStore } from "../state/index";

export class StageLayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: CanvasConfig;
  private camera: Camera | null = null;
  private unsubStage?: () => void;
  /** Edit-in-place: draw the artboard in the edited symbol's local space. */
  private localTransform: [number, number, number, number, number, number] | null = null;

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

  /**
   * Extra world → local matrix applied under the camera (null = scene). Set
   * while editing a symbol in place so the artboard follows the parent.
   */
  setLocalTransform(matrix: [number, number, number, number, number, number] | null) {
    this.localTransform = matrix;
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
    if (this.localTransform) {
      const [la, lb, lc, ld, ltx, lty] = this.localTransform;
      this.ctx.transform(la, lb, lc, ld, ltx, lty);
    }

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
