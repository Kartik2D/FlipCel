import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";

// ============================================================
// Panel Section (shaded inset group inside panel windows)
// ============================================================

@customElement("inkwell-panel-section")
export class InkwellPanelSection extends LitElement {
  @property({ type: String }) title = "";
  /** Center the section title (e.g. startup theme picker). */
  @property({ type: Boolean, reflect: true, attribute: "center-title" }) centerTitle = false;
  /** Fill remaining vertical space inside a flex `.panel-form` stack. */
  @property({ type: Boolean, reflect: true }) grow = false;

  static styles = css`
    :host {
      display: block;
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
      border-radius: var(--panel-control-radius, 8px);
      background: var(
        --inkwell-panel-inset-bg,
        color-mix(
          in srgb,
          var(--inkwell-panel-depth, #d4d4d4) 45%,
          var(--block-face-bg, var(--inkwell-panel-surface, #ffffff))
        )
      );
      padding: 10px;
      color: var(--inkwell-text-secondary, #333333);
    }

    :host([grow]) {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }

    .section-title {
      margin: 0 0 10px;
      font: inherit;
      font-weight: 600;
      color: var(--inkwell-text-primary, #1a1a1a);
    }

    :host([center-title]) .section-title {
      text-align: center;
    }

    .section-body {
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-width: 0;
    }

    :host([grow]) .section-body {
      flex: 1 1 auto;
      min-height: 0;
    }
  `;

  render() {
    return html`
      ${this.title
        ? html`<h3 class="section-title">${this.title}</h3>`
        : nothing}
      <div class="section-body">
        <slot></slot>
      </div>
    `;
  }
}
