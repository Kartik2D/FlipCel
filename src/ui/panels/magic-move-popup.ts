import { LitElement, html, css, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { magicMoveUiStore, StoreController } from "../../state";

/**
 * Compact Apply popup shown once a Magic Move timing chart is valid.
 */
@customElement("inkwell-magic-move-popup")
export class InkwellMagicMovePopup extends LitElement {
  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: Number }) x = 0;
  @property({ type: Number }) y = 0;

  private ui = new StoreController(this, magicMoveUiStore);

  private _outsideClickHandler = (e: PointerEvent) => {
    if (!this.open) return;
    const path = e.composedPath();
    if (!path.includes(this)) {
      magicMoveUiStore.update((s) => ({ ...s, popupOpen: false }));
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
    }

    :host([open]) {
      display: block;
    }

    .shell {
      background: var(--inkwell-panel-depth, #bcbcbc);
      border: var(--inkwell-block-border-width, 0px) solid var(--inkwell-panel-border, #555555);
      border-radius: var(--inkwell-block-radius);
      padding: 0;
      box-shadow: var(--inkwell-shadow-panel, 0 0 10px rgba(5, 0, 0, 0.3));
      min-width: 120px;
      animation: mm-pop-in 180ms cubic-bezier(0.34, 1.25, 0.64, 1) both;
    }

    @keyframes mm-pop-in {
      0% {
        transform: scale(0.85);
        opacity: 0;
      }
      100% {
        transform: scale(1);
        opacity: 1;
      }
    }

    .face {
      background: var(--inkwell-panel-surface, rgba(255, 253, 249, 0.94));
      border-radius: calc(
        var(--inkwell-block-radius) - var(--inkwell-block-border-width, 2px)
      );
      padding: var(--inkwell-block-face-padding, 12px);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .hint {
      margin: 0;
      color: var(--inkwell-text-secondary, #6b6b6b);
      font-weight: 500;
      line-height: 1.3;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("pointerdown", this._outsideClickHandler, true);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("pointerdown", this._outsideClickHandler, true);
  }

  private clampPosition() {
    const margin = 8;
    const rect = this.getBoundingClientRect();
    const w = rect.width || 140;
    const h = rect.height || 60;
    let left = this.x - w / 2;
    let top = this.y;
    if (left + w > window.innerWidth - margin) left = window.innerWidth - margin - w;
    if (top + h > window.innerHeight - margin) top = window.innerHeight - margin - h;
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    this.style.left = `${left}px`;
    this.style.top = `${top}px`;
  }

  protected updated(changed: PropertyValues) {
    const state = this.ui.value;
    if (
      this.open !== state.popupOpen ||
      this.x !== state.popupX ||
      this.y !== state.popupY
    ) {
      this.open = state.popupOpen;
      this.x = state.popupX;
      this.y = state.popupY;
    }
    if (changed.has("x") || changed.has("y") || changed.has("open") || this.open) {
      this.clampPosition();
    }
  }

  private onApply() {
    this.dispatchEvent(
      new CustomEvent("magic-move-apply", {
        bubbles: true,
        composed: true,
      }),
    );
    magicMoveUiStore.update((s) => ({ ...s, popupOpen: false }));
  }

  render() {
    return html`
      <div class="shell">
        <div class="face">
          <p class="hint">Timing chart ready</p>
          <blocky-button flat accent stretch @click=${() => this.onApply()}
            >Apply</blocky-button
          >
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "inkwell-magic-move-popup": InkwellMagicMovePopup;
  }
}
