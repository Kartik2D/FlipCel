/**
 * Blocky UI Library
 *
 * A minimal UI component library using CSS custom properties for inheritance.
 * Uses 3-layer structure: Host (BlockHolder) > Block (shell) > Face (surface)
 */
import { LitElement, html, css, nothing, type TemplateResult, type PropertyValues } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
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
  INKWELL_MOTION_BOUNCE_MS,
  INKWELL_PANEL_SNAP_ANIMATION,
  INKWELL_PANEL_SNAP_BACK_KEYFRAMES,
} from "./inkwell-motion";
import {
  colorStore,
  prevColorStore,
  colorPanelPrefsStore,
  normalizeColorPanelPrefs,
  toolStore,
  prevToolStore,
  modifiersStore,
  toolSettingsStore,
  viewOverlayStore,
  themeModeStore,
  StoreController,
  type ColorPanelPrefs,
  type PickerGeometry,
} from "../core/stores";
import { historyStateStore } from "../core/history";

// ============================================================
// Phosphor Icons — Duotone weight, inline paths (MIT)
// https://phosphoricons.com/ · assets from @phosphor-icons/core
// ============================================================

const PHOSPHOR_ICONS: Record<string, string> = {
  gear:
    '<path d="M207.86,123.18l16.78-21a99.14,99.14,0,0,0-10.07-24.29l-26.7-3a81,81,0,0,0-6.81-6.81l-3-26.71a99.43,99.43,0,0,0-24.3-10l-21,16.77a81.59,81.59,0,0,0-9.64,0l-21-16.78A99.14,99.14,0,0,0,77.91,41.43l-3,26.7a81,81,0,0,0-6.81,6.81l-26.71,3a99.43,99.43,0,0,0-10,24.3l16.77,21a81.59,81.59,0,0,0,0,9.64l-16.78,21a99.14,99.14,0,0,0,10.07,24.29l26.7,3a81,81,0,0,0,6.81,6.81l3,26.71a99.43,99.43,0,0,0,24.3,10l21-16.77a81.59,81.59,0,0,0,9.64,0l21,16.78a99.14,99.14,0,0,0,24.29-10.07l3-26.7a81,81,0,0,0,6.81-6.81l26.71-3a99.43,99.43,0,0,0,10-24.3l-16.77-21A81.59,81.59,0,0,0,207.86,123.18ZM128,168a40,40,0,1,1,40-40A40,40,0,0,1,128,168Z" opacity="0.2"/><path d="M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm88-29.84q.06-2.16,0-4.32l14.92-18.64a8,8,0,0,0,1.48-7.06,107.6,107.6,0,0,0-10.88-26.25,8,8,0,0,0-6-3.93l-23.72-2.64q-1.48-1.56-3-3L186,40.54a8,8,0,0,0-3.94-6,107.29,107.29,0,0,0-26.25-10.86,8,8,0,0,0-7.06,1.48L130.16,40Q128,40,125.84,40L107.2,25.11a8,8,0,0,0-7.06-1.48A107.6,107.6,0,0,0,73.89,34.51a8,8,0,0,0-3.93,6L67.32,64.27q-1.56,1.49-3,3L40.54,70a8,8,0,0,0-6,3.94,107.71,107.71,0,0,0-10.87,26.25,8,8,0,0,0,1.49,7.06L40,125.84Q40,128,40,130.16L25.11,148.8a8,8,0,0,0-1.48,7.06,107.6,107.6,0,0,0,10.88,26.25,8,8,0,0,0,6,3.93l23.72,2.64q1.49,1.56,3,3L70,215.46a8,8,0,0,0,3.94,6,107.71,107.71,0,0,0,26.25,10.87,8,8,0,0,0,7.06-1.49L125.84,216q2.16.06,4.32,0l18.64,14.92a8,8,0,0,0,7.06,1.48,107.21,107.21,0,0,0,26.25-10.88,8,8,0,0,0,3.93-6l2.64-23.72q1.56-1.48,3-3L215.46,186a8,8,0,0,0,6-3.94,107.71,107.71,0,0,0,10.87-26.25,8,8,0,0,0-1.49-7.06Zm-16.1-6.5a73.93,73.93,0,0,1,0,8.68,8,8,0,0,0,1.74,5.48l14.19,17.73a91.57,91.57,0,0,1-6.23,15L187,173.11a8,8,0,0,0-5.1,2.64,74.11,74.11,0,0,1-6.14,6.14,8,8,0,0,0-2.64,5.1l-2.51,22.58a91.32,91.32,0,0,1-15,6.23l-17.74-14.19a8,8,0,0,0-5-1.75h-.48a73.93,73.93,0,0,1-8.68,0,8.06,8.06,0,0,0-5.48,1.74L100.45,215.8a91.57,91.57,0,0,1-15-6.23L82.89,187a8,8,0,0,0-2.64-5.1,74.11,74.11,0,0,1-6.14-6.14,8,8,0,0,0-5.1-2.64L46.43,170.6a91.32,91.32,0,0,1-6.23-15l14.19-17.74a8,8,0,0,0,1.74-5.48,73.93,73.93,0,0,1,0-8.68,8,8,0,0,0-1.74-5.48L40.2,100.45a91.57,91.57,0,0,1,6.23-15L69,82.89a8,8,0,0,0,5.1-2.64,74.11,74.11,0,0,1,6.14-6.14A8,8,0,0,0,82.89,69L85.4,46.43a91.32,91.32,0,0,1,15-6.23l17.74,14.19a8,8,0,0,0,5.48,1.74,73.93,73.93,0,0,1,8.68,0,8.06,8.06,0,0,0,5.48-1.74L155.55,40.2a91.57,91.57,0,0,1,15,6.23L173.11,69a8,8,0,0,0,2.64,5.1,74.11,74.11,0,0,1,6.14,6.14,8,8,0,0,0,5.1,2.64l22.58,2.51a91.32,91.32,0,0,1,6.23,15l-14.19,17.74A8,8,0,0,0,199.87,123.66Z"/>',
  stack:
    '<path d="M224,80l-96,56L32,80l96-56Z" opacity="0.2"/><path d="M230.91,172A8,8,0,0,1,228,182.91l-96,56a8,8,0,0,1-8.06,0l-96-56A8,8,0,0,1,36,169.09l92,53.65,92-53.65A8,8,0,0,1,230.91,172ZM220,121.09l-92,53.65L36,121.09A8,8,0,0,0,28,134.91l96,56a8,8,0,0,0,8.06,0l96-56A8,8,0,1,0,220,121.09ZM24,80a8,8,0,0,1,4-6.91l96-56a8,8,0,0,1,8.06,0l96,56a8,8,0,0,1,0,13.82l-96,56a8,8,0,0,1-8.06,0l-96-56A8,8,0,0,1,24,80Zm23.88,0L128,126.74,208.12,80,128,33.26Z"/>',
  "paint-brush":
    '<path d="M224,32c0,32.81-31.64,67.43-58.64,91.05A84.39,84.39,0,0,0,133,90.64C156.57,63.64,191.19,32,224,32Z" opacity="0.2"/><path d="M232,32a8,8,0,0,0-8-8c-44.08,0-89.31,49.71-114.43,82.63A60,60,0,0,0,32,164c0,30.88-19.54,44.73-20.47,45.37A8,8,0,0,0,16,224H92a60,60,0,0,0,57.37-77.57C182.3,121.31,232,76.08,232,32ZM92,208H34.63C41.38,198.41,48,183.92,48,164a44,44,0,1,1,44,44Zm32.42-94.45q5.14-6.66,10.09-12.55A76.23,76.23,0,0,1,155,121.49q-5.9,4.94-12.55,10.09A60.54,60.54,0,0,0,124.42,113.55Zm42.7-2.68a92.57,92.57,0,0,0-22-22c31.78-34.53,55.75-45,69.9-47.91C212.17,55.12,201.65,79.09,167.12,110.87Z"/>',
  eye:
    '<path d="M128,56C48,56,16,128,16,128s32,72,112,72,112-72,112-72S208,56,128,56Zm0,112a40,40,0,1,1,40-40A40,40,0,0,1,128,168Z" opacity="0.2"/><path d="M247.31,124.76c-.35-.79-8.82-19.58-27.65-38.41C194.57,61.26,162.88,48,128,48S61.43,61.26,36.34,86.35C17.51,105.18,9,124,8.69,124.76a8,8,0,0,0,0,6.5c.35.79,8.82,19.57,27.65,38.4C61.43,194.74,93.12,208,128,208s66.57-13.26,91.66-38.34c18.83-18.83,27.3-37.61,27.65-38.4A8,8,0,0,0,247.31,124.76ZM128,192c-30.78,0-57.67-11.19-79.93-33.25A133.47,133.47,0,0,1,25,128,133.33,133.33,0,0,1,48.07,97.25C70.33,75.19,97.22,64,128,64s57.67,11.19,79.93,33.25A133.46,133.46,0,0,1,231.05,128C223.84,141.46,192.43,192,128,192Zm0-112a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Z"/>',
  "eye-slash":
    '<path d="M128,56C48,56,16,128,16,128s32,72,112,72,112-72,112-72S208,56,128,56Zm0,112a40,40,0,1,1,40-40A40,40,0,0,1,128,168Z" opacity="0.2"/><path d="M53.92,34.62A8,8,0,1,0,42.08,45.38L61.32,66.55C25,88.84,9.38,123.2,8.69,124.76a8,8,0,0,0,0,6.5c.35.79,8.82,19.57,27.65,38.4C61.43,194.74,93.12,208,128,208a127.11,127.11,0,0,0,52.07-10.83l22,24.21a8,8,0,1,0,11.84-10.76Zm47.33,75.84,41.67,45.85a32,32,0,0,1-41.67-45.85ZM128,192c-30.78,0-57.67-11.19-79.93-33.25A133.16,133.16,0,0,1,25,128c4.69-8.79,19.66-33.39,47.35-49.38l18,19.75a48,48,0,0,0,63.66,70l14.73,16.2A112,112,0,0,1,128,192Zm6-95.43a8,8,0,0,1,3-15.72,48.16,48.16,0,0,1,38.77,42.64,8,8,0,0,1-7.22,8.71,6.39,6.39,0,0,1-.75,0,8,8,0,0,1-8-7.26A32.09,32.09,0,0,0,134,96.57Zm113.28,34.69c-.42.94-10.55,23.37-33.36,43.8a8,8,0,1,1-10.67-11.92A132.77,132.77,0,0,0,231.05,128a133.15,133.15,0,0,0-23.12-30.77C185.67,75.19,158.78,64,128,64a118.37,118.37,0,0,0-19.36,1.57A8,8,0,1,1,106,49.79,134,134,0,0,1,128,48c34.88,0,66.57,13.26,91.66,38.35,18.83,18.83,27.3,37.62,27.65,38.41A8,8,0,0,1,247.31,131.26Z"/>',
  trash:
    '<path d="M200,56V208a8,8,0,0,1-8,8H64a8,8,0,0,1-8-8V56Z" opacity="0.2"/><path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z"/>',
  x:
    '<path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"/>',
};

const PANEL_ICON_MAP: Record<string, string> = {
  "tools-panel": "paint-brush",
  "universal-panel": "gear",
  "layers-panel": "stack",
};

function phosphorIcon(name: string, size = 16): TemplateResult {
  const inner = PHOSPHOR_ICONS[name];
  if (!inner) return html``;
  return html`<svg width="${size}" height="${size}" viewBox="0 0 256 256" fill="currentColor">${unsafeSVG(inner)}</svg>`;
}

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
    box-shadow: var(--inkwell-shadow-soft, 0 0 2px rgba(0, 0, 0, 0.5));
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
    border-radius: var(--panel-control-radius, 8px);
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
    border-radius: var(--panel-control-radius, 8px);
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
    box-shadow: var(--inkwell-shadow-soft, 0 0 2px rgba(0, 0, 0, 0.5));
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
  protected _isDragging = false;

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
    this._isDragging = true;
    onUpdate(e);
    let rafId = 0;
    let lastEv: PointerEvent | null = null;
    const move = (ev: PointerEvent) => {
      lastEv = ev;
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          if (lastEv) onUpdate(lastEv);
        });
      }
    };
    const up = () => {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this._isDragging = false;
      if (lastEv) onUpdate(lastEv);
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

  /** Pointer movement below this (px) ends drag without committing (click / jitter). */
  private static readonly DRAG_COMMIT_MIN_PX = 12;

  // Drag state
  private _isDragging = false;
  private _dragOffset = { x: 0, y: 0 };
  private _dragPointerStart = { x: 0, y: 0 };
  private _dragLastClient = { x: 0, y: 0 };
  private _dragStyleSnapshot: {
    left: string;
    top: string;
    right: string;
    bottom: string;
    zIndex: string;
  } | null = null;

  private _snapBackClearTimeout: ReturnType<typeof setTimeout> | null = null;

  private _onSnapBackAnimationEnd = (e: AnimationEvent) => {
    if (e.animationName !== INKWELL_PANEL_SNAP_BACK_KEYFRAMES) return;
    this.removeEventListener("animationend", this._onSnapBackAnimationEnd);
    this._finishSnapBackAnimationCleanup();
  };

  // Resize state (protected for subclass override)
  protected _isResizing = false;
  protected _resizeCorner: ResizeCorner = null;
  protected _resizeStart = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };

  static styles = css`
    :host {
      /* Design tokens */
      --block-depth: 7px;
      --block-depth-color: var(--inkwell-panel-depth, #bcbcbc);
      --block-border: var(--inkwell-panel-border, #555555);
      --block-radius: 10px;
      --block-face-bg: var(--inkwell-panel-surface, #ffffff);
      --block-face-padding: 10px;
      --block-font: var(--inkwell-font, system-ui, sans-serif);
      --block-font-size: 12px;
      --block-font-weight: 500;
      --block-font-color: var(--inkwell-text-secondary, #6b6b6b);

      display: block;
      box-sizing: border-box;
      padding: 0;
      font-family: var(--block-font);
      font-size: var(--block-font-size);
      font-weight: var(--block-font-weight);
      line-height: 1.35;
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
      box-shadow: var(--inkwell-shadow-panel, 0 0 10px rgba(5, 0, 0, 0.3));
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

    /* Same timing breakpoints as .floating-close (0 / 55 / 78 / 100%) — overshoot + settle on translate */
    @keyframes inkwell-panel-snap-back {
      0% {
        transform: translate(var(--inkwell-snap-x, 0px), var(--inkwell-snap-y, 0px));
      }
      55% {
        transform: translate(
          calc(var(--inkwell-snap-x, 0px) * -0.1),
          calc(var(--inkwell-snap-y, 0px) * -0.1)
        );
      }
      78% {
        transform: translate(
          calc(var(--inkwell-snap-x, 0px) * 0.04),
          calc(var(--inkwell-snap-y, 0px) * 0.04)
        );
      }
      100% {
        transform: translate(0, 0);
      }
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
    this._finishSnapBackAnimationCleanup();
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

    this._dragPointerStart = { x: e.clientX, y: e.clientY };
    this._dragLastClient = { x: e.clientX, y: e.clientY };
    this._dragStyleSnapshot = {
      left: this.style.getPropertyValue("left"),
      top: this.style.getPropertyValue("top"),
      right: this.style.getPropertyValue("right"),
      bottom: this.style.getPropertyValue("bottom"),
      zIndex: this.style.getPropertyValue("z-index"),
    };

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
    window.addEventListener("pointercancel", this._onDragEnd);
  }

  private _onDragMove = (e: PointerEvent) => {
    if (!this._isDragging) return;

    this._dragLastClient = { x: e.clientX, y: e.clientY };

    const newLeft = e.clientX - this._dragOffset.x;
    const newTop = e.clientY - this._dragOffset.y;

    this.style.left = `${newLeft}px`;
    this.style.top = `${newTop}px`;
    this.style.right = "auto";
    this.style.bottom = "auto";
  };

  private _clearSnapBackTimeout() {
    if (this._snapBackClearTimeout !== null) {
      clearTimeout(this._snapBackClearTimeout);
      this._snapBackClearTimeout = null;
    }
  }

  private _finishSnapBackAnimationCleanup() {
    this._clearSnapBackTimeout();
    this.removeEventListener("animationend", this._onSnapBackAnimationEnd);
    this.style.removeProperty("animation");
    this.style.removeProperty("transform");
    this.style.removeProperty("--inkwell-snap-x");
    this.style.removeProperty("--inkwell-snap-y");
  }

  private _restorePreDragLayout(
    snap: {
      left: string;
      top: string;
      right: string;
      bottom: string;
      zIndex: string;
    },
  ) {
    const apply = (prop: "left" | "top" | "right" | "bottom" | "zIndex", val: string) => {
      const css = prop === "zIndex" ? "z-index" : prop;
      if (val.trim()) this.style.setProperty(css, val);
      else this.style.removeProperty(css);
    };
    apply("left", snap.left);
    apply("top", snap.top);
    apply("right", snap.right);
    apply("bottom", snap.bottom);
    apply("zIndex", snap.zIndex);
  }

  private _onDragEnd = () => {
    const snapshot = this._dragStyleSnapshot;

    const dx = this._dragLastClient.x - this._dragPointerStart.x;
    const dy = this._dragLastClient.y - this._dragPointerStart.y;
    const useMoveThreshold = this.dragUsesMinimumMovementThreshold();
    const movedEnough =
      !useMoveThreshold ||
      Math.hypot(dx, dy) >= Block.DRAG_COMMIT_MIN_PX;

    this._dragStyleSnapshot = null;

    if (movedEnough) {
      this._applyPercentagePosition();
      this.onDragCommitted();
      this._cleanupDrag();
      return;
    }

    this._cleanupDrag();

    if (!snapshot) return;

    const rectBefore = this.getBoundingClientRect();
    this._restorePreDragLayout(snapshot);
    const rectAfter = this.getBoundingClientRect();
    const sx = rectBefore.left - rectAfter.left;
    const sy = rectBefore.top - rectAfter.top;

    this.style.setProperty("--inkwell-snap-x", `${sx}px`);
    this.style.setProperty("--inkwell-snap-y", `${sy}px`);

    this.removeEventListener("animationend", this._onSnapBackAnimationEnd);
    this.addEventListener("animationend", this._onSnapBackAnimationEnd);

    requestAnimationFrame(() => {
      this.style.animation = INKWELL_PANEL_SNAP_ANIMATION;
    });

    this._clearSnapBackTimeout();
    this._snapBackClearTimeout = setTimeout(() => {
      this._snapBackClearTimeout = null;
      this._finishSnapBackAnimationCleanup();
    }, INKWELL_MOTION_BOUNCE_MS + 200);
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
    window.removeEventListener("pointercancel", this._onDragEnd);
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

  /**
   * When true, a drag shorter than DRAG_COMMIT_MIN_PX is reverted (e.g. dock-attached panels).
   * Floating panels should return false so any drag commits.
   */
  protected dragUsesMinimumMovementThreshold(): boolean {
    return false;
  }

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
  /** Flat chrome for use inside panels; keep 3D depth for dock / shell toggles only. */
  @property({ type: Boolean, reflect: true }) flat = false;
  @property({ type: Boolean, reflect: true }) danger = false;
  @property({ type: Boolean, reflect: true }) disabled = false;
  /** Fill flex row width (e.g. equal-width dock toggles). */
  @property({ type: Boolean, reflect: true }) stretch = false;

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
      --block-font-weight: 600;
      --block-font-color: var(--inkwell-text-primary, #29241e);
      display: inline-block;
      cursor: pointer;
      text-align: center;
      transition: padding 100ms ease-in-out;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
      user-select: none;
      -webkit-user-select: none;
    }

    :host([disabled]) {
      opacity: 0.45;
      pointer-events: none;
      cursor: not-allowed;
    }

    :host([stretch]) {
      display: block;
      width: 100%;
      box-sizing: border-box;
    }

    :host([stretch]) .block {
      width: 100%;
      box-sizing: border-box;
    }

    /* Stretch slot children on the block cross-axis; center icon wrappers only. */
    :host(:not([flat])) .face {
      display: flex;
      align-items: stretch;
      justify-content: center;
      overflow: hidden;
    }

    :host(:not([flat])) .face ::slotted(.btn-content) {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      max-width: 100%;
      align-self: center;
    }

    :host([stretch]:not([flat])) {
      height: 100%;
      box-sizing: border-box;
    }

    :host([stretch]:not([flat])) .block {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    :host([stretch]:not([flat])) .face {
      flex: 1 1 auto;
      min-height: 0;
      height: auto;
      overflow: hidden;
    }

    .block {
      transition: padding 100ms ease-in-out;
      box-shadow: var(--inkwell-shadow-soft, 0 0 10px rgba(5, 0, 0, 0.2));
    }

    @media (hover: hover) {
      :host(:hover:not(:active):not([active]):not([flat])) {
        padding-top: calc(var(--block-depth) / 2);
      }
      :host(:hover:not(:active):not([active]):not([flat])) .block {
        padding-bottom: calc(var(--block-depth) / 2);
      }
    }

    :host(:active:not([flat])),
    :host([active]:not([flat])) {
      padding-top: var(--block-depth);
    }
    :host(:active:not([flat])) .block,
    :host([active]:not([flat])) .block {
      padding-bottom: 0;
    }

    :host([flat]) {
      --block-depth: 0px;
      transition: none;
      /* Same grey as 3D block “depth” face (dock bevel) */
      --block-face-bg: var(--block-depth-color, #bcbcbc);
      --block-font-color: var(--block-border, #555555);
      color: var(--block-font-color);
      min-width: 0;
      max-width: 100%;
    }

    :host([flat]) .block {
      padding-bottom: 0;
      border: none;
      background: transparent;
      box-shadow: none;
      min-width: 0;
      max-width: 100%;
    }

    :host([flat]) .face {
      overflow: hidden;
      min-width: 0;
      max-width: 100%;
      box-sizing: border-box;
      padding: 6px 5px;
    }

    :host([flat]:hover) .face {
      filter: brightness(0.97);
    }

    :host([flat][active]) .face {
      background: var(--inkwell-accent, #4a6fb5);
      color: var(--inkwell-danger-contrast, #ffffff);
      --block-font-color: var(--inkwell-danger-contrast, #ffffff);
    }

    :host([danger]) {
      --block-face-bg: var(--inkwell-danger, #333);
      --block-font-color: var(--inkwell-danger-contrast, white);
    }

    :host([flat][danger]) {
      --block-face-bg: var(--inkwell-danger, #9a4545);
      --block-font-color: var(--inkwell-danger-contrast, #ffffff);
    }

    :host([flat][danger]:not([active]):hover) .face {
      filter: brightness(0.95);
    }

    :host([flat][danger][active]) .face {
      background: var(--inkwell-danger-hover, #7a3535);
      color: var(--inkwell-danger-contrast, #ffffff);
      --block-font-color: var(--inkwell-danger-contrast, #ffffff);
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
  private planeResizeObserver: ResizeObserver | null = null;
  private lastPlaneBitmapSize = { w: 0, h: 0 };

  static styles = [pickerVars, handleStyles, sliderColumnStyles, css`
    :host { display: block; height: 100%; }

    .picker-main { display: flex; gap: var(--picker-gap); width: 100%; align-items: stretch; }
    .plane-area { flex: 1; min-width: 0; }

    .plane-square { position: relative; width: 100%; height: 0; padding-bottom: 100%; }
    .plane-square-inner {
      position: absolute; inset: 0; cursor: crosshair;
      border-radius: var(--panel-control-radius, 8px);
      overflow: hidden;
      border: var(--picker-border-width) solid var(--picker-border-color); box-sizing: border-box;
    }

    .plane-circle-wrap { position: relative; width: 100%; height: 0; padding-bottom: 100%; }
    .plane-circle-inner { position: absolute; inset: 0; cursor: crosshair; }
    .circle-disk {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      overflow: hidden;
      border: var(--picker-border-width) solid var(--picker-border-color);
      box-sizing: border-box;
    }

    canvas { display: block; width: 100%; height: 100%; }
    .slider-column { flex-shrink: 0; }
    .sliders-stack { flex: 1; display: flex; flex-direction: column; gap: 6px; min-height: 48px; }
    .sliders-stack .s-slider { flex: 1; min-height: 36px; }
  `];

  private getAdapter(): ColorSpaceAdapter { return getColorSpaceAdapter(this.prefs.space); }
  private channelMeta(id: string) { return this.getAdapter().channels.find((c) => c.id === id); }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.planeResizeObserver?.disconnect();
    this.planeResizeObserver = null;
  }

  firstUpdated() {
    this.ensureCanvas();
    this.setupPlaneResizeObserver();
    this.syncFromColor(this.color);
    this.syncPlaneCanvasSize();
  }

  updated(changed: Map<string, unknown>) {
    this.ensureCanvas();
    if (changed.has("prefs")) {
      this.lastPlaneBitmapSize = { w: 0, h: 0 };
      this.setupPlaneResizeObserver();
    }
    if (changed.has("color") && !this._isDragging) {
      this.syncFromColor(this.color);
    }
    if (changed.has("prefs")) this.syncFromColor(this.color);
    if ((changed.has("color") && !this._isDragging) || changed.has("prefs")) {
      this.syncPlaneCanvasSize();
    }
  }

  private ensureCanvas() {
    const c = this.renderRoot.querySelector("canvas");
    if (c && c instanceof HTMLCanvasElement && c !== this.canvas) {
      this.canvas = c;
      this.ctx = c.getContext("2d");
      this.lastPlaneBitmapSize = { w: 0, h: 0 };
    }
  }

  private setupPlaneResizeObserver() {
    this.planeResizeObserver?.disconnect();
    const planeHost = this.renderRoot.querySelector(".plane-square-inner, .circle-disk");
    if (!planeHost) return;
    this.planeResizeObserver = new ResizeObserver(() => this.syncPlaneCanvasSize());
    this.planeResizeObserver.observe(planeHost);
    this.syncPlaneCanvasSize();
  }

  /** Match backing-store resolution to on-screen size so the plane stays sharp and inside the border. */
  private syncPlaneCanvasSize() {
    if (!this.canvas || !this.ctx) return;
    const planeHost =
      this.canvas.closest(".plane-square-inner") ?? this.canvas.closest(".circle-disk");
    if (!planeHost) return;
    const r = planeHost.getBoundingClientRect();
    const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2.5);
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (w === this.lastPlaneBitmapSize.w && h === this.lastPlaneBitmapSize.h) {
      this.drawPlane();
      return;
    }
    this.lastPlaneBitmapSize = { w, h };
    this.canvas.width = w;
    this.canvas.height = h;
    this.drawPlane();
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
      const cx = w / 2, cy = h / 2, radius = Math.min(cx, cy);
      const invRadius = radius > 0 ? 1 / radius : 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = x - cx, dy = y - cy;
          const distSq = dx * dx + dy * dy;
          if (distSq > radius * radius) continue;
          const i = (y * w + x) * 4;
          const dist = Math.sqrt(distSq);
          let angleDeg = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
          if (angleDeg < 0) angleDeg += 360;
          const t = dist * invRadius;
          pix[planeX] = mx.cyclic ? angleDeg : mx.min + (angleDeg / 360) * mxRange;
          pix[planeY] = my.min + t * myRange;
          const [r, g, b] = toRgb(pix);
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
      this.emitChange();
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
      this.emitChange();
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
                <canvas></canvas>
                <div class="handle" style="left:${h.left}%;top:${h.top}%;"></div>
              </div>
            </div>
          ` : html`
            <div class="plane-circle-wrap">
              <div class="plane-circle-inner">
                <div class="circle-disk" data-interactive @pointerdown=${this.handleCircleDown}>
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
      /* Stable default width so content changes (toggles, tool schema) do not reflow the shell */
      width: var(--panel-width, 280px);
      min-width: var(--panel-min-width, 200px);
      max-width: calc(100vw - 16px);
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      max-height: var(--panel-max-height, min(85vh, 720px));
      touch-action: auto;

      --panel-control-radius: 8px;
      --panel-accent: var(--inkwell-accent, #4a6fb5);
      --panel-accent-hover: var(--inkwell-accent-hover, #3d5e9a);
      --panel-accent-muted: var(--inkwell-accent-muted, rgba(74, 111, 181, 0.35));
      --panel-track-bg: var(--inkwell-track-bg, #cfcfcf);
      --panel-track-focus: var(--inkwell-track-bg, #b8b8b8);
    }

    .block {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      max-height: 100%;
      height: auto;
    }

    .face {
      flex: 1 1 auto;
      min-height: 0;
      height: auto;
      overflow-x: hidden;
      overflow-y: auto;
    }

    /* Form stack: use inside .face for sliders, fields, toggles */
    .panel-form {
      display: flex;
      flex-direction: column;
      gap: 12px;
      width: 100%;
      min-width: 0;
    }

    .panel-form section {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin: 0;
    }

    .panel-form > section {
      margin: 0;
    }

    section {
      margin-bottom: 12px;
    }
    section:last-child {
      margin-bottom: 0;
    }

    h3 {
      margin: 0;
      font-weight: 600;
      color: var(--inkwell-text-muted, #666);
    }

    .panel-title {
      display: flex;
      align-items: center;
      justify-content: flex-start;
    }

    /* One centered drag affordance per panel (not repeated per section title) */
    .panel-drag-pill-wrap {
      display: flex;
      justify-content: center;
      align-items: center;
      width: 100%;
      min-width: 0;
      flex-shrink: 0;
    }

    /* Horizontal grab pill — flat, no shadow */
    .panel-drag-pill {
      width: 2.5rem;
      height: 7px;
      border-radius: 999px;
      background: var(--block-border, #555555);
      box-shadow: none;
      flex-shrink: 0;
      cursor: grab;
      pointer-events: auto;
    }

    :host([dragging]) .panel-drag-pill {
      cursor: grabbing;
    }

    @keyframes floating-close-bounce-in {
      0% {
        transform: scale(0.55);
      }
      55% {
        transform: scale(1.1);
      }
      78% {
        transform: scale(0.96);
      }
      100% {
        transform: scale(1);
      }
    }

    .floating-close {
      position: absolute;
      top: -11px;
      right: -11px;
      width: 26px;
      height: 26px;
      box-sizing: border-box;
      border: 2px solid var(--block-border, #555555);
      border-radius: 50%;
      background: var(--block-depth-color, #bcbcbc);
      color: var(--block-border, #555555);
      line-height: 0;
      display: grid;
      place-items: center;
      cursor: pointer;
      z-index: 1300;
      box-shadow: none;
      padding: 0;
      -webkit-tap-highlight-color: transparent;
      transform: scale(1);
      transform-origin: center center;
      animation: floating-close-bounce-in var(--inkwell-motion-bounce-duration, 380ms)
        var(--inkwell-motion-bounce-easing, cubic-bezier(0.34, 1.25, 0.64, 1)) both;
    }

    .floating-close svg {
      display: block;
    }

    .floating-close:hover {
      filter: brightness(0.96);
    }

    .floating-close:focus {
      outline: none;
    }

    .floating-close:focus-visible {
      box-shadow: 0 0 0 2px var(--panel-accent-muted, rgba(74, 111, 181, 0.35));
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      width: 100%;
      min-width: 0;
    }

    /* Last solo cell in a 2-col grid (e.g. 5th tool) spans full width */
    .grid > *:nth-child(odd):nth-last-child(1) {
      grid-column: 1 / -1;
    }

    .grid > blocky-button {
      min-width: 0;
      width: 100%;
      max-width: 100%;
      justify-self: stretch;
    }

    .row {
      display: flex;
      flex-direction: row;
      gap: 8px;
      align-items: stretch;
      min-width: 0;
      width: 100%;
    }
    .row > * {
      flex: 1;
      min-width: 0;
    }

    .row > blocky-button {
      width: auto;
      max-width: 100%;
    }

    .panel-form label {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 0;
      min-width: 0;
    }

    .panel-form label > span:first-child {
      color: var(--inkwell-text-muted, #666);
    }

    /* Native selects: match flat panel buttons (depth grey, no shadow) */
    .panel-form select {
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
      font: inherit;
      padding: 6px 1.75rem 6px 10px;
      margin: 0;
      border: none;
      border-radius: var(--panel-control-radius, 8px);
      background-color: var(--block-depth-color, #bcbcbc);
      color: var(--block-border, #555555);
      cursor: pointer;
      appearance: none;
      -webkit-appearance: none;
      box-shadow: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 256 256'%3E%3Cpath fill='%23555555' d='M215.39 92.94a8 8 0 0 0-11.32 0L128 164 51.93 92.94a8 8 0 0 0-11.32 11.32l80 80a8 8 0 0 0 11.32 0l80-80a8 8 0 0 0 0-11.32Z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
      background-size: 10px;
    }

    .panel-form select:hover {
      filter: brightness(0.97);
    }

    .panel-form select:focus {
      outline: none;
    }

    .panel-form select:focus-visible {
      box-shadow: 0 0 0 2px var(--panel-accent-muted, rgba(74, 111, 181, 0.35));
    }

    .panel-form input[type="range"] {
      width: 100%;
      min-width: 0;
      height: 1.25rem;
      margin: 0;
      -webkit-appearance: none;
      appearance: none;
      background: transparent;
      cursor: pointer;
    }

    .panel-form input[type="range"]:focus {
      outline: none;
    }

    .panel-form input[type="range"]:focus-visible::-webkit-slider-thumb {
      box-shadow: 0 0 0 3px var(--panel-accent-muted, rgba(74, 111, 181, 0.35));
    }

    .panel-form input[type="range"]:focus-visible::-moz-range-thumb {
      box-shadow: 0 0 0 3px var(--panel-accent-muted, rgba(74, 111, 181, 0.35));
    }

    .panel-form input[type="range"]::-webkit-slider-runnable-track {
      height: 6px;
      border-radius: 999px;
      background: var(--panel-track-bg);
    }

    .panel-form input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 16px;
      height: 16px;
      margin-top: -5px;
      border-radius: 50%;
      background: var(--panel-accent);
      border: 2px solid var(--inkwell-toggle-thumb, #fff);
      box-shadow: none;
    }

    .panel-form input[type="range"]:hover::-webkit-slider-thumb {
      background: var(--panel-accent-hover);
    }

    .panel-form input[type="range"]::-moz-range-track {
      height: 6px;
      border-radius: 999px;
      background: var(--panel-track-bg);
    }

    .panel-form input[type="range"]::-moz-range-thumb {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: var(--panel-accent);
      border: 2px solid var(--inkwell-toggle-thumb, #fff);
      box-shadow: none;
    }

    .panel-form input[type="range"]:hover::-moz-range-thumb {
      background: var(--panel-accent-hover);
    }

    .toggle {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin: 0;
      min-height: 28px;
    }

    .toggle span {
      flex: 1;
      min-width: 0;
      color: var(--inkwell-text-muted, #666);
    }

    .toggle input[type="checkbox"] {
      appearance: none;
      -webkit-appearance: none;
      position: relative;
      width: 40px;
      height: 24px;
      margin: 0;
      flex: 0 0 auto;
      border-radius: 999px;
      border: 1.5px solid var(--inkwell-toggle-border, #b3a99d);
      background: var(--inkwell-toggle-track, #d8d0c7);
      cursor: pointer;
      transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
    }

    .toggle input[type="checkbox"]::after {
      content: "";
      position: absolute;
      top: 50%;
      left: 3px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: var(--inkwell-toggle-thumb, #ffffff);
      box-shadow: var(--inkwell-shadow-soft, 0 2px 4px rgba(0, 0, 0, 0.12));
      transform: translateY(-50%);
      transition: transform 120ms ease, background-color 120ms ease;
    }

    .toggle input[type="checkbox"]:checked {
      background: var(--panel-accent, #4a6fb5);
      border-color: var(--panel-accent, #4a6fb5);
    }

    .toggle input[type="checkbox"]:checked::after {
      transform: translate(16px, -50%);
      background: #ffffff;
    }

    .toggle input[type="checkbox"]:focus {
      outline: none;
    }

    .toggle input[type="checkbox"]:focus-visible {
      box-shadow: 0 0 0 3px var(--panel-accent-muted, rgba(74, 111, 181, 0.35));
    }

    .hint {
      color: var(--inkwell-text-muted, #666);
      font-style: italic;
      margin: 0;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute('data-panel', '');
  }

  protected dragUsesMinimumMovementThreshold(): boolean {
    return !this.pinned;
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

  protected renderDragHandlePill() {
    if (!this.draggable) return html``;
    return html`
      <div class="panel-drag-pill-wrap">
        <div class="panel-drag-pill" title="Drag to move panel" aria-hidden="true"></div>
      </div>
    `;
  }

  protected renderPanelTitle(title: string) {
    return html`<h3 class="panel-title"><span>${title}</span></h3>`;
  }

  protected renderPinnedClose() {
    if (!this.pinned || !this.showPinnedClose) return html``;
    return html`
      <button
        type="button"
        class="floating-close"
        title="Hide panel"
        data-interactive
        @click=${(e: Event) => {
          e.stopPropagation();
          this.hidePanel();
        }}
      >
        ${phosphorIcon("x", 12)}
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
      container-type: inline-size;
      container-name: inkwell-color-panel;
      --block-face-padding: 10px;
      /* Wide enough for two axis selects (e.g. “Saturation”) without clipping */
      --panel-width: 288px;
    }

    .color-config {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
      width: 100%;
    }
    .color-config label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin: 0;
      min-width: 0;
    }
    .row-2 {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      width: 100%;
      min-width: 0;
    }
    .row-2 > label {
      min-width: 0;
    }

    @container inkwell-color-panel (max-width: 260px) {
      .row-2 {
        grid-template-columns: 1fr;
      }
    }
    .picker-wrap {
      min-height: 140px;
      flex-shrink: 0;
      width: 100%;
      min-width: 0;
    }
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
          <div class="panel-form">
            ${this.renderDragHandlePill()}
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

    :host {
      --panel-width: 280px;
    }
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
    const label = def.label ?? this.formatLabel(key);

    if (def.type === "toggle") {
      return html`
        <label>
          <span>${label} ${hint}</span>
          <div class="row">
            ${def.options.map(
              (opt) => html`
                <blocky-button
                  flat
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
          <div class="panel-form">
            ${this.renderDragHandlePill()}
            ${this.renderPanelTitle("Tools")}
            <div class="grid">
              ${tools
                .filter((t) => t.id !== "pan")
                .map(
                  (t) => html`
                  <blocky-button
                    flat
                    ?active=${this.tool.value === t.id}
                    @click=${() => this.setTool(t.id as ToolId)}
                    >${t.name}</blocky-button
                  >
                `,
                )}
            </div>
            <section>
              ${this.renderPanelTitle("Tool Settings")}
              ${this.renderToolSettings()}
            </section>
          </div>
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

    :host {
      --panel-width: 280px;
    }
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
    const label = def.label ?? this.formatLabel(key);

    if (def.type === "toggle") {
      return html`
        <label>
          <span>${label} ${hint}</span>
          <div class="row">
            ${def.options.map(
              (opt) => html`
                <blocky-button
                  flat
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
          <div class="panel-form">
            ${this.renderDragHandlePill()}
            ${this.renderPanelTitle("Tool Settings")}
            ${this.renderToolSettings()}
          </div>
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

function parseHexRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) {
    s = [...s].map((c) => c + c).join("");
  }
  const n = parseInt(s, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** WCAG relative luminance for sRGB hex (0 = black, 1 = white). */
function hexRelativeLuminance(hex: string): number | null {
  const rgb = parseHexRgb(hex);
  if (!rgb) return null;
  const lin = (u: number) => {
    u /= 255;
    return u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(rgb.r);
  const G = lin(rgb.g);
  const B = lin(rgb.b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/** 3D depth strip: mix toward black on light colors, toward white on dark colors. */
function dockColorDepthStripColor(faceCss: string): string {
  const lum = hexRelativeLuminance(faceCss);
  const darkInkMaxLuminance = 0.1;
  if (lum !== null && lum < darkInkMaxLuminance) {
    return `color-mix(in srgb, ${faceCss} 76%, #ffffff)`;
  }
  return `color-mix(in srgb, ${faceCss} 76%, #000000)`;
}

const PANEL_VISIBILITY_DEFAULTS: PanelVisibility[] = [
  { id: "universal-panel", label: "Settings", visible: false },
  { id: "layers-panel", label: "Layers", visible: false },
  { id: "tools-panel", label: "Brush", visible: false },
  { id: "color-panel", label: "Color", visible: false },
];

// ============================================================
// Top Bar Panel (panel visibility toggles)
// ============================================================

@customElement("inkwell-top-bar-panel")
export class InkwellTopBarPanel extends FloatingPanel {
  @property({ type: Number }) zoomLevel = 100;
  @property({ type: Number }) rotation = 0;

  @state() private panelVisibility: PanelVisibility[] = PANEL_VISIBILITY_DEFAULTS.map((p) => ({
    ...p,
  }));
  private dockColor = new StoreController(this, colorStore);
  private tool = new StoreController(this, toolStore);
  private prevTool = new StoreController(this, prevToolStore);
  private settings = new StoreController(this, toolSettingsStore);
  private modifiers = new StoreController(this, modifiersStore);
  private readonly outsidePointerHandler = (e: PointerEvent) => this.closePanelsOnOutsideClick(e);
  private readonly panelVisibilityChangeHandler = (e: Event) =>
    this.onPanelVisibilityChange(e as CustomEvent<{ id: string; visible: boolean }>);

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      --panel-top: 8px;
      --panel-left: 50%;
      --panel-width: min(300px, calc(100vw - 16px));
      --panel-min-width: 0;
      transform: translateX(-50%);
      z-index: 1200;
      max-width: calc(100vw - 16px);
    }

    .face {
      padding: 6px 10px 8px;
    }

    .unified-dock {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 6px;
      width: 100%;
      box-sizing: border-box;
    }

    .dock-status {
      display: flex;
      flex-direction: row;
      flex-wrap: nowrap;
      align-items: stretch;
      width: 100%;
      box-sizing: border-box;
    }

    .dock-cell {
      flex: 1 1 0;
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 3px;
      box-sizing: border-box;
    }

    .dock-cell:last-child {
      padding-right: 0;
    }

    .dock-cell:first-child {
      padding-left: 0;
    }

    .dock-chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 3px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: var(--inkwell-text-primary, #222);
      white-space: nowrap;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .dock-chip-stacked {
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1px;
      white-space: normal;
      text-align: center;
    }

    .dock-value {
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .dock-prefix {
      flex-shrink: 0;
      font-weight: 500;
      color: var(--inkwell-text-muted, #666);
    }

    button.dock-chip-reset {
      cursor: pointer;
      border: none;
      background: transparent;
      font: inherit;
      padding: 2px 4px;
      margin: 0;
      border-radius: 4px;
      color: inherit;
      max-width: 100%;
    }

    button.dock-chip-reset:hover {
      background: color-mix(in srgb, var(--inkwell-text-primary, #222) 8%, transparent);
    }

    button.dock-chip-reset:focus-visible {
      outline: 2px solid var(--inkwell-panel-border, #555555);
      outline-offset: 1px;
    }

    .bar {
      display: flex;
      flex-direction: row;
      flex-wrap: nowrap;
      align-items: stretch;
      gap: 6px;
      width: 100%;
      box-sizing: border-box;
    }

    .bar > blocky-button {
      flex: 1 1 0;
      min-width: 0;
      height: auto;
    }

    .btn-content {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .btn-content svg {
      flex-shrink: 0;
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

  firstUpdated(_changed: PropertyValues<this>) {
    super.firstUpdated(_changed);
    this.positionAllVisiblePanels();
  }

  private emitDock(name: string) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
  }

  /** 3D chrome for dock color toggle: face = ink, depth strip = slightly offset for contrast. */
  private dockColorBlockChromeStyle(): string {
    const c = this.dockColor.value;
    return `--block-face-bg: ${c}; --block-depth-color: ${dockColorDepthStripColor(c)};`;
  }

  /** Current mode label derived from the active tool's dockModeSetting. */
  private effectivePaintModeLabel(): string {
    const tool = getTool(this.tool.value);
    const key = tool.dockModeSetting;
    if (!key) return "—";
    const def = tool.settings[key];
    if (!def || def.type !== "toggle") return "—";
    const options = def.options as readonly string[];
    const raw = String(
      (this.settings.value[tool.id] as Record<string, unknown>)?.[key] ?? def.default,
    );
    // Shift-modifier preview: show the next option in the cycle
    const effective =
      this.modifiers.value.shift
        ? options[(options.indexOf(raw) + 1) % options.length]
        : raw;
    return effective.charAt(0).toUpperCase() + effective.slice(1);
  }

  // ----------------------------------------------------------------
  // Dock widget helper – renders a compact status cell.
  //   clickable:  wraps in a <button> (with hover highlight)
  //   otherwise:  wraps in a <span> (display-only)
  // ----------------------------------------------------------------
  private renderDockWidget(opts: {
    label: string;
    value: string;
    title: string;
    onClick?: () => void;
  }) {
    const inner = html`
      <span class="dock-prefix">${opts.label}</span>
      <span class="dock-value">${opts.value}</span>
    `;
    return html`
      <div class="dock-cell">
        ${opts.onClick
          ? html`
              <button
                type="button"
                class="dock-chip dock-chip-stacked dock-chip-reset"
                title=${opts.title}
                aria-label=${opts.title}
                data-interactive
                @click=${opts.onClick}
              >${inner}</button>
            `
          : html`
              <span class="dock-chip dock-chip-stacked" title=${opts.title}
                >${inner}</span
              >
            `}
      </div>
    `;
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

  private async togglePanel(id: string, triggerEl?: HTMLElement) {
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
    await el.updateComplete;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
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
    this.panelVisibility.forEach((panel) => {
      if (!panel.visible) return;
      const trigger = this.renderRoot.querySelector<HTMLElement>(
        `blocky-button[data-panel-trigger="${panel.id}"]`,
      );
      const panelEl = document.getElementById(panel.id) as ToggleablePanel | null;
      if (!panelEl || !trigger) return;
      this.positionPanelBelowTrigger(panelEl, trigger);
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
    const paintMode = this.effectivePaintModeLabel();
    const prevToolName = getTool(this.prevTool.value).name;
    const currentToolName = getTool(this.tool.value).name;
    const toolTip =
      this.prevTool.value !== this.tool.value
        ? `Click to switch back to ${prevToolName}`
        : `Current tool: ${currentToolName}`;

    return html`
      ${this.renderPinnedClose()}
      <div class="block">
        <div class="face">
          <div class="unified-dock">
            <div class="dock-status">
              ${this.renderDockWidget({
                label: "zoom",
                value: `${this.zoomLevel}%`,
                title: "Reset zoom to 100%",
                onClick: () => this.emitDock("zoom-reset"),
              })}
              ${this.renderDockWidget({
                label: "rotation",
                value: `${Math.round(this.rotation)}°`,
                title: "Reset rotation to 0°",
                onClick: () => this.emitDock("rotate-reset"),
              })}
              ${this.renderDockWidget({
                label: "tool",
                value: currentToolName,
                title: toolTip,
                onClick: () => this.emitDock("tool-cycle"),
              })}
              ${this.renderDockWidget({
                label: "mode",
                value: paintMode,
                title: "Click to cycle paint mode",
                onClick: () => this.emitDock("mode-cycle"),
              })}
            </div>
            <div class="bar">
              ${this.panelVisibility.map(
                (panel) => html`
                  <blocky-button
                    data-panel-trigger=${panel.id}
                    title=${panel.label}
                    data-interactive
                    stretch
                    style=${panel.id === "color-panel" ? this.dockColorBlockChromeStyle() : nothing}
                    ?active=${panel.visible}
                    @click=${(e: Event) =>
                      this.togglePanel(panel.id, e.currentTarget as HTMLElement)}
                    >${panel.id === "color-panel"
                      ? nothing
                      : html`<span class="btn-content"
                          >${phosphorIcon(PANEL_ICON_MAP[panel.id], 14)}</span
                        >`}</blocky-button
                  >
                `,
              )}
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

@customElement("inkwell-universal-panel")
export class InkwellUniversalPanel extends FloatingPanel {
  @property({ type: Boolean }) brushSizeIndicatorEnabled = true;
  @property({ type: Boolean }) aliasFixEnabled = true;

  private history = new StoreController(this, historyStateStore);
  private viewOverlay = new StoreController(this, viewOverlayStore);
  private themeMode = new StoreController(this, themeModeStore);

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      --panel-width: 280px;
    }
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
          <div class="panel-form">
            ${this.renderDragHandlePill()}
            ${this.renderPanelTitle("Settings")}
            <div class="toggle">
              <span>Show brush size</span>
              <input
                type="checkbox"
                .checked=${this.brushSizeIndicatorEnabled}
                @change=${(e: Event) => {
        this.brushSizeIndicatorEnabled = (e.target as HTMLInputElement).checked;
        this.emit("brush-size-toggle", this.brushSizeIndicatorEnabled);
      }}
              />
            </div>

            <div class="toggle">
              <span>Alias fix</span>
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
              <span>Dark mode</span>
              <input
                type="checkbox"
                .checked=${this.themeMode.value === "dark"}
                @change=${(e: Event) => {
                  const checked = (e.target as HTMLInputElement).checked;
                  this.themeMode.set(checked ? "dark" : "light");
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

            <div class="row">
              <blocky-button
                flat
                ?disabled=${!this.history.value.canUndo}
                @click=${() => this.emit("undo")}
                >Undo</blocky-button
              >
              <blocky-button
                flat
                ?disabled=${!this.history.value.canRedo}
                @click=${() => this.emit("redo")}
                >Redo</blocky-button
              >
            </div>

            <div class="row">
              <blocky-button flat @click=${() => this.emit("flatten")}
                >Flatten</blocky-button
              >
              <blocky-button flat danger @click=${() => this.emit("clear")}
                >Clear</blocky-button
              >
            </div>

            <div class="row">
              <blocky-button
                flat
                @click=${() =>
                  this.dispatchEvent(
                    new CustomEvent("export-view-svg", { bubbles: true, composed: true }),
                  )}
                >Export view to SVG</blocky-button
              >
            </div>
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
  @state() private editingLayerId: string | null = null;
  @state() private editingName = "";
  private layerDragGhost: HTMLElement | null = null;

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      --panel-width: 220px;
    }

    .layer-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 200px;
      overflow-y: auto;
      margin: 0;
      min-width: 0;
    }

    /* Match flat blocky-button: depth face + border-colored label; active = accent + contrast text */
    .layer-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      border-radius: var(--panel-control-radius, 8px);
      cursor: pointer;
      transition: background-color 100ms ease, color 100ms ease, filter 100ms ease;
      background: var(--block-depth-color, var(--inkwell-panel-depth));
      border: none;
      color: var(--block-border, var(--inkwell-panel-border));
    }

    .layer-item:hover:not(.active) {
      filter: brightness(0.97);
    }

    .layer-item.active {
      background: var(--inkwell-accent, var(--panel-accent, #4a6fb5));
      color: var(--inkwell-danger-contrast, #ffffff);
    }

    .layer-item.hidden {
      opacity: 0.5;
    }

    .layer-item.dragging {
      opacity: 0.45;
    }

    .layer-item.drop-target {
      background: color-mix(
        in srgb,
        var(--inkwell-accent, var(--panel-accent, #4a6fb5)) 38%,
        var(--block-depth-color, var(--inkwell-panel-depth))
      );
    }

    .layer-item.active.drop-target {
      background: color-mix(
        in srgb,
        var(--inkwell-accent, var(--panel-accent, #4a6fb5)) 88%,
        var(--inkwell-panel-surface, white)
      );
    }

    .layer-drag-handle {
      flex-shrink: 0;
      width: 12px;
      height: 22px;
      cursor: grab;
      touch-action: none;
      border-radius: 999px;
      align-self: center;
      background: color-mix(
        in srgb,
        var(--inkwell-text-muted) 32%,
        var(--block-depth-color, var(--inkwell-panel-depth))
      );
      box-shadow: inset 0 0 0 1px
        color-mix(in srgb, var(--inkwell-panel-border) 22%, transparent);
    }

    .layer-drag-handle:active {
      cursor: grabbing;
    }

    .layer-drag-ghost {
      box-shadow: var(--inkwell-shadow-soft, 0 6px 18px rgba(0, 0, 0, 0.18));
    }

    .layer-name {
      flex: 1;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }

    .layer-item.active .layer-name {
      color: var(--inkwell-danger-contrast, #ffffff);
    }

    .layer-name-input {
      flex: 1;
      min-width: 0;
      margin: 0;
      box-sizing: border-box;
      font: inherit;
      color: inherit;
      background: color-mix(in srgb, var(--inkwell-panel-surface) 55%, transparent);
      border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
      border-radius: 4px;
      padding: 2px 5px;
    }

    .layer-item.active .layer-name-input {
      background: color-mix(in srgb, var(--inkwell-danger-contrast, #fff) 14%, transparent);
      border-color: color-mix(in srgb, var(--inkwell-danger-contrast, #fff) 42%, transparent);
    }

    .visibility-btn,
    .delete-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      width: 26px;
      height: 26px;
      padding: 0;
      cursor: pointer;
      border-radius: var(--panel-control-radius, 8px);
      border: none;
      background: transparent;
      color: inherit;
      transition: background-color 100ms ease, color 100ms ease, filter 100ms ease, opacity 100ms ease;
    }

    .visibility-btn svg,
    .delete-btn svg {
      display: block;
    }

    .layer-item:not(.active) .visibility-btn:hover:not(:disabled) {
      filter: brightness(0.95);
    }

    .layer-item:not(.active) .delete-btn:hover:not(:disabled) {
      background: var(--inkwell-danger, #9a4545);
      color: var(--inkwell-danger-contrast, #ffffff);
      filter: none;
    }

    .visibility-btn.dim {
      opacity: 0.72;
    }

    .layer-item.active .visibility-btn:hover:not(:disabled) {
      background: color-mix(in srgb, var(--inkwell-danger-contrast, #fff) 14%, transparent);
      filter: none;
    }

    .layer-item.active .delete-btn:hover:not(:disabled) {
      background: var(--inkwell-danger, #9a4545);
      color: var(--inkwell-danger-contrast, #ffffff);
      filter: none;
    }

    .delete-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
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

  updated(changedProperties: Map<string, unknown>) {
    super.updated(changedProperties);
    if (!changedProperties.has("editingLayerId") || !this.editingLayerId) return;
    void this.updateComplete.then(() => {
      const input = this.renderRoot.querySelector<HTMLInputElement>(
        `[data-layer-edit="${this.editingLayerId}"]`,
      );
      input?.focus();
      input?.select();
    });
  }

  private startLayerRename(layerId: string, currentName: string, e: Event) {
    e.stopPropagation();
    this.editingLayerId = layerId;
    this.editingName = currentName;
  }

  private commitLayerRename(layerId: string) {
    if (this.editingLayerId !== layerId) return;
    const prev =
      this.layers.value.layers.find((l) => l.id === layerId)?.name ?? "";
    const next = this.editingName.trim();
    this.editingLayerId = null;
    this.editingName = "";
    if (!next || next === prev) return;
    this.emit("layer-rename", { id: layerId, name: next });
  }

  private onRenameKeydown(_layerId: string, e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.editingLayerId = null;
      this.editingName = "";
    }
  }

  private cancelLayerRename() {
    this.editingLayerId = null;
    this.editingName = "";
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

  private clearLayerDragGhost() {
    if (this.layerDragGhost?.isConnected) {
      this.layerDragGhost.remove();
    }
    this.layerDragGhost = null;
  }

  private onLayerDragStart(layerId: string, e: DragEvent) {
    this.cancelLayerRename();
    this.draggedLayerId = layerId;
    this.dropTargetLayerId = null;
    const dt = e.dataTransfer;
    if (dt) {
      dt.effectAllowed = "move";
      dt.setData("text/plain", layerId);
    }

    const handle = e.currentTarget as HTMLElement | null;
    const row = handle?.closest(".layer-item") as HTMLElement | null;
    if (!row || !dt || typeof dt.setDragImage !== "function") return;

    this.clearLayerDragGhost();
    const ghost = row.cloneNode(true) as HTMLElement;
    ghost.classList.add("layer-drag-ghost");
    ghost.classList.remove("dragging", "drop-target");
    ghost.querySelectorAll<HTMLElement>(".layer-drag-handle").forEach((el) => {
      el.removeAttribute("draggable");
    });

    const rect = row.getBoundingClientRect();
    ghost.style.cssText = `
      box-sizing: border-box;
      width: ${rect.width}px;
      position: fixed;
      left: -9999px;
      top: 0;
      pointer-events: none;
      opacity: 0.96;
      z-index: 2147483647;
    `;

    this.renderRoot.appendChild(ghost);
    this.layerDragGhost = ghost;
    void ghost.offsetWidth;

    const offsetX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const offsetY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    dt.setDragImage(ghost, offsetX, offsetY);
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
    this.clearLayerDragGhost();
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
          <div class="panel-form">
            ${this.renderDragHandlePill()}
            ${this.renderPanelTitle("Layers")}
            <div class="layer-list">
            ${displayLayers.map(
              (layer) => html`
                <div
                  class="layer-item ${layer.id === activeLayerId ? "active" : ""} ${!layer.visible ? "hidden" : ""} ${this.draggedLayerId === layer.id ? "dragging" : ""} ${this.dropTargetLayerId === layer.id ? "drop-target" : ""}"
                  data-interactive
                  @click=${() => this.selectLayer(layer.id)}
                  @dragover=${(e: DragEvent) => this.onLayerDragOver(layer.id, e)}
                  @drop=${(e: DragEvent) => this.onLayerDrop(layer.id, e)}
                >
                  <span
                    class="layer-drag-handle"
                    draggable="true"
                    title="Drag to reorder"
                    role="img"
                    aria-label="Drag to reorder layer"
                    @dragstart=${(e: DragEvent) => this.onLayerDragStart(layer.id, e)}
                    @dragend=${() => this.onLayerDragEnd()}
                  ></span>
                  ${this.editingLayerId === layer.id
                    ? html`
                        <input
                          type="text"
                          class="layer-name-input"
                          data-layer-edit=${layer.id}
                          .value=${this.editingName}
                          aria-label="Layer name"
                          @input=${(e: Event) => {
                            this.editingName = (e.target as HTMLInputElement).value;
                          }}
                          @keydown=${(e: KeyboardEvent) =>
                            this.onRenameKeydown(layer.id, e)}
                          @blur=${() => this.commitLayerRename(layer.id)}
                          @click=${(e: Event) => e.stopPropagation()}
                          @pointerdown=${(e: Event) => e.stopPropagation()}
                        />
                      `
                    : html`
                        <span
                          class="layer-name"
                          title="Double-click to rename"
                          @dblclick=${(e: Event) =>
                            this.startLayerRename(layer.id, layer.name, e)}
                          >${layer.name}</span
                        >
                      `}
                  <button
                    type="button"
                    class="visibility-btn ${!layer.visible ? "dim" : ""}"
                    @click=${(e: Event) => this.toggleVisibility(layer.id, e)}
                    title="${layer.visible ? "Hide layer" : "Show layer"}"
                  >
                    ${phosphorIcon(layer.visible ? "eye" : "eye-slash", 14)}
                  </button>
                  <button
                    type="button"
                    class="delete-btn"
                    @click=${(e: Event) => this.deleteLayer(layer.id, e)}
                    title="Delete layer"
                    ?disabled=${layers.length <= 1}
                  >
                    ${phosphorIcon("trash", 14)}
                  </button>
                </div>
              `
            )}
            </div>
            <blocky-button class="add-layer-btn" flat @click=${() => this.addLayer()}>
              + Add Layer
            </blocky-button>
          </div>
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
