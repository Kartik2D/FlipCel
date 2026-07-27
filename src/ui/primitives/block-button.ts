import { css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { Block } from "./block";

// ============================================================
// Blocky Button
// ============================================================

@customElement("blocky-button")
export class BlockyButton extends Block {
  /** Flat chrome for use inside panels; keep 3D depth for dock / shell toggles only. */
  @property({ type: Boolean, reflect: true }) flat = false;
  /** Larger flat control for primary chooser actions (e.g. startup window). */
  @property({ type: Boolean, reflect: true }) large = false;
  @property({ type: Boolean, reflect: true }) accent = false;
  /** Flat face uses positive / constructive accent (e.g. paint add mode). */
  @property({ type: Boolean, reflect: true }) positive = false;
  /** Flat face uses negative / destructive accent (e.g. paint subtract mode). */
  @property({ type: Boolean, reflect: true }) negative = false;
  /** Flat face uses neutral accent (e.g. paint inside mode). */
  @property({ type: Boolean, reflect: true }) neutral = false;
  /** Flat face uses timeline playhead color (theme token). */
  @property({ type: Boolean, reflect: true }) playhead = false;
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
      --block-font-color: var(--inkwell-text-primary, #1a1a1a);
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
      border-color: var(--inkwell-accent, #4a6fb5);
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

    :host([flat][large]) {
      --block-font-size: 14px;
      --block-radius: 12px;
    }

    :host([flat][large]) .face {
      padding: 14px 16px;
      border-radius: calc(var(--block-radius) - 2px);
    }

    :host([flat]:hover) .face {
      filter: brightness(0.97);
    }

    :host([flat][active]) .face {
      background: var(--inkwell-accent, #4a6fb5);
      color: var(--inkwell-accent-contrast, #ffffff);
      --block-font-color: var(--inkwell-accent-contrast, #ffffff);
    }

    :host([accent]) {
      --block-face-bg: var(--inkwell-accent, #4a6fb5);
      --block-font-color: var(--inkwell-accent-contrast, #ffffff);
    }

    :host([flat][accent]) {
      --block-face-bg: var(--inkwell-accent, #4a6fb5);
      --block-font-color: var(--inkwell-accent-contrast, #ffffff);
    }

    :host([flat][accent]:not([active]):hover) .face {
      filter: brightness(0.95);
    }

    :host([flat][accent][active]) .face {
      background: var(--inkwell-accent-hover, #3d5e9a);
      color: var(--inkwell-accent-contrast, #ffffff);
      --block-font-color: var(--inkwell-accent-contrast, #ffffff);
    }

    :host([positive]) {
      --block-face-bg: var(--inkwell-positive, #3d9a6a);
      --block-font-color: var(--inkwell-positive-contrast, #ffffff);
    }

    :host([flat][positive]) {
      --block-face-bg: var(--inkwell-positive, #3d9a6a);
      --block-font-color: var(--inkwell-positive-contrast, #ffffff);
      color: var(--inkwell-positive-contrast, #ffffff);
    }

    :host([flat][positive]:not([active]):hover) .face {
      filter: brightness(0.95);
    }

    :host([flat][positive][active]) .face {
      background: var(--inkwell-positive-hover, #328555);
      color: var(--inkwell-positive-contrast, #ffffff);
      --block-font-color: var(--inkwell-positive-contrast, #ffffff);
    }

    :host([negative]) {
      --block-face-bg: var(--inkwell-negative, #c45a5a);
      --block-font-color: var(--inkwell-negative-contrast, #ffffff);
    }

    :host([flat][negative]) {
      --block-face-bg: var(--inkwell-negative, #c45a5a);
      --block-font-color: var(--inkwell-negative-contrast, #ffffff);
      color: var(--inkwell-negative-contrast, #ffffff);
    }

    :host([flat][negative]:not([active]):hover) .face {
      filter: brightness(0.95);
    }

    :host([flat][negative][active]) .face {
      background: var(--inkwell-negative-hover, #a84848);
      color: var(--inkwell-negative-contrast, #ffffff);
      --block-font-color: var(--inkwell-negative-contrast, #ffffff);
    }

    :host([neutral]) {
      --block-face-bg: var(--inkwell-neutral, #6b7280);
      --block-font-color: var(--inkwell-neutral-contrast, #ffffff);
    }

    :host([flat][neutral]) {
      --block-face-bg: var(--inkwell-neutral, #6b7280);
      --block-font-color: var(--inkwell-neutral-contrast, #ffffff);
      color: var(--inkwell-neutral-contrast, #ffffff);
    }

    :host([flat][neutral]:not([active]):hover) .face {
      filter: brightness(0.95);
    }

    :host([flat][neutral][active]) .face {
      background: var(--inkwell-neutral-hover, #565d6b);
      color: var(--inkwell-neutral-contrast, #ffffff);
      --block-font-color: var(--inkwell-neutral-contrast, #ffffff);
    }

    :host([playhead]) {
      --block-face-bg: var(--inkwell-playhead, #f2c14e);
      --block-font-color: var(--inkwell-text-primary, #1a1a1a);
    }

    :host([flat][playhead]) {
      --block-face-bg: var(--inkwell-playhead, #f2c14e);
      --block-font-color: var(--inkwell-text-primary, #1a1a1a);
      color: var(--inkwell-text-primary, #1a1a1a);
    }

    :host([flat][playhead]:not([active]):hover) .face {
      filter: brightness(0.96);
    }

    :host([flat][playhead][active]) .face {
      background: color-mix(in srgb, var(--inkwell-playhead, #f2c14e) 88%, #000000);
      color: var(--inkwell-text-primary, #1a1a1a);
      --block-font-color: var(--inkwell-text-primary, #1a1a1a);
    }
  `;
}
