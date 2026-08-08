import { html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { PopupWindow } from "../primitives/popup-window";
import type { GodotExportOptions, GodotExportScale } from "../../export/godot-sprite-export";

export type { GodotExportOptions };

/**
 * Options popup for Godot 4 spritesheet export (opened from Settings → File).
 */
@customElement("flipcel-godot-export-popup")
export class FlipCelGodotExportPopup extends PopupWindow {
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

    .scale-row {
      display: flex;
      gap: 4px;
    }

    .label {
      color: var(--flipcel-text-secondary, #6b6b6b);
      font-weight: 600;
      font-size: 11px;
    }
  `;

  @state() private splitLayers = false;
  @state() private autoCrop = true;
  @state() private transparentStage = true;
  @state() private scale: GodotExportScale = 1;
  @state() private exporting = false;

  private options(): GodotExportOptions {
    return {
      splitLayers: this.splitLayers,
      autoCrop: this.autoCrop,
      transparentStage: this.transparentStage,
      scale: this.scale,
    };
  }

  private export() {
    if (this.exporting) return;
    this.exporting = true;
    this.dispatchEvent(
      new CustomEvent<GodotExportOptions>("godot-export", {
        detail: this.options(),
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Called by the app when the ZIP download finishes (success or fail). */
  exportFinished() {
    this.exporting = false;
    this.hidePanel();
  }

  render() {
    return this.renderPopupBlock(html`
      <p class="hint">Godot 4 spritesheet + scene</p>
      <div class="opt-row">
        <div class="toggle-row">
          <blocky-button
            flat
            stretch
            ?accent=${this.splitLayers}
            title="One AnimatedSprite2D (and sheet) per layer"
            @click=${() => (this.splitLayers = !this.splitLayers)}
            >Split layers</blocky-button
          >
          <blocky-button
            flat
            stretch
            ?accent=${this.autoCrop}
            title="Crop cells to the smallest rect covering all artwork"
            @click=${() => (this.autoCrop = !this.autoCrop)}
            >Auto crop</blocky-button
          >
          <blocky-button
            flat
            stretch
            ?accent=${this.transparentStage}
            title="Leave stage background transparent in the PNG"
            @click=${() => (this.transparentStage = !this.transparentStage)}
            >Transparent stage</blocky-button
          >
        </div>
        <div>
          <div class="label">Resolution</div>
          <div class="scale-row">
            ${([1, 2, 4, 8] as GodotExportScale[]).map(
              (s) => html`
                <blocky-button
                  flat
                  stretch
                  ?accent=${this.scale === s}
                  @click=${() => (this.scale = s)}
                  >${s}×</blocky-button
                >
              `,
            )}
          </div>
        </div>
      </div>
      <blocky-button
        flat
        accent
        stretch
        ?disabled=${this.exporting}
        @click=${() => void this.export()}
        >${this.exporting ? "Exporting…" : "Export ZIP"}</blocky-button
      >
    `);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "flipcel-godot-export-popup": FlipCelGodotExportPopup;
  }
}
