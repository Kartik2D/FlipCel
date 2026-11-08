import { html, css, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  getColorSpaceAdapter,
  valuesToHex,
  clampChannelValues,
  type ColorSpaceAdapter,
  type ChannelValues,
} from "../../color/spaces";
import type { ColorPanelPrefs } from "../../state";
import { BaseColorPicker } from "./base";
import { pickerVars, handleStyles, sliderColumnStyles } from "./styles";

// ============================================================
// Generic Configurable Color Picker
// ============================================================

@customElement("generic-color-picker")
export class GenericColorPicker extends BaseColorPicker {
  @property({ type: Object }) prefs!: ColorPanelPrefs;

  private values: ChannelValues = {};
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private planeResizeObserver: ResizeObserver | null = null;
  /* Fixed low-res backing store (upscaled by CSS with bilinear filtering).
     Keeps drawPlane cheap even for expensive OK* conversions on every slider
     tick while still looking smooth at typical panel sizes. */
  private static readonly PLANE_RES = 192;
  /* ponytail: OK* is a full gamut solve per pixel. 64px, CSS-scaled. Raise if the field bands. */
  private static readonly OK_PLANE_RES = 64;
  /* Bitmap is scaled by this much inside the circular clip so the bilinear
     fringe of the low-res rim falls outside the mask. Color radius is the
     inverse, so the clip edge is still full saturation. */
  private static readonly CIRCLE_OVERSCAN = 1.1;
  private drawRaf: number | null = null;
  private lastPlaneSignature = "";
  /** Last hex already sent for this drag, so identical samples skip the app. */
  private liveHex = "";

  static styles = [pickerVars, handleStyles, sliderColumnStyles, css`
    :host {
      display: block;
      height: 100%;
      min-width: 0;
      min-height: 0;
    }

    .picker-main {
      display: flex;
      gap: var(--picker-gap);
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      align-items: stretch;
      touch-action: none;
    }

    .plane-area {
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      /* Circle sizes against this box via cqw/cqh. */
      container-type: size;
    }

    /* Square planes (hsv1 / okhsl2): fill the plane area; no forced 1:1. */
    .plane-square {
      position: relative;
      flex: 1 1 auto;
      align-self: stretch;
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
    }
    .plane-square-inner {
      position: absolute; inset: 0; cursor: crosshair;
      border-radius: var(--flipcel-content-radius);
      overflow: hidden;
      border: var(--picker-border-width) solid var(--picker-border-color); box-sizing: border-box;
    }

    /*
     * Circle plane (okhsl1): must stay 1:1. vmin is the intrinsic fallback
     * before the area has a real height budget (content-sized panel).
     */
    .plane-circle-wrap {
      position: relative;
      flex: 0 0 auto;
      align-self: center;
      aspect-ratio: 1;
      width: min(100%, var(--picker-circle-size, 36vmin));
      height: auto;
      max-width: 100%;
      max-height: 100%;
    }

    @container (min-height: 1px) {
      .plane-circle-wrap {
        /* Largest square that fits — don't keep a vmin ceiling on tall panels. */
        width: min(100cqw, 100cqh);
      }
    }

    .plane-circle-inner { position: absolute; inset: 0; cursor: crosshair; }
    .circle-disk {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      overflow: hidden;
      border: var(--picker-border-width) solid var(--picker-border-color);
      box-sizing: border-box;
    }
    /* Overscan the low-res bitmap so the circular clip covers the soft rim. */
    .circle-disk canvas {
      transform: scale(var(--circle-overscan, 1));
      transform-origin: center;
    }

    canvas { display: block; width: 100%; height: 100%; image-rendering: auto; }
    .slider-column {
      flex: 0 1 var(--picker-slider-width);
      min-width: 12px;
      min-height: 0;
    }

    .sliders-stack {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-height: 0;
    }

    .sliders-stack .s-slider {
      flex: 1;
      min-height: 0;
    }
  `];

  private getAdapter(): ColorSpaceAdapter { return getColorSpaceAdapter(this.prefs.space); }
  private channelMeta(id: string) { return this.getAdapter().channels.find((c) => c.id === id); }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.planeResizeObserver?.disconnect();
    this.planeResizeObserver = null;
    if (this.drawRaf !== null) {
      cancelAnimationFrame(this.drawRaf);
      this.drawRaf = null;
    }
  }

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("prefs") || (changed.has("color") && !this._isDragging)) {
      this.syncFromColor(this.color);
    }
  }

  firstUpdated() {
    this.ensureCanvas();
    this.setupPlaneResizeObserver();
    this.syncPlaneCanvasSize();
  }

  updated(changed: Map<string, unknown>) {
    this.ensureCanvas();
    if (changed.has("prefs")) {
      this.lastPlaneSignature = "";
      this.setupPlaneResizeObserver();
    }
    if (changed.has("prefs") || (changed.has("color") && !this._isDragging)) {
      this.syncPlaneCanvasSize();
    }
  }

  private ensureCanvas() {
    const c = this.renderRoot.querySelector("canvas");
    if (c && c instanceof HTMLCanvasElement && c !== this.canvas) {
      this.canvas = c;
      this.ctx = c.getContext("2d");
      this.lastPlaneSignature = "";
    }
  }

  private setupPlaneResizeObserver() {
    this.planeResizeObserver?.disconnect();
    const planeArea = this.renderRoot.querySelector(".plane-area");
    const planeHost = this.renderRoot.querySelector(".plane-square-inner, .circle-disk");
    if (!planeArea && !planeHost) return;
    this.planeResizeObserver = new ResizeObserver(() => {
      this.syncPlaneCanvasSize();
    });
    if (planeArea) this.planeResizeObserver.observe(planeArea);
    else if (planeHost) this.planeResizeObserver.observe(planeHost);
    this.syncPlaneCanvasSize();
  }

  /**
   * Use a fixed low-res backing store and let the browser scale it to the plane
   * element's CSS size. This trades pixel-perfect sharpness (unneeded on a
   * smooth colour gradient) for a ~10× speed-up on every slider tick.
   */
  private planeResolution(): number {
    const space = this.prefs?.space;
    return space === "okhsl" || space === "okhsv"
      ? GenericColorPicker.OK_PLANE_RES
      : GenericColorPicker.PLANE_RES;
  }

  private syncPlaneCanvasSize() {
    if (!this.canvas || !this.ctx) return;
    const size = this.planeResolution();
    if (this.canvas.width !== size || this.canvas.height !== size) {
      this.canvas.width = size;
      this.canvas.height = size;
      this.lastPlaneSignature = "";
    }
    this.scheduleDrawPlane();
  }

  private scheduleDrawPlane() {
    if (this.drawRaf !== null) return;
    this.drawRaf = requestAnimationFrame(() => {
      this.drawRaf = null;
      this.drawPlane();
    });
  }

  protected syncFromColor(hex: string) {
    const adapter = this.getAdapter();
    this.values = clampChannelValues(adapter, adapter.fromHex(hex));
  }

  protected getColorFromState(): string {
    return valuesToHex(this.getAdapter(), this.values);
  }

  // --- 2D plane rendering ---

  private drawPlane() {
    if (!this.ctx || !this.canvas) return;
    const adapter = this.getAdapter();
    const { planeX, planeY, geometry } = this.prefs;
    const mx = this.channelMeta(planeX);
    const my = this.channelMeta(planeY);
    if (!mx || !my) return;

    /* Only the "third" (slider) channels plus space/geometry/axes affect the
       plane image — moving the plane handle itself doesn't. Skip redraw when
       the signature is unchanged. */
    const sigParts: string[] = [adapter.id, geometry, planeX, planeY];
    for (const ch of adapter.channels) {
      if (ch.id === planeX || ch.id === planeY) continue;
      sigParts.push(`${ch.id}:${(this.values[ch.id] ?? 0).toFixed(3)}`);
    }
    const signature = sigParts.join("|");
    if (signature === this.lastPlaneSignature) return;
    this.lastPlaneSignature = signature;

    const w = this.canvas.width;
    const h = this.canvas.height;
    const imgData = this.ctx.createImageData(w, h);
    const data = imgData.data;
    const pix = { ...this.values };
    const toRgb = adapter.toRgb.bind(adapter);
    const mxRange = mx.max - mx.min;
    const myRange = my.max - my.min;

    if (geometry === "square") {
      for (let y = 0; y < h; y++) {
        pix[planeY] = my.max - (y / h) * myRange;
        for (let x = 0; x < w; x++) {
          pix[planeX] = mx.min + (x / w) * mxRange;
          const [r, g, b] = toRgb(pix);
          const i = (y * w + x) * 4;
          data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
        }
      }
    } else {
      const cx = w / 2, cy = h / 2;
      const radius = Math.min(cx, cy) / GenericColorPicker.CIRCLE_OVERSCAN;
      const invRadius = radius > 0 ? 1 / radius : 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = x - cx, dy = y - cy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const i = (y * w + x) * 4;
          let angleDeg = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
          if (angleDeg < 0) angleDeg += 360;
          const t = Math.min(1, dist * invRadius);
          pix[planeX] = mx.cyclic ? angleDeg : mx.min + (angleDeg / 360) * mxRange;
          pix[planeY] = my.min + t * myRange;
          const [r, g, b] = toRgb(pix);
          data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
        }
      }
    }
    this.ctx.putImageData(imgData, 0, 0);
  }

  private sliderId(): string | null {
    return this.getAdapter().channels.find(
      (channel) => channel.id !== this.prefs.planeX && channel.id !== this.prefs.planeY
    )?.id ?? null;
  }

  private sliderGradient(sid: string): string {
    const adapter = this.getAdapter();
    const m = this.channelMeta(sid);
    if (!m) return "";

    if (m.cyclic) {
      const base: ChannelValues = {};
      for (const ch of adapter.channels) {
        if (ch.id === sid) continue;
        base[ch.id] = ch.id === "l" ? (ch.min + ch.max) / 2 : ch.max;
      }
      const stops: string[] = [];
      const n = 7;
      for (let j = 0; j <= n; j++) {
        const v = m.max - (j / n) * (m.max - m.min);
        const [r, g, b] = adapter.toRgb(clampChannelValues(adapter, { ...base, [sid]: v }));
        stops.push(`rgb(${r},${g},${b})`);
      }
      return `linear-gradient(to bottom, ${stops.join(", ")})`;
    }

    /* Lightness / value: two RGB stops would only lerp black→white (HSL/OKHSL force achromatic
       at 0% and 100% L). Multi-stop samples the true axis at the current plane hue & saturation. */
    if (sid === "l" || sid === "v") {
      const stops: string[] = [];
      const n = 14;
      for (let j = 0; j <= n; j++) {
        const v = m.max - (j / n) * (m.max - m.min);
        const [r, g, b] = adapter.toRgb(clampChannelValues(adapter, { ...this.values, [sid]: v }));
        stops.push(`rgb(${r},${g},${b})`);
      }
      return `linear-gradient(to bottom, ${stops.join(", ")})`;
    }

    const [r1, g1, b1] = adapter.toRgb(clampChannelValues(adapter, { ...this.values, [sid]: m.max }));
    const [r2, g2, b2] = adapter.toRgb(clampChannelValues(adapter, { ...this.values, [sid]: m.min }));
    return `linear-gradient(to bottom, rgb(${r1},${g1},${b1}), rgb(${r2},${g2},${b2}))`;
  }

  // --- Interaction ---

  /**
   * Move handles and the current swatch without a Lit render.
   * Slider drags keep the gradient (it doesn't depend on the dragged channel).
   */
  private paintLive(fromSlider: boolean) {
    const hex = this.getColorFromState();
    const current = this.renderRoot.querySelector(".color-half:last-child") as HTMLElement | null;
    if (current) current.style.background = hex;

    const pos = this.prefs.geometry === "square" ? this.squareHandle() : this.circleHandle();
    const handle = this.renderRoot.querySelector(".handle") as HTMLElement | null;
    if (handle) {
      handle.style.left = `${pos.left}%`;
      handle.style.top = `${pos.top}%`;
    }

    const sid = this.sliderId();
    if (sid) {
      const sh = this.renderRoot.querySelector(".s-handle") as HTMLElement | null;
      if (sh) sh.style.top = `${this.sliderTop(sid)}%`;
      if (!fromSlider) {
        const grad = this.renderRoot.querySelector(".s-gradient") as HTMLElement | null;
        if (grad) grad.style.background = this.sliderGradient(sid);
      }
    }

    if (hex === this.liveHex) return;
    this.liveHex = hex;
    this.dispatchEvent(
      new CustomEvent("input", {
        detail: { value: hex },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private finishDrag() {
    this.color = this.getColorFromState();
  }

  private handleSquareDown(e: PointerEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const adapter = this.getAdapter();
    const { planeX, planeY } = this.prefs;
    const mx = this.channelMeta(planeX)!, my = this.channelMeta(planeY)!;
    const update = (ev: PointerEvent) => {
      const u = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const v = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
      this.values = clampChannelValues(adapter, {
        ...this.values,
        [planeX]: mx.min + u * (mx.max - mx.min),
        [planeY]: my.max - v * (my.max - my.min),
      });
      this.paintLive(false);
    };
    this.liveHex = this.color;
    this.startDrag(e, update, () => this.finishDrag());
  }

  private handleCircleDown(e: PointerEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const adapter = this.getAdapter();
    const { planeX, planeY } = this.prefs;
    const mx = this.channelMeta(planeX)!, my = this.channelMeta(planeY)!;
    const cx = rect.width / 2, cy = rect.height / 2, radius = Math.min(cx, cy);
    const update = (ev: PointerEvent) => {
      const x = ev.clientX - rect.left - cx, y = ev.clientY - rect.top - cy;
      const dist = Math.min(Math.sqrt(x * x + y * y), radius);
      let angleDeg = Math.atan2(y, x) * (180 / Math.PI) + 90;
      if (angleDeg < 0) angleDeg += 360;
      const t = radius > 0 ? dist / radius : 0;
      const vx = mx.cyclic ? angleDeg : mx.min + (angleDeg / 360) * (mx.max - mx.min);
      const vy = my.min + t * (my.max - my.min);
      this.values = clampChannelValues(adapter, { ...this.values, [planeX]: vx, [planeY]: vy });
      this.paintLive(false);
    };
    this.liveHex = this.color;
    this.startDrag(e, update, () => this.finishDrag());
  }

  private handleSliderDown(e: PointerEvent) {
    const sid = this.sliderId(); if (!sid) return;
    const m = this.channelMeta(sid); if (!m) return;
    const adapter = this.getAdapter();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const update = (ev: PointerEvent) => {
      const v = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
      this.values = clampChannelValues(adapter, { ...this.values, [sid]: m.max - v * (m.max - m.min) });
      const prev = this.liveHex;
      this.paintLive(true);
      if (this.liveHex !== prev) this.scheduleDrawPlane();
    };
    this.liveHex = this.color;
    this.startDrag(e, update, () => this.finishDrag());
  }

  // --- Handle positioning ---

  private squareHandle(): { left: number; top: number } {
    const mx = this.channelMeta(this.prefs.planeX)!;
    const my = this.channelMeta(this.prefs.planeY)!;
    const sx = mx.max - mx.min, sy = my.max - my.min;
    return {
      left: sx > 0 ? ((this.values[this.prefs.planeX] ?? mx.min) - mx.min) / sx * 100 : 0,
      top: sy > 0 ? (my.max - (this.values[this.prefs.planeY] ?? my.min)) / sy * 100 : 0,
    };
  }

  private circleHandle(): { left: number; top: number } {
    const mx = this.channelMeta(this.prefs.planeX)!;
    const my = this.channelMeta(this.prefs.planeY)!;
    const vx = this.values[this.prefs.planeX] ?? mx.min;
    const vy = this.values[this.prefs.planeY] ?? my.min;
    const angleDeg = mx.cyclic ? vx : (mx.max - mx.min > 0 ? ((vx - mx.min) / (mx.max - mx.min)) * 360 : 0);
    const sy = my.max - my.min;
    const t = sy > 0 ? Math.max(0, Math.min(1, (vy - my.min) / sy)) : 0;
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return { left: 50 + t * 50 * Math.cos(rad), top: 50 + t * 50 * Math.sin(rad) };
  }

  private sliderTop(sid: string): number {
    const m = this.channelMeta(sid); if (!m) return 0;
    const span = m.max - m.min;
    return span > 0 ? (1 - ((this.values[sid] ?? m.min) - m.min) / span) * 100 : 0;
  }

  render() {
    const { geometry } = this.prefs;
    const h = geometry === "square" ? this.squareHandle() : this.circleHandle();
    const sid = this.sliderId();
    return html`
      <div class="picker-main">
        <div class="plane-area">
          ${geometry === "square" ? html`
            <div class="plane-square">
              <div class="plane-square-inner" data-interactive @pointerdown=${this.handleSquareDown}>
                <canvas></canvas>
                <div class="handle" style="left:${h.left}%;top:${h.top}%;"></div>
              </div>
            </div>
          ` : html`
            <div class="plane-circle-wrap">
              <div class="plane-circle-inner">
                <div
                  class="circle-disk"
                  style="--circle-overscan:${GenericColorPicker.CIRCLE_OVERSCAN}"
                  data-interactive
                  @pointerdown=${this.handleCircleDown}
                >
                  <canvas></canvas>
                  <div class="handle" style="left:${h.left}%;top:${h.top}%;"></div>
                </div>
              </div>
            </div>
          `}
        </div>
        <div class="slider-column">
          <div class="color-preview">
            <div class="color-half" style="background:${this.prevColor}"></div>
            <div class="color-half" style="background:${this.color}"></div>
          </div>
          <div class="sliders-stack">
            ${sid ? html`
              <div class="s-slider" data-interactive @pointerdown=${(ev: PointerEvent) => this.handleSliderDown(ev)}>
                <div class="s-gradient" style="background:${this.sliderGradient(sid)}"></div>
                <div class="s-handle" style="top:${this.sliderTop(sid)}%;"></div>
              </div>
            ` : ""}
          </div>
        </div>
      </div>
    `;
  }
}
