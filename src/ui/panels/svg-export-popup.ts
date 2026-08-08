import { html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { PopupWindow } from "../primitives/popup-window";
import type { SvgExportOptions } from "../../export/svg-export";

export type { SvgExportOptions };

/**
 * Options popup for SVG export (opened from Settings → File).
 */
@customElement("flipcel-svg-export-popup")
export class FlipCelSvgExportPopup extends PopupWindow {
  static styles = css`
    ${PopupWindow.styles}

    :host {
      --panel-width: 240px;
      font-size: 12px;
    }

    .hint {
      margin: 0;
      color: var(--flipcel-text-secondary, #6b6b6b);
      font-weight: 500;
      line-height: 1.3;
    }

    .opt-row {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .toggle-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
  `;

  @state() private splitLayers = false;
  @state() private autoCrop = true;
  @state() private transparentStage = true;
  @state() private exporting = false;

  private options(): SvgExportOptions {
    return {
      splitLayers: this.splitLayers,
      autoCrop: this.autoCrop,
      transparentStage: this.transparentStage,
    };
  }

  private export() {
    if (this.exporting) return;
    this.exporting = true;
    this.dispatchEvent(
      new CustomEvent<SvgExportOptions>("svg-export", {
        detail: this.options(),
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Called by the app when the download finishes (success or fail). */
  exportFinished() {
    this.exporting = false;
    this.hidePanel();
  }

  render() {
    return this.renderPopupBlock(html`
      <p class="hint">Export SVG</p>
      <div class="opt-row">
        <div class="toggle-row">
          <blocky-button
            flat
            stretch
            ?accent=${this.splitLayers}
            title="One SVG file per layer (ZIP)"
            @click=${() => (this.splitLayers = !this.splitLayers)}
            >Split layers</blocky-button
          >
          <blocky-button
            flat
            stretch
            ?accent=${this.autoCrop}
            title="Crop to the smallest rect covering all artwork"
            @click=${() => (this.autoCrop = !this.autoCrop)}
            >Auto crop</blocky-button
          >
          <blocky-button
            flat
            stretch
            ?accent=${this.transparentStage}
            title="Omit the stage color background"
            @click=${() => (this.transparentStage = !this.transparentStage)}
            >Transparent stage</blocky-button
          >
        </div>
      </div>
      <blocky-button
        flat
        accent
        stretch
        ?disabled=${this.exporting}
        @click=${() => this.export()}
        >${this.exporting ? "Exporting…" : "Export"}</blocky-button
      >
    `);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "flipcel-svg-export-popup": FlipCelSvgExportPopup;
  }
}
