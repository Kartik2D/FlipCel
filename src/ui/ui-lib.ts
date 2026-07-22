/**
 * Blocky UI Library
 *
 * A minimal UI component library using CSS custom properties for inheritance.
 * Uses 3-layer structure: Host (BlockHolder) > Block (shell) > Face (surface)
 */
import { LitElement, html, css, nothing, type TemplateResult, type PropertyValues } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { repeat } from "lit/directives/repeat.js";
import { customElement, property, state } from "lit/decorators.js";
import { type ToolId, type SettingsSchema, type SettingDef, getTool } from "../core/tools";
import {
  getColorSpaceAdapter,
  valuesToHex,
  clampChannelValues,
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
  modifiersStore,
  toolSettingsStore,
  viewOverlayStore,
  themeModeStore,
  StoreController,
  type ColorPanelPrefs,
} from "../core/stores";
import type { FunctionMenuItem } from "../core/functions";
import { historyStateStore } from "../core/history";
import { timelineStore } from "../core/document";
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
  copy:
    '<path d="M184,64V168a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V64a8,8,0,0,1,8-8H176A8,8,0,0,1,184,64Z" opacity="0.2"/><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"/>',
  cursor:
    '<path d="M82.44,37.84l120,168a4,4,0,0,1-3.26,6.32l-55.27-4.53-25.64,51a4,4,0,0,1-7.12.06L38.72,93.37A4,4,0,0,1,43.33,87.6L82.44,37.84Z" opacity="0.2"/><path d="M80.37,29.7a12,12,0,0,0-18.77,5.78L5.07,194.77a12,12,0,0,0,11.32,16.08,12.14,12.14,0,0,0,4.37-.82L80,184.42l25.57,50.66A12,12,0,0,0,116.28,242h.31a12,12,0,0,0,10.59-7.18l25.67-51,55.26,4.52a12,12,0,0,0,10-18.94ZM126.52,222.7l-26.64-52.78a8,8,0,0,0-6.18-4.35,8.17,8.17,0,0,0-1.14-.08,8,8,0,0,0-2.94.56L29.2,192.16l56.53-158.85L200,185.18l-53.62-4.39a8,8,0,0,0-7,3.36,8.08,8.08,0,0,0-1.09,2.09Z"/>',
  "flip-horizontal":
    '<path d="M128 32v192" stroke="currentColor" stroke-width="16" stroke-linecap="round" fill="none"/><path d="M112 72L56 128l56 56" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M144 72l56 56-56 56" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  "flip-vertical":
    '<path d="M32 128h192" stroke="currentColor" stroke-width="16" stroke-linecap="round" fill="none"/><path d="M72 112l56-56 56 56" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M72 144l56 56 56-56" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  "selection-simplify":
    '<path d="M40 172c28-48 52-48 76 0s48 48 100-8" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="40" cy="172" r="12"/><circle cx="92" cy="116" r="12"/><circle cx="144" cy="172" r="12"/><circle cx="216" cy="164" r="12"/>',
  "point-corner":
    '<path d="M48 192l80-128 80 128" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="48" cy="192" r="10"/><circle cx="128" cy="64" r="10"/><circle cx="208" cy="192" r="10"/>',
  "point-mirrored":
    '<path d="M48 192c20-52 44-84 80-84s60 32 80 84" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M88 88h80" stroke="currentColor" stroke-width="16" stroke-linecap="round" fill="none"/><circle cx="48" cy="192" r="10"/><circle cx="88" cy="88" r="10"/><circle cx="168" cy="88" r="10"/><circle cx="208" cy="192" r="10"/>',
  "point-asymmetric":
    '<path d="M48 192c22-52 46-84 80-84s58 28 80 84" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M128 108c10-22 28-36 48-44" stroke="currentColor" stroke-width="16" stroke-linecap="round" fill="none"/><circle cx="48" cy="192" r="10"/><circle cx="128" cy="108" r="10"/><circle cx="176" cy="64" r="10"/><circle cx="208" cy="192" r="10"/>',
  "film-strip":
    '<rect x="28" y="56" width="200" height="144" rx="12" stroke="currentColor" stroke-width="16" fill="none"/><path d="M28 92h200M28 164h200" stroke="currentColor" stroke-width="12" fill="none"/><path d="M76 56v36M128 56v36M180 56v36M76 164v36M128 164v36M180 164v36" stroke="currentColor" stroke-width="12" fill="none"/>',
  "jog-wheel":
    '<circle cx="128" cy="43" r="20"/><circle cx="188" cy="68" r="20"/><circle cx="213" cy="128" r="20"/><circle cx="188" cy="188" r="20"/><circle cx="128" cy="213" r="20"/><circle cx="68" cy="188" r="20"/><circle cx="43" cy="128" r="20"/><circle cx="68" cy="68" r="20"/><circle cx="128" cy="128" r="12"/>',
  "grid-four":
    '<rect x="36" y="36" width="80" height="80" rx="10"/><rect x="140" y="36" width="80" height="80" rx="10"/><rect x="36" y="140" width="80" height="80" rx="10"/><rect x="140" y="140" width="80" height="80" rx="10"/>',
  "onion-skin":
    '<circle cx="92" cy="128" r="56" opacity="0.35"/><circle cx="160" cy="128" r="56" stroke="currentColor" stroke-width="16" fill="none"/>',
  "dots-six-vertical":
    '<circle cx="100" cy="64" r="14"/><circle cx="156" cy="64" r="14"/><circle cx="100" cy="128" r="14"/><circle cx="156" cy="128" r="14"/><circle cx="100" cy="192" r="14"/><circle cx="156" cy="192" r="14"/>',
};

const PANEL_ICON_MAP: Record<string, string> = {
  "tools-panel": "paint-brush",
  "universal-panel": "gear",
  "layers-panel": "stack",
  "wheel-panel": "jog-wheel",
  "view-panel": "eye",
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
// Inkwell Scrollbar — generic custom scrollbar
// ============================================================

/**
 * A generic custom scrollbar that mirrors an external scroll container.
 *
 * Point it at a scroller either by assigning the `target` property or by
 * setting the `for` attribute to a selector resolved within the element's
 * root (document or shadow root). The component tracks the target's scroll
 * and size (including content growth), supports thumb dragging plus
 * track-jump, and hides itself while the content fits.
 *
 * Layout is left to the consumer: the host is a plain block that can be
 * placed in flow (like the timeline's frames scrollbar) or absolutely
 * positioned as an overlay (like panel faces).
 */
@customElement("inkwell-scrollbar")
export class InkwellScrollbar extends LitElement {
  /** Scroll axis this bar mirrors. */
  @property({ reflect: true }) orientation: "horizontal" | "vertical" =
    "horizontal";
  /** Selector for the scroll container, resolved in this element's root. */
  @property({ attribute: "for" }) forSelector = "";
  /**
   * Keep the bar visible when the content fits: the thumb stretches to
   * fill the whole track instead of the bar hiding itself.
   */
  @property({ type: Boolean, reflect: true }) persistent = false;

  static styles = css`
    :host {
      --scrollbar-size: 8px;
      --scrollbar-track-bg: var(--block-depth-color, var(--inkwell-panel-depth, rgba(120, 120, 120, 0.16)));
      --scrollbar-thumb-bg: color-mix(
        in srgb,
        var(--block-border, #555555) 55%,
        transparent
      );
      --scrollbar-thumb-bg-hover: color-mix(
        in srgb,
        var(--block-border, #555555) 75%,
        transparent
      );
      display: block;
      position: relative;
      touch-action: none;
      cursor: pointer;
    }

    :host([orientation="horizontal"]) {
      height: var(--scrollbar-size);
    }

    :host([orientation="vertical"]) {
      width: var(--scrollbar-size);
    }

    :host([data-hidden]) {
      visibility: hidden;
    }

    .track {
      position: absolute;
      inset: 0;
      border-radius: 999px;
      background: var(--scrollbar-track-bg);
    }

    .thumb {
      position: absolute;
      border-radius: 999px;
      background: var(--scrollbar-thumb-bg);
      cursor: grab;
    }

    :host([orientation="horizontal"]) .thumb {
      top: 0;
      bottom: 0;
      left: 0;
      width: 24px;
    }

    :host([orientation="vertical"]) .thumb {
      left: 0;
      right: 0;
      top: 0;
      height: 24px;
    }

    .thumb:hover {
      background: var(--scrollbar-thumb-bg-hover);
    }

    .thumb:active {
      cursor: grabbing;
    }
  `;

  private _target: HTMLElement | null = null;
  /** Thumb-drag state: pointer position and scroll offset at drag start. */
  private drag: { start: number; startScroll: number } | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** Re-registers child resize observation when the target's children change. */
  private childListObserver: MutationObserver | null = null;

  /** The scroll container this bar mirrors. */
  get target(): HTMLElement | null {
    return this._target;
  }

  set target(el: HTMLElement | null) {
    if (el === this._target) return;
    this.detachFromTarget();
    this._target = el;
    this.attachToTarget();
  }

  private get horizontal(): boolean {
    return this.orientation !== "vertical";
  }

  connectedCallback() {
    super.connectedCallback();
    this.resolveForSelector();
    this.attachToTarget();
  }

  disconnectedCallback() {
    this.detachFromTarget();
    super.disconnectedCallback();
  }

  firstUpdated() {
    // `for` targets rendered after this element in the same template pass
    // may not have existed at connect time.
    if (!this._target) this.resolveForSelector();
    this.sync();
  }

  updated(changed: PropertyValues) {
    super.updated(changed);
    if (changed.has("forSelector")) this.resolveForSelector();
    if (changed.has("orientation") || changed.has("persistent")) this.sync();
  }

  private resolveForSelector() {
    if (!this.forSelector) return;
    const root = this.getRootNode() as Document | ShadowRoot;
    const el = root.querySelector?.(this.forSelector);
    if (el instanceof HTMLElement) this.target = el;
  }

  private attachToTarget() {
    const t = this._target;
    if (!t || !this.isConnected) return;
    t.addEventListener("scroll", this.onTargetScroll, { passive: true });
    this.resizeObserver = new ResizeObserver(() => this.sync());
    this.observeSizes();
    this.childListObserver = new MutationObserver(() => {
      this.observeSizes();
      this.sync();
    });
    this.childListObserver.observe(t, { childList: true });
    this.sync();
  }

  private detachFromTarget() {
    this._target?.removeEventListener("scroll", this.onTargetScroll);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.childListObserver?.disconnect();
    this.childListObserver = null;
    this.drag = null;
  }

  /** Watches the bar, the viewport, and its children (content growth). */
  private observeSizes() {
    const ro = this.resizeObserver;
    const t = this._target;
    if (!ro || !t) return;
    ro.disconnect();
    ro.observe(this);
    ro.observe(t);
    for (const child of Array.from(t.children)) ro.observe(child);
  }

  private onTargetScroll = () => this.sync();

  private thumbEl(): HTMLElement | null {
    return this.renderRoot?.querySelector<HTMLElement>(".thumb") ?? null;
  }

  /** Repaints the thumb from scroll geometry (no re-render). */
  private sync() {
    const t = this._target;
    const thumb = this.thumbEl();
    if (!t || !thumb) return;
    const h = this.horizontal;
    const view = h ? t.clientWidth : t.clientHeight;
    const content = h ? t.scrollWidth : t.scrollHeight;
    const needed = content > view + 1 && view > 0;
    this.toggleAttribute("data-hidden", !needed && !this.persistent);
    if (!needed && !this.persistent) return;

    const trackLen = h ? this.clientWidth : this.clientHeight;
    const thumbLen = needed
      ? Math.min(trackLen, Math.max(24, (view / content) * trackLen))
      : trackLen;
    const maxScroll = Math.max(0, content - view);
    const travel = trackLen - thumbLen;
    const scrollPos = h ? t.scrollLeft : t.scrollTop;
    const offset = maxScroll > 0 ? (scrollPos / maxScroll) * travel : 0;
    if (h) {
      thumb.style.width = `${thumbLen}px`;
      thumb.style.transform = `translateX(${offset}px)`;
    } else {
      thumb.style.height = `${thumbLen}px`;
      thumb.style.transform = `translateY(${offset}px)`;
    }
  }

  private setScroll(value: number) {
    const t = this._target;
    if (!t) return;
    if (this.horizontal) t.scrollLeft = value;
    else t.scrollTop = value;
  }

  private onPointerDown = (e: PointerEvent) => {
    const t = this._target;
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    const track = e.currentTarget as HTMLElement;
    const thumb = this.thumbEl();
    track.setPointerCapture(e.pointerId);
    const h = this.horizontal;
    const pointer = h ? e.clientX : e.clientY;

    // Clicking the track (not the thumb) jumps so the thumb centers under
    // the pointer, then the same drag continues from there.
    if (thumb && e.composedPath()[0] !== thumb) {
      const trackRect = track.getBoundingClientRect();
      const thumbRect = thumb.getBoundingClientRect();
      const trackLen = h ? trackRect.width : trackRect.height;
      const thumbLen = h ? thumbRect.width : thumbRect.height;
      const trackStart = h ? trackRect.left : trackRect.top;
      const travel = Math.max(1, trackLen - thumbLen);
      const ratio = (pointer - trackStart - thumbLen / 2) / travel;
      const maxScroll = h
        ? t.scrollWidth - t.clientWidth
        : t.scrollHeight - t.clientHeight;
      this.setScroll(Math.max(0, Math.min(1, ratio)) * maxScroll);
    }
    this.drag = {
      start: pointer,
      startScroll: h ? t.scrollLeft : t.scrollTop,
    };
  };

  private onPointerMove = (e: PointerEvent) => {
    const drag = this.drag;
    const t = this._target;
    const thumb = this.thumbEl();
    if (!drag || !t || !thumb) return;
    e.preventDefault();
    const h = this.horizontal;
    const trackLen = h ? this.clientWidth : this.clientHeight;
    const thumbRect = thumb.getBoundingClientRect();
    const thumbLen = h ? thumbRect.width : thumbRect.height;
    const travel = Math.max(1, trackLen - thumbLen);
    const maxScroll = h
      ? t.scrollWidth - t.clientWidth
      : t.scrollHeight - t.clientHeight;
    const pointer = h ? e.clientX : e.clientY;
    this.setScroll(drag.startScroll + ((pointer - drag.start) * maxScroll) / travel);
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.drag) return;
    this.drag = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  render() {
    return html`
      <div
        class="track"
        part="track"
        @pointerdown=${this.onPointerDown}
        @pointermove=${this.onPointerMove}
        @pointerup=${this.onPointerUp}
        @pointercancel=${this.onPointerUp}
      >
        <div class="thumb" part="thumb"></div>
      </div>
    `;
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

    /* Native scrollbars are hidden everywhere; scrolling surfaces get an
       overlaid <inkwell-scrollbar> instead (see ensureFaceScrollbar). */
    :host,
    * {
      scrollbar-width: none;
    }

    *::-webkit-scrollbar {
      display: none;
    }

    /* Vertical overlay scrollbar for the .face scroller, injected by the
       base class so every panel gets it for free. */
    .face-scrollbar {
      position: absolute;
      top: 8px;
      bottom: calc(var(--block-depth) + 8px);
      right: 4px;
      z-index: 30;
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

  protected getResizeMinWidth(): number {
    return 100;
  }

  protected getResizeMinHeight(_width: number): number {
    return 80;
  }

  protected getResizeMaxHeight(_width: number): number {
    return Number.POSITIVE_INFINITY;
  }

  protected _onResizeMove = (e: PointerEvent) => {
    if (!this._isResizing) return;

    const minWidth = this.getResizeMinWidth();

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

    const minHeight = this.getResizeMinHeight(newWidth);
    if (newHeight < minHeight) {
      newHeight = minHeight;
    }
    newHeight = Math.min(newHeight, this.getResizeMaxHeight(newWidth));

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
    this.ensureFaceScrollbar();
  }

  private _faceScrollbar: InkwellScrollbar | null = null;

  /**
   * Every Block subclass renders a .block > .face pair with its own
   * template, so the shared overlay scrollbar is appended imperatively
   * (Lit leaves foreign children of .block alone). It auto-hides while
   * the face content fits. Fixed-size panels (e.g. the jog wheel) opt out.
   */
  protected usesFaceScrollbar(): boolean {
    return true;
  }

  private ensureFaceScrollbar() {
    if (!this.usesFaceScrollbar()) {
      this._faceScrollbar?.remove();
      this._faceScrollbar = null;
      return;
    }
    const block = this.renderRoot.querySelector<HTMLElement>(".block");
    const face = this.renderRoot.querySelector<HTMLElement>(".face");
    if (!block || !face) return;
    if (!this._faceScrollbar || this._faceScrollbar.parentElement !== block) {
      const bar = document.createElement("inkwell-scrollbar") as InkwellScrollbar;
      bar.orientation = "vertical";
      bar.classList.add("face-scrollbar");
      bar.setAttribute("data-interactive", "");
      block.appendChild(bar);
      this._faceScrollbar = bar;
    }
    this._faceScrollbar.target = face;
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

  @state() private values: ChannelValues = {};
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private planeResizeObserver: ResizeObserver | null = null;
  /* Fixed low-res backing store (upscaled by CSS with bilinear filtering).
     Keeps drawPlane cheap even for expensive OK* conversions on every slider
     tick while still looking smooth at typical panel sizes. */
  private static readonly PLANE_RES = 192;
  private drawRaf: number | null = null;
  private lastPlaneSignature = "";

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
    }

    .plane-area {
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
      display: flex;
      align-items: stretch;
    }

    .plane-square {
      position: relative;
      flex: 1 1 auto;
      width: auto;
      height: 100%;
      min-width: 0;
      max-width: 100%;
      aspect-ratio: 1;
    }
    .plane-square-inner {
      position: absolute; inset: 0; cursor: crosshair;
      border-radius: var(--panel-control-radius, 8px);
      overflow: hidden;
      border: var(--picker-border-width) solid var(--picker-border-color); box-sizing: border-box;
    }

    .plane-circle-wrap {
      position: relative;
      flex: 1 1 auto;
      width: auto;
      height: 100%;
      min-width: 0;
      max-width: 100%;
      aspect-ratio: 1;
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

  firstUpdated() {
    this.ensureCanvas();
    this.setupPlaneResizeObserver();
    this.syncFromColor(this.color);
    this.syncPlaneCanvasSize();
  }

  updated(changed: Map<string, unknown>) {
    this.ensureCanvas();
    if (changed.has("prefs")) {
      this.lastPlaneSignature = "";
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
      this.lastPlaneSignature = "";
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

  /**
   * Use a fixed low-res backing store and let the browser scale it to the plane
   * element's CSS size. This trades pixel-perfect sharpness (unneeded on a
   * smooth colour gradient) for a ~10× speed-up on every slider tick.
   */
  private syncPlaneCanvasSize() {
    if (!this.canvas || !this.ctx) return;
    const size = GenericColorPicker.PLANE_RES;
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
      const cx = w / 2, cy = h / 2, radius = Math.min(cx, cy);
      const invRadius = radius > 0 ? 1 / radius : 0;
      /* Edge anti-aliasing: fade pixels near the radius over ~1px so the
         circle doesn't look jagged after CSS upscaling. */
      const aaWidth = 1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = x - cx, dy = y - cy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > radius + aaWidth) continue;
          const i = (y * w + x) * 4;
          let angleDeg = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
          if (angleDeg < 0) angleDeg += 360;
          const t = Math.min(1, dist * invRadius);
          pix[planeX] = mx.cyclic ? angleDeg : mx.min + (angleDeg / 360) * mxRange;
          pix[planeY] = my.min + t * myRange;
          const [r, g, b] = toRgb(pix);
          const alpha = dist > radius ? Math.max(0, 1 - (dist - radius) / aaWidth) : 1;
          data[i] = r; data[i + 1] = g; data[i + 2] = b;
          data[i + 3] = Math.round(255 * alpha);
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
      this.emitChange();
      this.scheduleDrawPlane();
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
      min-height: var(--panel-min-height, auto);
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

    /* Sticky drag affordance stays visible while panel content scrolls. */
    .panel-drag-pill-wrap {
      position: sticky;
      top: calc(-1 * var(--block-face-padding));
      z-index: 20;
      display: flex;
      justify-content: center;
      align-items: center;
      width: calc(100% + (var(--block-face-padding) * 2));
      min-width: 0;
      flex-shrink: 0;
      margin: calc(-1 * var(--block-face-padding)) calc(-1 * var(--block-face-padding)) 0;
      padding: var(--block-face-padding) var(--block-face-padding) 6px;
      background: var(--block-face-bg);
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

    /* Inline title variant: title sits on the left of the pill row while
       the pill itself stays centered on the panel. */
    .panel-drag-pill-wrap.has-title {
      justify-content: flex-start;
    }

    .panel-drag-pill-wrap.has-title .panel-drag-pill {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
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

  /**
   * Sticky drag-pill row. Pass a title to render it inline on the same
   * row (title left, pill centered).
   */
  protected renderDragHandlePill(title?: string) {
    if (!this.draggable) return title ? this.renderPanelTitle(title) : html``;
    return html`
      <div class="panel-drag-pill-wrap ${title ? "has-title" : ""}">
        ${title ? this.renderPanelTitle(title) : nothing}
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

/** Each entry fixes colour space, geometry, and plane axes for the picker. */
interface PickerVariant {
  id: string;
  label: string;
  prefs: ColorPanelPrefs;
}

const PICKER_VARIANTS: PickerVariant[] = [
  {
    id: "hsv1",
    label: "hsv1",
    prefs: { space: "hsv", geometry: "square", planeX: "s", planeY: "v" },
  },
  {
    id: "okhsl1",
    label: "okhsl1",
    prefs: { space: "okhsl", geometry: "circle", planeX: "h", planeY: "s" },
  },
  {
    id: "okhsl2",
    label: "okhsl2",
    prefs: { space: "okhsl", geometry: "square", planeX: "h", planeY: "l" },
  },
];

function exactVariantId(prefs: ColorPanelPrefs): string {
  return (
    PICKER_VARIANTS.find(
      (v) =>
        v.prefs.space === prefs.space &&
        v.prefs.geometry === prefs.geometry &&
        v.prefs.planeX === prefs.planeX &&
        v.prefs.planeY === prefs.planeY,
    )?.id ?? ""
  );
}

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
      --panel-width: 288px;
    }

    .face {
      overflow: hidden;
    }

    .panel-form {
      height: 100%;
      min-height: 0;
    }

    .row {
      flex: 0 0 auto;
    }

    .picker-wrap {
      flex: 1 1 auto;
      width: 100%;
      min-width: 0;
      min-height: 0;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.unsubscribeColor = colorStore.subscribe((c) => { if (this.color !== c) this.color = c; });
    this.unsubscribePrevColor = prevColorStore.subscribe((p) => { this.prevColor = p; });

    /* If persisted prefs don't match any of the new variants (legacy HSV/HSL
       state), snap to the first variant so the UI isn't inconsistent. */
    const prefs = colorPanelPrefsStore.get();
    if (!exactVariantId(prefs)) {
      colorPanelPrefsStore.set(normalizeColorPanelPrefs({ ...PICKER_VARIANTS[0].prefs }));
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribeColor?.();
    this.unsubscribePrevColor?.();
  }

  private emit(name: string, detail?: unknown) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private onVariantChange(id: string) {
    const variant = PICKER_VARIANTS.find((v) => v.id === id);
    if (!variant) return;
    colorPanelPrefsStore.set(normalizeColorPanelPrefs({ ...variant.prefs }));
  }

  render() {
    const prefs = this.pickerPrefs.value;
    const activeVariant = exactVariantId(prefs) || PICKER_VARIANTS[0].id;

    return html`
      ${this.renderPinnedClose()}
      <div class="block">
        <div class="face">
          <div class="panel-form">
            ${this.renderDragHandlePill()}
            <div class="row" data-interactive>
              ${PICKER_VARIANTS.map(
                (v) => html`
                  <blocky-button
                    flat
                    ?active=${v.id === activeVariant}
                    @click=${() => this.onVariantChange(v.id)}
                    >${v.label}</blocky-button
                  >
                `,
              )}
            </div>
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
                @change=${() => {
                  prevColorStore.set(this.color);
                  this.emit("color-change-end", this.color);
                }}
              ></generic-color-picker>
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

  /** Panel tool order; pan is dock-only and omitted here. */
  private static readonly TOOL_GROUPS: ToolId[][] = [
    ["select", "direct-select"],
    ["brush", "lasso", "rect", "circle"],
    ["magnet", "eyedropper"],
  ];

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
    // NOTE: pixel-res-change is intentionally emitted on `change` (release)
    // rather than `input` (every tick). Each emit triggers a full canvas
    // reconfiguration (writes to pixelCanvas.width, uiCanvas.width,
    // chromeCanvas.width, etc.). Firing that on every input tick during a
    // slider drag causes rapid canvas resets mid-touch-gesture which, on
    // some mobile browsers, leaves the ui-canvas unable to receive further
    // pointer/touch input -- breaking drawing and therefore tracing.
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
          }}
          @change=${(e: Event) => {
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

  private renderToolButton(toolId: ToolId): TemplateResult {
    const t = getTool(toolId);
    return html`
      <blocky-button
        flat
        ?active=${this.tool.value === toolId}
        @click=${() => this.setTool(toolId)}
        >${t.name}</blocky-button
      >
    `;
  }

  private renderToolGroups(): TemplateResult[] {
    return InkwellToolsPanel.TOOL_GROUPS.map(
      (group) => html`
        <div class="grid">
          ${group.map((toolId) => this.renderToolButton(toolId))}
        </div>
      `,
    );
  }

  private renderToolSettings(): TemplateResult {
    const currentToolId = this.tool.value;
    const currentTool = getTool(currentToolId);
    const toolSettings = this.settings.value[currentToolId] as Record<string, unknown>;
    const schema = currentTool.settings as SettingsSchema;

    const schemaKeys = Object.keys(schema);
    // Pixel resolution only affects tools that rasterize through the pixel
    // canvas before tracing; vector tools (select, direct-select, magnet,
    // pan, eyedropper) don't touch it and shouldn't advertise the setting.
    const showsPixelRes = currentToolId === "brush" || currentToolId === "lasso" || currentToolId === "rect" || currentToolId === "circle";
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
      if (currentToolId === "direct-select") {
        return html`<p class="hint">Drag a rectangle or lasso to select vertices on the active layer.</p>`;
      }
      return showsPixelRes ? html`${this.renderPixelRes()}` : html``;
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
      ${showsPixelRes ? this.renderPixelRes() : ""}
    `;
  }

  render() {
    return html`
      ${this.renderPinnedClose()}
      <div class="block">
        <div class="face">
          <div class="panel-form">
            ${this.renderDragHandlePill("Tools")}
            ${this.renderToolGroups()}
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
    // See matching note in InkwellToolsPanel.renderPixelRes(): we only emit
    // the expensive pixel-res-change (canvas reconfigure) on `change`
    // (slider release), not on every `input` tick. Firing on every tick
    // during a mobile touch drag causes repeated canvas.width resets that
    // can break pointer event delivery on #ui-canvas on some mobile
    // browsers, leaving drawing + tracing non-functional afterwards.
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
          }}
          @change=${(e: Event) => {
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
      if (currentToolId === "direct-select") {
        return html`<p class="hint">Drag a rectangle or lasso to select vertices on the active layer.</p>`;
      }
      return html``;
    }

    const showsPixelRes = currentToolId === "brush" || currentToolId === "lasso" || currentToolId === "rect" || currentToolId === "circle";
    return html`
      ${schemaKeys.map((key) =>
        this.renderSetting(
          currentToolId,
          key,
          schema[key],
          toolSettings[key]
        )
      )}
      ${showsPixelRes ? this.renderPixelRes() : ""}
    `;
  }

  render() {
    return html`
      ${this.renderPinnedClose()}
      <div class="block">
        <div class="face">
          <div class="panel-form">
            ${this.renderDragHandlePill("Tool Settings")}
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
  { id: "wheel-panel", label: "Wheel", visible: false },
  { id: "view-panel", label: "View", visible: false },
  { id: "tools-panel", label: "Brush", visible: false },
  { id: "color-panel", label: "Color", visible: false },
];

const TOP_BAR_PANEL_IDS = [
  "universal-panel",
  "layers-panel",
  "wheel-panel",
  "view-panel",
  "tools-panel",
  "color-panel",
] as const;

/** Quick-info chip kinds in the shortcuts panel. */
type DockInfoChip = "mode" | "frame" | "zoom";

const TOP_BAR_SHORTCUT_CHIPS: readonly DockInfoChip[] = ["mode", "frame", "zoom"];

/** Shared chip styles for compact dock readouts (top-bar shortcuts panel). */
const dockChipStyles = css`
  .dock-status {
    display: flex;
    flex-direction: row;
    flex-wrap: nowrap;
    align-items: stretch;
    gap: 6px;
    box-sizing: border-box;
  }

  .dock-cell {
    flex: 0 0 var(--inkwell-dock-control);
    width: var(--inkwell-dock-control);
    min-width: var(--inkwell-dock-control);
    max-width: var(--inkwell-dock-control);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    box-sizing: border-box;
  }

  .dock-cell .dock-chip-stacked,
  .dock-cell .dock-chip-reset {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
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
    align-items: stretch;
    justify-content: center;
    gap: 1px;
    text-align: center;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }

  .dock-value {
    max-width: 100%;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dock-prefix {
    flex-shrink: 0;
    font-weight: 500;
    color: var(--inkwell-text-muted, #666);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
    min-width: 0;
  }

  button.dock-chip-reset:hover {
    background: color-mix(in srgb, var(--inkwell-text-primary, #222) 8%, transparent);
  }

  button.dock-chip-reset:focus-visible {
    outline: 2px solid var(--inkwell-panel-border, #555555);
    outline-offset: 1px;
  }
`;

// ============================================================
// Top Bar Panel (panel visibility toggles)
// ============================================================

@customElement("inkwell-top-bar-panel")
export class InkwellTopBarPanel extends FloatingPanel {
  @state() private panelVisibility: PanelVisibility[] = PANEL_VISIBILITY_DEFAULTS.map((p) => ({
    ...p,
  }));
  private dockColor = new StoreController(this, colorStore);
  private tool = new StoreController(this, toolStore);
  private readonly outsidePointerHandler = (e: PointerEvent) => this.closePanelsOnOutsideClick(e);
  private readonly panelVisibilityChangeHandler = (e: Event) =>
    this.onPanelVisibilityChange(e as CustomEvent<{ id: string; visible: boolean }>);

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      /* Below Safari iOS / iPadOS chrome; env() needs viewport-fit=cover. */
      --panel-top: max(8px, calc(env(safe-area-inset-top, 0px) + 2px));
      --panel-left: 50%;
      --panel-right: auto;
      transform: translateX(-50%);
      --panel-width: auto;
      --panel-min-width: 0;
      --block-face-bg: var(--inkwell-topbar-surface, var(--inkwell-canvas-bg, #ffffff));
      z-index: 1200;
      width: auto;
      max-width: min(calc(100vw - 32px), 640px);
      /* Slightly lighter than the full floating-panels default on compact docks. */
      --inkwell-shadow-panel: 0 4px 16px rgba(0, 0, 0, 0.2);
      /* Panel row; icon / control column width. */
      --inkwell-dock-row-h: 44px;
      --inkwell-dock-control: 44px;
      --inkwell-dock-face-pt: 6px;
      --inkwell-dock-face-pb: 8px;
    }

    .face {
      overflow-x: visible;
      overflow-y: visible;
      padding: var(--inkwell-dock-face-pt) 12px var(--inkwell-dock-face-pb);
      min-height: calc(
        var(--inkwell-dock-row-h) + var(--inkwell-dock-face-pt) + var(--inkwell-dock-face-pb)
      );
    }

    .bar {
      display: flex;
      flex-direction: row;
      flex-wrap: nowrap;
      align-items: stretch;
      gap: 6px;
      height: var(--inkwell-dock-row-h);
      min-height: var(--inkwell-dock-row-h);
      max-height: var(--inkwell-dock-row-h);
      box-sizing: border-box;
    }

    .bar > blocky-button {
      height: 100%;
      min-height: 0;
      align-self: stretch;
    }

    /* Let the tool label collapse with ellipsis when the bar hits max-width; 96px min was clipping. */
    .bar > blocky-button.dock-btn-flex {
      flex: 0 1 auto;
      min-width: 0;
    }

    /* Icon-only and color: fixed size, never flex-shrink (avoids right-edge clip). */
    .bar > blocky-button.dock-btn-icon {
      flex: 0 0 var(--inkwell-dock-control);
      min-width: var(--inkwell-dock-control);
      max-width: var(--inkwell-dock-control);
    }

    .btn-content {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .btn-content svg {
      flex-shrink: 0;
    }
    .btn-content-text {
      display: block;
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
      padding: 0 4px;
      text-align: center;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.01em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
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

  /** 3D chrome for dock color toggle: face = ink, depth strip = slightly offset for contrast. */
  private dockColorBlockChromeStyle(): string {
    const c = this.dockColor.value;
    return `--block-face-bg: ${c}; --block-depth-color: ${dockColorDepthStripColor(c)};`;
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

  private renderPanelTriggerContent(panelId: string) {
    if (panelId === "color-panel") return nothing;
    if (panelId === "tools-panel") {
      const currentToolName = getTool(this.tool.value).name;
      return html`<span class="btn-content btn-content-text">${currentToolName}</span>`;
    }
    return html`<span class="btn-content">${phosphorIcon(PANEL_ICON_MAP[panelId], 14)}</span>`;
  }

  /** Panel toggle buttons in dock order. */
  private visiblePanelTriggers(): PanelVisibility[] {
    return TOP_BAR_PANEL_IDS.map((id) => this.panelVisibility.find((p) => p.id === id))
      .filter((p): p is PanelVisibility => Boolean(p));
  }

  render() {
    const currentToolName = getTool(this.tool.value).name;
    const panelTriggers = this.visiblePanelTriggers();
    return html`
      ${this.renderPinnedClose()}
      <div class="block">
        <div class="face">
          <div class="bar">
            ${panelTriggers.map(
                (panel) => html`
                  <blocky-button
                    data-panel-trigger=${panel.id}
                    class=${panel.id === "tools-panel" ? "dock-btn-flex" : "dock-btn-icon"}
                    title=${panel.id === "tools-panel" ? currentToolName : panel.label}
                    data-interactive
                    stretch
                    style=${panel.id === "color-panel" ? this.dockColorBlockChromeStyle() : nothing}
                    ?active=${panel.visible}
                    @click=${(e: Event) =>
                      this.togglePanel(panel.id, e.currentTarget as HTMLElement)}
                    >${this.renderPanelTriggerContent(panel.id)}</blocky-button
                  >
                `,
              )}
          </div>
        </div>
      </div>
    `;
  }
}

// ============================================================
// Shortcuts Panel (mode / frame / zoom quick actions)
// ============================================================

@customElement("inkwell-shortcuts-panel")
export class InkwellShortcutsPanel extends FloatingPanel {
  @property({ type: Number }) zoomLevel = 100;

  private tool = new StoreController(this, toolStore);
  private settings = new StoreController(this, toolSettingsStore);
  private modifiers = new StoreController(this, modifiersStore);
  private timeline = new StoreController(this, timelineStore);

  static styles = css`
    ${FloatingPanel.styles}
    ${dockChipStyles}

    :host {
      --panel-top: max(8px, calc(env(safe-area-inset-top, 0px) + 2px));
      --panel-left: auto;
      --panel-right: max(8px, env(safe-area-inset-right, 0px));
      --panel-width: auto;
      --panel-min-width: 0;
      --block-face-bg: var(--inkwell-topbar-surface, var(--inkwell-canvas-bg, #ffffff));
      z-index: 1200;
      width: auto;
      --inkwell-shadow-panel: 0 4px 16px rgba(0, 0, 0, 0.2);
      --inkwell-dock-row-h: 44px;
      --inkwell-dock-control: 44px;
      --inkwell-dock-face-pt: 6px;
      --inkwell-dock-face-pb: 8px;
    }

    .face {
      overflow-x: visible;
      overflow-y: visible;
      padding: var(--inkwell-dock-face-pt) 12px var(--inkwell-dock-face-pb);
      min-height: calc(
        var(--inkwell-dock-row-h) + var(--inkwell-dock-face-pt) + var(--inkwell-dock-face-pb)
      );
    }

    .dock-status {
      min-height: var(--inkwell-dock-row-h);
      align-items: center;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.pinned = true;
    this.showPinnedClose = false;
  }

  private emitDock(name: string) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
  }

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
    const effective =
      this.modifiers.value.shift
        ? options[(options.indexOf(raw) + 1) % options.length]
        : raw;
    return effective.charAt(0).toUpperCase() + effective.slice(1);
  }

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

  private buildInfoChip(kind: DockInfoChip) {
    switch (kind) {
      case "mode":
        return {
          label: "mode",
          value: this.effectivePaintModeLabel(),
          title: "Click to cycle paint mode",
          onClick: () => this.emitDock("mode-cycle"),
        };
      case "frame": {
        const t = this.timeline.value;
        return {
          label: "frame",
          value: String(t.currentFrame + 1),
          title: t.playing ? "Pause" : "Play",
          onClick: () => this.emitDock("play-toggle"),
        };
      }
      case "zoom":
        return {
          label: "zoom",
          value: `${this.zoomLevel}%`,
          title: "Fit stage in view",
          onClick: () => this.emitDock("zoom-reset"),
        };
    }
  }

  render() {
    return html`
      <div class="block">
        <div class="face">
          <div class="dock-status">
            ${TOP_BAR_SHORTCUT_CHIPS.map((kind) =>
              this.renderDockWidget(this.buildInfoChip(kind)),
            )}
          </div>
        </div>
      </div>
    `;
  }
}

@customElement("inkwell-view-panel")
export class InkwellViewPanel extends FloatingPanel {
  @property({ type: Boolean }) brushSizeIndicatorEnabled = true;

  private viewOverlay = new StoreController(this, viewOverlayStore);
  private timeline = new StoreController(this, timelineStore);

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      --panel-width: 240px;
    }
  `;

  private emit(name: string, detail?: unknown) {
    this.dispatchEvent(
      new CustomEvent(name, { detail, bubbles: true, composed: true }),
    );
  }

  render() {
    const gridOn = this.viewOverlay.value.gridEnabled;
    const onionOn = this.timeline.value.onionSkin;
    return html`
      ${this.renderPinnedClose()}
      <div class="block">
        <div class="face">
          <div class="panel-form">
            ${this.renderDragHandlePill("View")}
            <div class="toggle">
              <span>Show grid</span>
              <input
                type="checkbox"
                .checked=${gridOn}
                @change=${(e: Event) => {
                  const checked = (e.target as HTMLInputElement).checked;
                  this.viewOverlay.update((v) => ({ ...v, gridEnabled: checked }));
                }}
              />
            </div>
            <div class="toggle">
              <span>Onion skin</span>
              <input
                type="checkbox"
                .checked=${onionOn}
                @change=${() => this.emit("onion-toggle")}
              />
            </div>
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
          </div>
        </div>
      </div>
    `;
  }
}

@customElement("inkwell-universal-panel")
export class InkwellUniversalPanel extends FloatingPanel {
  @property({ type: Boolean }) aliasFixEnabled = false;

  private history = new StoreController(this, historyStateStore);
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
            ${this.renderDragHandlePill("Settings")}
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

            <div class="row">
              <blocky-button flat @click=${() => this.emit("doc-save")}
                >Save</blocky-button
              >
              <blocky-button flat @click=${() => this.emit("doc-open")}
                >Open</blocky-button
              >
              <blocky-button flat danger @click=${() => this.emit("doc-new")}
                >New</blocky-button
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

import { layerStore, generateLayerId, STAGE_LAYER_ID } from "../core/stores";

@customElement("inkwell-layers-panel")
export class InkwellLayersPanel extends FloatingPanel {
  private layers = new StoreController(this, layerStore);
  private timeline = new StoreController(this, timelineStore);
  @state() private editingLayerId: string | null = null;
  @state() private editingName = "";
  /**
   * Custom pointer-drag reorder for layer rows. The preview is pure CSS
   * transforms — the DOM is never reordered mid-drag, so Lit's keyed repeat
   * stays the sole owner of the list and re-renders the committed order
   * from the store on release.
   */
  private rowDrag: {
    pointerId: number;
    fromIndex: number;
    toIndex: number;
    startY: number;
    /** Drag activated (moved past a small threshold from the handle). */
    active: boolean;
    /** The row being dragged (preview class + transform target). */
    el: HTMLElement;
  } | null = null;
  /** Swallows the row click that fires right after a completed drag. */
  private suppressRowClick = false;

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      --panel-width: 480px;
      --layers-control-size: 24px;
      --layers-side-width: 196px;
      --frame-cell-w: 15px;
    }

    .block {
      height: 100%;
      min-height: 0;
    }

    .face {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    .panel-form {
      flex: 1 1 auto;
      height: auto;
      min-height: 0;
    }

    .layers-header {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      width: 100%;
      min-width: 0;
    }

    .playback-fps {
      justify-self: start;
    }

    .playback-play {
      justify-self: center;
    }

    .playback-frames {
      justify-self: end;
    }

    .header-group {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
    }

    .timeline-actions {
      width: var(--layers-side-width, 168px);
      flex: 0 0 auto;
      gap: 3px;
    }

    .timeline-actions .tl-btn {
      min-width: 24px;
      padding: 0 4px;
      font-size: 11px;
    }

    .layer-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex: 0 0 auto;
      overflow: visible;
      margin: 0;
      min-width: 0;
    }

    .layer-item {
      display: grid;
      grid-template-columns:
        var(--layers-control-size)
        minmax(0, 1fr)
        var(--layers-control-size);
      align-items: center;
      gap: 4px;
      height: var(--layers-control-size);
      min-width: 0;
      flex: 0 0 auto;
      cursor: pointer;
      color: var(--block-border, var(--inkwell-panel-border));
    }

    .layer-drag-handle {
      width: 100%;
      height: 100%;
      cursor: grab;
      touch-action: none;
    }

    .layer-drag-handle:active,
    .layer-item.dragging .layer-drag-handle {
      cursor: grabbing;
    }

    .layer-item.hidden {
      opacity: 0.5;
    }

    /* Row being drag-reordered: lifted above its siblings, which animate
       out of the way (transitions only while a drag is live so committed
       re-renders snap instantly). */
    .layer-item.dragging {
      position: relative;
      z-index: 5;
      cursor: grabbing;
      filter: brightness(0.96);
      box-shadow: var(--inkwell-shadow-soft, 0 6px 18px rgba(0, 0, 0, 0.18));
    }

    .layer-list.reordering .layer-item:not(.dragging) {
      transition: transform 120ms ease;
    }

    .layer-action-button,
    .layer-control,
    .layer-name-cell {
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 0;
      min-height: 24px;
      border-radius: 6px;
      background: var(--block-depth-color, var(--inkwell-panel-depth));
      color: var(--block-border, var(--inkwell-panel-border));
    }

    .layer-action-button,
    .layer-control {
      padding: 0;
      border: none;
      cursor: pointer;
    }

    .layer-action-button {
      width: var(--layers-control-size);
      height: var(--layers-control-size);
      flex: 0 0 auto;
      font: inherit;
      font-size: 16px;
      font-weight: 700;
      line-height: 1;
      color: var(--inkwell-text-muted, #666);
    }

    .layer-action-button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .layer-delete-current:hover:not(:disabled) {
      background: var(--inkwell-danger, #9a4545);
      color: var(--inkwell-danger-contrast, #ffffff);
      filter: none;
    }

    .layer-name-cell {
      justify-content: flex-start;
      padding: 0 8px;
      grid-column: 2;
      min-width: 0;
    }

    .layer-name-cell {
      gap: 5px;
    }

    .layer-item:hover:not(.active) .layer-control,
    .layer-item:hover:not(.active) .layer-name-cell,
    .layer-action-button:hover:not(:disabled) {
      filter: brightness(0.97);
    }

    .layer-item.active .layer-control,
    .layer-item.active .layer-name-cell {
      background: var(--inkwell-accent, var(--panel-accent, #b5a04a));
      color: var(--inkwell-danger-contrast, #ffffff);
    }

    .layer-name-cell {
      overflow: hidden;
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
      padding: 1px 5px;
    }

    .layer-item.active .layer-name-input {
      background: color-mix(in srgb, var(--inkwell-danger-contrast, #fff) 14%, transparent);
      border-color: color-mix(in srgb, var(--inkwell-danger-contrast, #fff) 42%, transparent);
    }

    .visibility-btn {
      width: 100%;
      height: 100%;
      color: inherit;
    }

    .visibility-btn svg,
    .layer-action-button svg {
      display: block;
    }

    .layer-item:not(.active) .visibility-btn:hover:not(:disabled) {
      filter: brightness(0.88);
    }

    .visibility-btn.dim {
      opacity: 0.72;
    }

    .layer-item.active .visibility-btn:hover:not(:disabled) {
      background: color-mix(in srgb, var(--inkwell-danger-contrast, #fff) 32%, transparent);
      filter: none;
    }

    /* ---- Timeline (Flash-style frames grid merged into the layer rows) ---- */

    .tl-btn {
      min-width: 30px;
      height: var(--layers-control-size);
      padding: 0 7px;
      border: none;
      border-radius: 6px;
      background: var(--block-depth-color, var(--inkwell-panel-depth));
      color: var(--inkwell-text-muted, #666);
      font: inherit;
      font-weight: 600;
      line-height: 1;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      -webkit-tap-highlight-color: transparent;
    }

    .tl-btn:hover {
      filter: brightness(0.95);
    }

    .tl-btn.on {
      background: var(--inkwell-accent, var(--panel-accent, #4a6fb5));
      color: var(--inkwell-danger-contrast, #ffffff);
    }

    .frame-counter {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      font-variant-numeric: tabular-nums;
      color: var(--inkwell-text-muted, #666);
      padding: 0 4px;
      white-space: nowrap;
    }

    .fps-field {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--inkwell-text-muted, #666);
    }

    .duration-input,
    .fps-field input {
      width: 40px;
      font: inherit;
      padding: 3px 4px;
      border: none;
      border-radius: 6px;
      background: var(--block-depth-color, var(--inkwell-panel-depth));
      color: var(--block-border, var(--inkwell-panel-border));
      text-align: center;
    }

    .duration-input:focus,
    .fps-field input:focus {
      outline: none;
      box-shadow: 0 0 0 2px var(--panel-accent-muted, rgba(74, 111, 181, 0.35));
    }

    /* Two real columns: a fixed name/controls column and a frames column
       that is the only horizontal scroller. Vertical scrolling happens in
       .layer-scroll and moves both columns together. The wrap is the
       positioning context for the overlaid vertical scrollbar. */
    .layer-scroll-wrap {
      position: relative;
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
    }

    .layer-scroll {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
    }

    .layers-vscroll {
      position: absolute;
      top: 0;
      bottom: 0;
      right: 0;
      z-index: 3;
    }

    .layers-body {
      display: flex;
      flex-direction: row;
      align-items: flex-start;
      gap: 8px;
      min-width: 0;
    }

    .side-column {
      display: flex;
      flex-direction: column;
      width: var(--layers-side-width, 168px);
      flex: 0 0 auto;
    }

    .frames-viewport {
      flex: 1 1 auto;
      min-width: 0;
      overflow-x: auto;
      overflow-y: hidden;
      /* Native scrollbar is replaced by the custom .frames-scrollbar below. */
      scrollbar-width: none;
      -ms-overflow-style: none;
    }

    .frames-viewport::-webkit-scrollbar {
      display: none;
    }

    /* Positioning context for the playhead so it scrolls with the frames. */
    .frames-content {
      position: relative;
      width: max-content;
      min-width: 100%;
    }

    .strip-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      width: max-content;
      min-width: 100%;
    }

    .strip-row {
      display: flex;
      align-items: center;
      height: var(--layers-control-size);
      width: max-content;
      min-width: 100%;
      flex: 0 0 auto;
    }

    .strip-row.hidden {
      opacity: 0.5;
    }

    /* Two stacked layers: frame squares underneath, span overlay on top. */
    .frame-strip {
      position: relative;
      flex: 0 0 auto;
    }

    .frame-cells {
      display: flex;
      flex-direction: row;
      align-items: center;
    }

    .frame-cell,
    .ruler-cell {
      width: var(--frame-cell-w, 15px);
      flex: 0 0 var(--frame-cell-w, 15px);
      box-sizing: border-box;
    }

    /* Flat cells: each frame is its own rounded rect separated by a tiny
       gap. The margins keep the 15px pitch so the ruler and span overlay
       stay aligned. */
    .frame-cell {
      width: calc(var(--frame-cell-w, 15px) - 2px);
      flex: 0 0 calc(var(--frame-cell-w, 15px) - 2px);
      height: calc(var(--layers-control-size) - 4px);
      padding: 0;
      margin: 0 1px;
      border: none;
      border-radius: 4px;
      background: var(--block-depth-color, var(--inkwell-panel-depth));
      cursor: pointer;
      touch-action: none;
      -webkit-tap-highlight-color: transparent;
    }

    .frame-cell.in-selection {
      cursor: grab;
    }

    /* Aseprite-style cross shading: the playhead column is tinted in every
       row, the selected layer's row is tinted across every frame, and only
       their intersection gets the solid box. */
    .frame-cell.current {
      background: color-mix(
        in srgb,
        var(--inkwell-accent, #4a6fb5) 18%,
        var(--block-depth-color, var(--inkwell-panel-depth))
      );
    }

    .strip-row.active .frame-cell {
      background: color-mix(
        in srgb,
        var(--inkwell-accent, #4a6fb5) 12%,
        var(--block-depth-color, var(--inkwell-panel-depth))
      );
    }

    .strip-row.active .frame-cell.current {
      box-shadow: inset 0 0 0 2px var(--inkwell-playhead, #f2c14e);
    }

    .frame-cell:hover {
      filter: brightness(0.92);
    }

    /* Span overlay: a dot per single-frame keyframe (hollow when blank),
       a pill per held span. Positioned by --f (start frame) / --len
       (frames). Clicks fall through to the cells underneath. */
    .span-overlay {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }

    .span-pill {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      left: calc(var(--f) * var(--frame-cell-w, 15px) + 3px);
      width: calc(var(--len) * var(--frame-cell-w, 15px) - 6px);
      height: 6px;
      border-radius: 999px;
      background: var(--block-border, #555555);
    }

    .span-dot {
      position: absolute;
      top: 50%;
      left: calc((var(--f) + 0.5) * var(--frame-cell-w, 15px));
      transform: translate(-50%, -50%);
      width: 6px;
      height: 6px;
      border-radius: 50%;
      box-sizing: border-box;
      border: 1.5px solid var(--block-border, #555555);
    }

    /* Single-frame keyframe: filled dot instead of a crammed pill. */
    .span-dot--filled {
      background: var(--block-border, #555555);
    }

    .strip-row.active .span-pill {
      background: var(--inkwell-accent, #4a6fb5);
    }

    .strip-row.active .span-dot {
      border-color: var(--inkwell-accent, #4a6fb5);
    }

    .strip-row.active .span-dot--filled {
      background: var(--inkwell-accent, #4a6fb5);
    }

    /* Drag-selected frame range: accent box over the strip, positioned with
       the same --f / --len technique as .span-pill. Shifted live while the
       block is being dragged to a new time. */
    .frame-selection {
      position: absolute;
      top: 0;
      bottom: 0;
      left: calc(var(--f) * var(--frame-cell-w, 15px) + 1px);
      width: calc(var(--len) * var(--frame-cell-w, 15px) - 2px);
      border-radius: 4px;
      background: color-mix(in srgb, var(--inkwell-accent, #4a6fb5) 24%, transparent);
      box-shadow: inset 0 0 0 2px var(--inkwell-accent, #4a6fb5);
      pointer-events: none;
    }

    .frame-selection.moving {
      opacity: 0.75;
    }

    /* Move preview: the departing artwork fades in place while a ghost of
       the would-be frames travels with the selection box. */
    .span-pill.moving-out,
    .span-dot.moving-out {
      opacity: 0.25;
    }

    .ghost-overlay {
      opacity: 0.6;
    }

    /* ---- Playhead: vertical line over the current frame (scrolls with the
       frames; its grab flag lives in the fixed timeline strip above) ---- */

    .playhead {
      position: absolute;
      top: 0;
      bottom: 0;
      left: calc((var(--f) + 0.5) * var(--frame-cell-w, 15px));
      width: 0;
      z-index: 2;
      pointer-events: none;
    }

    .playhead::before {
      content: "";
      position: absolute;
      top: 0;
      bottom: 0;
      left: -1px;
      width: 2px;
      border-radius: 1px;
      background: var(--inkwell-playhead, #f2c14e);
      opacity: 0.85;
    }

    /* ---- Timeline strip: scrollbar + frame numbers + playhead flag ----
       One fixed strip above the scroll area, aligned with the frames
       column. Three stacked layers: the horizontal scrollbar as the
       background, the frame-number ruler above it (scroll-synced with the
       frames viewport), and the playhead flag on top. The scrollbar thumb
       is raised between the ruler and the flag so it stays grabbable. */
    /* Row holding the add/delete layer buttons (in the name-column slot)
       and the timeline strip next to them, over the frames column. */
    .timeline-row {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 8px;
      flex: 0 0 auto;
      min-width: 0;
    }

    .timeline-strip {
      position: relative;
      height: 20px;
      flex: 1 1 auto;
      min-width: 0;
      /* Never wider than the frames themselves (duration set inline). */
      max-width: calc(var(--timeline-frames, 1) * var(--frame-cell-w, 15px));
      overflow: hidden;
      border-radius: 6px;
    }

    .timeline-strip .frames-scrollbar {
      position: absolute;
      inset: 0;
      width: auto;
      height: auto;
    }

    .timeline-strip .frames-scrollbar::part(track),
    .timeline-strip .frames-scrollbar::part(thumb) {
      border-radius: 6px;
    }

    .timeline-strip .frames-scrollbar::part(thumb) {
      z-index: 2;
    }

    .strip-ruler {
      position: absolute;
      inset: 0;
      z-index: 1;
      overflow: hidden;
      touch-action: none;
      cursor: pointer;
    }

    .strip-ruler-content {
      display: flex;
      flex-direction: row;
      align-items: center;
      height: 100%;
      width: max-content;
      min-width: 100%;
      will-change: transform;
    }

    .ruler-cell {
      font-size: 9px;
      line-height: 1;
      text-align: center;
      color: var(--inkwell-text-muted, #666);
      text-shadow: 0 0 3px var(--block-face-bg, rgba(255, 255, 255, 0.7));
      white-space: nowrap;
      overflow: visible;
      user-select: none;
      cursor: pointer;
    }

    .ruler-cell.current {
      color: var(--inkwell-playhead, #f2c14e);
      font-weight: 700;
    }

    /* Playhead flag: topmost layer of the strip; slides out of view when
       the current frame is scrolled away (intended). */
    .strip-playhead {
      position: absolute;
      top: 2px;
      bottom: 2px;
      left: 0;
      transform: translateX(-50%);
      width: 11px;
      border-radius: 4px;
      background: var(--inkwell-playhead, #f2c14e);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
      z-index: 3;
      cursor: grab;
      touch-action: none;
    }

    /* Widen the touch/click target beyond the visible flag. */
    .strip-playhead::after {
      content: "";
      position: absolute;
      inset: -4px -6px;
    }

    .strip-playhead:active {
      cursor: grabbing;
    }
  `;

  /** True while the playhead (or ruler) is being scrubbed. */
  private scrubbing = false;
  /** Last frame-cell tap, for double-tap (toggle keyframe hold) detection. */
  private lastCellTap: { layerId: string; frame: number; time: number } | null = null;
  /** Selected frame range on one layer's strip (inclusive, start <= end). */
  @state() private frameSelection: {
    layerId: string;
    start: number;
    end: number;
  } | null = null;
  /** Live frame offset while dragging the selection to a new time. */
  @state() private moveDelta = 0;
  /**
   * Frame-cell gesture state. A press starts as a "tap"; horizontal motion
   * past half a cell turns it into "select" (drag out a range) or, when the
   * press landed inside the current selection, "move" (drag the block).
   */
  private cellDrag: {
    layerId: string;
    anchor: number;
    startX: number;
    mode: "tap" | "select" | "move";
    /** Selection bounds at drag start; set only in move mode. */
    base: { start: number; end: number } | null;
  } | null = null;
  /** Last frame seen in updated(), to auto-scroll the playhead into view. */
  private lastSeenFrame = -1;
  private lastSeenLayerCount = -1;

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

    const layerCount = this.layers.value.layers.filter(
      (layer) => layer.kind !== "stage",
    ).length;
    const layerCountChanged = layerCount !== this.lastSeenLayerCount;
    this.lastSeenLayerCount = layerCount;

    // A manually sized panel should track its content as layers are added or
    // removed, and never preserve empty vertical space below the final layer.
    const contentHeight = this.getResizeMaxHeight(this.getBoundingClientRect().width);
    if (
      this.blockHeight !== null &&
      Number.isFinite(contentHeight) &&
      (layerCountChanged || this.blockHeight > contentHeight + 0.5)
    ) {
      this.blockHeight = contentHeight;
    }

    // Follow the playhead during playback.
    const frame = this.timeline.value.currentFrame;
    if (frame !== this.lastSeenFrame) {
      this.lastSeenFrame = frame;
      if (!this.scrubbing) this.ensureFrameVisible(frame);
    }

    // Duration and frame changes move the strip's ruler/flag; scrolling is
    // handled by the viewport's @scroll listener.
    this.syncTimelineStrip();

    if (!changedProperties.has("editingLayerId") || !this.editingLayerId) return;
    void this.updateComplete.then(() => {
      const input = this.renderRoot.querySelector<HTMLInputElement>(
        `[data-layer-edit="${this.editingLayerId}"]`,
      );
      input?.focus();
      input?.select();
    });
  }

  // ---- Playhead scrubbing --------------------------------------------

  private framesViewportEl(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>(".frames-viewport");
  }

  /**
   * Keeps the fixed timeline strip mirroring the frames viewport: the
   * ruler numbers are translated by the scroll offset and the playhead
   * flag is placed over the current frame (it slides out of the strip
   * when the frame is scrolled out of view — intended). Imperative so
   * horizontal scrolling never forces a Lit re-render.
   */
  private syncTimelineStrip = () => {
    const vp = this.framesViewportEl();
    if (!vp) return;
    const scrollLeft = vp.scrollLeft;
    const ruler = this.renderRoot.querySelector<HTMLElement>(".strip-ruler-content");
    if (ruler) ruler.style.transform = `translateX(${-scrollLeft}px)`;
    const flag = this.renderRoot.querySelector<HTMLElement>(".strip-playhead");
    if (flag) {
      const x =
        (this.timeline.value.currentFrame + 0.5) * this.frameCellWidth() - scrollLeft;
      flag.style.left = `${x}px`;
    }
  };

  private frameCellWidth(): number {
    const raw = getComputedStyle(this).getPropertyValue("--frame-cell-w");
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 15;
  }

  private frameFromPointer(e: PointerEvent): number {
    const content = this.renderRoot.querySelector<HTMLElement>(".frames-content");
    if (!content) return 0;
    const rect = content.getBoundingClientRect();
    const frame = Math.floor((e.clientX - rect.left) / this.frameCellWidth());
    return Math.max(0, Math.min(this.timeline.value.duration - 1, frame));
  }

  private scrubTo(e: PointerEvent) {
    const frame = this.frameFromPointer(e);
    if (frame !== this.timeline.value.currentFrame) {
      this.emit("frame-select", { frame });
    }
    this.ensureFrameVisible(frame);
  }

  /** Nudge the frames viewport so `frame` is fully visible. */
  private ensureFrameVisible(frame: number) {
    const vp = this.framesViewportEl();
    if (!vp) return;
    const cellW = this.frameCellWidth();
    const x = frame * cellW;
    if (x < vp.scrollLeft) {
      vp.scrollLeft = x;
    } else if (x + cellW > vp.scrollLeft + vp.clientWidth) {
      vp.scrollLeft = x + cellW - vp.clientWidth;
    }
  }

  private onScrubDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.scrubbing = true;
    this.scrubTo(e);
  };

  private onScrubMove = (e: PointerEvent) => {
    if (!this.scrubbing) return;
    e.preventDefault();
    this.scrubTo(e);
  };

  private onScrubUp = (e: PointerEvent) => {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  // ---- Frame range selection + move ------------------------------------

  private onCellDown(layerId: string, frame: number, e: PointerEvent) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const sel = this.frameSelection;
    const inSelection =
      sel !== null &&
      sel.layerId === layerId &&
      frame >= sel.start &&
      frame <= sel.end;
    this.cellDrag = {
      layerId,
      anchor: frame,
      startX: e.clientX,
      mode: "tap",
      base: inSelection ? { start: sel.start, end: sel.end } : null,
    };
  }

  private onCellMove = (e: PointerEvent) => {
    const drag = this.cellDrag;
    if (!drag) return;

    if (drag.mode === "tap") {
      if (Math.abs(e.clientX - drag.startX) < this.frameCellWidth() * 0.6) return;
      drag.mode = drag.base ? "move" : "select";
    }
    e.preventDefault();

    const frame = this.frameFromPointer(e);
    if (drag.mode === "select") {
      const start = Math.min(drag.anchor, frame);
      const end = Math.max(drag.anchor, frame);
      const cur = this.frameSelection;
      if (!cur || cur.layerId !== drag.layerId || cur.start !== start || cur.end !== end) {
        this.frameSelection = { layerId: drag.layerId, start, end };
      }
    } else if (drag.base) {
      // Keep at least one frame of the block on the timeline.
      const duration = this.timeline.value.duration;
      const raw = frame - drag.anchor;
      this.moveDelta = Math.max(
        -drag.base.end,
        Math.min(duration - 1 - drag.base.start, raw),
      );
    }
    this.ensureFrameVisible(frame);
  };

  private onCellUp = (e: PointerEvent) => {
    const drag = this.cellDrag;
    if (!drag) return;
    this.cellDrag = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);

    if (drag.mode === "tap") {
      this.frameSelection = null;
      this.emit("frame-select", { frame: drag.anchor, layerId: drag.layerId });
      // Double-tap on a keyframe's span toggles its hold (extend to the
      // next keyframe / end of animation, or back to a single frame).
      const now = performance.now();
      const last = this.lastCellTap;
      if (
        last &&
        last.layerId === drag.layerId &&
        last.frame === drag.anchor &&
        now - last.time < 350
      ) {
        this.lastCellTap = null;
        this.emit("keyframe-hold-toggle", { frame: drag.anchor, layerId: drag.layerId });
      } else {
        this.lastCellTap = { layerId: drag.layerId, frame: drag.anchor, time: now };
      }
      return;
    }

    if (drag.mode === "move" && drag.base) {
      const delta = this.moveDelta;
      this.moveDelta = 0;
      if (delta !== 0) {
        this.emit("frames-move", {
          layerId: drag.layerId,
          start: drag.base.start,
          end: drag.base.end,
          delta,
        });
        // Selection follows the moved block (clipped to the timeline).
        const max = this.timeline.value.duration - 1;
        this.frameSelection = {
          layerId: drag.layerId,
          start: Math.max(0, Math.min(max, drag.base.start + delta)),
          end: Math.max(0, Math.min(max, drag.base.end + delta)),
        };
      }
    }
    // "select" mode: the live-updated selection simply stays.
  };

  private onCellCancel = (e: PointerEvent) => {
    if (!this.cellDrag) return;
    this.cellDrag = null;
    this.moveDelta = 0;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  /**
   * The panel's useful height is its fixed chrome plus the timeline ruler and
   * layer rows. Replace the flexible scroll area's current height with its
   * actual content height so resizing cannot create blank space underneath.
   */
  protected getResizeMaxHeight(_width: number): number {
    const panelHeight = this.getBoundingClientRect().height;
    const scroll = this.renderRoot.querySelector<HTMLElement>(".layer-scroll");
    const body = this.renderRoot.querySelector<HTMLElement>(".layers-body");
    if (!scroll || !body || panelHeight <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.ceil(
      panelHeight - scroll.getBoundingClientRect().height + body.scrollHeight,
    );
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

  private deleteCurrentLayer() {
    const layerId = this.layers.value.activeLayerId;
    // Don't allow deleting the last regular layer (Stage doesn't count).
    const nonStage = this.layers.value.layers.filter((l) => l.kind !== "stage");
    if (layerId === STAGE_LAYER_ID || nonStage.length <= 1) return;
    this.emit("layer-delete", layerId);
  }

  private addLayer() {
    const newId = generateLayerId();
    const nonStage = this.layers.value.layers.filter((l) => l.kind !== "stage");
    const layerNumber = nonStage.length + 1;
    this.emit("layer-add", { id: newId, name: `Layer ${layerNumber}` });
  }

  disconnectedCallback() {
    this.cancelRowDrag();
    super.disconnectedCallback();
  }

  // ---- Layer row drag-reorder ------------------------------------------

  /** Row pitch in the list: row height + the list's 4px gap. */
  private rowPitch(): number {
    const raw = getComputedStyle(this).getPropertyValue("--layers-control-size");
    const size = Number.parseFloat(raw);
    return (Number.isFinite(size) && size > 0 ? size : 24) + 4;
  }

  private layerRowEls(): HTMLElement[] {
    return Array.from(
      this.renderRoot.querySelectorAll<HTMLElement>(".layer-list .layer-item"),
    );
  }

  /** Starts from the row's dedicated drag handle. */
  private onRowDown(index: number, e: PointerEvent) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const handle = e.currentTarget as HTMLElement;
    const row = handle.closest<HTMLElement>(".layer-item");
    if (!row) return;
    // Capture on the row: its move/up handlers then receive the whole drag.
    row.setPointerCapture(e.pointerId);
    this.rowDrag = {
      pointerId: e.pointerId,
      fromIndex: index,
      toIndex: index,
      startY: e.clientY,
      active: false,
      el: row,
    };
  }

  private activateRowDrag() {
    const drag = this.rowDrag;
    if (!drag || drag.active) return;
    drag.active = true;
    this.cancelLayerRename();
    drag.el.classList.add("dragging");
    drag.el.closest(".layer-list")?.classList.add("reordering");
  }

  private onRowMove = (e: PointerEvent) => {
    const drag = this.rowDrag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dy = e.clientY - drag.startY;

    if (!drag.active) {
      if (Math.abs(dy) < 4) return;
      this.activateRowDrag();
    }
    e.preventDefault();

    const rows = this.layerRowEls();
    const pitch = this.rowPitch();
    drag.toIndex = Math.max(
      0,
      Math.min(rows.length - 1, drag.fromIndex + Math.round(dy / pitch)),
    );

    // Preview: the dragged row follows the pointer, displaced rows shift by
    // one pitch. DOM order never changes.
    rows.forEach((row, i) => {
      if (i === drag.fromIndex) {
        row.style.transform = `translateY(${dy}px)`;
      } else if (drag.fromIndex < drag.toIndex && i > drag.fromIndex && i <= drag.toIndex) {
        row.style.transform = `translateY(${-pitch}px)`;
      } else if (drag.fromIndex > drag.toIndex && i >= drag.toIndex && i < drag.fromIndex) {
        row.style.transform = `translateY(${pitch}px)`;
      } else {
        row.style.transform = "";
      }
    });
  };

  private onRowUp = (e: PointerEvent) => {
    const drag = this.rowDrag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { active, fromIndex, toIndex } = drag;
    this.cancelRowDrag();
    if (!active) return; // plain tap: let the row's @click select the layer

    this.suppressRowClick = true;
    setTimeout(() => (this.suppressRowClick = false), 0);
    if (toIndex === fromIndex) return;

    // The list holds regular layers only, top layer first; Stage renders
    // outside it and always sits at the bottom of the stack.
    const ids = this.layers.value.layers
      .filter((l) => l.kind !== "stage")
      .reverse()
      .map((l) => l.id);
    if (fromIndex >= ids.length || toIndex >= ids.length) return;
    const [moved] = ids.splice(fromIndex, 1);
    ids.splice(toIndex, 0, moved);
    this.emit("layer-reorder", {
      order: [...ids, STAGE_LAYER_ID],
      movedId: moved,
    });
  };

  /** Tear down drag state and the transform/class preview. */
  private cancelRowDrag = () => {
    const drag = this.rowDrag;
    if (!drag) return;
    this.rowDrag = null;
    drag.el.releasePointerCapture?.(drag.pointerId);
    drag.el.classList.remove("dragging");
    drag.el.closest(".layer-list")?.classList.remove("reordering");
    for (const row of this.layerRowEls()) row.style.transform = "";
  };

  /**
   * A layer's frames: a flat row of clickable squares, with the span
   * markers (a dot per single-frame keyframe, a pill per held span; hollow /
   * outlined when blank) drawn in a single overlay on top. `keyframes` is
   * sorted ascending and may be empty (all frames empty).
   */
  private renderFrameStrip(
    layerId: string,
    keyframes: Array<{ frame: number; blank: boolean; holdUntil: number }>,
    duration: number,
    currentFrame: number,
  ) {
    const sel = this.frameSelection;
    const selected = sel !== null && sel.layerId === layerId ? sel : null;
    const cells = Array.from({ length: duration }, (_, f) => html`
      <button
        type="button"
        class="frame-cell ${f === currentFrame ? "current" : ""} ${
          selected && f >= selected.start && f <= selected.end ? "in-selection" : ""
        }"
        title=${`Frame ${f + 1}`}
        @pointerdown=${(e: PointerEvent) => this.onCellDown(layerId, f, e)}
        @pointermove=${this.onCellMove}
        @pointerup=${this.onCellUp}
        @pointercancel=${this.onCellCancel}
        @click=${(e: Event) => {
          // Don't bubble into the row's layer-select (which switches tools);
          // taps are handled in onCellUp.
          e.stopPropagation();
        }}
      ></button>
    `);

    const moving = selected !== null && this.moveDelta !== 0;
    const spans = keyframes.map((kf) => {
      const spanEnd = Math.min(kf.holdUntil, duration - 1);
      const len = Math.max(1, spanEnd - kf.frame + 1);
      // While the selection is being dragged, the part of the artwork that
      // is leaving fades out (its would-be position renders as a ghost).
      const leaving =
        moving && selected && kf.frame <= selected.end && spanEnd >= selected.start
          ? "moving-out"
          : "";
      // A one-frame span is just a keyframe: a dot (hollow when blank —
      // blank keyframes are always single-frame).
      if (len === 1) {
        return html`<div class="span-dot ${kf.blank ? "" : "span-dot--filled"} ${leaving}" style="--f: ${kf.frame}"></div>`;
      }
      // Held span: pill from the keyframe to its hold end.
      return html`<div class="span-pill ${leaving}" style="--f: ${kf.frame}; --len: ${len}"></div>`;
    });

    // Would-be frames while dragging the selection: the selected slice of
    // each span, shifted by the current delta and clipped to the timeline.
    const ghosts = moving && selected
      ? keyframes.flatMap((kf) => {
          const spanEnd = Math.min(kf.holdUntil, duration - 1);
          const from = Math.max(kf.frame, selected.start);
          const to = Math.min(spanEnd, selected.end);
          if (to < from) return [];
          const shiftedFrom = Math.max(0, from + this.moveDelta);
          const shiftedTo = Math.min(duration - 1, to + this.moveDelta);
          if (shiftedTo < shiftedFrom) return [];
          const len = shiftedTo - shiftedFrom + 1;
          if (len === 1) {
            return [
              html`<div class="span-dot ${kf.blank ? "" : "span-dot--filled"}" style="--f: ${shiftedFrom}"></div>`,
            ];
          }
          return [
            html`<div class="span-pill" style="--f: ${shiftedFrom}; --len: ${len}"></div>`,
          ];
        })
      : null;

    return html`
      <div class="frame-strip">
        <div class="frame-cells">${cells}</div>
        <div class="span-overlay">${spans}</div>
        ${ghosts ? html`<div class="span-overlay ghost-overlay">${ghosts}</div>` : nothing}
        ${selected
          ? html`<div
              class="frame-selection ${this.moveDelta !== 0 ? "moving" : ""}"
              style="--f: ${selected.start + this.moveDelta}; --len: ${
                selected.end - selected.start + 1
              }"
            ></div>`
          : nothing}
      </div>
    `;
  }

  private renderKeyframeActions() {
    const t = this.timeline.value;
    return html`
      <button type="button" class="tl-btn" title="Insert keyframe (copies current artwork)"
        @click=${() => this.emit("keyframe-add", { blank: false })}>+K</button>
      <button type="button" class="tl-btn" title="Insert blank keyframe"
        @click=${() => this.emit("keyframe-add", { blank: true })}>+B</button>
      <button type="button" class="tl-btn"
        title="Delete selected frames (or the frame at the playhead)"
        @click=${() => {
          const sel = this.frameSelection;
          this.frameSelection = null;
          this.emit("keyframe-remove", sel ? { ...sel } : null);
        }}>&#215;K</button>
      <button type="button" class="tl-btn ${t.autoHold ? "on" : ""}"
        title="Auto hold: new keyframes extend the previous keyframe's hold"
        @click=${() => this.emit("auto-hold-toggle")}>AH</button>
    `;
  }

  private renderPlaybackActions() {
    const t = this.timeline.value;
    return html`
      <span class="fps-field playback-fps">
        fps
        <input
          type="number"
          min="1"
          max="60"
          .value=${String(t.frameRate)}
          @change=${(e: Event) => {
            const value = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(value)) this.emit("frame-rate-change", value);
          }}
        />
      </span>
      <button
        type="button"
        class="tl-btn playback-play ${t.playing ? "on" : ""}"
        title=${t.playing ? "Stop" : "Play"}
        @click=${() => this.emit("play-toggle")}
      >${t.playing ? html`&#9632;` : html`&#9654;`}</button>
      <span class="frame-counter playback-frames">
        ${t.currentFrame + 1}/<input
          class="duration-input"
          type="number"
          min="1"
          max="9999"
          title="Total frames (shrinking deletes trailing keyframes)"
          .value=${String(t.duration)}
          @change=${(e: Event) => {
            const value = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(value)) this.emit("duration-set", value);
          }}
        />
      </span>
    `;
  }

  render() {
    const { layers, activeLayerId } = this.layers.value;
    const t = this.timeline.value;
    // Regular layers only, top layer first; the Stage layer stays in the
    // document as the fixed background but has no row in the panel.
    const displayLayers = layers.filter((l) => l.kind !== "stage").reverse();
    const nonStageCount = displayLayers.length;
    const frames = Array.from({ length: t.duration }, (_, i) => i);
    const keyframesByTrack = new Map(
      t.tracks.map((track) => [track.id, track.keyframes]),
    );

    return html`
      ${this.renderPinnedClose()}
      <div class="block">
        <div class="face">
          <div class="panel-form">
            ${this.renderDragHandlePill("Layers")}
            <div class="layers-header">
              ${this.renderPlaybackActions()}
            </div>
            <div class="timeline-row">
              <div class="header-group timeline-actions">
                <button
                  type="button"
                  class="layer-action-button"
                  title="Add layer above selected"
                  aria-label="Add layer"
                  @click=${() => this.addLayer()}
                >+</button>
                <button
                  type="button"
                  class="layer-action-button layer-delete-current"
                  title="Delete current layer"
                  aria-label="Delete current layer"
                  ?disabled=${activeLayerId === STAGE_LAYER_ID || nonStageCount <= 1}
                  @click=${() => this.deleteCurrentLayer()}
                >${phosphorIcon("trash", 14)}</button>
                ${this.renderKeyframeActions()}
              </div>
              <div class="timeline-strip" data-interactive style="--timeline-frames: ${t.duration}">
              <inkwell-scrollbar
                class="frames-scrollbar"
                orientation="horizontal"
                for=".frames-viewport"
                persistent
              ></inkwell-scrollbar>
              <div
                class="strip-ruler"
                @pointerdown=${this.onScrubDown}
                @pointermove=${this.onScrubMove}
                @pointerup=${this.onScrubUp}
                @pointercancel=${this.onScrubUp}
              >
                <div class="strip-ruler-content">
                  ${frames.map(
                    (f) => html`
                      <div
                        class="ruler-cell ${f === t.currentFrame ? "current" : ""}"
                        title=${`Go to frame ${f + 1}`}
                        @click=${() => this.emit("frame-select", { frame: f })}
                      >
                        ${f === 0 || (f + 1) % 5 === 0 || f === t.currentFrame ? f + 1 : ""}
                      </div>
                    `,
                  )}
                </div>
              </div>
              <div
                class="strip-playhead"
                title="Drag to scrub"
                @pointerdown=${this.onScrubDown}
                @pointermove=${this.onScrubMove}
                @pointerup=${this.onScrubUp}
                @pointercancel=${this.onScrubUp}
              ></div>
              </div>
            </div>
            <div class="layer-scroll-wrap">
              <div class="layer-scroll">
              <div class="layers-body">
                <div class="side-column">
                  <div class="layer-list">
                    ${repeat(
                      displayLayers,
                      (layer) => layer.id,
                      (layer, i) => html`
                        <div
                          class="layer-item ${layer.id === activeLayerId ? "active" : ""} ${!layer.visible ? "hidden" : ""}"
                          data-layer-id=${layer.id}
                          data-interactive
                          @pointermove=${this.onRowMove}
                          @pointerup=${this.onRowUp}
                          @pointercancel=${this.cancelRowDrag}
                          @click=${() => {
                            if (this.suppressRowClick) return;
                            this.selectLayer(layer.id);
                          }}
                        >
                          <div
                            class="layer-control layer-drag-handle"
                            title="Drag to reorder"
                            @pointerdown=${(e: PointerEvent) => this.onRowDown(i, e)}
                          >
                            ${phosphorIcon("dots-six-vertical", 14)}
                          </div>
                          <div class="layer-name-cell">
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
                          </div>
                          <button
                            type="button"
                            class="layer-control visibility-btn ${!layer.visible ? "dim" : ""}"
                            @click=${(e: Event) => this.toggleVisibility(layer.id, e)}
                            title="${layer.visible ? "Hide layer" : "Show layer"}"
                          >
                            ${phosphorIcon(layer.visible ? "eye" : "eye-slash", 14)}
                          </button>
                        </div>
                      `
                    )}
                  </div>
                </div>
                <div class="frames-viewport" @scroll=${this.syncTimelineStrip}>
                  <div class="frames-content">
                    <div class="strip-list">
                      ${repeat(
                        displayLayers,
                        (layer) => layer.id,
                        (layer) => html`
                          <div
                            class="strip-row ${layer.id === activeLayerId ? "active" : ""} ${!layer.visible ? "hidden" : ""}"
                          >
                            ${this.renderFrameStrip(
                              layer.id,
                              keyframesByTrack.get(layer.id) ?? [],
                              t.duration,
                              t.currentFrame,
                            )}
                          </div>
                        `
                      )}
                    </div>
                    <div class="playhead" style="--f: ${t.currentFrame}"></div>
                  </div>
                </div>
              </div>
              </div>
              <inkwell-scrollbar
                class="layers-vscroll"
                orientation="vertical"
                for=".layer-scroll"
                data-interactive
              ></inkwell-scrollbar>
            </div>
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
// Wheel Panel (revolver-barrel jog wheel)
// ============================================================

/** Visual chamber count on the barrel; rolling past one steps one frame. */
const WHEEL_CHAMBERS = 12;
const WHEEL_DEG_PER_FRAME = 360 / WHEEL_CHAMBERS;
/** Exponential friction while coasting (ms); lower = more drag. */
const WHEEL_FRICTION_TAU_MS = 90;
/** Coasting ends below this angular velocity (deg/ms). */
const WHEEL_COAST_STOP_VELOCITY = 0.02;
const WHEEL_RAD2DEG = 180 / Math.PI;
/** Hub floor (px); avoids blow-up at the exact center. */
const WHEEL_HUB_MIN_R = 14;
/** Lever exponent: 2 = full finger lever, 1 = no distance scaling (rim-normalized). */
const WHEEL_LEVER_EXPONENT = 1.25;

@customElement("inkwell-wheel-panel")
export class InkwellWheelPanel extends FloatingPanel {
  private timeline = new StoreController(this, timelineStore);
  /** Cumulative barrel rotation in degrees; grows clockwise without bound. */
  private rotationDeg = 0;
  @state() private dragging = false;
  @state() private coasting = false;

  private lastClientX = 0;
  private lastClientY = 0;
  /**
   * The notch (whole chamber count) the barrel last rested on. A frame step
   * fires the moment `round(rotationDeg / degPerFrame)` changes.
   */
  private lastNotch = 0;
  /** Last frame seen from the store, for wrap-aware playback sync. */
  private lastFrame = timelineStore.get().currentFrame;
  private unsubscribeTimeline: (() => void) | null = null;
  /** rAF throttle for frame commits while dragging (touch coalescing). */
  private notchStepRaf: number | null = null;
  /** Linear barrel spin while the timeline is playing. */
  private playbackRaf: number | null = null;
  private playbackLastTs = 0;
  private coastRaf: number | null = null;
  private lastCoastTs = 0;
  private angularVelocity = 0;
  private lastMoveTs = 0;
  /**
   * True while our own frame-step event is being dispatched. The store
   * update it causes re-enters syncRotationToFrame synchronously; without
   * this flag the barrel would rotate twice per step.
   */
  private suppressSync = false;

  protected override usesFaceScrollbar(): boolean {
    return false;
  }

  updated(changedProperties: Map<string, unknown>) {
    // Keep the wheel a fixed circle — never adopt resize dimensions.
    if (this.blockWidth !== null) this.blockWidth = null;
    if (this.blockHeight !== null) this.blockHeight = null;
    super.updated(changedProperties);
  }

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      /* Special case: fixed-size host where the FACE is a true circle. The
         block is taller than it is wide by the 3D depth, so the panel shell
         reads as a slightly elongated puck while the face stays circular. */
      --wheel-size: 180px;
      --wheel-grab-outset: 16px;
      --panel-size: 224px;
      --panel-width: var(--panel-size);
      --panel-min-width: 0;
      --chamber-size: 19px;
      --chamber-inset: 9px;
      height: calc(var(--panel-size) + var(--block-depth));
      min-height: calc(var(--panel-size) + var(--block-depth));
      max-height: calc(var(--panel-size) + var(--block-depth));
    }

    /* Stadium-shaped block: circle stretched vertically by the depth. */
    .block {
      border-radius: calc(var(--panel-size) / 2);
    }

    /* Fixed-size content; never show a scrollbar next to the wheel. */
    .face {
      border-radius: 50%;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }

    .panel-form {
      align-items: center;
      justify-content: center;
    }

    .wheel-wrap {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }

    .wheel {
      position: relative;
      width: var(--wheel-size);
      height: var(--wheel-size);
      border-radius: 50%;
      background: var(--block-depth-color, var(--inkwell-panel-depth));
      -webkit-tap-highlight-color: transparent;
    }

    /* Hit target extends past the visual rim into the face margin (panel drag zone). */
    .wheel-grab {
      position: absolute;
      inset: calc(-1 * var(--wheel-grab-outset));
      border-radius: 50%;
      z-index: 1;
      cursor: grab;
      touch-action: none;
    }

    .wheel.dragging .wheel-grab {
      cursor: grabbing;
    }

    .barrel {
      position: absolute;
      inset: 0;
      pointer-events: none;
      transition: transform 350ms cubic-bezier(0.175, 0.885, 0.32, 1.6);
      will-change: transform;
    }

    /* Drag, coast, and playback drive the barrel directly — no CSS lag. */
    .wheel.live .barrel {
      transition: none;
    }

    .chamber {
      position: absolute;
      top: 50%;
      left: 50%;
      width: var(--chamber-size);
      height: var(--chamber-size);
      margin: calc(var(--chamber-size) / -2) 0 0 calc(var(--chamber-size) / -2);
      border-radius: 50%;
      background: var(--block-face-bg, var(--inkwell-panel-surface));
      pointer-events: none;
    }

    /* Solid accent hub pill: the play button sits centered on the wheel's
       hub and the pill runs right to the wheel's edge, ending in the
       current frame number. */
    .hub-pill {
      --hub-pill-height: 44px;
      position: absolute;
      top: 50%;
      /* Left edge placed so the play half is centered on the wheel hub. */
      left: calc(50% - var(--hub-pill-height) / 2);
      transform: translateY(-50%);
      width: calc(var(--wheel-size) / 2 + var(--hub-pill-height) / 2 + 6px);
      height: var(--hub-pill-height);
      border-radius: 999px;
      overflow: hidden;
      display: flex;
      align-items: stretch;
      background: var(--inkwell-accent, #4a6fb5);
      z-index: 2;
      pointer-events: none;
    }

    .hub-play {
      flex: 0 0 auto;
      width: var(--hub-pill-height);
      min-width: 0;
      border: none;
      margin: 0;
      padding: 0;
      background: transparent;
      color: var(--inkwell-danger-contrast, #ffffff);
      font: inherit;
      font-size: 17px;
      line-height: 1;
      display: grid;
      place-items: center;
      cursor: pointer;
      pointer-events: auto;
      -webkit-tap-highlight-color: transparent;
    }

    .hub-play:hover {
      filter: brightness(0.92);
    }

    /* Shaded circle enclosing the frame number, inset at the pill's right end. */
    .hub-frame {
      --hub-frame-inset: 5px;
      flex: 0 0 auto;
      width: calc(var(--hub-pill-height) - var(--hub-frame-inset) * 2);
      height: calc(var(--hub-pill-height) - var(--hub-frame-inset) * 2);
      margin: var(--hub-frame-inset) var(--hub-frame-inset) var(--hub-frame-inset) auto;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.22);
      color: var(--inkwell-danger-contrast, #ffffff);
      display: grid;
      place-items: center;
      font-size: 14px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      line-height: 1;
      user-select: none;
      -webkit-user-select: none;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.resizable = false;
    this.blockWidth = null;
    this.blockHeight = null;
    const frame = timelineStore.get().currentFrame;
    this.lastFrame = frame;
    this.lastNotch = frame;
    this.rotationDeg = this.lastNotch * WHEEL_DEG_PER_FRAME;
    this.unsubscribeTimeline = timelineStore.subscribe((t) => {
      this.syncRotationToFrame(t.currentFrame, t.duration);
      this.updatePlaybackRotation(t);
    });
  }

  disconnectedCallback() {
    this.unsubscribeTimeline?.();
    this.unsubscribeTimeline = null;
    this.cancelNotchStepSchedule();
    this.stopPlaybackRotation();
    this.stopCoasting();
    super.disconnectedCallback();
  }

  /** Paint the barrel immediately — bypasses Lit so drags stay glued to the finger. */
  private setBarrelRotationLive(deg: number) {
    this.rotationDeg = deg;
    const barrel = this.renderRoot.querySelector<HTMLElement>(".barrel");
    if (barrel) barrel.style.transform = `rotate(${deg}deg)`;
  }

  private isBarrelLive(): boolean {
    return this.dragging || this.coasting || this.timeline.value.playing;
  }

  /** Nearest chamber angle on the same lap as `nearDeg`. */
  private chamberDegForNotch(notch: number, nearDeg: number): number {
    const base = notch * WHEEL_DEG_PER_FRAME;
    return base + Math.round((nearDeg - base) / 360) * 360;
  }

  /** Ease the barrel onto the current notch (revolver peg lock). */
  private settleToChamber() {
    if (this.isBarrelLive()) return;
    const target = this.chamberDegForNotch(this.lastNotch, this.rotationDeg);
    if (Math.abs(this.rotationDeg - target) < 0.05) {
      this.rotationDeg = target;
      this.setBarrelRotationLive(target);
      return;
    }
    // Lit may not have re-rendered yet after coasting stops — drop .live so CSS can run.
    this.renderRoot.querySelector<HTMLElement>(".wheel")?.classList.remove("live");
    this.rotationDeg = target;
    this.setBarrelRotationLive(target);
  }

  private cancelNotchStepSchedule() {
    if (this.notchStepRaf !== null) {
      cancelAnimationFrame(this.notchStepRaf);
      this.notchStepRaf = null;
    }
  }

  /** Commit frame steps at most once per display frame while dragging. */
  private scheduleNotchSteps() {
    if (this.notchStepRaf !== null) return;
    this.notchStepRaf = requestAnimationFrame(() => {
      this.notchStepRaf = null;
      this.emitNotchSteps();
    });
  }

  private flushNotchSteps() {
    this.cancelNotchStepSchedule();
    this.emitNotchSteps();
  }

  private emitStep(delta: number) {
    this.suppressSync = true;
    try {
      this.dispatchEvent(
        new CustomEvent("frame-step", { detail: delta, bubbles: true, composed: true }),
      );
    } finally {
      this.suppressSync = false;
    }
  }

  private emitNotchSteps() {
    const notch = Math.round(this.rotationDeg / WHEEL_DEG_PER_FRAME);
    if (notch !== this.lastNotch) {
      const steps = notch - this.lastNotch;
      this.lastNotch = notch;
      this.emitStep(steps);
    }
  }

  /**
   * Keep the barrel aligned when the playhead moves while paused or scrubbed.
   * During playback the rAF loop drives rotation instead.
   */
  private syncRotationToFrame(frame: number, duration: number) {
    if (frame === this.lastFrame) return;
    let df = frame - this.lastFrame;
    if (duration > 1 && Math.abs(df) > duration / 2) {
      df -= Math.sign(df) * duration;
    }
    this.lastFrame = frame;
    if (this.suppressSync || this.dragging || this.coasting) return;
    if (timelineStore.get().playing) {
      this.lastNotch += df;
      return;
    }
    this.lastNotch += df;
    this.settleToChamber();
  }

  private updatePlaybackRotation(t: { playing: boolean }) {
    if (t.playing && !this.dragging && !this.coasting) {
      if (this.playbackRaf === null) {
        this.playbackLastTs = performance.now();
        this.playbackRaf = requestAnimationFrame(this.playbackTick);
      }
    } else {
      this.stopPlaybackRotation();
    }
  }

  private stopPlaybackRotation() {
    const wasPlaying = this.playbackRaf !== null;
    if (this.playbackRaf !== null) {
      cancelAnimationFrame(this.playbackRaf);
      this.playbackRaf = null;
    }
    if (wasPlaying && !this.isBarrelLive()) {
      this.settleToChamber();
    }
  }

  private stopCoasting() {
    if (this.coastRaf !== null) {
      cancelAnimationFrame(this.coastRaf);
      this.coastRaf = null;
    }
    this.coasting = false;
  }

  private startCoasting(velocity: number) {
    this.stopCoasting();
    this.angularVelocity = velocity;
    this.coasting = true;
    this.lastCoastTs = performance.now();
    this.coastRaf = requestAnimationFrame(this.coastTick);
  }

  private coastTick = (now: number) => {
    const dt = now - this.lastCoastTs;
    this.lastCoastTs = now;
    this.setBarrelRotationLive(this.rotationDeg + this.angularVelocity * dt);
    this.emitNotchSteps();
    this.angularVelocity *= Math.exp(-dt / WHEEL_FRICTION_TAU_MS);
    if (Math.abs(this.angularVelocity) < WHEEL_COAST_STOP_VELOCITY) {
      this.stopCoasting();
      this.settleToChamber();
      return;
    }
    this.coastRaf = requestAnimationFrame(this.coastTick);
  };

  /** Constant-rate spin: one chamber per timeline frame, no easing. */
  private playbackTick = (now: number) => {
    const t = timelineStore.get();
    if (!t.playing || this.dragging) {
      this.stopPlaybackRotation();
      return;
    }
    const dt = now - this.playbackLastTs;
    this.playbackLastTs = now;
    const degPerMs = (t.frameRate * WHEEL_DEG_PER_FRAME) / 1000;
    this.setBarrelRotationLive(this.rotationDeg + degPerMs * dt);
    this.lastNotch = Math.round(this.rotationDeg / WHEEL_DEG_PER_FRAME);
    this.playbackRaf = requestAnimationFrame(this.playbackTick);
  };

  /** Visual wheel radius in screen pixels. */
  private wheelRimRadius(): number {
    const wheel = this.renderRoot.querySelector<HTMLElement>(".wheel");
    return wheel ? wheel.getBoundingClientRect().width / 2 : 90;
  }

  /** Finger offset from wheel center (screen plane). */
  private wheelOffset(e: PointerEvent): { px: number; py: number } {
    const grab = e.currentTarget as HTMLElement;
    const rect = grab.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return { px: e.clientX - cx, py: e.clientY - cy };
  }

  /**
   * Virtual dial with rim-normalized lever: denom = r^exp · R^(2−exp) so
   * sensitivity at the rim matches exp=2 while distance coupling softens.
   */
  private wheelScrubDeg(
    anchorPx: number,
    anchorPy: number,
    dx: number,
    dy: number,
    rimR: number,
  ): number {
    const r = Math.max(Math.hypot(anchorPx, anchorPy), WHEEL_HUB_MIN_R);
    const denom =
      Math.pow(r, WHEEL_LEVER_EXPONENT) *
      Math.pow(rimR, 2 - WHEEL_LEVER_EXPONENT);
    return ((anchorPx * dy - anchorPy * dx) / denom) * WHEEL_RAD2DEG;
  }

  private onWheelDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    this.dragging = true;
    if (this.timeline.value.playing) {
      this.dispatchEvent(
        new CustomEvent("play-toggle", { bubbles: true, composed: true }),
      );
    }
    this.stopPlaybackRotation();
    this.stopCoasting();
    this.cancelNotchStepSchedule();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Pointer already released (fast tap) — drag still works uncaptured.
    }
    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;
    this.angularVelocity = 0;
    this.lastMoveTs = e.timeStamp;
    e.preventDefault();
  };

  private onWheelMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastClientX;
    const dy = e.clientY - this.lastClientY;
    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;

    const { px, py } = this.wheelOffset(e);
    const scrubDeg = this.wheelScrubDeg(px - dx, py - dy, dx, dy, this.wheelRimRadius());
    this.setBarrelRotationLive(this.rotationDeg + scrubDeg);

    const dt = e.timeStamp - this.lastMoveTs;
    if (dt > 0 && dt < 200) {
      this.angularVelocity = this.angularVelocity * 0.5 + (scrubDeg / dt) * 0.5;
    }
    this.lastMoveTs = e.timeStamp;
    this.scheduleNotchSteps();
  };

  private onWheelUp = (e: PointerEvent) => {
    if (!this.dragging) return;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    this.flushNotchSteps();
    if (Math.abs(this.angularVelocity) >= WHEEL_COAST_STOP_VELOCITY) {
      this.startCoasting(this.angularVelocity);
    }
    this.dragging = false;
    this.updatePlaybackRotation(timelineStore.get());
  };

  render() {
    const t = this.timeline.value;
    const chambers = Array.from({ length: WHEEL_CHAMBERS }, (_, i) => i);
    return html`
      <div class="block">
        <div class="face">
          <div class="panel-form">
            <div class="wheel-wrap">
              <div
                class="wheel ${this.dragging ? "dragging" : ""} ${this.isBarrelLive()
                  ? "live"
                  : ""}"
              >
                <div class="barrel" style="transform: rotate(${this.rotationDeg}deg)">
                  ${chambers.map(
                    (i) => html`
                      <div
                        class="chamber"
                        style="transform: rotate(${i * WHEEL_DEG_PER_FRAME}deg)
                          translateY(calc(var(--wheel-size) / -2 + var(--chamber-size) / 2 + var(--chamber-inset)))"
                      ></div>
                    `,
                  )}
                </div>
                <div
                  class="wheel-grab"
                  data-interactive
                  title="Drag to spin or scrub the playhead"
                  @pointerdown=${this.onWheelDown}
                  @pointermove=${this.onWheelMove}
                  @pointerup=${this.onWheelUp}
                  @pointercancel=${this.onWheelUp}
                ></div>
                <div class="hub-pill">
                  <button
                    type="button"
                    class="hub-play ${t.playing ? "on" : ""}"
                    title=${t.playing ? "Stop" : "Play"}
                    data-interactive
                    @pointerdown=${(e: Event) => e.stopPropagation()}
                    @click=${() =>
                      this.dispatchEvent(
                        new CustomEvent("play-toggle", { bubbles: true, composed: true }),
                      )}
                  >${t.playing ? html`&#9632;` : html`&#9654;`}</button>
                  <div class="hub-frame">${t.currentFrame + 1}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

// ============================================================
// Modal Window
// ============================================================

@customElement("inkwell-modal")
export class InkwellModal extends LitElement {
  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: Number }) x = 0;
  @property({ type: Number }) y = 0;

  private _outsideClickHandler = (e: PointerEvent) => {
    if (!this.open) return;
    const path = e.composedPath();
    if (!path.includes(this)) {
      this.close();
    }
  };

  static styles = css`
    :host {
      position: fixed;
      z-index: 2000;
      display: none;
      font-family: var(--inkwell-font, system-ui, sans-serif);
      font-size: 12px;
      font-weight: 500;
      color: var(--inkwell-text-secondary, #6b6b6b);
    }

    :host([open]) {
      display: block;
    }

    .modal-shell {
      background: var(--inkwell-panel-depth, #bcbcbc);
      border: 2px solid var(--inkwell-panel-border, #555555);
      border-radius: 10px;
      padding: 0 0 7px 0;
      box-shadow: var(--inkwell-shadow-panel, 0 0 10px rgba(5, 0, 0, 0.3));
      position: relative;
      overflow: hidden;
      min-width: 140px;
      animation: modal-pop-in 180ms cubic-bezier(0.34, 1.25, 0.64, 1) both;
    }

    @keyframes modal-pop-in {
      0% { transform: scale(0.85); opacity: 0; }
      100% { transform: scale(1); opacity: 1; }
    }

    .modal-face {
      background: var(--inkwell-panel-surface, rgba(255, 253, 249, 0.94));
      border-radius: 8px;
      padding: 8px;
    }

    .modal-close {
      position: absolute;
      top: -11px;
      right: -11px;
      width: 26px;
      height: 26px;
      box-sizing: border-box;
      border: 2px solid var(--inkwell-panel-border, #555555);
      border-radius: 50%;
      background: var(--inkwell-panel-depth, #bcbcbc);
      color: var(--inkwell-panel-border, #555555);
      line-height: 0;
      display: grid;
      place-items: center;
      cursor: pointer;
      z-index: 2001;
      box-shadow: none;
      padding: 0;
      -webkit-tap-highlight-color: transparent;
      animation: floating-close-bounce-in 380ms cubic-bezier(0.34, 1.25, 0.64, 1) both;
    }

    @keyframes floating-close-bounce-in {
      0% { transform: scale(0.55); }
      55% { transform: scale(1.1); }
      78% { transform: scale(0.96); }
      100% { transform: scale(1); }
    }

    .modal-close svg { display: block; }
    .modal-close:hover { filter: brightness(0.96); }
    .modal-close:focus { outline: none; }
  `;

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("pointerdown", this._outsideClickHandler, true);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("pointerdown", this._outsideClickHandler, true);
  }

  show(x: number, y: number) {
    this.x = x;
    this.y = y;
    this.clampPosition();
    this.open = true;
  }

  close() {
    this.open = false;
    this.dispatchEvent(new CustomEvent("modal-close", { bubbles: true, composed: true }));
  }

  private clampPosition() {
    const margin = 8;
    const rect = this.getBoundingClientRect();
    const w = rect.width || 160;
    const h = rect.height || 120;
    if (this.x + w > window.innerWidth - margin) this.x = window.innerWidth - margin - w;
    if (this.y + h > window.innerHeight - margin) this.y = window.innerHeight - margin - h;
    if (this.x < margin) this.x = margin;
    if (this.y < margin) this.y = margin;
  }

  updated(changed: PropertyValues) {
    super.updated(changed);
    if (changed.has("x") || changed.has("y") || changed.has("open")) {
      this.style.left = `${this.x}px`;
      this.style.top = `${this.y}px`;
      if (this.open) {
        requestAnimationFrame(() => this.clampPosition());
      }
    }
  }

  render() {
    return html`
      <button type="button" class="modal-close" @click=${() => this.close()}>
        ${phosphorIcon("x", 12)}
      </button>
      <div class="modal-shell">
        <div class="modal-face">
          <slot></slot>
        </div>
      </div>
    `;
  }
}

// ============================================================
// Functions Panel (appears on selection)
// ============================================================

@customElement("inkwell-functions-panel")
export class InkwellFunctionsPanel extends LitElement {
  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: Number }) x = 0;
  @property({ type: Number }) y = 0;
  @property({ attribute: false }) functions: FunctionMenuItem[] = [];
  private activeDrag:
    | {
        id: string;
        pointerId: number;
        startX: number;
        startY: number;
        dragging: boolean;
      }
    | null = null;
  private suppressClickForId: string | null = null;

  private _outsideClickHandler = (e: PointerEvent) => {
    if (!this.open) return;
    const path = e.composedPath();
    if (!path.includes(this)) {
      this.dismiss();
    }
  };

  static styles = css`
    :host {
      position: fixed;
      z-index: 2000;
      display: none;
      font-family: var(--inkwell-font, system-ui, sans-serif);
      font-size: 12px;
      font-weight: 600;
      color: var(--inkwell-text-secondary, #6b6b6b);
    }

    :host([open]) {
      display: block;
    }

    .fn-shell {
      background: var(--inkwell-panel-depth, #bcbcbc);
      border: 2px solid var(--inkwell-panel-border, #555555);
      border-radius: 10px;
      padding: 0 0 7px 0;
      box-shadow: var(--inkwell-shadow-panel, 0 0 10px rgba(5, 0, 0, 0.3));
      position: relative;
      overflow: hidden;
      min-width: 0;
      animation: fn-pop-in 180ms cubic-bezier(0.34, 1.25, 0.64, 1) both;
    }

    @keyframes fn-pop-in {
      0% { transform: scale(0.85); opacity: 0; }
      100% { transform: scale(1); opacity: 1; }
    }

    .fn-face {
      background: var(--inkwell-panel-surface, rgba(255, 253, 249, 0.94));
      border-radius: 8px;
      padding: 6px;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .fn-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      padding: 0;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--inkwell-text-primary, #29241e);
      font: inherit;
      cursor: pointer;
      transition: background 80ms ease;
    }

    .fn-btn:hover {
      background: var(--inkwell-accent-muted, rgba(77, 115, 215, 0.28));
    }

    .fn-btn.danger { color: var(--inkwell-danger, #af5b5b); }
    .fn-btn.danger:hover { background: var(--inkwell-panel-active-danger, rgba(255, 122, 122, 0.58)); }
  `;

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("pointerdown", this._outsideClickHandler, true);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("pointerdown", this._outsideClickHandler, true);
  }

  show(x: number, y: number) {
    this.x = x;
    this.y = y;
    this.open = true;
    requestAnimationFrame(() => this.clampPosition());
  }

  setPosition(x: number, y: number) {
    this.x = x;
    this.y = y;
    if (this.open) {
      this.clampPosition();
    }
  }

  dismiss() {
    this.close("dismissed");
  }

  close(reason: "dismissed" | "hidden" = "hidden") {
    this.open = false;
    this.dispatchEvent(new CustomEvent("functions-close", {
      detail: { reason },
      bubbles: true,
      composed: true,
    }));
  }

  private clampPosition() {
    const margin = 8;
    const rect = this.getBoundingClientRect();
    const w = rect.width || 160;
    const h = rect.height || 120;
    let left = this.x - w / 2;
    let top = this.y;
    if (left + w > window.innerWidth - margin) left = window.innerWidth - margin - w;
    if (top + h > window.innerHeight - margin) top = window.innerHeight - margin - h;
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    this.style.left = `${left}px`;
    this.style.top = `${top}px`;
  }

  updated(changed: PropertyValues) {
    super.updated(changed);
    if (changed.has("x") || changed.has("y") || changed.has("open")) {
      this.clampPosition();
    }
  }

  private onFunction(id: string) {
    if (this.suppressClickForId === id) {
      this.suppressClickForId = null;
      return;
    }
    this.dispatchEvent(new CustomEvent("function-invoke", {
      detail: { id },
      bubbles: true,
      composed: true,
    }));
    this.close("hidden");
  }

  private onFunctionPointerDown(fn: FunctionMenuItem, e: PointerEvent) {
    if (!fn.draggable) return;
    this.activeDrag = {
      id: fn.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  private onFunctionPointerMove(fn: FunctionMenuItem, e: PointerEvent) {
    if (!fn.draggable || !this.activeDrag || this.activeDrag.id !== fn.id || this.activeDrag.pointerId !== e.pointerId) {
      return;
    }

    const dx = e.clientX - this.activeDrag.startX;
    const dy = e.clientY - this.activeDrag.startY;
    const dragDistanceSq = dx * dx + dy * dy;
    if (!this.activeDrag.dragging && dragDistanceSq >= 25) {
      this.activeDrag.dragging = true;
      this.dispatchEvent(new CustomEvent("function-drag-start", {
        detail: { id: fn.id, dx, dy },
        bubbles: true,
        composed: true,
      }));
    }

    if (!this.activeDrag.dragging) return;

    this.dispatchEvent(new CustomEvent("function-drag-move", {
      detail: { id: fn.id, dx, dy },
      bubbles: true,
      composed: true,
    }));
  }

  private onFunctionPointerUp(fn: FunctionMenuItem, e: PointerEvent) {
    if (!fn.draggable || !this.activeDrag || this.activeDrag.id !== fn.id || this.activeDrag.pointerId !== e.pointerId) {
      return;
    }

    const dx = e.clientX - this.activeDrag.startX;
    const dy = e.clientY - this.activeDrag.startY;
    const wasDragging = this.activeDrag.dragging;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    this.activeDrag = null;

    if (!wasDragging) return;

    this.suppressClickForId = fn.id;
    this.dispatchEvent(new CustomEvent("function-drag-end", {
      detail: { id: fn.id, dx, dy },
      bubbles: true,
      composed: true,
    }));
  }

  private onFunctionPointerCancel(fn: FunctionMenuItem, e: PointerEvent) {
    if (!fn.draggable || !this.activeDrag || this.activeDrag.id !== fn.id || this.activeDrag.pointerId !== e.pointerId) {
      return;
    }
    const wasDragging = this.activeDrag.dragging;
    const dx = e.clientX - this.activeDrag.startX;
    const dy = e.clientY - this.activeDrag.startY;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    this.activeDrag = null;
    if (!wasDragging) return;
    this.suppressClickForId = fn.id;
    this.dispatchEvent(new CustomEvent("function-drag-end", {
      detail: { id: fn.id, dx, dy },
      bubbles: true,
      composed: true,
    }));
  }

  render() {
    return html`
      <div class="fn-shell">
        <div class="fn-face">
          ${this.functions.map(
            (fn) => html`
              <button
                type="button"
                class="fn-btn ${fn.danger ? "danger" : ""}"
                title=${fn.name}
                aria-label=${fn.name}
                @pointerdown=${(e: PointerEvent) => this.onFunctionPointerDown(fn, e)}
                @pointermove=${(e: PointerEvent) => this.onFunctionPointerMove(fn, e)}
                @pointerup=${(e: PointerEvent) => this.onFunctionPointerUp(fn, e)}
                @pointercancel=${(e: PointerEvent) => this.onFunctionPointerCancel(fn, e)}
                @click=${() => this.onFunction(fn.id)}
              >
                ${phosphorIcon(fn.icon, 16)}
              </button>
            `
          )}
        </div>
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
    "inkwell-shortcuts-panel": InkwellShortcutsPanel;
    "inkwell-tools-panel": InkwellToolsPanel;
    "inkwell-tool-settings-panel": InkwellToolSettingsPanel;
    "inkwell-universal-panel": InkwellUniversalPanel;
    "inkwell-view-panel": InkwellViewPanel;
    "inkwell-layers-panel": InkwellLayersPanel;
    "inkwell-wheel-panel": InkwellWheelPanel;
    "inkwell-modal": InkwellModal;
    "inkwell-functions-panel": InkwellFunctionsPanel;
  }
}
