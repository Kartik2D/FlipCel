/**
 * Blocky UI Library
 *
 * A minimal UI component library using CSS custom properties for inheritance.
 * Uses 3-layer structure: Host (BlockHolder) > Block (shell) > Face (surface)
 */
import { LitElement, html, css, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { tools, type ToolId, type SettingsSchema, type SettingDef, getTool } from "../core/tools";
import {
  getColorSpaceAdapter,
  valuesToHex,
  clampChannelValues,
  type ColorSpaceId,
  type ColorSpaceAdapter,
  type ChannelValues,
} from "./color-utils";
import {
  colorStore,
  prevColorStore,
  colorPanelPrefsStore,
  normalizeColorPanelPrefs,
  toolStore,
  modifiersStore,
  toolSettingsStore,
  viewOverlayStore,
  StoreController,
  type ColorPanelPrefs,
  type PickerGeometry,
} from "../core/stores";
import { historyStateStore } from "../core/history";

// ============================================================
// Shared Picker Styles (consolidated CSS variables)
// ============================================================

const pickerVars = css`
  :host {
    --picker-border-width: 2px;
    --picker-border-color: var(--block-border, #9f9f9f);
    --picker-handle-size: 12px;
    --picker-slider-width: 20px;
    --picker-gap: 8px;
  }
`;

const handleStyles = css`
  .handle {
    position: absolute;
    width: var(--picker-handle-size);
    height: var(--picker-handle-size);
    border-radius: 50%;
    border: var(--picker-border-width) solid white;
    box-shadow: 0 0 2px rgba(0, 0, 0, 0.5);
    background: transparent;
    transform: translate(-50%, -50%);
    box-sizing: border-box;
    pointer-events: none;
  }
`;

const sliderColumnStyles = css`
  .slider-column {
    display: flex;
    flex-direction: column;
    gap: var(--picker-gap);
    width: var(--picker-slider-width);
  }

  .color-preview {
    width: 100%;
    aspect-ratio: 1;
    border-radius: 2px;
    border: var(--picker-border-width) solid var(--picker-border-color);
    box-sizing: border-box;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .color-half { flex: 1; }

  .s-slider {
    flex: 1;
    position: relative;
    border-radius: 2px;
    overflow: hidden;
    border: var(--picker-border-width) solid var(--picker-border-color);
    box-sizing: border-box;
    cursor: pointer;
  }

  .s-gradient { width: 100%; height: 100%; }

  .s-handle {
    position: absolute;
    left: 50%;
    width: calc(100% - 4px);
    height: 6px;
    border-radius: 2px;
    border: var(--picker-border-width) solid white;
    box-shadow: 0 0 2px rgba(0, 0, 0, 0.5);
    background: transparent;
    transform: translate(-50%, -50%);
    box-sizing: border-box;
    pointer-events: none;
  }
`;

// ============================================================
// Base Color Picker Class (shared logic for all pickers)
// ============================================================

abstract class BaseColorPicker extends LitElement {
  @property({ type: String }) color = "#037ffc";
  @property({ type: String }) prevColor = "#000000";

  protected abstract syncFromColor(hex: string): void;
  protected abstract getColorFromState(): string;

  protected emitChange() {
    this.color = this.getColorFromState();
    this.dispatchEvent(
      new CustomEvent("input", {
        detail: { value: this.color },
        bubbles: true,
        composed: true,
      })
    );
    this.requestUpdate();
  }

  protected emitChangeEnd() {
    this.dispatchEvent(
      new CustomEvent("change", {
        detail: { value: this.color },
        bubbles: true,
        composed: true,
      })
    );
  }

  protected startDrag(
    e: PointerEvent,
    onUpdate: (e: PointerEvent) => void,
    onEnd?: () => void
  ) {
    onUpdate(e);
    const move = (ev: PointerEvent) => onUpdate(ev);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this.emitChangeEnd();
      onEnd?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
}

// ============================================================
// Base Block Component
// ============================================================

type ResizeCorner = "left" | "right" | null;

export class Block extends LitElement {
  @property({ type: Boolean, reflect: true }) active = false;
  @property({ type: Boolean }) draggable = false;
  @property({ type: Boolean }) resizable = false;
  @property({ type: Number }) blockWidth: number | null = null;
  @property({ type: Number }) blockHeight: number | null = null;

  // Drag state
  private _isDragging = false;
  private _dragOffset = { x: 0, y: 0 };

  // Resize state (protected for subclass override)
  protected _isResizing = false;
  protected _resizeCorner: ResizeCorner = null;
  protected _resizeStart = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };

  static styles = css`
    :host {
      /* Design tokens */
      --block-depth: 7px;
      --block-depth-color: #bcbcbc;
      --block-border: #555555;
      --block-radius: 10px;
      --block-face-bg: #ffffff;
      --block-face-padding: 10px;
      --block-font: system-ui, sans-serif;
      --block-font-size: 13px;
      --block-font-weight: 500;
      --block-font-color: #6b6b6b;

      display: block;
      box-sizing: border-box;
      padding: 0;
      font-family: var(--block-font);
      font-size: var(--block-font-size);
      font-weight: var(--block-font-weight);
      color: var(--block-font-color);
    }

    :host([dragging]) {
      cursor: grabbing;
      user-select: none;
    }

    :host([resizing]) {
      user-select: none;
    }

    .block {
      box-sizing: border-box;
      background: var(--block-depth-color);
      border: 2px solid var(--block-border);
      border-radius: var(--block-radius);
      padding: 0 0 var(--block-depth) 0;
      height: 100%;
      box-shadow: 0 0 10px rgba(5, 0, 0, 0.3);
      position: relative;
      overflow: hidden;
    }

    .face {
      box-sizing: border-box;
      background: var(--block-face-bg);
      border-radius: calc(var(--block-radius) - 2px);
      padding: var(--block-face-padding);
      height: 100%;
      overflow: auto;
    }

    /* Resize corner zones in the depth area */
    .resize-left,
    .resize-right {
      position: absolute;
      bottom: 0;
      width: 25%;
      height: var(--block-depth);
      z-index: 10;
    }

    .resize-left {
      left: 0;
      cursor: nesw-resize;
      border-bottom-left-radius: calc(var(--block-radius) - 2px);
    }

    .resize-right {
      right: 0;
      cursor: nwse-resize;
      border-bottom-right-radius: calc(var(--block-radius) - 2px);
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener("pointerdown", this._onPointerDown);
    this.addEventListener("pointermove", this._onPointerHover);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("pointerdown", this._onPointerDown);
    this.removeEventListener("pointermove", this._onPointerHover);
    this._cleanupDrag();
    this._cleanupResize();
  }

  private _isWhitespaceTarget(e: PointerEvent): boolean {
    const path = e.composedPath();
    const blockEl = this.renderRoot.querySelector(".block");
    const faceEl = this.renderRoot.querySelector(".face");

    for (const el of path) {
      if (el === blockEl || el === faceEl) return true;
      if (el === this) return true;
      if (el instanceof HTMLElement) {
        // Block if element is explicitly marked as interactive
        if (el.hasAttribute("data-interactive")) {
          return false;
        }
        const tag = el.tagName.toLowerCase();
        if (tag === "button" || tag === "input" || tag === "blocky-button") {
          return false;
        }
        if (tag === "h3" || tag === "span" || tag === "p") continue;
      }
    }
    return false;
  }

  private _getResizeCorner(e: PointerEvent): ResizeCorner {
    if (!this.resizable) return null;

    const rect = this.getBoundingClientRect();
    const depth = parseInt(
      getComputedStyle(this).getPropertyValue("--block-depth") || "10"
    );

    // Check if in bottom depth area
    const inDepthY = e.clientY > rect.bottom - depth - 2; // -2 for border
    if (!inDepthY) return null;

    const relX = e.clientX - rect.left;
    const cornerWidth = rect.width * 0.25;

    if (relX < cornerWidth) return "left";
    if (relX > rect.width - cornerWidth) return "right";

    return null; // Middle area - use for dragging
  }

  private _onPointerHover = (e: PointerEvent) => {
    if (this._isDragging || this._isResizing) return;

    const corner = this._getResizeCorner(e);
    if (corner === "left") {
      this.style.cursor = "nesw-resize";
    } else if (corner === "right") {
      this.style.cursor = "nwse-resize";
    } else {
      this.style.cursor = "";
    }
  };

  private _onPointerDown = (e: PointerEvent) => {
    // Check for resize first
    const corner = this._getResizeCorner(e);
    if (corner) {
      this._startResize(e, corner);
      return;
    }

    // Otherwise, handle drag
    if (!this.draggable) return;
    if (!this._isWhitespaceTarget(e)) return;
    this._startDrag(e);
  };

  // ============================================================
  // Drag Logic
  // ============================================================

  private _startDrag(e: PointerEvent) {
    e.preventDefault();
    this._isDragging = true;
    this.setAttribute("dragging", "");

    // Bring panel to top
    const allPanels = document.querySelectorAll<HTMLElement>("[data-panel]");
    let maxZIndex = 1000;
    allPanels.forEach((panel) => {
      const zIndex = parseInt(
        window.getComputedStyle(panel).zIndex || "1000",
        10
      );
      if (zIndex > maxZIndex) maxZIndex = zIndex;
    });
    this.style.zIndex = `${maxZIndex + 1}`;

    const rect = this.getBoundingClientRect();
    this._dragOffset = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };

    window.addEventListener("pointermove", this._onDragMove);
    window.addEventListener("pointerup", this._onDragEnd);
  }

  private _onDragMove = (e: PointerEvent) => {
    if (!this._isDragging) return;

    const newLeft = e.clientX - this._dragOffset.x;
    const newTop = e.clientY - this._dragOffset.y;

    this.style.left = `${newLeft}px`;
    this.style.top = `${newTop}px`;
    this.style.right = "auto";
    this.style.bottom = "auto";
  };

  private _onDragEnd = () => {
    this._applyPercentagePosition();
    this.onDragCommitted();
    this._cleanupDrag();
  };

  private _applyPercentagePosition() {
    const rect = this.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const nearLeft = centerX < vw / 2;
    const nearTop = centerY < vh / 2;

    if (nearLeft) {
      const leftPercent = (rect.left / vw) * 100;
      this.style.left = `${leftPercent}%`;
      this.style.right = "auto";
    } else {
      const rightPercent = ((vw - rect.right) / vw) * 100;
      this.style.right = `${rightPercent}%`;
      this.style.left = "auto";
    }

    if (nearTop) {
      const topPercent = (rect.top / vh) * 100;
      this.style.top = `${topPercent}%`;
      this.style.bottom = "auto";
    } else {
      const bottomPercent = ((vh - rect.bottom) / vh) * 100;
      this.style.bottom = `${bottomPercent}%`;
      this.style.top = "auto";
    }
  }

  private _cleanupDrag() {
    this._isDragging = false;
    this.removeAttribute("dragging");
    window.removeEventListener("pointermove", this._onDragMove);
    window.removeEventListener("pointerup", this._onDragEnd);
  }

  // ============================================================
  // Resize Logic
  // ============================================================

  private _startResize(e: PointerEvent, corner: ResizeCorner) {
    e.preventDefault();
    e.stopPropagation();

    this._isResizing = true;
    this._resizeCorner = corner;
    this.setAttribute("resizing", "");

    const rect = this.getBoundingClientRect();
    this._resizeStart = {
      x: e.clientX,
      y: e.clientY,
      width: rect.width,
      height: rect.height,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    };

    // Switch to pixel positioning immediately so resize works correctly
    // regardless of which corner the panel was anchored to
    this.style.left = `${rect.left}px`;
    this.style.top = `${rect.top}px`;
    this.style.right = "auto";
    this.style.bottom = "auto";

    // Initialize blockWidth/blockHeight if not set
    if (this.blockWidth === null) this.blockWidth = rect.width;
    if (this.blockHeight === null) this.blockHeight = rect.height;

    // Bring panel to top
    const allPanels = document.querySelectorAll<HTMLElement>("[data-panel]");
    let maxZIndex = 1000;
    allPanels.forEach((panel) => {
      const zIndex = parseInt(
        window.getComputedStyle(panel).zIndex || "1000",
        10
      );
      if (zIndex > maxZIndex) maxZIndex = zIndex;
    });
    this.style.zIndex = `${maxZIndex + 1}`;

    window.addEventListener("pointermove", this._onResizeMove);
    window.addEventListener("pointerup", this._onResizeEnd);
  }

  protected _onResizeMove = (e: PointerEvent) => {
    if (!this._isResizing) return;

    const minWidth = 100;
    const minHeight = 80;

    // Calculate new bounds based on which corner is being dragged
    // The dragged corner follows the cursor, opposite corner stays fixed
    let newLeft = this._resizeStart.left;
    let newTop = this._resizeStart.top;
    let newRight = this._resizeStart.right;
    let newBottom = e.clientY; // Bottom always follows cursor Y for bottom corners

    if (this._resizeCorner === "right") {
      // Right corner: right edge follows cursor X, left edge stays fixed
      newRight = e.clientX;
    } else if (this._resizeCorner === "left") {
      // Left corner: left edge follows cursor X, right edge stays fixed
      newLeft = e.clientX;
    }

    // Calculate new dimensions
    let newWidth = newRight - newLeft;
    let newHeight = newBottom - newTop;

    // Enforce minimums
    if (newWidth < minWidth) {
      if (this._resizeCorner === "left") {
        newLeft = newRight - minWidth;
      }
      newWidth = minWidth;
    }
    if (newHeight < minHeight) {
      newHeight = minHeight;
    }

    // Apply position and size
    this.style.left = `${newLeft}px`;
    this.style.top = `${newTop}px`;
    this.blockWidth = newWidth;
    this.blockHeight = newHeight;

    this.requestUpdate();
  };

  private _onResizeEnd = () => {
    this._applyPercentagePosition();
    this._cleanupResize();
  };

  protected onDragCommitted() {
    // Subclasses can react when a drag operation commits a new position.
  }

  private _cleanupResize() {
    this._isResizing = false;
    this._resizeCorner = null;
    this.removeAttribute("resizing");
    window.removeEventListener("pointermove", this._onResizeMove);
    window.removeEventListener("pointerup", this._onResizeEnd);
  }

  updated(changedProperties: Map<string, unknown>) {
    super.updated(changedProperties);
    // Apply dimensions directly to host element style
    if (changedProperties.has("blockWidth") || changedProperties.has("blockHeight")) {
      if (this.blockWidth !== null) {
        this.style.width = `${this.blockWidth}px`;
      } else {
        this.style.removeProperty("width");
      }
      if (this.blockHeight !== null) {
        this.style.height = `${this.blockHeight}px`;
      } else {
        this.style.removeProperty("height");
      }
    }
  }

  render() {
    return html`
      <div class="block">
        <div class="face">
          <slot></slot>
        </div>
        ${this.resizable
          ? html`
              <div class="resize-left"></div>
              <div class="resize-right"></div>
            `
          : ""}
      </div>
    `;
  }
}

// ============================================================
// Blocky Button
// ============================================================

@customElement("blocky-button")
export class BlockyButton extends Block {
  @property({ type: Boolean, reflect: true }) danger = false;

  connectedCallback() {
    super.connectedCallback();
    // iOS Safari needs explicit touch handling for custom elements
    this.addEventListener("touchend", this._onTouchEnd);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("touchend", this._onTouchEnd);
  }

  private _onTouchEnd = (e: TouchEvent) => {
    e.preventDefault();
    this.click();
  };

  static styles = css`
    ${Block.styles}

    :host {
      display: inline-block;
      cursor: pointer;
      text-align: center;
      transition: padding 100ms ease-in-out;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
      user-select: none;
      -webkit-user-select: none;
    }

    .block {
      transition: padding 100ms ease-in-out;
      box-shadow: 0 0 10px rgba(5, 0, 0, 0.2);
    }

    @media (hover: hover) {
      :host(:hover:not(:active):not([active])) {
        padding-top: calc(var(--block-depth) / 2);
      }
      :host(:hover:not(:active):not([active])) .block {
        padding-bottom: calc(var(--block-depth) / 2);
      }
    }

    :host(:active),
    :host([active]) {
      padding-top: var(--block-depth);
    }
    :host(:active) .block,
    :host([active]) .block {
      padding-bottom: 0;
    }

    :host([danger]) {
      --block-face-bg: #333;
      --block-color: white;
    }
  `;
}



// ============================================================
// Generic Configurable Color Picker
// ============================================================

@customElement("generic-color-picker")
export class GenericColorPicker extends BaseColorPicker {
  @property({ type: Object }) prefs!: ColorPanelPrefs;

  private values: ChannelValues = {};
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  static styles = [pickerVars, handleStyles, sliderColumnStyles, css`
    :host { display: block; height: 100%; }

    .picker-main { display: flex; gap: var(--picker-gap); width: 100%; align-items: stretch; }
    .plane-area { flex: 1; min-width: 0; }

    .plane-square { position: relative; width: 100%; height: 0; padding-bottom: 100%; }
    .plane-square-inner {
      position: absolute; inset: 0; cursor: crosshair; border-radius: 2px; overflow: hidden;
      border: var(--picker-border-width) solid var(--picker-border-color); box-sizing: border-box;
    }

    .plane-circle-wrap { position: relative; width: 100%; height: 0; padding-bottom: 100%; }
    .plane-circle-inner { position: absolute; inset: 0; cursor: crosshair; }
    .circle-disk {
      position: absolute; inset: 0; border-radius: 50%; overflow: hidden;
      outline: var(--picker-border-width) solid var(--picker-border-color);
      outline-offset: calc(-1 * var(--picker-border-width));
    }

    canvas { display: block; width: 100%; height: 100%; }
    .slider-column { flex-shrink: 0; }
    .sliders-stack { flex: 1; display: flex; flex-direction: column; gap: 6px; min-height: 48px; }
    .sliders-stack .s-slider { flex: 1; min-height: 36px; }
  `];

  private getAdapter(): ColorSpaceAdapter { return getColorSpaceAdapter(this.prefs.space); }
  private channelMeta(id: string) { return this.getAdapter().channels.find((c) => c.id === id); }

  firstUpdated() {
    this.ensureCanvas();
    this.syncFromColor(this.color);
    this.drawPlane();
  }

  updated(changed: Map<string, unknown>) {
    this.ensureCanvas();
    if (changed.has("color")) {
      this.syncFromColor(this.color);
    }
    if (changed.has("prefs")) this.syncFromColor(this.color);
    if (changed.has("color") || changed.has("prefs")) {
      this.drawPlane();
    }
  }

  private ensureCanvas() {
    const c = this.renderRoot.querySelector("canvas");
    if (c && c instanceof HTMLCanvasElement && c !== this.canvas) {
      this.canvas = c;
      this.ctx = c.getContext("2d");
    }
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

    const w = this.canvas.width;
    const h = this.canvas.height;
    const imgData = this.ctx.createImageData(w, h);
    const data = imgData.data;
    const base = { ...this.values };

    if (geometry === "square") {
      for (let y = 0; y < h; y++) {
        const vy = my.max - (y / h) * (my.max - my.min);
        for (let x = 0; x < w; x++) {
          const vx = mx.min + (x / w) * (mx.max - mx.min);
          const [r, g, b] = adapter.toRgb(clampChannelValues(adapter, { ...base, [planeX]: vx, [planeY]: vy }));
          const i = (y * w + x) * 4;
          data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
        }
      }
    } else {
      const cx = w / 2, cy = h / 2, radius = Math.min(cx, cy);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = x - cx, dy = y - cy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const i = (y * w + x) * 4;
          if (dist > radius) continue;
          let angleDeg = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
          if (angleDeg < 0) angleDeg += 360;
          const t = radius > 0 ? dist / radius : 0;
          const vx = mx.cyclic ? angleDeg : mx.min + (angleDeg / 360) * (mx.max - mx.min);
          const vy = my.min + t * (my.max - my.min);
          const [r, g, b] = adapter.toRgb(clampChannelValues(adapter, { ...base, [planeX]: vx, [planeY]: vy }));
          data[i] = r; data[i+1] = g; data[i+2] = b; data[i+3] = 255;
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

    const [r1, g1, b1] = adapter.toRgb(clampChannelValues(adapter, { ...this.values, [sid]: m.max }));
    const [r2, g2, b2] = adapter.toRgb(clampChannelValues(adapter, { ...this.values, [sid]: m.min }));
    return `linear-gradient(to bottom, rgb(${r1},${g1},${b1}), rgb(${r2},${g2},${b2}))`;
  }

  // --- Interaction ---

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
      this.emitChange(); this.drawPlane();
    };
    this.startDrag(e, update);
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
      this.emitChange(); this.drawPlane();
    };
    this.startDrag(e, update);
  }

  private handleSliderDown(e: PointerEvent) {
    const sid = this.sliderId(); if (!sid) return;
    const m = this.channelMeta(sid); if (!m) return;
    const adapter = this.getAdapter();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const update = (ev: PointerEvent) => {
      const v = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
      this.values = clampChannelValues(adapter, { ...this.values, [sid]: m.max - v * (m.max - m.min) });
      this.emitChange(); this.drawPlane();
    };
    this.startDrag(e, update);
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
                <canvas width="100" height="100"></canvas>
                <div class="handle" style="left:${h.left}%;top:${h.top}%;"></div>
              </div>
            </div>
          ` : html`
            <div class="plane-circle-wrap">
              <div class="plane-circle-inner">
                <div class="circle-disk" data-interactive @pointerdown=${this.handleCircleDown}>
                  <canvas width="100" height="100"></canvas>
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

// ============================================================
// Floating Panel Base Class
// ============================================================

export class FloatingPanel extends Block {
  @property({ type: Boolean, reflect: true }) pinned = false;
  @property({ type: Boolean }) showPinnedClose = true;

  static styles = css`
    ${Block.styles}

    :host {
      position: fixed;
      z-index: 1000;
      top: var(--panel-top, auto);
      right: var(--panel-right, auto);
      bottom: var(--panel-bottom, auto);
      left: var(--panel-left, auto);
      width: var(--panel-width, auto);
      touch-action: auto;
    }

    .block {
      display: flex;
      flex-direction: column;
    }

    .face {
      flex: 1;
      min-height: 0;
    }

    section {
      margin-bottom: 12px;
    }
    section:last-child {
      margin-bottom: 0;
    }

    h3 {
      margin: 0 0 8px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #666;
    }

    .panel-title {
      display: flex;
      align-items: center;
      justify-content: flex-start;
    }

    .floating-close {
      position: absolute;
      top: -10px;
      right: -10px;
      width: 22px;
      height: 22px;
      border: 1px solid #8a8a8a;
      border-radius: 50%;
      background: #d2d2d2;
      color: #4d4d4d;
      font-size: 14px;
      line-height: 1;
      display: grid;
      place-items: center;
      cursor: pointer;
      z-index: 1300;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
      padding: 0;
    }

    .floating-close:hover {
      background: #c4c4c4;
    }

    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .row {
      display: flex;
      gap: 8px;
    }
    .row > * {
      flex: 1;
    }

    label {
      display: block;
      margin-bottom: 12px;
    }
    label > span {
      display: block;
      margin-bottom: 6px;
    }
    label:last-child {
      margin-bottom: 0;
    }

    input[type="range"] {
      width: 100%;
    }

    .toggle {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .hint {
      color: #666;
      font-style: italic;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute('data-panel', '');
  }

  protected onDragCommitted() {
    this.pinned = true;
  }

  hidePanel() {
    this.pinned = false;
    this.blockWidth = null;
    this.blockHeight = null;
    this.style.display = "none";
    this.dispatchEvent(
      new CustomEvent("panel-visibility-change", {
        detail: { id: this.id, visible: false },
        bubbles: true,
        composed: true,
      }),
    );
  }

  protected renderPanelTitle(title: string) {
    return html`<h3 class="panel-title"><span>${title}</span></h3>`;
  }

  protected renderPinnedClose() {
    if (!this.pinned || !this.showPinnedClose) return html``;
    return html`
      <button
        class="floating-close"
        title="Hide panel"
        data-interactive
        @click=${(e: Event) => {
          e.stopPropagation();
          this.hidePanel();
        }}
      >
        ×
      </button>
    `;
  }
}

// ============================================================
// Color Panel (generic configurable picker)
// ============================================================

const COLOR_SPACE_OPTIONS: { id: ColorSpaceId; label: string }[] = [
  { id: "hsv", label: "HSV" },
  { id: "hsl", label: "HSL" },
  { id: "okhsv", label: "OKHSV" },
  { id: "okhsl", label: "OKHSL" },
];

@customElement("inkwell-color-panel")
export class InkwellColorPanel extends FloatingPanel {
  @property({ type: String }) color = "#037ffc";
  @state() private prevColor = "#000000";

  private pickerPrefs = new StoreController(this, colorPanelPrefsStore);
  private unsubscribeColor?: () => void;
  private unsubscribePrevColor?: () => void;

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      --block-face-padding: 10px;
      --panel-width: 240px;
    }

    .face {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .color-config {
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 11px;
    }
    .color-config label { display: flex; flex-direction: column; gap: 2px; margin: 0; }
    .color-config select { width: 100%; font: inherit; padding: 2px 4px; }
    .row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .picker-wrap { min-height: 140px; flex-shrink: 0; }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.unsubscribeColor = colorStore.subscribe((c) => { if (this.color !== c) this.color = c; });
    this.unsubscribePrevColor = prevColorStore.subscribe((p) => { this.prevColor = p; });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribeColor?.();
    this.unsubscribePrevColor?.();
  }

  private emit(name: string, detail?: unknown) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private onSpaceChange(e: Event) {
    const newSpace = (e.target as HTMLSelectElement).value as ColorSpaceId;
    const cur = this.pickerPrefs.value;
    const oldAdapter = getColorSpaceAdapter(cur.space);
    const newAdapter = getColorSpaceAdapter(newSpace);
    const xIdx = oldAdapter.channels.findIndex((c) => c.id === cur.planeX);
    const yIdx = oldAdapter.channels.findIndex((c) => c.id === cur.planeY);
    const newX = xIdx >= 0 && xIdx < newAdapter.channels.length ? newAdapter.channels[xIdx].id : newAdapter.defaultPlaneX;
    const newY = yIdx >= 0 && yIdx < newAdapter.channels.length ? newAdapter.channels[yIdx].id : newAdapter.defaultPlaneY;
    colorPanelPrefsStore.set(normalizeColorPanelPrefs({ space: newSpace, geometry: cur.geometry, planeX: newX, planeY: newY }));
  }

  private onGeometryChange(g: PickerGeometry) {
    colorPanelPrefsStore.set(normalizeColorPanelPrefs({ ...this.pickerPrefs.value, geometry: g }));
  }

  private onGeometrySelectChange(e: Event) {
    this.onGeometryChange((e.target as HTMLSelectElement).value as PickerGeometry);
  }

  private onPlaneAxisChange(axis: "planeX" | "planeY", e: Event) {
    const newId = (e.target as HTMLSelectElement).value;
    const cur = { ...this.pickerPrefs.value };
    const other = axis === "planeX" ? "planeY" : "planeX";
    if (newId === cur[other]) {
      cur[other] = cur[axis];
    }
    cur[axis] = newId;
    colorPanelPrefsStore.set(normalizeColorPanelPrefs(cur));
  }

  render() {
    const prefs = this.pickerPrefs.value;
    const adapter = getColorSpaceAdapter(prefs.space);
    const channelOpts = adapter.channels;

    return html`
      ${this.renderPinnedClose()}
      <div class="block">
        <div class="face">
          <div class="picker-wrap">
            <generic-color-picker
              .color=${this.color}
              .prevColor=${this.prevColor}
              .prefs=${prefs}
              @input=${(e: CustomEvent<{ value: string }>) => {
                this.color = e.detail.value;
                colorStore.set(this.color);
                this.emit("color-change", this.color);
              }}
              @change=${() => { prevColorStore.set(this.color); }}
            ></generic-color-picker>
          </div>
          <div class="color-config" data-interactive>
            <label>
              <span>Color space</span>
              <select @change=${this.onSpaceChange}>
                ${COLOR_SPACE_OPTIONS.map((o) => html`<option value=${o.id} .selected=${o.id === prefs.space}>${o.label}</option>`)}
              </select>
            </label>
            <label>
              <span>Shape</span>
              <select @change=${this.onGeometrySelectChange}>
                <option value="square" .selected=${prefs.geometry === "square"}>Square</option>
                <option value="circle" .selected=${prefs.geometry === "circle"}>Circle</option>
              </select>
            </label>
            <div class="row-2">
              <label>
                <span>X / angle</span>
                <select @change=${(e: Event) => this.onPlaneAxisChange("planeX", e)}>
                  ${channelOpts.map((c) => html`<option value=${c.id} .selected=${c.id === prefs.planeX}>${c.label}</option>`)}
                </select>
              </label>
              <label>
                <span>Y / radius</span>
                <select @change=${(e: Event) => this.onPlaneAxisChange("planeY", e)}>
                  ${channelOpts.map((c) => html`<option value=${c.id} .selected=${c.id === prefs.planeY}>${c.label}</option>`)}
                </select>
              </label>
            </div>
          </div>
        </div>
        ${this.resizable ? html`<div class="resize-left"></div><div class="resize-right"></div>` : ""}
      </div>
    `;
  }
}

// ============================================================
// Tools Panel
// ============================================================

@customElement("inkwell-tools-panel")
export class InkwellToolsPanel extends FloatingPanel {
  @property({ type: Number }) pixelRes = 2;

  private tool = new StoreController(this, toolStore);
  private modifiers = new StoreController(this, modifiersStore);
  private settings = new StoreController(this, toolSettingsStore);

  static styles = css`
    ${FloatingPanel.styles}
  `;

  private emit(name: string, detail?: unknown) {
    this.dispatchEvent(
      new CustomEvent(name, { detail, bubbles: true, composed: true })
    );
  }

  private setTool(tool: ToolId) {
    this.tool.set(tool);
    this.emit("tool-change", tool);
  }

  private updateSetting(toolId: ToolId, key: string, value: unknown) {
    this.settings.update((s) => ({
      ...s,
      [toolId]: { ...s[toolId], [key]: value },
    }));
    this.emit("settings-change", this.settings.value);
  }

  private renderPixelRes() {
    return html`
      <label>
        <span>Pixel Resolution: ${this.pixelRes}x</span>
        <input
          type="range"
          min="1"
          max="8"
          step="1"
          .value=${String(this.pixelRes)}
          @input=${(e: Event) => {
            this.pixelRes = parseInt((e.target as HTMLInputElement).value);
            this.emit("pixel-res-change", this.pixelRes);
          }}
        />
      </label>
    `;
  }

  private renderSetting(
    toolId: ToolId,
    key: string,
    def: SettingDef,
    currentValue: unknown
  ): TemplateResult {
    const hint =
      key === "mode" &&
      this.modifiers.value.shift
        ? "(Shift toggled)"
        : "";
    const label = this.formatLabel(key);

    if (def.type === "toggle") {
      return html`
        <label>
          <span>${label} ${hint}</span>
          <div class="row">
            ${def.options.map(
              (opt) => html`
                <blocky-button
                  ?active=${currentValue === opt}
                  @click=${() => this.updateSetting(toolId, key, opt)}
                  >${this.formatLabel(opt)}</blocky-button
                >
              `
            )}
          </div>
        </label>
      `;
    }

    if (def.type === "range") {
      return html`
        <label>
          <span>${label}: ${currentValue}</span>
          <input
            type="range"
            min=${def.min}
            max=${def.max}
            step=${def.step}
            .value=${String(currentValue)}
            @input=${(e: Event) =>
              this.updateSetting(
                toolId,
                key,
                parseFloat((e.target as HTMLInputElement).value)
              )}
          />
        </label>
      `;
    }

    if (def.type === "color") {
      return html`
        <label>
          <span>${label}</span>
          <input
            type="color"
            .value=${String(currentValue)}
            @input=${(e: Event) =>
              this.updateSetting(toolId, key, (e.target as HTMLInputElement).value)}
          />
        </label>
      `;
    }

    return html``;
  }

  private formatLabel(key: string): string {
    return key
      .replace(/([A-Z])/g, " $1")
      .replace(/^./, (str) => str.toUpperCase())
      .trim();
  }

  private renderToolSettings(): TemplateResult {
    const currentToolId = this.tool.value;
    const currentTool = getTool(currentToolId);
    const toolSettings = this.settings.value[currentToolId] as Record<string, unknown>;
    const schema = currentTool.settings as SettingsSchema;

    const schemaKeys = Object.keys(schema);
    if (schemaKeys.length === 0) {
      if (currentToolId === "select") {
        return html`<p class="hint">Click to select, drag to move.</p>`;
      }
      if (currentToolId === "pan") {
        return html`<p class="hint">Drag to pan, scroll to zoom.</p>`;
      }
      if (currentToolId === "eyedropper") {
        return html`<p class="hint">Click artwork to pick its color.</p>`;
      }
      return html`${this.renderPixelRes()}`;
    }

    return html`
      ${schemaKeys.map((key) =>
        this.renderSetting(
          currentToolId,
          key,
          schema[key],
          toolSettings[key]
        )
      )}
      ${currentToolId === "select"
        ? html`<p class="hint">Drag a rectangle or freeform lasso to extract a selection.</p>`
        : ""}
      ${this.renderPixelRes()}
    `;
  }

  render() {
    return html`
      ${this.renderPinnedClose()}
      <div class="block">
        <div class="face">
          ${this.renderPanelTitle("Tools")}
          <div class="grid">
            ${tools.map(
              (t) => html`
                <blocky-button
                  ?active=${this.tool.value === t.id}
                  @click=${() => this.setTool(t.id as ToolId)}
                  >${t.name}</blocky-button
                >
              `
            )}
          </div>
          <section>
            ${this.renderPanelTitle("Tool Settings")}
            ${this.renderToolSettings()}
          </section>
        </div>
      </div>
    `;
  }
}

// ============================================================
// Tool Settings Panel
// ============================================================

@customElement("inkwell-tool-settings-panel")
export class InkwellToolSettingsPanel extends FloatingPanel {
  @property({ type: Number }) pixelRes = 2;

  private tool = new StoreController(this, toolStore);
  private modifiers = new StoreController(this, modifiersStore);
  private settings = new StoreController(this, toolSettingsStore);

  static styles = css`
    ${FloatingPanel.styles}
  `;

  private emit(name: string, detail?: unknown) {
    this.dispatchEvent(
      new CustomEvent(name, { detail, bubbles: true, composed: true })
    );
  }

  /**
   * Update a setting for the current tool
   */
  private updateSetting(toolId: ToolId, key: string, value: unknown) {
    this.settings.update((s) => ({
      ...s,
      [toolId]: { ...s[toolId], [key]: value },
    }));
    this.emit("settings-change", this.settings.value);
  }

  private renderPixelRes() {
    return html`
      <label>
        <span>Pixel Resolution: ${this.pixelRes}x</span>
        <input
          type="range"
          min="1"
          max="8"
          step="1"
          .value=${String(this.pixelRes)}
          @input=${(e: Event) => {
            this.pixelRes = parseInt((e.target as HTMLInputElement).value);
            this.emit("pixel-res-change", this.pixelRes);
          }}
        />
      </label>
    `;
  }

  /**
   * Render a single setting based on its schema definition
   */
  private renderSetting(
    toolId: ToolId,
    key: string,
    def: SettingDef,
    currentValue: unknown
  ): TemplateResult {
    const hint =
      key === "mode" &&
      this.modifiers.value.shift
        ? "(Shift toggled)"
        : "";
    const label = this.formatLabel(key);

    if (def.type === "toggle") {
      return html`
        <label>
          <span>${label} ${hint}</span>
          <div class="row">
            ${def.options.map(
              (opt) => html`
                <blocky-button
                  ?active=${currentValue === opt}
                  @click=${() => this.updateSetting(toolId, key, opt)}
                  >${this.formatLabel(opt)}</blocky-button
                >
              `
            )}
          </div>
        </label>
      `;
    }

    if (def.type === "range") {
      return html`
        <label>
          <span>${label}: ${currentValue}</span>
          <input
            type="range"
            min=${def.min}
            max=${def.max}
            step=${def.step}
            .value=${String(currentValue)}
            @input=${(e: Event) =>
              this.updateSetting(
                toolId,
                key,
                parseFloat((e.target as HTMLInputElement).value)
              )}
          />
        </label>
      `;
    }

    if (def.type === "color") {
      return html`
        <label>
          <span>${label}</span>
          <input
            type="color"
            .value=${String(currentValue)}
            @input=${(e: Event) =>
              this.updateSetting(toolId, key, (e.target as HTMLInputElement).value)}
          />
        </label>
      `;
    }

    return html``;
  }

  /**
   * Format a camelCase key into a human-readable label
   */
  private formatLabel(key: string): string {
    // Convert camelCase to Title Case with spaces
    return key
      .replace(/([A-Z])/g, " $1")
      .replace(/^./, (str) => str.toUpperCase())
      .trim();
  }

  /**
   * Render settings from the tool's schema
   */
  private renderToolSettings(): TemplateResult {
    const currentToolId = this.tool.value;
    const currentTool = getTool(currentToolId);
    const toolSettings = this.settings.value[currentToolId] as Record<string, unknown>;
    const schema = currentTool.settings as SettingsSchema;

    // Check if tool has any settings
    const schemaKeys = Object.keys(schema);
    if (schemaKeys.length === 0) {
      // Show hints for tools without settings
      if (currentToolId === "select") {
        return html`<p class="hint">Click to select, drag to move.</p>`;
      }
      if (currentToolId === "pan") {
        return html`<p class="hint">Drag to pan, scroll to zoom.</p>`;
      }
      if (currentToolId === "eyedropper") {
        return html`<p class="hint">Click artwork to pick its color.</p>`;
      }
      return html``;
    }

    // Render each setting from schema
    return html`
      ${schemaKeys.map((key) =>
        this.renderSetting(
          currentToolId,
          key,
          schema[key],
          toolSettings[key]
        )
      )}
      ${this.renderPixelRes()}
    `;
  }

  render() {
    return html`
      ${this.renderPinnedClose()}
      <div class="block">
        <div class="face">
            ${this.renderPanelTitle("Tool Settings")}
            ${this.renderToolSettings()}
        </div>
      </div>
    `;
  }
}

// ============================================================
// Universal Panel
// ============================================================

interface PanelVisibility {
  id: string;
  label: string;
  visible: boolean;
}

type ToggleablePanel = FloatingPanel & HTMLElement;

const PANEL_VISIBILITY_DEFAULTS: PanelVisibility[] = [
  { id: "color-panel", label: "Color", visible: false },
  { id: "tools-panel", label: "Tools", visible: false },
  { id: "universal-panel", label: "Settings", visible: false },
  { id: "layers-panel", label: "Layers", visible: false },
];

// ============================================================
// Top Bar Panel (panel visibility toggles)
// ============================================================

@customElement("inkwell-top-bar-panel")
export class InkwellTopBarPanel extends FloatingPanel {
  @state() private panelVisibility: PanelVisibility[] = PANEL_VISIBILITY_DEFAULTS.map((p) => ({
    ...p,
  }));
  private readonly outsidePointerHandler = (e: PointerEvent) => this.closePanelsOnOutsideClick(e);
  private readonly panelVisibilityChangeHandler = (e: Event) =>
    this.onPanelVisibilityChange(e as CustomEvent<{ id: string; visible: boolean }>);

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      --panel-top: 1%;
      --panel-left: 50%;
      --panel-width: max-content;
      transform: translateX(-50%);
      z-index: 1200;
      max-width: calc(100vw - 16px);
    }

    .face {
      padding: 8px 10px;
    }

    .bar {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      width: max-content;
      max-width: 100%;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.pinned = true;
    this.showPinnedClose = false;
    this.initializeAllPanelsHidden();
    document.addEventListener("pointerdown", this.outsidePointerHandler, true);
    document.addEventListener("panel-visibility-change", this.panelVisibilityChangeHandler as EventListener);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("pointerdown", this.outsidePointerHandler, true);
    document.removeEventListener(
      "panel-visibility-change",
      this.panelVisibilityChangeHandler as EventListener,
    );
  }

  firstUpdated() {
    this.positionAllVisiblePanels();
  }

  private initializeAllPanelsHidden() {
    this.panelVisibility = this.panelVisibility.map((panel) => {
      const el = document.getElementById(panel.id) as ToggleablePanel | null;
      if (el) {
        el.style.display = "none";
      }
      return { ...panel, visible: false };
    });
  }

  private togglePanel(id: string, triggerEl?: HTMLElement) {
    const el = document.getElementById(id) as ToggleablePanel | null;
    if (!el) return;
    const panel = this.panelVisibility.find((p) => p.id === id);
    if (!panel) return;

    const newVisible = !panel.visible;
    if (!newVisible) {
      el.hidePanel();
      return;
    }

    this.panelVisibility.forEach((p) => {
      if (p.id === id || !p.visible) return;
      const otherEl = document.getElementById(p.id) as ToggleablePanel | null;
      if (!otherEl || otherEl.pinned) return;
      otherEl.hidePanel();
    });

    el.style.display = "";
    this.positionPanelBelowTrigger(el, triggerEl);
    this.bringPanelToFront(el);
    this.panelVisibility = this.panelVisibility.map((p) =>
      p.id === id ? { ...p, visible: true } : p,
    );
  }

  private onPanelVisibilityChange(e: CustomEvent<{ id: string; visible: boolean }>) {
    const { id, visible } = e.detail;
    this.panelVisibility = this.panelVisibility.map((panel) =>
      panel.id === id ? { ...panel, visible } : panel,
    );
  }

  private closePanelsOnOutsideClick(e: PointerEvent) {
    const path = e.composedPath();
    const clickedInsidePanel = path.some(
      (node) => node instanceof HTMLElement && node.hasAttribute("data-panel"),
    );
    if (clickedInsidePanel) return;

    let changed = false;
    this.panelVisibility.forEach((panel) => {
      if (!panel.visible) return;
      const el = document.getElementById(panel.id) as ToggleablePanel | null;
      if (!el || el.pinned) return;
      el.hidePanel();
      changed = true;
    });

    if (changed) this.requestUpdate();
  }

  private positionAllVisiblePanels() {
    const buttons = Array.from(this.renderRoot.querySelectorAll<HTMLElement>("blocky-button"));
    this.panelVisibility.forEach((panel, index) => {
      if (!panel.visible) return;
      const panelEl = document.getElementById(panel.id) as ToggleablePanel | null;
      if (!panelEl) return;
      this.positionPanelBelowTrigger(panelEl, buttons[index]);
    });
  }

  private positionPanelBelowTrigger(panelEl: ToggleablePanel, triggerEl?: HTMLElement) {
    if (!triggerEl) return;

    const triggerRect = triggerEl.getBoundingClientRect();
    const gap = 10;
    const panelRect = panelEl.getBoundingClientRect();
    const idealLeft = triggerRect.left + triggerRect.width / 2 - panelRect.width / 2;
    const maxLeft = window.innerWidth - panelRect.width - 8;
    const clampedLeft = Math.max(8, Math.min(idealLeft, maxLeft));
    let top = triggerRect.bottom + gap;

    if (top + panelRect.height > window.innerHeight - 8) {
      top = Math.max(8, triggerRect.top - panelRect.height - gap);
    }

    panelEl.style.left = `${Math.round(clampedLeft)}px`;
    panelEl.style.top = `${Math.round(top)}px`;
    panelEl.style.right = "auto";
    panelEl.style.bottom = "auto";
  }

  private bringPanelToFront(panelEl: HTMLElement) {
    const allPanels = document.querySelectorAll<HTMLElement>("[data-panel]");
    let maxZIndex = 1000;
    allPanels.forEach((panel) => {
      const zIndex = parseInt(window.getComputedStyle(panel).zIndex || "1000", 10);
      if (zIndex > maxZIndex) maxZIndex = zIndex;
    });
    panelEl.style.zIndex = `${maxZIndex + 1}`;
  }

  render() {
    return html`
      ${this.renderPinnedClose()}
      <div class="block">
        <div class="face">
          <div class="bar">
            ${this.panelVisibility.map(
              (panel) => html`
                <blocky-button
                  ?active=${panel.visible}
                  @click=${(e: Event) =>
                    this.togglePanel(panel.id, e.currentTarget as HTMLElement)}
                  >${panel.label}</blocky-button
                >
              `,
            )}
          </div>
        </div>
      </div>
    `;
  }
}

@customElement("inkwell-universal-panel")
export class InkwellUniversalPanel extends FloatingPanel {
  @property({ type: Number }) zoomLevel = 100;
  @property({ type: Number }) rotation = 0;
  @property({ type: Boolean }) cursorEnabled = true;
  @property({ type: Boolean }) aliasFixEnabled = true;

  private history = new StoreController(this, historyStateStore);
  private viewOverlay = new StoreController(this, viewOverlayStore);

  static styles = css`
    ${FloatingPanel.styles}
  `;

  private emit(name: string, detail?: unknown) {
    this.dispatchEvent(
      new CustomEvent(name, { detail, bubbles: true, composed: true })
    );
  }

  render() {
    return html`
      ${this.renderPinnedClose()}
      <div class="block">
        <div class="face">
            ${this.renderPanelTitle("Settings")}
            <div class="toggle">
              <span>Show Cursor</span>
              <input
                type="checkbox"
                .checked=${this.cursorEnabled}
                @change=${(e: Event) => {
        this.cursorEnabled = (e.target as HTMLInputElement).checked;
        this.emit("cursor-toggle", this.cursorEnabled);
      }}
              />
            </div>

            <div class="toggle">
              <span>ailias fix</span>
              <input
                type="checkbox"
                .checked=${this.aliasFixEnabled}
                @change=${(e: Event) => {
                  this.aliasFixEnabled = (e.target as HTMLInputElement).checked;
                  this.emit("alias-fix-toggle", this.aliasFixEnabled);
                }}
              />
            </div>

            <div class="toggle">
              <span>Show grid</span>
              <input
                type="checkbox"
                .checked=${this.viewOverlay.value.gridEnabled}
                @change=${(e: Event) => {
                  const checked = (e.target as HTMLInputElement).checked;
                  this.viewOverlay.update((v) => ({ ...v, gridEnabled: checked }));
                }}
              />
            </div>

            <div class="toggle">
              <span>Show origin</span>
              <input
                type="checkbox"
                .checked=${this.viewOverlay.value.originEnabled}
                @change=${(e: Event) => {
                  const checked = (e.target as HTMLInputElement).checked;
                  this.viewOverlay.update((v) => ({ ...v, originEnabled: checked }));
                }}
              />
            </div>

            <div class="toggle">
              <span>Show screen size</span>
              <input
                type="checkbox"
                .checked=${this.viewOverlay.value.screenSizeEnabled}
                @change=${(e: Event) => {
                  const checked = (e.target as HTMLInputElement).checked;
                  this.viewOverlay.update((v) => ({ ...v, screenSizeEnabled: checked }));
                }}
              />
            </div>

            <div class="toggle">
              <span>Grid follows zoom</span>
              <input
                type="checkbox"
                .checked=${this.viewOverlay.value.gridLiveWhileZooming}
                @change=${(e: Event) => {
                  const checked = (e.target as HTMLInputElement).checked;
                  this.viewOverlay.update((v) => ({ ...v, gridLiveWhileZooming: checked }));
                }}
              />
            </div>

            <label>
              <span>Zoom: ${this.zoomLevel}%</span>
              <div class="row">
                <blocky-button @click=${() => this.emit("zoom-out")}
                  >−</blocky-button
                >
                <blocky-button @click=${() => this.emit("zoom-reset")}
                  >Reset</blocky-button
                >
                <blocky-button @click=${() => this.emit("zoom-in")}
                  >+</blocky-button
                >
              </div>
            </label>

            <label>
              <span>Rotation: ${Math.round(this.rotation)}°</span>
              <div class="row">
                <blocky-button @click=${() => this.emit("rotate-ccw")}
                  >CCW</blocky-button
                >
                <blocky-button @click=${() => this.emit("rotate-reset")}
                  >Reset</blocky-button
                >
                <blocky-button @click=${() => this.emit("rotate-cw")}
                  >CW</blocky-button
                >
              </div>
            </label>

            <div class="row">
              <blocky-button
                ?disabled=${!this.history.value.canUndo}
                @click=${() => this.emit("undo")}
                >Undo</blocky-button
              >
              <blocky-button
                ?disabled=${!this.history.value.canRedo}
                @click=${() => this.emit("redo")}
                >Redo</blocky-button
              >
            </div>

            <div class="row">
              <blocky-button @click=${() => this.emit("flatten")}
                >Flatten</blocky-button
              >
              <blocky-button danger @click=${() => this.emit("clear")}
                >Clear</blocky-button
              >
            </div>

            <div class="row">
              <blocky-button
                @click=${() =>
                  this.dispatchEvent(
                    new CustomEvent("export-view-svg", { bubbles: true, composed: true }),
                  )}
                >Export view to SVG</blocky-button
              >
            </div>

        </div>
      </div>
    `;
  }
}

// ============================================================
// Layers Panel
// ============================================================

import { layerStore, generateLayerId } from "../core/stores";

@customElement("inkwell-layers-panel")
export class InkwellLayersPanel extends FloatingPanel {
  private layers = new StoreController(this, layerStore);
  @state() private draggedLayerId: string | null = null;
  @state() private dropTargetLayerId: string | null = null;

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      --panel-width: 180px;
    }

    .layer-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 200px;
      overflow-y: auto;
      margin-bottom: 8px;
    }

    .layer-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      border-radius: 4px;
      cursor: pointer;
      transition: background-color 100ms ease;
      background: #f0f0f0;
      border: 1px solid transparent;
    }

    .layer-item:hover {
      background: #e5e5e5;
    }

    .layer-item.active {
      background: #d0e8ff;
      border-color: #0066cc;
    }

    .layer-item.hidden {
      opacity: 0.5;
    }

    .layer-item.dragging {
      opacity: 0.45;
    }

    .layer-item.drop-target {
      outline: 2px dashed #0066cc;
      outline-offset: -2px;
    }

    .layer-name {
      flex: 1;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .visibility-btn,
    .delete-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border: none;
      background: none;
      cursor: pointer;
      border-radius: 3px;
      font-size: 12px;
      color: #666;
      transition: background-color 100ms ease, color 100ms ease;
    }

    .visibility-btn:hover,
    .delete-btn:hover {
      background: rgba(0, 0, 0, 0.1);
    }

    .delete-btn:hover {
      color: #cc0000;
    }

    .visibility-btn.hidden {
      color: #999;
    }

    .add-layer-btn {
      width: 100%;
    }
  `;

  private emit(name: string, detail?: unknown) {
    this.dispatchEvent(
      new CustomEvent(name, { detail, bubbles: true, composed: true })
    );
  }

  private selectLayer(layerId: string) {
    this.emit("layer-select", layerId);
  }

  private toggleVisibility(layerId: string, e: Event) {
    e.stopPropagation();
    this.emit("layer-visibility-toggle", layerId);
  }

  private deleteLayer(layerId: string, e: Event) {
    e.stopPropagation();
    // Don't allow deleting the last layer
    if (this.layers.value.layers.length <= 1) return;
    this.emit("layer-delete", layerId);
  }

  private addLayer() {
    const newId = generateLayerId();
    const layerNumber = this.layers.value.layers.length + 1;
    this.emit("layer-add", { id: newId, name: `Layer ${layerNumber}` });
  }

  private onLayerDragStart(layerId: string, e: DragEvent) {
    this.draggedLayerId = layerId;
    this.dropTargetLayerId = null;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", layerId);
    }
  }

  private onLayerDragOver(layerId: string, e: DragEvent) {
    if (!this.draggedLayerId || this.draggedLayerId === layerId) return;
    e.preventDefault();
    this.dropTargetLayerId = layerId;
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  }

  private onLayerDrop(targetLayerId: string, e: DragEvent) {
    e.preventDefault();
    const draggedLayerId = this.draggedLayerId ?? e.dataTransfer?.getData("text/plain");
    if (!draggedLayerId || draggedLayerId === targetLayerId) {
      this.draggedLayerId = null;
      this.dropTargetLayerId = null;
      return;
    }

    const displayLayers = [...this.layers.value.layers].reverse();
    const fromIndex = displayLayers.findIndex((layer) => layer.id === draggedLayerId);
    const toIndex = displayLayers.findIndex((layer) => layer.id === targetLayerId);
    if (fromIndex < 0 || toIndex < 0) {
      this.draggedLayerId = null;
      this.dropTargetLayerId = null;
      return;
    }

    const reordered = [...displayLayers];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);

    this.emit(
      "layer-reorder",
      reordered.map((layer) => layer.id),
    );

    this.draggedLayerId = null;
    this.dropTargetLayerId = null;
  }

  private onLayerDragEnd() {
    this.draggedLayerId = null;
    this.dropTargetLayerId = null;
  }

  render() {
    const { layers, activeLayerId } = this.layers.value;
    // Display layers in reverse order (top layer first)
    const displayLayers = [...layers].reverse();

    return html`
      ${this.renderPinnedClose()}
      <div class="block">
        <div class="face">
          ${this.renderPanelTitle("Layers")}
          <div class="layer-list">
            ${displayLayers.map(
              (layer) => html`
                <div
                  class="layer-item ${layer.id === activeLayerId ? "active" : ""} ${!layer.visible ? "hidden" : ""} ${this.draggedLayerId === layer.id ? "dragging" : ""} ${this.dropTargetLayerId === layer.id ? "drop-target" : ""}"
                  data-interactive
                  draggable="true"
                  @click=${() => this.selectLayer(layer.id)}
                  @dragstart=${(e: DragEvent) => this.onLayerDragStart(layer.id, e)}
                  @dragover=${(e: DragEvent) => this.onLayerDragOver(layer.id, e)}
                  @drop=${(e: DragEvent) => this.onLayerDrop(layer.id, e)}
                  @dragend=${() => this.onLayerDragEnd()}
                >
                  <button
                    class="visibility-btn ${!layer.visible ? "hidden" : ""}"
                    @click=${(e: Event) => this.toggleVisibility(layer.id, e)}
                    title="${layer.visible ? "Hide layer" : "Show layer"}"
                  >
                    ${layer.visible ? "👁" : "○"}
                  </button>
                  <span class="layer-name">${layer.name}</span>
                  <button
                    class="delete-btn"
                    @click=${(e: Event) => this.deleteLayer(layer.id, e)}
                    title="Delete layer"
                    ?disabled=${layers.length <= 1}
                  >
                    ✕
                  </button>
                </div>
              `
            )}
          </div>
          <blocky-button class="add-layer-btn" @click=${() => this.addLayer()}>
            + Add Layer
          </blocky-button>
        </div>
        ${this.resizable
          ? html`
              <div class="resize-left"></div>
              <div class="resize-right"></div>
            `
          : ""}
      </div>
    `;
  }
}

// ============================================================
// Type Declarations
// ============================================================

declare global {
  interface HTMLElementTagNameMap {
    "blocky-button": BlockyButton;
    "generic-color-picker": GenericColorPicker;
    "inkwell-color-panel": InkwellColorPanel;
    "inkwell-top-bar-panel": InkwellTopBarPanel;
    "inkwell-tools-panel": InkwellToolsPanel;
    "inkwell-tool-settings-panel": InkwellToolSettingsPanel;
    "inkwell-universal-panel": InkwellUniversalPanel;
    "inkwell-layers-panel": InkwellLayersPanel;
  }
}
