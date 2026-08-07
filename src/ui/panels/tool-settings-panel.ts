import { html, css, svg, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { type ToolId, type SettingsSchema, type SettingDef, getTool } from "../../tools/registry";
import { paintModeAccent } from "../../tools/paint-mode";
import { isBrushTip, type BrushTip } from "../../tools/brush";
import {
  toolStore,
  modifiersStore,
  toolSettingsStore,
  magicMoveUiStore,
  magicMorphUiStore,
  StoreController,
} from "../../state";
import {
  formatModifier,
  getModifierBinding,
  isPaintModeModifierHeld,
  shortcutsStore,
} from "../../input/shortcuts";
import { FloatingPanel } from "../primitives/floating-panel";
import { raisePanelZIndex } from "../primitives/panel-anchor";
import { getHelp, helpIdForTool } from "../help/catalog";

// ============================================================
// Tool Settings Panel — floating panel (opened via tool hold or double-tap)
// ============================================================

@customElement("flipcel-tool-settings-panel")
export class FlipCelToolSettingsPanel extends FloatingPanel {
  @property({ type: Number }) pixelRes = 2;
  @property({ type: Boolean, reflect: true }) override masonry = false;

  private tool = new StoreController(this, toolStore);
  private modifiers = new StoreController(this, modifiersStore);
  private settings = new StoreController(this, toolSettingsStore);
  private shortcuts = new StoreController(this, shortcutsStore);
  private magicMoveUi = new StoreController(this, magicMoveUiStore);
  private magicMorphUi = new StoreController(this, magicMorphUiStore);

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      --panel-width: 280px;
      --panel-min-width: 220px;
    }

    .tool-info {
      margin: 0 0 10px;
      padding: 8px 10px;
      border-radius: var(--flipcel-content-radius, 6px);
      background: color-mix(
        in srgb,
        var(--panel-accent, #4a6fb5) 16%,
        transparent
      );
      box-sizing: border-box;
    }

    .tool-info-body {
      margin: 0;
      font-size: 12px;
      font-weight: 500;
      line-height: 1.45;
      color: var(--flipcel-text-secondary, #333);
    }

    .setting-select {
      position: relative;
      width: 100%;
      min-width: 0;
    }

    .setting-select > summary {
      list-style: none;
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      box-sizing: border-box;
      margin: 0;
      padding: 5px 8px;
      border: none;
      border-radius: var(--flipcel-content-radius);
      background: var(--block-depth-color, #bcbcbc);
      color: var(--block-border, #555555);
      cursor: pointer;
      font: inherit;
      font-weight: 500;
      letter-spacing: var(--flipcel-letter-spacing, -0.011em);
      user-select: none;
    }

    .setting-select > summary::-webkit-details-marker {
      display: none;
    }

    .setting-select > summary:hover {
      filter: brightness(0.97);
    }

    .setting-select-menu {
      position: absolute;
      z-index: 40;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 4px;
      border-radius: var(--flipcel-content-radius);
      background: var(--block-face-bg, var(--flipcel-panel-surface, #383838));
      box-shadow: var(--flipcel-shadow-soft, 0 8px 20px rgba(0, 0, 0, 0.35));
      box-sizing: border-box;
    }

    .setting-select-option {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      margin: 0;
      padding: 5px 8px;
      border: none;
      border-radius: var(--flipcel-content-radius);
      background: transparent;
      color: var(--flipcel-text-primary, #f0f0f0);
      font: inherit;
      font-weight: 500;
      letter-spacing: var(--flipcel-letter-spacing, -0.011em);
      text-align: left;
      cursor: pointer;
      box-sizing: border-box;
    }

    .setting-select-option:hover,
    .setting-select-option[aria-selected="true"] {
      background: var(--block-depth-color, #bcbcbc);
      color: var(--block-border, #555555);
    }

    .tip-preview {
      flex: 0 0 auto;
      width: 18px;
      height: 18px;
      display: grid;
      place-items: center;
      color: currentColor;
    }

    .tip-preview svg {
      display: block;
      width: 16px;
      height: 16px;
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
    const paintMod = getModifierBinding("mod.paintMode", this.shortcuts.value);
    const hint =
      key === "mode" && isPaintModeModifierHeld(this.modifiers.value)
        ? `(${formatModifier(paintMod)} toggled)`
        : "";
    const label = def.label ?? this.formatLabel(key);

    if (def.type === "toggle") {
      return html`
        <label>
          <span>${label} ${hint}</span>
          <div class="row">
            ${def.options.map((opt) => {
              const selected = currentValue === opt;
              const modeAccent =
                key === "mode" && selected ? paintModeAccent(opt) : null;
              return html`
                <blocky-button
                  flat
                  ?active=${selected}
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

    if (def.type === "select") {
      const selected = String(currentValue ?? def.default);
      const showTipPreview = key === "tip";
      return html`
        <label>
          <span>${label}</span>
          <details
            class="setting-select"
            @toggle=${(e: Event) => {
              const el = e.currentTarget as HTMLDetailsElement;
              if (!el.open) return;
              // One open select at a time inside this panel.
              this.renderRoot
                .querySelectorAll<HTMLDetailsElement>("details.setting-select")
                .forEach((other) => {
                  if (other !== el) other.open = false;
                });
            }}
          >
            <summary>
              ${showTipPreview ? this.renderTipPreview(selected) : nothing}
              <span>${this.formatLabel(selected)}</span>
            </summary>
            <div class="setting-select-menu" role="listbox">
              ${def.options.map((opt) => {
                const isSelected = selected === opt;
                return html`
                  <button
                    type="button"
                    class="setting-select-option"
                    role="option"
                    aria-selected=${isSelected ? "true" : "false"}
                    @click=${(e: Event) => {
                      this.updateSetting(toolId, key, opt);
                      const details = (e.currentTarget as HTMLElement).closest(
                        "details",
                      ) as HTMLDetailsElement | null;
                      if (details) details.open = false;
                    }}
                  >
                    ${showTipPreview ? this.renderTipPreview(opt) : nothing}
                    <span>${this.formatLabel(opt)}</span>
                  </button>
                `;
              })}
            </div>
          </details>
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

  private renderTipPreview(value: string): TemplateResult | typeof nothing {
    if (!isBrushTip(value)) return nothing;
    return html`<span class="tip-preview" aria-hidden="true"
      >${this.tipPreviewSvg(value)}</span
    >`;
  }

  private tipPreviewSvg(tip: BrushTip): TemplateResult {
    switch (tip) {
      case "square":
        return svg`<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1"/></svg>`;
      case "ellipse":
        return svg`<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><ellipse cx="8" cy="8" rx="6.5" ry="3.6"/></svg>`;
      case "diag":
        return svg`<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="1.5" y="7" width="13" height="2" rx="1" transform="rotate(-45 8 8)"/></svg>`;
      default:
        return svg`<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="8" r="5.2"/></svg>`;
    }
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
      return showsPixelRes ? html`${this.renderPixelRes()}` : html``;
    }

    return html`
      ${schemaKeys.map((key) =>
        this.renderSetting(currentToolId, key, schema[key], toolSettings[key]),
      )}
      ${currentToolId === "fill"
        ? (() => {
            const algo =
              toolSettings.algorithm === "vector" ? "vector" : "screen";
            return algo === "vector"
              ? html`<p class="hint">Vector: click a shape to recolor, or an enclosed empty pocket to fill. Fill gap morph-closes outline openings up to that width (zoom-relative). Regions open to the view edge won’t fill.</p>`
              : html`<p class="hint">Screen: click a chamber — inside a fill or empty space — to replace it. Fill gap stops spill through openings in empty pockets, and on existing strokes splits arms at crossings so one branch can be recolored.</p>`;
          })()
        : ""}
      ${currentToolId === "eyedropper"
        ? html`<p class="hint">“All” samples unlocked visible layers.</p>`
        : ""}
      ${currentToolId === "select"
        ? html`<p class="hint">“All” selects across unlocked visible layers.</p>`
        : ""}
      ${currentToolId === "magic-move"
        ? html`
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
    const help = getHelp(helpIdForTool(this.tool.value));
    return this.renderFloatingBlock(
      title,
      html`
        ${help
          ? html`
              <div class="tool-info">
                <p class="tool-info-body">${help.body}</p>
              </div>
            `
          : ""}
        <flipcel-panel-section data-interactive>
          ${this.renderToolSettings()}
        </flipcel-panel-section>
      `,
    );
  }
}
