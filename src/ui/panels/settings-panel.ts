import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  themeModeStore,
  wheelFrictionStore,
  wheelDirectionStore,
  quickShapeEnabledStore,
  quickShapeCurveStyleStore,
  quickShapeHoldMsStore,
  clampQuickShapeCurveStyle,
  clampQuickShapeHoldMs,
  QUICK_SHAPE_HOLD_MS_MIN,
  QUICK_SHAPE_HOLD_MS_MAX,
  stageStore,
  clampStageDimension,
  normalizeStageDimensionInput,
  snapStageDimension,
  STAGE_SIZE_MIN,
  STAGE_SIZE_MAX,
  STAGE_SIZE_STEP,
  STAGE_SIZE_PRESETS,
  THEME_OPTIONS,
  THEMES,
  WHEEL_FRICTION_OPTIONS,
  WHEEL_DIRECTION_OPTIONS,
  StoreController,
} from "../../state";
import { historyStateStore } from "../../document/history";
import { FloatingPanel } from "../primitives/floating-panel";
import { renderThemePreview } from "../theme-preview";

@customElement("flipcel-universal-panel")
export class FlipCelUniversalPanel extends FloatingPanel {
  @property({ type: Boolean }) aliasFixEnabled = false;
  @property({ type: Boolean }) historyWindowVisible = false;
  @property({ type: Boolean }) keyboardShortcutsVisible = false;

  private history = new StoreController(this, historyStateStore);
  private themeMode = new StoreController(this, themeModeStore);
  private wheelFriction = new StoreController(this, wheelFrictionStore);
  private wheelDirection = new StoreController(this, wheelDirectionStore);
  private quickShapeEnabled = new StoreController(this, quickShapeEnabledStore);
  private quickShapeCurveStyle = new StoreController(
    this,
    quickShapeCurveStyleStore,
  );
  private quickShapeHoldMs = new StoreController(this, quickShapeHoldMsStore);
  private stage = new StoreController(this, stageStore);

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      /* Wide enough for FloatingPanel masonry to settle into two columns. */
      --panel-width: 600px;
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

    .theme-chip-btn {
      width: 76px;
    }

    .theme-option {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: 100%;
      min-width: 0;
      padding: 2px 0;
      box-sizing: border-box;
    }

    .theme-preview {
      display: block;
      width: 36px;
      height: 28px;
      flex: 0 0 auto;
      border-radius: 6px;
      overflow: hidden;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
    }

    .theme-label {
      font-size: 12px;
      line-height: 1.1;
      font-weight: 600;
    }

    .qs-slider-labels {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: var(--flipcel-text-muted, #666);
      margin-top: 2px;
    }

    .qs-slider-labels[data-disabled] {
      opacity: 0.45;
    }
  `;

  private emit(name: string, detail?: unknown) {
    this.dispatchEvent(
      new CustomEvent(name, { detail, bubbles: true, composed: true })
    );
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
    // Keep thumb on the snapped value while dragging — don't rely on Lit re-render.
    if (Number(input.value) !== value) {
      input.value = String(value);
    }

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

  private renderStageSettings() {
    const { width, height, color } = this.stage.value;
    const sliderWidth = clampStageDimension(width);
    const sliderHeight = clampStageDimension(height);

    return html`
      <flipcel-panel-section title="Stage" data-interactive>
        <div class="stage-color-row">
          <span>Stage color</span>
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
        ${this.renderStageSizeSlider("width", "Width", width, sliderWidth)}
        ${this.renderStageSizeSlider("height", "Height", height, sliderHeight)}
      </flipcel-panel-section>
    `;
  }

  render() {
    return this.renderFloatingBlock(
      "Settings",
      html`
            <flipcel-panel-section data-interactive>
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
                <blocky-button
                  flat
                  ?active=${this.historyWindowVisible}
                  @click=${() => {
                    this.historyWindowVisible = !this.historyWindowVisible;
                    this.emit("history-window-toggle", this.historyWindowVisible);
                  }}
                  >History</blocky-button
                >
                <blocky-button
                  flat
                  ?active=${this.keyboardShortcutsVisible}
                  @click=${() => {
                    this.keyboardShortcutsVisible = !this.keyboardShortcutsVisible;
                    this.emit(
                      "keyboard-shortcuts-toggle",
                      this.keyboardShortcutsVisible,
                    );
                  }}
                  >Shortcuts</blocky-button
                >
              </div>
            </flipcel-panel-section>

            <flipcel-panel-section data-interactive>
              <div class="row">
                <blocky-button flat @click=${() => this.emit("flatten")}
                  >Flatten</blocky-button
                >
                <blocky-button flat negative @click=${() => this.emit("clear")}
                  >Clear</blocky-button
                >
              </div>
            </flipcel-panel-section>

            <flipcel-panel-section title="File" data-interactive>
              <div class="row">
                <blocky-button flat accent @click=${() => this.emit("doc-new")}
                  >New File</blocky-button
                >
                <blocky-button flat @click=${() => this.emit("doc-open")}
                  >Open</blocky-button
                >
                <blocky-button flat @click=${() => this.emit("doc-save")}
                  >Save JSON</blocky-button
                >
                <blocky-button
                  flat
                  @click=${() =>
                    this.dispatchEvent(
                      new CustomEvent("export-view-svg", { bubbles: true, composed: true }),
                    )}
                  >Export SVG</blocky-button
                >
              </div>
            </flipcel-panel-section>

            <flipcel-panel-section title="Animation Wheel" data-interactive>
              <label>
                <span>Friction</span>
                <div class="row">
                  ${WHEEL_FRICTION_OPTIONS.map(
                    (level) => html`
                      <blocky-button
                        flat
                        ?active=${this.wheelFriction.value === level}
                        @click=${() => this.wheelFriction.set(level)}
                        >${level.charAt(0).toUpperCase() + level.slice(1)}</blocky-button
                      >
                    `,
                  )}
                </div>
              </label>
              <label>
                <span>Direction</span>
                <div class="row">
                  ${WHEEL_DIRECTION_OPTIONS.map(
                    (direction) => html`
                      <blocky-button
                        flat
                        ?active=${this.wheelDirection.value === direction}
                        @click=${() => this.wheelDirection.set(direction)}
                        >${direction === "clockwise"
                          ? "Clockwise"
                          : "Counterclockwise"}</blocky-button
                      >
                    `,
                  )}
                </div>
              </label>
            </flipcel-panel-section>

            <flipcel-panel-section title="Quick Shape" data-interactive>
              <div class="toggle">
                <span>Quick Shape</span>
                <input
                  type="checkbox"
                  .checked=${this.quickShapeEnabled.value}
                  @change=${(e: Event) => {
                    this.quickShapeEnabled.set(
                      (e.target as HTMLInputElement).checked,
                    );
                  }}
                />
              </div>
              <label>
                <span>Hold delay: ${(this.quickShapeHoldMs.value / 1000).toFixed(1)}s</span>
                <input
                  type="range"
                  min=${QUICK_SHAPE_HOLD_MS_MIN}
                  max=${QUICK_SHAPE_HOLD_MS_MAX}
                  step="50"
                  .value=${String(this.quickShapeHoldMs.value)}
                  ?disabled=${!this.quickShapeEnabled.value}
                  @input=${(e: Event) => {
                    const ms = parseInt(
                      (e.target as HTMLInputElement).value,
                      10,
                    );
                    this.quickShapeHoldMs.set(clampQuickShapeHoldMs(ms));
                  }}
                />
              </label>
              <label>
                <span>Style</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  .value=${String(
                    Math.round(this.quickShapeCurveStyle.value * 100),
                  )}
                  ?disabled=${!this.quickShapeEnabled.value}
                  @input=${(e: Event) => {
                    const pct = parseInt(
                      (e.target as HTMLInputElement).value,
                      10,
                    );
                    this.quickShapeCurveStyle.set(
                      clampQuickShapeCurveStyle(pct / 100),
                    );
                  }}
                />
                <div
                  class="qs-slider-labels"
                  ?data-disabled=${!this.quickShapeEnabled.value}
                >
                  <span>Straight</span>
                  <span>Curvy</span>
                </div>
              </label>
            </flipcel-panel-section>

            ${this.renderStageSettings()}

            <flipcel-panel-section data-interactive>
              <flipcel-scroll-strip label="Theme" flush rows="2">
                ${THEME_OPTIONS.map(
                  (mode) => html`
                    <blocky-button
                      class="theme-chip-btn"
                      flat
                      ?active=${this.themeMode.value === mode}
                      @click=${() => this.themeMode.set(mode)}
                    >
                      <span class="theme-option">
                        ${renderThemePreview(mode)}
                        <span class="theme-label">${THEMES[mode].label}</span>
                      </span>
                    </blocky-button>
                  `,
                )}
              </flipcel-scroll-strip>
            </flipcel-panel-section>

            <flipcel-panel-section title="Alias Fix" data-interactive>
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
            </flipcel-panel-section>
      `,
    );
  }
}
