import { html, css, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { FloatingPanel } from "../primitives/floating-panel";
import {
  anchorPanelBelowTrigger,
  raisePanelZIndex,
} from "../primitives/panel-anchor";
import {
  DEFAULT_IMAGE_IMPORT_OPTIONS,
  applyVtracerPreset,
  canvasToImageData,
  fileToTraceCanvas,
  toVtracerWasmOptions,
  type ImageImportOptions,
  type VtracerMode,
  type VtracerOptimize,
  type VtracerPreset,
} from "../../import/image-import";
import { traceWithVtracer } from "../../import/vtracer-client";
import { remapSvgColorsForPreview } from "../../import/svg-import";
import { documentColorsStore } from "../../state";

export type { ImageImportOptions };

export type ImageImportDetail = {
  file: File;
  options: ImageImportOptions;
  svg: string;
};

const PREVIEW_DEBOUNCE_MS = 280;

/**
 * Trace window for importing a bitmap as vector paths.
 * Opened from File → Import Image or by dropping an image on the app.
 */
@customElement("flipcel-image-import-popup")
export class FlipCelImageImportPopup extends FloatingPanel {
  static styles = css`
    ${FloatingPanel.styles}

    :host {
      --panel-width: 640px;
      --panel-min-width: 420px;
      height: min(560px, calc(100vh - 16px));
      font-size: 12px;
    }

    .hint {
      margin: 0;
      color: var(--flipcel-text-secondary, #6b6b6b);
      font-weight: 500;
      line-height: 1.3;
      word-break: break-all;
    }

    .layout {
      position: relative;
      display: grid;
      grid-template-columns: minmax(200px, 1fr) 200px;
      gap: 10px;
      align-items: stretch;
      min-height: 240px;
    }

    .preview {
      position: relative;
      min-height: 160px;
      height: auto;
      max-height: none;
      aspect-ratio: auto;
      box-sizing: border-box;
      touch-action: none;
      cursor: grab;
      border-radius: var(--flipcel-content-radius, 6px);
      background:
        linear-gradient(45deg, #cfcfcf 25%, transparent 25%) 0 0 / 12px 12px,
        linear-gradient(-45deg, #cfcfcf 25%, transparent 25%) 0 6px / 12px 12px,
        linear-gradient(45deg, transparent 75%, #cfcfcf 75%) 6px -6px / 12px 12px,
        linear-gradient(-45deg, transparent 75%, #cfcfcf 75%) -6px 0 / 12px 12px,
        #e8e8e8;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }

    .preview:active {
      cursor: grabbing;
    }

    .preview img {
      display: block;
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      transform-origin: center center;
      user-select: none;
      pointer-events: none;
    }

    .preview-empty {
      color: var(--flipcel-text-secondary, #6b6b6b);
      font-weight: 500;
    }

    .preview-spin {
      position: absolute;
      inset: 0;
      z-index: 2;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      background: rgba(26, 26, 26, 0.45);
      color: #fff;
      font-weight: 600;
      font-size: 12px;
      pointer-events: none;
    }

    .preview-spin[hidden] {
      display: none !important;
    }

    .spin {
      width: 32px;
      height: 32px;
      border: 3px solid rgba(255, 255, 255, 0.35);
      border-top-color: #fff;
      border-radius: 50%;
      animation: vtracer-spin 0.7s linear infinite;
    }

    @keyframes vtracer-spin {
      to {
        transform: rotate(360deg);
      }
    }

    .opts {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
    }

    details.more {
      border-top: 1px solid var(--flipcel-track-bg, #cfcfcf);
      padding-top: 6px;
    }

    details.more > summary {
      cursor: pointer;
      color: var(--flipcel-text-secondary, #6b6b6b);
      font-weight: 600;
      font-size: 11px;
    }

    details.more > .more-body {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
    }
  `;

  @state() private fileName = "";
  @state() private importing = false;
  @state() private previewUrl = "";
  @state() private showSpin = false;
  @state() private clustering = DEFAULT_IMAGE_IMPORT_OPTIONS.clustering;
  @state() private hierarchical = DEFAULT_IMAGE_IMPORT_OPTIONS.hierarchical;
  @state() private mode = DEFAULT_IMAGE_IMPORT_OPTIONS.mode;
  @state() private filterSpeckle = DEFAULT_IMAGE_IMPORT_OPTIONS.filterSpeckle;
  @state() private colorPrecision = DEFAULT_IMAGE_IMPORT_OPTIONS.colorPrecision;
  @state() private layerDifference = DEFAULT_IMAGE_IMPORT_OPTIONS.layerDifference;
  @state() private cornerThreshold = DEFAULT_IMAGE_IMPORT_OPTIONS.cornerThreshold;
  @state() private lengthThreshold = DEFAULT_IMAGE_IMPORT_OPTIONS.lengthThreshold;
  @state() private maxIterations = DEFAULT_IMAGE_IMPORT_OPTIONS.maxIterations;
  @state() private spliceThreshold = DEFAULT_IMAGE_IMPORT_OPTIONS.spliceThreshold;
  @state() private simplify = DEFAULT_IMAGE_IMPORT_OPTIONS.simplify;
  @state() private pathPrecision = DEFAULT_IMAGE_IMPORT_OPTIONS.pathPrecision;
  @state() private maxColors = DEFAULT_IMAGE_IMPORT_OPTIONS.maxColors;
  @state() private optimize = DEFAULT_IMAGE_IMPORT_OPTIONS.optimize;
  @state() private binaryThreshold = DEFAULT_IMAGE_IMPORT_OPTIONS.binaryThreshold;
  @state() private adaptive = DEFAULT_IMAGE_IMPORT_OPTIONS.adaptive;
  @state() private adaptiveWindow = DEFAULT_IMAGE_IMPORT_OPTIONS.adaptiveWindow;
  @state() private adaptiveT = DEFAULT_IMAGE_IMPORT_OPTIONS.adaptiveT;
  @state() private watershedDetail = DEFAULT_IMAGE_IMPORT_OPTIONS.watershedDetail;
  @state() private useDocPalette = DEFAULT_IMAGE_IMPORT_OPTIONS.useDocPalette;
  @state() private snapToDocumentColors =
    DEFAULT_IMAGE_IMPORT_OPTIONS.snapToDocumentColors;

  private file: File | null = null;
  private sourceCanvas: HTMLCanvasElement | null = null;
  private previewTimer: number | null = null;
  private previewGen = 0;
  private tracedSvg = "";
  private tracedKey = "";
  private previewWellEl: HTMLElement | null = null;
  private view = { x: 0, y: 0, s: 1 };
  private drag: { x: number; y: number } | null = null;
  private pinch: { d: number; cx: number; cy: number } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();

  private options(): ImageImportOptions {
    return {
      clustering: this.clustering,
      hierarchical: this.hierarchical,
      mode: this.mode,
      filterSpeckle: this.filterSpeckle,
      colorPrecision: this.colorPrecision,
      layerDifference: this.layerDifference,
      cornerThreshold: this.cornerThreshold,
      lengthThreshold: this.lengthThreshold,
      maxIterations: this.maxIterations,
      spliceThreshold: this.spliceThreshold,
      simplify: this.simplify,
      pathPrecision: this.pathPrecision,
      maxColors: this.maxColors,
      optimize: this.optimize,
      binaryThreshold: this.binaryThreshold,
      adaptive: this.adaptive,
      adaptiveWindow: this.adaptiveWindow,
      adaptiveT: this.adaptiveT,
      watershedDetail: this.watershedDetail,
      useDocPalette: this.useDocPalette,
      snapToDocumentColors: this.snapToDocumentColors,
    };
  }

  private applyOptions(next: ImageImportOptions) {
    this.clustering = next.clustering;
    this.hierarchical = next.hierarchical;
    this.mode = next.mode;
    this.filterSpeckle = next.filterSpeckle;
    this.colorPrecision = next.colorPrecision;
    this.layerDifference = next.layerDifference;
    this.cornerThreshold = next.cornerThreshold;
    this.lengthThreshold = next.lengthThreshold;
    this.maxIterations = next.maxIterations;
    this.spliceThreshold = next.spliceThreshold;
    this.simplify = next.simplify;
    this.pathPrecision = next.pathPrecision;
    this.maxColors = next.maxColors;
    this.optimize = next.optimize;
    this.binaryThreshold = next.binaryThreshold;
    this.adaptive = next.adaptive;
    this.adaptiveWindow = next.adaptiveWindow;
    this.adaptiveT = next.adaptiveT;
    this.watershedDetail = next.watershedDetail;
    this.useDocPalette = next.useDocPalette;
    this.snapToDocumentColors = next.snapToDocumentColors;
  }

  private clearPreviewUrl() {
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = "";
  }

  private resetPreview() {
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.previewGen += 1;
    this.sourceCanvas = null;
    this.tracedSvg = "";
    this.tracedKey = "";
    this.view = { x: 0, y: 0, s: 1 };
    this.drag = null;
    this.pinch = null;
    this.pointers.clear();
    this.showSpin = false;
    this.clearPreviewUrl();
  }

  private schedulePreview() {
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      void this.refreshPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }

  private optionsKey(): string {
    return JSON.stringify(this.options());
  }

  private async traceCurrentSvg(): Promise<string> {
    if (!this.sourceCanvas) throw new Error("No source image");
    const opts = this.options();
    const palette = documentColorsStore.get();
    let svg = await traceWithVtracer(
      canvasToImageData(this.sourceCanvas),
      toVtracerWasmOptions(opts, palette),
    );
    if (opts.snapToDocumentColors) {
      svg = remapSvgColorsForPreview(svg, palette);
    }
    return svg.replace(/^<\?xml[^>]*>\s*/i, "").replace(/<!--[\s\S]*?-->\s*/, "");
  }

  private async refreshPreview() {
    if (!this.sourceCanvas) {
      this.showSpin = false;
      return;
    }
    const gen = ++this.previewGen;
    const key = this.optionsKey();
    this.showSpin = true;
    try {
      const svg = await this.traceCurrentSvg();
      if (gen !== this.previewGen) return;
      this.tracedSvg = svg;
      this.tracedKey = key;

      const url = URL.createObjectURL(
        new Blob([svg], { type: "image/svg+xml" }),
      );
      if (gen !== this.previewGen) {
        URL.revokeObjectURL(url);
        return;
      }
      this.clearPreviewUrl();
      this.previewUrl = url;
    } catch (err) {
      if (err instanceof Error && err.message === "replaced") return;
      console.error("Image preview failed", err);
    } finally {
      if (gen === this.previewGen) this.showSpin = false;
    }
  }

  /**
   * Open with a file ready to import. Anchor below a trigger when provided;
   * otherwise center in the viewport (drag-drop).
   */
  async openForFile(file: File, anchor?: HTMLElement | null): Promise<void> {
    this.file = file;
    this.fileName = file.name;
    this.importing = false;
    this.resetPreview();
    this.previewUrl = URL.createObjectURL(file);
    this.style.display = "";
    this.bindPreviewCam();

    const place = () => {
      if (!this.style.left) {
        if (anchor) {
          anchorPanelBelowTrigger(this, anchor);
        } else {
          const rect = this.getBoundingClientRect();
          const left = Math.max(8, (window.innerWidth - rect.width) / 2);
          const top = Math.max(8, (window.innerHeight - rect.height) / 2);
          this.style.left = `${Math.round(left)}px`;
          this.style.top = `${Math.round(top)}px`;
          this.style.right = "auto";
          this.style.bottom = "auto";
        }
      }
      raisePanelZIndex(this);
      this.playShowAnimation();
      // Pin a height so `.face` is a real scrollport (auto-height + max-height
      // otherwise grows with content and the face scrollbar never appears).
      if (this.blockHeight == null) {
        const h = this.getBoundingClientRect().height;
        if (h > 0) this.blockHeight = Math.round(h);
      }
    };
    requestAnimationFrame(place);

    try {
      this.sourceCanvas = await fileToTraceCanvas(file);
      void this.refreshPreview();
    } catch (err) {
      console.error("Image preview failed", err);
      this.sourceCanvas = null;
    }
  }

  private import() {
    void this.importNow();
  }

  private async importNow() {
    if (this.importing || !this.file) return;
    this.importing = true;
    try {
      if (this.tracedKey !== this.optionsKey() || !this.tracedSvg) {
        await this.refreshPreview();
      }
      if (!this.file || !this.tracedSvg) {
        this.importing = false;
        return;
      }
      this.dispatchEvent(
        new CustomEvent<ImageImportDetail>("image-import", {
          detail: {
            file: this.file,
            options: this.options(),
            svg: this.tracedSvg,
          },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (err) {
      console.error("Image import failed", err);
      this.importing = false;
    }
  }

  /** Called by the app when the import finishes (success or fail). */
  importFinished() {
    this.importing = false;
    this.file = null;
    this.resetPreview();
    this.hidePanel();
  }

  override hidePanel() {
    if (!this.importing) {
      this.file = null;
      this.resetPreview();
    }
    super.hidePanel();
  }

  override connectedCallback() {
    super.connectedCallback();
    this.pinned = true;
    this.showPinnedClose = true;
    this.draggable = true;
    this.resizable = true;
    this.masonry = false;
  }

  protected override canPreviewDockHover(): boolean {
    return false;
  }

  protected override onDragCommitted() {
    this.pinned = true;
  }

  override disconnectedCallback() {
    this.unbindPreviewCam();
    super.disconnectedCallback();
  }

  private bindPreviewCam() {
    const well = this.renderRoot.querySelector(".preview") as HTMLElement | null;
    if (!well || well === this.previewWellEl) return;
    this.unbindPreviewCam();
    this.previewWellEl = well;
    well.addEventListener("wheel", this.onPreviewWheel, { passive: false });
    well.addEventListener("pointerdown", this.onPreviewPointerDown);
    well.addEventListener("pointermove", this.onPreviewPointerMove);
    well.addEventListener("pointerup", this.onPreviewPointerUp);
    well.addEventListener("pointercancel", this.onPreviewPointerUp);
  }

  private unbindPreviewCam() {
    const well = this.previewWellEl;
    if (!well) return;
    well.removeEventListener("wheel", this.onPreviewWheel);
    well.removeEventListener("pointerdown", this.onPreviewPointerDown);
    well.removeEventListener("pointermove", this.onPreviewPointerMove);
    well.removeEventListener("pointerup", this.onPreviewPointerUp);
    well.removeEventListener("pointercancel", this.onPreviewPointerUp);
    this.previewWellEl = null;
  }

  private applyView() {
    const img = this.renderRoot.querySelector(
      ".preview img",
    ) as HTMLImageElement | null;
    if (!img) return;
    img.style.transform = `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.s})`;
  }

  private onPreviewWheel = (e: WheelEvent) => {
    e.preventDefault();
    const well = this.previewWellEl;
    if (!well) return;
    const r = well.getBoundingClientRect();
    const mx = e.clientX - r.left - r.width / 2;
    const my = e.clientY - r.top - r.height / 2;
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
    if (e.shiftKey) {
      this.view.x -= dx || dy;
      this.view.y -= dy;
    } else {
      const next = Math.min(16, Math.max(0.05, this.view.s * (1 - dy * 0.001)));
      const k = next / this.view.s;
      this.view.x = mx - (mx - this.view.x) * k;
      this.view.y = my - (my - this.view.y) * k;
      this.view.s = next;
    }
    this.applyView();
  };

  private onPreviewPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    const well = this.previewWellEl;
    if (!well) return;
    e.preventDefault();
    well.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size >= 2) {
      const pts = [...this.pointers.values()];
      const a = pts[0]!;
      const b = pts[1]!;
      this.pinch = {
        d: Math.hypot(b.x - a.x, b.y - a.y),
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
      };
      this.drag = null;
      return;
    }
    this.drag = { x: e.clientX, y: e.clientY };
  };

  private onPreviewPointerMove = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && this.pointers.size >= 2) {
      const pts = [...this.pointers.values()];
      const a = pts[0]!;
      const b = pts[1]!;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      if (this.pinch.d > 0) {
        this.view.s = Math.min(16, Math.max(0.05, this.view.s * (d / this.pinch.d)));
      }
      this.view.x += cx - this.pinch.cx;
      this.view.y += cy - this.pinch.cy;
      this.pinch = { d, cx, cy };
      this.applyView();
      return;
    }
    if (this.drag) {
      this.view.x += e.clientX - this.drag.x;
      this.view.y += e.clientY - this.drag.y;
      this.drag = { x: e.clientX, y: e.clientY };
      this.applyView();
    }
  };

  private onPreviewPointerUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    const well = this.previewWellEl;
    if (well?.hasPointerCapture(e.pointerId)) well.releasePointerCapture(e.pointerId);
    if (this.pointers.size >= 2) {
      const pts = [...this.pointers.values()];
      const a = pts[0]!;
      const b = pts[1]!;
      this.pinch = {
        d: Math.hypot(b.x - a.x, b.y - a.y),
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
      };
      this.drag = null;
      return;
    }
    this.pinch = null;
    const leftover = [...this.pointers.values()][0];
    this.drag = leftover ? { x: leftover.x, y: leftover.y } : null;
  };

  private setFlag(update: () => void) {
    update();
    this.schedulePreview();
  }

  private applyPreset(preset: VtracerPreset) {
    this.applyOptions(
      applyVtracerPreset(preset, {
        useDocPalette: this.useDocPalette,
        snapToDocumentColors: this.snapToDocumentColors,
      }),
    );
    this.schedulePreview();
  }

  private slider(
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    display: string,
    set: (n: number) => void,
  ): TemplateResult {
    return html`
      <label>
        <span>${label}: ${display}</span>
        <input
          type="range"
          min=${min}
          max=${max}
          step=${step}
          .value=${String(value)}
          @input=${(e: Event) => {
            set(Number((e.target as HTMLInputElement).value));
            this.schedulePreview();
          }}
        />
      </label>
    `;
  }

  private select<T extends string>(
    label: string,
    items: { value: T; label: string }[],
    current: T,
    set: (value: T) => void,
  ): TemplateResult {
    return html`
      <label>
        <span>${label}</span>
        <select
          .value=${current}
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value as T;
            this.setFlag(() => set(value));
          }}
        >
          ${items.map(
            (opt) => html`
              <option value=${opt.value} ?selected=${current === opt.value}>
                ${opt.label}
              </option>
            `,
          )}
        </select>
      </label>
    `;
  }

  render() {
    const preset: VtracerPreset =
      this.maxColors > 0 && this.maxColors <= 2
        ? "ink"
        : this.maxColors > 0 && this.maxColors <= 8
          ? "flat"
          : "cel";
    const docColors =
      this.useDocPalette && this.snapToDocumentColors
        ? "both"
        : this.useDocPalette
          ? "palette"
          : this.snapToDocumentColors
            ? "snap"
            : "off";
    return this.renderFloatingBlock(
      "Trace image",
      html`
      <div class="layout">
        <div class="preview">
          ${this.previewUrl
            ? html`<img
                src=${this.previewUrl}
                alt="Trace preview"
                draggable="false"
                @load=${() => this.applyView()}
              />`
            : html`<span class="preview-empty">Preview</span>`}
          <div class="preview-spin" ?hidden=${!this.showSpin}>
            <div class="spin"></div>
            <span>Tracing…</span>
          </div>
        </div>
        <div class="opts">
          <p class="hint">Trace ${this.fileName || "image"}</p>
            ${this.select<VtracerPreset>(
              "Preset",
              [
                { value: "cel", label: "Cel" },
                { value: "flat", label: "Flat" },
                { value: "ink", label: "Ink" },
              ],
              preset,
              (value) => this.applyPreset(value),
            )}
            ${this.select<VtracerMode>(
              "Curve fitting",
              [
                { value: "pixel", label: "Pixel" },
                { value: "polygon", label: "Polygon" },
                { value: "spline", label: "Spline" },
              ],
              this.mode,
              (v) => (this.mode = v),
            )}
            ${this.select(
              "Optimize",
              [
                { value: "0", label: "Off" },
                { value: "1", label: "Cleanup" },
                { value: "2", label: "Compact" },
              ],
              String(this.optimize),
              (v) => (this.optimize = Number(v) as VtracerOptimize),
            )}
            ${this.select(
              "Document colors",
              [
                { value: "off", label: "Off" },
                { value: "palette", label: "Use palette" },
                { value: "snap", label: "Snap fills" },
                { value: "both", label: "Palette + snap" },
              ],
              docColors,
              (v) => {
                this.useDocPalette = v === "palette" || v === "both";
                this.snapToDocumentColors = v === "snap" || v === "both";
              },
            )}
            ${this.slider(
              "Watershed detail",
              this.watershedDetail,
              0,
              255,
              1,
              String(this.watershedDetail),
              (n) => (this.watershedDetail = n),
            )}
            ${this.slider(
              "Filter speckle",
              this.filterSpeckle,
              0,
              128,
              1,
              String(this.filterSpeckle),
              (n) => (this.filterSpeckle = n),
            )}
            ${this.slider(
              "Max colors",
              this.maxColors,
              0,
              32,
              1,
              this.maxColors === 0 ? "off" : String(this.maxColors),
              (n) => (this.maxColors = n),
            )}

            <details class="more">
              <summary>More</summary>
              <div class="more-body">
                ${this.slider(
                  "Color precision",
                  this.colorPrecision,
                  1,
                  8,
                  1,
                  String(this.colorPrecision),
                  (n) => (this.colorPrecision = n),
                )}
                ${this.slider(
                  "Gradient step",
                  this.layerDifference,
                  0,
                  255,
                  1,
                  String(this.layerDifference),
                  (n) => (this.layerDifference = n),
                )}
                ${this.mode === "spline"
                  ? html`
                      ${this.slider(
                        "Corner threshold",
                        this.cornerThreshold,
                        0,
                        180,
                        1,
                        String(this.cornerThreshold),
                        (n) => (this.cornerThreshold = n),
                      )}
                      ${this.slider(
                        "Segment length",
                        this.lengthThreshold,
                        3.5,
                        10,
                        0.1,
                        this.lengthThreshold.toFixed(1),
                        (n) => (this.lengthThreshold = n),
                      )}
                      ${this.slider(
                        "Max iterations",
                        this.maxIterations,
                        1,
                        20,
                        1,
                        String(this.maxIterations),
                        (n) => (this.maxIterations = n),
                      )}
                      ${this.slider(
                        "Splice threshold",
                        this.spliceThreshold,
                        0,
                        180,
                        1,
                        String(this.spliceThreshold),
                        (n) => (this.spliceThreshold = n),
                      )}
                    `
                  : nothing}
                ${this.slider(
                  "Simplify",
                  this.simplify,
                  0,
                  4,
                  0.1,
                  this.simplify === 0 ? "off" : this.simplify.toFixed(1),
                  (n) => (this.simplify = n),
                )}
                ${this.slider(
                  "Path precision",
                  this.pathPrecision,
                  0,
                  8,
                  1,
                  String(this.pathPrecision),
                  (n) => (this.pathPrecision = n),
                )}
              </div>
            </details>
          <blocky-button
            flat
            accent
            stretch
            ?disabled=${this.importing || !this.tracedSvg}
            @click=${() => this.import()}
            >${this.importing ? "Tracing…" : "Import"}</blocky-button
          >
        </div>
      </div>
    `);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "flipcel-image-import-popup": FlipCelImageImportPopup;
  }
}
