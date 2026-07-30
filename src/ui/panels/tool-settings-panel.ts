import { html, css, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { type ToolId, type SettingsSchema, type SettingDef, getTool } from "../../tools/registry";
import { paintModeAccent } from "../../tools/paint-mode";
import {
  toolStore,
  modifiersStore,
  toolSettingsStore,
  magicMoveUiStore,
  magicMorphUiStore,
  StoreController,
} from "../../state";
import { FloatingPanel } from "../primitives/floating-panel";
import { raisePanelZIndex } from "../primitives/panel-anchor";

// ============================================================
// Tool Settings Panel — normal floating panel (opened via tool double-tap)
// ============================================================

@customElement("flipcel-tool-settings-panel")
export class FlipCelToolSettingsPanel extends FloatingPanel {
  @property({ type: Number }) pixelRes = 2;
  @property({ type: Boolean, reflect: true }) override masonry = false;

  private tool = new StoreController(this, toolStore);
  private modifiers = new StoreController(this, modifiersStore);
  private settings = new StoreController(this, toolSettingsStore);
  private magicMoveUi = new StoreController(this, magicMoveUiStore);
  private magicMorphUi = new StoreController(this, magicMorphUiStore);

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      --panel-width: 280px;
      --panel-min-width: 220px;
    }
  `;

  private emit(name: string, detail?: unknown) {
    this.dispatchEvent(
      new CustomEvent(name, { detail, bubbles: true, composed: true }),
    );
  }

  private updateSetting(toolId: ToolId, key: string, value: unknown) {
    this.settings.update((s) => ({
      ...s,
      [toolId]: { ...s[toolId], [key]: value },
    }));
    this.emit("settings-change", this.settings.value);
  }

  /** Show beside an anchor (typically the tools rail). Not dock-toggled. */
  async showNear(anchor: HTMLElement) {
    this.style.display = "";
    await this.updateComplete;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    const gap = 10;
    const anchorRect = anchor.getBoundingClientRect();
    const panelRect = this.getBoundingClientRect();
    let left = anchorRect.right + gap;
    let top = anchorRect.top;

    if (left + panelRect.width > window.innerWidth - 8) {
      left = Math.max(8, anchorRect.left - panelRect.width - gap);
    }
    if (top + panelRect.height > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - panelRect.height - 8);
    }

    this.style.left = `${Math.round(left)}px`;
    this.style.top = `${Math.round(top)}px`;
    this.style.right = "auto";
    this.style.bottom = "auto";
    raisePanelZIndex(this);
    this.playShowAnimation();
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
    currentValue: unknown,
  ): TemplateResult {
    const hint =
      key === "mode" && this.modifiers.value.shift ? "(Shift toggled)" : "";
    const label = def.label ?? this.formatLabel(key);

    if (def.type === "toggle") {
      return html`
        <label>
          <span>${label} ${hint}</span>
          <div class="row">
            ${def.options.map((opt) => {
              const modeAccent = key === "mode" ? paintModeAccent(opt) : null;
              return html`
                <blocky-button
                  flat
                  ?active=${currentValue === opt}
                  ?positive=${modeAccent === "positive"}
                  ?negative=${modeAccent === "negative"}
                  ?neutral=${modeAccent === "neutral"}
                  @click=${() => this.updateSetting(toolId, key, opt)}
                  >${this.formatLabel(opt)}</blocky-button
                >
              `;
            })}
          </div>
        </label>
      `;
    }

    if (def.type === "range") {
      const valueLabel =
        def.maxLabel !== undefined && Number(currentValue) >= def.max
          ? def.maxLabel
          : currentValue;
      return html`
        <label>
          <span>${label}: ${valueLabel}</span>
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
                parseFloat((e.target as HTMLInputElement).value),
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

  private renderToolSettings(): TemplateResult {
    const currentToolId = this.tool.value;
    const currentTool = getTool(currentToolId);
    const toolSettings = this.settings.value[currentToolId] as Record<string, unknown>;
    const schema = currentTool.settings as SettingsSchema;

    let schemaKeys = Object.keys(schema);
    // Pixel resolution only affects tools that rasterize through the pixel
    // canvas before tracing; vector tools don't touch it.
    const showsPixelRes = currentToolId === "brush" || currentToolId === "lasso";

    if (currentToolId === "magic-move") {
      const timing = toolSettings.timing === "duration" ? "duration" : "step";
      schemaKeys = schemaKeys.filter((key) => {
        if (key === "step") return timing === "step";
        if (key === "duration") return timing === "duration";
        return true;
      });
    }

    if (schemaKeys.length === 0) {
      if (currentToolId === "select") {
        return html`<p class="hint">Click to select, drag to move.</p>`;
      }
      if (currentToolId === "pan") {
        return html`<p class="hint">Drag to pan, scroll to zoom.</p>`;
      }
      if (currentToolId === "direct-select") {
        return html`<p class="hint">Drag a rectangle or lasso to select vertices on the active layer.</p>`;
      }
      return showsPixelRes ? html`${this.renderPixelRes()}` : html``;
    }

    return html`
      ${schemaKeys.map((key) =>
        this.renderSetting(currentToolId, key, schema[key], toolSettings[key]),
      )}
      ${currentToolId === "eyedropper"
        ? html`<p class="hint">Click artwork to pick its color. “All” samples unlocked visible layers.</p>`
        : ""}
      ${currentToolId === "select"
        ? html`<p class="hint">Drag a rectangle or freeform lasso to extract a selection. “All” selects across unlocked visible layers.</p>`
        : ""}
      ${currentToolId === "magic-move"
        ? html`
            <p class="hint">
              Lasso a selection, then draw a trajectory with crossing timing
              ticks. When the chart is valid, an Apply popup appears. Esc clears
              the chart, then the selection.
            </p>
            <blocky-button
              flat
              accent
              stretch
              ?disabled=${!this.magicMoveUi.value.canApply}
              @click=${() => this.emit("magic-move-apply")}
              >Apply</blocky-button
            >
          `
        : ""}
      ${currentToolId === "magic-morph"
        ? html`
            <p class="hint">
              Playhead on a hold, then draw a trajectory with crossing timing
              ticks. Apply morphs to the next keyframe using chart ratios.
            </p>
            <blocky-button
              flat
              accent
              stretch
              ?disabled=${!this.magicMorphUi.value.canApply}
              @click=${() => this.emit("magic-morph-apply")}
              >Apply</blocky-button
            >
          `
        : ""}
      ${showsPixelRes ? this.renderPixelRes() : ""}
    `;
  }

  render() {
    const title = getTool(this.tool.value).name;
    return this.renderFloatingBlock(
      title,
      html`
        <flipcel-panel-section data-interactive>
          ${this.renderToolSettings()}
        </flipcel-panel-section>
      `,
    );
  }
}
