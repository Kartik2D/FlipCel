import { css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { Block } from "./block";

// ============================================================
// Blocky Button (flat face chrome)
// ============================================================

@customElement("blocky-button")
export class BlockyButton extends Block {
  /** Kept for call-site compat; chrome is always flat. */
  @property({ type: Boolean, reflect: true }) flat = false;
  /** Larger control for primary chooser actions (e.g. startup window). */
  @property({ type: Boolean, reflect: true }) large = false;
  @property({ type: Boolean, reflect: true }) accent = false;
  /** Face uses positive / constructive accent (e.g. paint add mode). */
  @property({ type: Boolean, reflect: true }) positive = false;
  /** Face uses negative / destructive accent (e.g. paint subtract mode). */
  @property({ type: Boolean, reflect: true }) negative = false;
  /** Face uses neutral accent (e.g. paint inside mode). */
  @property({ type: Boolean, reflect: true }) neutral = false;
  /** Face uses timeline playhead color (theme token). */
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
      /* Don't inherit panel face padding / shell radius — buttons have their own. */
      --block-face-padding: var(--inkwell-flat-button-padding, 6px 5px);
      --block-radius: var(--inkwell-content-radius);
      --block-font-weight: 600;
      --block-face-bg: var(--block-depth-color, #bcbcbc);
      --block-font-color: var(--block-border, #555555);
      color: var(--block-font-color);
      display: inline-block;
      cursor: pointer;
      text-align: center;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
      user-select: none;
      -webkit-user-select: none;
      min-width: 0;
      max-width: 100%;
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

    .block {
      border: none;
      background: transparent;
      box-shadow: none;
      min-width: 0;
      max-width: 100%;
    }

    .face {
      overflow: hidden;
      min-width: 0;
      max-width: 100%;
      box-sizing: border-box;
    }

    :host([large]) {
      --block-face-padding: var(--inkwell-flat-button-large-padding, 14px 16px);
      --block-font-size: var(--inkwell-flat-button-large-font-size, 14px);
    }

    :host(:hover) .face {
      filter: brightness(0.97);
    }

    :host([active]) .face {
      background: var(--inkwell-accent, #4a6fb5);
      color: var(--inkwell-accent-contrast, #ffffff);
      --block-font-color: var(--inkwell-accent-contrast, #ffffff);
    }

    :host([accent]) {
      --block-face-bg: var(--inkwell-accent, #4a6fb5);
      --block-font-color: var(--inkwell-accent-contrast, #ffffff);
      color: var(--inkwell-accent-contrast, #ffffff);
    }

    :host([accent]:not([active]):hover) .face {
      filter: brightness(0.95);
    }

    :host([accent][active]) .face {
      background: var(--inkwell-accent-hover, #3d5e9a);
      color: var(--inkwell-accent-contrast, #ffffff);
      --block-font-color: var(--inkwell-accent-contrast, #ffffff);
    }

    :host([positive]) {
      --block-face-bg: var(--inkwell-positive, #3d9a6a);
      --block-font-color: var(--inkwell-positive-contrast, #ffffff);
      color: var(--inkwell-positive-contrast, #ffffff);
    }

    :host([positive]:not([active]):hover) .face {
      filter: brightness(0.95);
    }

    :host([positive][active]) .face {
      background: var(--inkwell-positive-hover, #328555);
      color: var(--inkwell-positive-contrast, #ffffff);
      --block-font-color: var(--inkwell-positive-contrast, #ffffff);
    }

    :host([negative]) {
      --block-face-bg: var(--inkwell-negative, #c45a5a);
      --block-font-color: var(--inkwell-negative-contrast, #ffffff);
      color: var(--inkwell-negative-contrast, #ffffff);
    }

    :host([negative]:not([active]):hover) .face {
      filter: brightness(0.95);
    }

    :host([negative][active]) .face {
      background: var(--inkwell-negative-hover, #a84848);
      color: var(--inkwell-negative-contrast, #ffffff);
      --block-font-color: var(--inkwell-negative-contrast, #ffffff);
    }

    :host([neutral]) {
      --block-face-bg: var(--inkwell-neutral, #6b7280);
      --block-font-color: var(--inkwell-neutral-contrast, #ffffff);
      color: var(--inkwell-neutral-contrast, #ffffff);
    }

    :host([neutral]:not([active]):hover) .face {
      filter: brightness(0.95);
    }

    :host([neutral][active]) .face {
      background: var(--inkwell-neutral-hover, #565d6b);
      color: var(--inkwell-neutral-contrast, #ffffff);
      --block-font-color: var(--inkwell-neutral-contrast, #ffffff);
    }

    :host([playhead]) {
      --block-face-bg: var(--inkwell-playhead, #f2c14e);
      --block-font-color: var(--inkwell-text-primary, #1a1a1a);
      color: var(--inkwell-text-primary, #1a1a1a);
    }

    :host([playhead]:not([active]):hover) .face {
      filter: brightness(0.96);
    }

    :host([playhead][active]) .face {
      background: color-mix(in srgb, var(--inkwell-playhead, #f2c14e) 88%, #000000);
      color: var(--inkwell-text-primary, #1a1a1a);
      --block-font-color: var(--inkwell-text-primary, #1a1a1a);
    }
  `;
}
