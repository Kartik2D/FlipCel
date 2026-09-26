import { html, css } from "lit";
import { customElement } from "lit/decorators.js";
import {
  documentNameStore,
  displayDocumentName,
  DEFAULT_DOCUMENT_NAME,
  stageStore,
  clampStageDimension,
  normalizeStageDimensionInput,
  snapStageDimension,
  STAGE_SIZE_MIN,
  STAGE_SIZE_MAX,
  STAGE_SIZE_STEP,
  STAGE_SIZE_PRESETS,
  StoreController,
} from "../../state";
import { FloatingPanel } from "../primitives/floating-panel";

@customElement("flipcel-file-panel")
export class FlipCelFilePanel extends FloatingPanel {
  private documentName = new StoreController(this, documentNameStore);
  private stage = new StoreController(this, stageStore);

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      --panel-width: 280px;
    }

    .name-input {
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      font: inherit;
      padding: 5px 8px;
      margin: 0;
      border: none;
      border-radius: var(--flipcel-content-radius);
      background-color: var(--block-depth-color, #bcbcbc);
      color: var(--block-border, #555555);
    }

    .name-input:focus {
      outline: none;
      box-shadow: 0 0 0 2px var(--panel-accent-muted, rgba(74, 111, 181, 0.35));
    }

    .stage-color-row {
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin: 0;
      min-height: 28px;
    }

    .stage-color-row > span {
      flex: 0 0 auto;
      color: var(--flipcel-text-secondary, #333333);
    }

    .stage-color-swatch {
      appearance: none;
      display: block;
      width: 28px;
      height: 28px;
      flex: 0 0 28px;
      margin-left: auto;
      padding: 0;
      border-radius: var(--flipcel-content-radius);
      border: var(--block-border-width, var(--flipcel-block-border-width, 2px)) solid
        var(--block-border, #555555);
      box-sizing: border-box;
      cursor: pointer;
    }

    .stage-color-swatch:hover {
      filter: brightness(1.05);
    }

    .stage-size-field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 0;
      min-width: 0;
    }

    .stage-size-label-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .stage-size-label-row > span:first-child {
      flex: 0 0 auto;
      min-width: 3.25rem;
      color: var(--flipcel-text-secondary, #333333);
    }

    .stage-size-input-wrap {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex: 0 0 auto;
      margin-left: auto;
    }

    .stage-size-input {
      box-sizing: border-box;
      width: 4.5rem;
      min-width: 0;
      font: inherit;
      font-variant-numeric: tabular-nums;
      padding: 5px 6px;
      margin: 0;
      border: none;
      border-radius: var(--flipcel-content-radius);
      background-color: var(--block-depth-color, #bcbcbc);
      color: var(--block-border, #555555);
      text-align: right;
      -moz-appearance: textfield;
      appearance: textfield;
    }

    .stage-size-input::-webkit-outer-spin-button,
    .stage-size-input::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }

    .stage-size-input:focus {
      outline: none;
      box-shadow: 0 0 0 2px var(--panel-accent-muted, rgba(74, 111, 181, 0.35));
    }

    .stage-size-unit {
      flex: 0 0 auto;
      color: var(--flipcel-text-muted, #666);
      font-size: 11px;
    }

    .stage-size-slider {
      position: relative;
      width: 100%;
      min-width: 0;
      height: 1.75rem;
    }

    .stage-size-track {
      position: absolute;
      left: 8px;
      right: 8px;
      top: 50%;
      height: 6px;
      transform: translateY(-50%);
      border-radius: 999px;
      background: var(--panel-track-bg, #cfcfcf);
      pointer-events: none;
      z-index: 1;
      overflow: visible;
    }

    .stage-size-ticks {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }

    .stage-size-tick {
      position: absolute;
      left: var(--tick-p);
      top: 50%;
      width: 3px;
      height: 10px;
      transform: translate(-50%, -50%);
      border-radius: 1px;
      background: var(--block-border, #555555);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--block-face-bg, #fff) 55%, transparent);
      opacity: 0.9;
    }

    .stage-size-slider input[type="range"] {
      position: absolute;
      inset: 0;
      width: 100%;
      margin: 0;
      z-index: 2;
      background: transparent;
      -webkit-appearance: none;
      appearance: none;
    }

    .stage-size-slider input[type="range"]::-webkit-slider-runnable-track {
      height: 6px;
      border-radius: 999px;
      background: transparent;
    }

    .stage-size-slider input[type="range"]::-moz-range-track {
      height: 6px;
      border-radius: 999px;
      background: transparent;
    }

    .stage-size-slider input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 22px;
      height: 22px;
      margin-top: -8px;
      border-radius: 50%;
      background: var(--panel-accent, #4a6fb5);
      border: none;
      box-shadow: none;
    }

    .stage-size-slider input[type="range"]::-moz-range-thumb {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: var(--panel-accent, #4a6fb5);
      border: none;
      box-shadow: none;
    }
  `;

  private emit(name: string, detail?: unknown) {
    this.dispatchEvent(
      new CustomEvent(name, { detail, bubbles: true, composed: true }),
    );
  }

  private commitName(raw: string) {
    const next = displayDocumentName(raw);
    if (next === displayDocumentName(this.documentName.value)) return;
    documentNameStore.set(next || DEFAULT_DOCUMENT_NAME);
  }

  private setStageDimension(key: "width" | "height", raw: string) {
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return;
    const value = normalizeStageDimensionInput(parsed);
    if (this.stage.value[key] === value) return;
    stageStore.update((s) => ({ ...s, [key]: value }));
  }

  private commitStageDimension(key: "width" | "height", raw: string) {
    const before = this.stage.value[key];
    this.setStageDimension(key, raw);
    if (this.stage.value[key] !== before) {
      this.emit("stage-size-change");
    }
  }

  private onStageSizeSliderInput(key: "width" | "height", e: Event) {
    const input = e.target as HTMLInputElement;
    const parsed = parseInt(input.value, 10);
    if (!Number.isFinite(parsed)) return;
    const value = snapStageDimension(parsed);
    if (Number(input.value) !== value) input.value = String(value);
    if (this.stage.value[key] !== value) {
      stageStore.update((s) => ({ ...s, [key]: value }));
    }
  }

  private onStageSizeSliderChange(key: "width" | "height", e: Event) {
    const input = e.target as HTMLInputElement;
    const parsed = parseInt(input.value, 10);
    if (!Number.isFinite(parsed)) return;
    const value = snapStageDimension(parsed);
    input.value = String(value);
    this.commitStageDimension(key, String(value));
  }

  private stageSizeTickPercent(value: number): string {
    const span = STAGE_SIZE_MAX - STAGE_SIZE_MIN;
    const p = span > 0 ? ((value - STAGE_SIZE_MIN) / span) * 100 : 0;
    return `${p}%`;
  }

  private renderStageSizeSlider(
    key: "width" | "height",
    label: string,
    value: number,
    sliderValue: number,
  ) {
    return html`
      <div class="stage-size-field">
        <div class="stage-size-label-row">
          <span>${label}</span>
          <div class="stage-size-input-wrap">
            <input
              type="number"
              class="stage-size-input"
              min="1"
              step="1"
              .value=${String(value)}
              data-interactive
              aria-label=${`${label} in pixels`}
              @change=${(e: Event) =>
                this.commitStageDimension(key, (e.target as HTMLInputElement).value)}
              @blur=${(e: Event) =>
                this.commitStageDimension(key, (e.target as HTMLInputElement).value)}
            />
            <span class="stage-size-unit">px</span>
          </div>
        </div>
        <div class="stage-size-slider">
          <div class="stage-size-track">
            <div class="stage-size-ticks" aria-hidden="true">
              ${STAGE_SIZE_PRESETS.map(
                (preset) => html`
                  <span
                    class="stage-size-tick"
                    style="--tick-p: ${this.stageSizeTickPercent(preset)}"
                    title=${`${preset}px`}
                  ></span>
                `,
              )}
            </div>
          </div>
          <input
            type="range"
            min=${STAGE_SIZE_MIN}
            max=${STAGE_SIZE_MAX}
            step=${STAGE_SIZE_STEP}
            .value=${String(sliderValue)}
            @input=${(e: Event) => this.onStageSizeSliderInput(key, e)}
            @change=${(e: Event) => this.onStageSizeSliderChange(key, e)}
          />
        </div>
      </div>
    `;
  }

  private onNameKeydown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      (e.target as HTMLInputElement).value = displayDocumentName(
        this.documentName.value,
      );
      (e.target as HTMLInputElement).blur();
    }
  }

  render() {
    const filename = displayDocumentName(this.documentName.value);
    const { width, height, color } = this.stage.value;
    return this.renderFloatingBlock(
      "Document",
      html`
        <flipcel-panel-section title="File" data-interactive>
          <label>
            <span>Name</span>
            <input
              type="text"
              class="name-input"
              data-help="dock.filename"
              data-interactive
              .value=${filename}
              aria-label="Document name"
              spellcheck="false"
              autocomplete="off"
              @change=${(e: Event) =>
                this.commitName((e.target as HTMLInputElement).value)}
              @keydown=${(e: KeyboardEvent) => this.onNameKeydown(e)}
            />
          </label>
          <div class="row">
            <blocky-button flat accent @click=${() => this.emit("doc-new")}
              >New</blocky-button
            >
          </div>
          <div class="row">
            <blocky-button flat @click=${() => this.emit("doc-save")}
              >Save JSON</blocky-button
            >
            <blocky-button flat @click=${() => this.emit("doc-open")}
              >Open JSON</blocky-button
            >
          </div>
          <div class="row">
            <blocky-button
              flat
              data-panel-trigger="image-import-popup"
              @click=${(e: Event) =>
                this.emit("import-image-open", e.currentTarget as HTMLElement)}
              >Import Image</blocky-button
            >
            <blocky-button
              flat
              data-panel-trigger="svg-import-popup"
              @click=${(e: Event) =>
                this.emit("import-svg-open", e.currentTarget as HTMLElement)}
              >Import SVG</blocky-button
            >
          </div>
          <div class="row">
            <blocky-button
              flat
              data-panel-trigger="generate-image-popup"
              @click=${(e: Event) =>
                this.emit("generate-image-open", e.currentTarget as HTMLElement)}
              >Generate Image</blocky-button
            >
          </div>
          <div class="row">
            <blocky-button
              flat
              data-panel-trigger="svg-export-popup"
              @click=${(e: Event) =>
                this.emit("export-svg-open", e.currentTarget as HTMLElement)}
              >Export SVG</blocky-button
            >
            <blocky-button
              flat
              data-panel-trigger="godot-export-popup"
              @click=${(e: Event) =>
                this.emit("export-godot-open", e.currentTarget as HTMLElement)}
              >Export Godot</blocky-button
            >
          </div>
        </flipcel-panel-section>
        <flipcel-panel-section title="Stage" data-interactive>
          <div class="stage-color-row">
            <span>Color</span>
            <button
              type="button"
              class="stage-color-swatch"
              style="background:${color}"
              title=${color}
              data-interactive
              @click=${(e: Event) => {
                this.emit("stage-color-picker-open", e.currentTarget as HTMLElement);
              }}
            ></button>
          </div>
          ${this.renderStageSizeSlider("width", "Width", width, clampStageDimension(width))}
          ${this.renderStageSizeSlider("height", "Height", height, clampStageDimension(height))}
        </flipcel-panel-section>
      `,
    );
  }
}
