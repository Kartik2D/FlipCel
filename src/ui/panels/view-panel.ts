import { html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  viewOverlayStore,
  normalizeViewOverlaySettings,
  symmetryStore,
  normalizeSymmetrySettings,
  type SymmetryMode,
  type SymmetrySettings,
  type ViewOverlaySettings,
  StoreController,
} from "../../state";
import { timelineStore } from "../../document/document";
import { FloatingPanel } from "../primitives/floating-panel";

@customElement("inkwell-view-panel")
export class InkwellViewPanel extends FloatingPanel {
  @property({ type: Boolean }) brushSizeIndicatorEnabled = true;

  private viewOverlay = new StoreController(this, viewOverlayStore);
  private symmetry = new StoreController(this, symmetryStore);
  private timeline = new StoreController(this, timelineStore);

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      --panel-width: 280px;
    }

    .symmetry-modes {
      display: flex;
      flex-direction: row;
      gap: 4px;
      flex-wrap: wrap;
    }

    .symmetry-modes blocky-button {
      flex: 1 1 0;
      min-width: 0;
    }
  `;

  private updateViewOverlay(patch: Partial<ViewOverlaySettings>) {
    this.viewOverlay.update((v) =>
      normalizeViewOverlaySettings({ ...v, ...patch }),
    );
  }

  private updateSymmetry(patch: Partial<SymmetrySettings>) {
    this.symmetry.update((v) =>
      normalizeSymmetrySettings({ ...v, ...patch }),
    );
  }

  private renderGridSettings(gridOn: boolean) {
    const {
      gridSpacing,
      gridMajorEvery,
      gridMinorOpacity,
      gridMajorOpacity,
    } = this.viewOverlay.value;
    const minorPct = Math.round(gridMinorOpacity * 100);
    const majorPct = Math.round(gridMajorOpacity * 100);

    return html`
      <label>
        <span>Spacing: ${gridSpacing}</span>
        <input
          type="range"
          min="10"
          max="500"
          step="10"
          .value=${String(gridSpacing)}
          ?disabled=${!gridOn}
          @input=${(e: Event) => {
            this.updateViewOverlay({
              gridSpacing: parseInt((e.target as HTMLInputElement).value, 10),
            });
          }}
        />
      </label>
      <label>
        <span>Major every: ${gridMajorEvery}</span>
        <input
          type="range"
          min="2"
          max="20"
          step="1"
          .value=${String(gridMajorEvery)}
          ?disabled=${!gridOn}
          @input=${(e: Event) => {
            this.updateViewOverlay({
              gridMajorEvery: parseInt((e.target as HTMLInputElement).value, 10),
            });
          }}
        />
      </label>
      <label>
        <span>Minor opacity: ${minorPct}%</span>
        <input
          type="range"
          min="0"
          max="30"
          step="1"
          .value=${String(minorPct)}
          ?disabled=${!gridOn}
          @input=${(e: Event) => {
            this.updateViewOverlay({
              gridMinorOpacity:
                parseInt((e.target as HTMLInputElement).value, 10) / 100,
            });
          }}
        />
      </label>
      <label>
        <span>Major opacity: ${majorPct}%</span>
        <input
          type="range"
          min="0"
          max="40"
          step="1"
          .value=${String(majorPct)}
          ?disabled=${!gridOn}
          @input=${(e: Event) => {
            this.updateViewOverlay({
              gridMajorOpacity:
                parseInt((e.target as HTMLInputElement).value, 10) / 100,
            });
          }}
        />
      </label>
    `;
  }

  private emit(name: string, detail?: unknown) {
    this.dispatchEvent(
      new CustomEvent(name, { detail, bubbles: true, composed: true }),
    );
  }

  private renderSymmetrySettings(sym: SymmetrySettings) {
    const modes: { id: SymmetryMode; label: string }[] = [
      { id: "vertical", label: "Vertical" },
      { id: "horizontal", label: "Horizontal" },
      { id: "radial", label: "Radial" },
    ];
    return html`
      <div class="symmetry-modes">
        ${modes.map(
          (m) => html`
            <blocky-button
              flat
              stretch
              ?active=${sym.mode === m.id}
              ?disabled=${!sym.enabled}
              @click=${() => this.updateSymmetry({ mode: m.id })}
              >${m.label}</blocky-button
            >
          `,
        )}
      </div>
      ${sym.mode === "radial"
        ? html`
            <label>
              <span>Count: ${sym.radialCount}</span>
              <input
                type="range"
                min="2"
                max="12"
                step="1"
                .value=${String(sym.radialCount)}
                ?disabled=${!sym.enabled}
                @input=${(e: Event) => {
                  this.updateSymmetry({
                    radialCount: parseInt(
                      (e.target as HTMLInputElement).value,
                      10,
                    ),
                  });
                }}
              />
            </label>
          `
        : nothing}
      <p style="margin: 4px 0 0; font-size: 12px; opacity: 0.7;">
        Drag the handle on the canvas to move the axis.
      </p>
    `;
  }

  render() {
    const gridOn = this.viewOverlay.value.gridEnabled;
    const onionOn = this.timeline.value.onionSkin;
    const onionOutline = this.viewOverlay.value.onionSkinOutline;
    const sym = this.symmetry.value;
    return this.renderFloatingBlock(
      "View",
      html`
            <inkwell-panel-section data-interactive>
              <div class="toggle">
                <span>Onion skin</span>
                <input
                  type="checkbox"
                  .checked=${onionOn}
                  @change=${() => this.emit("onion-toggle")}
                />
              </div>
              <div class="toggle">
                <span>Skin outline</span>
                <input
                  type="checkbox"
                  .checked=${onionOutline}
                  @change=${(e: Event) => {
                    const checked = (e.target as HTMLInputElement).checked;
                    this.viewOverlay.update((v) =>
                      normalizeViewOverlaySettings({ ...v, onionSkinOutline: checked }),
                    );
                  }}
                />
              </div>
            </inkwell-panel-section>
            <inkwell-panel-section data-interactive>
              <div class="toggle">
                <span>Show grid</span>
                <input
                  type="checkbox"
                  .checked=${gridOn}
                  @change=${(e: Event) => {
                    const checked = (e.target as HTMLInputElement).checked;
                    this.updateViewOverlay({ gridEnabled: checked });
                  }}
                />
              </div>
              ${this.renderGridSettings(gridOn)}
            </inkwell-panel-section>
            <inkwell-panel-section data-interactive>
              <div class="toggle">
                <span>Symmetry</span>
                <input
                  type="checkbox"
                  .checked=${sym.enabled}
                  @change=${(e: Event) => {
                    this.updateSymmetry({
                      enabled: (e.target as HTMLInputElement).checked,
                    });
                  }}
                />
              </div>
              ${this.renderSymmetrySettings(sym)}
            </inkwell-panel-section>
            <inkwell-panel-section data-interactive>
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
            </inkwell-panel-section>
      `,
    );
  }
}
