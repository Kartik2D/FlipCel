import { html, css, svg, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { type ToolId, type SettingsSchema, type SettingDef, getTool } from "../../tools/registry";
import { paintModeAccent } from "../../tools/paint-mode";
import { isBrushTip, type BrushTip } from "../../tools/brush";
import { isShapeKind, shapeUsesPoints } from "../../tools/shape";
import {
  ARTISTIC_TEXT_FONT_FILE,
  ARTISTIC_TEXT_FONTS,
  artisticTextFontStore,
  pickAndLoadArtisticTextFont,
  selectArtisticTextFont,
} from "../../tools/artistic-text-font";
import {
  toolStore,
  modifiersStore,
  toolSettingsStore,
  magicMoveUiStore,
  magicMorphUiStore,
  selectionStore,
  pixelResScaleStore,
  clampPixelResScale,
  PIXEL_RES_MIN,
  PIXEL_RES_MAX,
  StoreController,
} from "../../state";
import { selectionClipboardStore } from "../../editing/selection-clipboard";
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
  @property({ type: Boolean, reflect: true }) override masonry = false;
  @state() private pixelResDraft: number | null = null;

  private tool = new StoreController(this, toolStore);
  private pixelRes = new StoreController(this, pixelResScaleStore);
  private modifiers = new StoreController(this, modifiersStore);
  private settings = new StoreController(this, toolSettingsStore);
  private shortcuts = new StoreController(this, shortcutsStore);
  private magicMoveUi = new StoreController(this, magicMoveUiStore);
  private magicMorphUi = new StoreController(this, magicMorphUiStore);
  private selection = new StoreController(this, selectionStore);
  private selectionClipboard = new StoreController(this, selectionClipboardStore);
  private artisticTextFont = new StoreController(this, artisticTextFontStore);

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

    .tip-select {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .tip-select select {
      flex: 1 1 auto;
    }

    .tip-preview {
      flex: 0 0 auto;
      width: 22px;
      height: 22px;
      display: grid;
      place-items: center;
      border-radius: var(--flipcel-content-radius);
      background: var(--block-depth-color, #bcbcbc);
      color: var(--block-border, #555555);
    }

    .tip-preview svg {
      display: block;
      width: 14px;
      height: 14px;
    }

    .select-clipboard-actions {
      display: flex;
      gap: 8px;
      margin-top: 4px;
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
    // Apply on `change` (release), not `input`. Each write rebuilds canvases.
    const value = this.pixelResDraft ?? this.pixelRes.value;
    return html`
      <label>
        <span>Pixel resolution: ${value}x</span>
        <input
          type="range"
          min=${PIXEL_RES_MIN}
          max=${PIXEL_RES_MAX}
          step="1"
          .value=${String(value)}
          @input=${(e: Event) => {
            this.pixelResDraft = clampPixelResScale(
              parseInt((e.target as HTMLInputElement).value, 10),
            );
          }}
          @change=${(e: Event) => {
            pixelResScaleStore.set(
              clampPixelResScale(
                parseInt((e.target as HTMLInputElement).value, 10),
              ),
            );
            this.pixelResDraft = null;
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
    const dockKey = getTool(toolId).dockModeSetting;
    const isDockMode = key === dockKey;
    const modHeld = isDockMode && isPaintModeModifierHeld(this.modifiers.value);
    const hint = modHeld ? `(${formatModifier(paintMod)} toggled)` : "";
    const label = def.label ?? this.formatLabel(key);

    if (def.type === "toggle") {
      const options = def.options as readonly string[];
      const effectiveValue = modHeld
        ? options[(options.indexOf(String(currentValue)) + 1) % options.length]
        : currentValue;
      return html`
        <label>
          <span>${label} ${hint}</span>
          <div class="row">
            ${options.map((opt) => {
              const selected = effectiveValue === opt;
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
      const select = html`
        <select
          .value=${selected}
          @change=${(e: Event) =>
            this.updateSetting(
              toolId,
              key,
              (e.target as HTMLSelectElement).value,
            )}
        >
          ${def.options.map(
            (opt) =>
              html`<option value=${opt} ?selected=${selected === opt}>
                ${this.formatLabel(opt)}
              </option>`,
          )}
        </select>
      `;
      return html`
        <label>
          <span>${label}</span>
          ${key === "tip"
            ? html`<div class="tip-select">
                ${this.renderTipPreview(selected)}${select}
              </div>`
            : select}
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

    if (def.type === "checkbox") {
      return html`
        <div class="toggle">
          <span>${label}</span>
          <input
            type="checkbox"
            .checked=${Boolean(currentValue)}
            @change=${(e: Event) =>
              this.updateSetting(
                toolId,
                key,
                (e.target as HTMLInputElement).checked,
              )}
          />
        </div>
      `;
    }

    return html``;
  }

  private renderArtisticTextFont(): TemplateResult {
    const current = this.artisticTextFont.value;
    const isPreset = ARTISTIC_TEXT_FONTS.some((f) => f.family === current.family);
    const selected = isPreset ? current.family : ARTISTIC_TEXT_FONT_FILE;
    return html`
      <label>
        <span>Font</span>
        <select
          .value=${selected}
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            if (value === ARTISTIC_TEXT_FONT_FILE) {
              void pickAndLoadArtisticTextFont().catch((err) => {
                console.error("Font load failed:", err);
              });
              return;
            }
            void selectArtisticTextFont(value).catch((err) => {
              console.error("Font load failed:", err);
            });
          }}
        >
          ${ARTISTIC_TEXT_FONTS.map(
            (f) =>
              html`<option value=${f.family} ?selected=${selected === f.family}>
                ${f.label}
              </option>`,
          )}
          <option
            value=${ARTISTIC_TEXT_FONT_FILE}
            ?selected=${selected === ARTISTIC_TEXT_FONT_FILE}
          >
            ${isPreset ? "From file…" : current.label}
          </option>
        </select>
      </label>
    `;
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
    const showsPixelRes = currentToolId === "brush" || currentToolId === "lasso";

    if (currentToolId === "magic-move") {
      const timing = toolSettings.timing === "duration" ? "duration" : "step";
      schemaKeys = schemaKeys.filter((key) => {
        if (key === "step") return timing === "step";
        if (key === "duration") return timing === "duration";
        return true;
      });
    }

    if (currentToolId === "shape") {
      const kind = isShapeKind(toolSettings.shape) ? toolSettings.shape : "circle";
      if (!shapeUsesPoints(kind)) {
        schemaKeys = schemaKeys.filter((key) => key !== "points");
      }
    }

    if (
      currentToolId === "lasso" ||
      currentToolId === "shape" ||
      currentToolId === "create-points"
    ) {
      if (toolSettings.style !== "stroke") {
        schemaKeys = schemaKeys.filter(
          (key) => key !== "width" && key !== "scaleWithStage",
        );
      }
    }

    if (schemaKeys.length === 0 && currentToolId !== "artistic-text") {
      return showsPixelRes ? html`${this.renderPixelRes()}` : html``;
    }

    return html`
      ${schemaKeys.map((key) =>
        this.renderSetting(currentToolId, key, schema[key], toolSettings[key]),
      )}
      ${currentToolId === "artistic-text" ? this.renderArtisticTextFont() : ""}
      ${currentToolId === "select"
        ? html`
            <div class="select-clipboard-actions">
              <blocky-button
                flat
                stretch
                ?disabled=${this.selection.value.count === 0}
                @click=${() => this.emit("select-copy")}
                >Copy</blocky-button
              >
              <blocky-button
                flat
                stretch
                ?disabled=${!this.selectionClipboard.value}
                @click=${() => this.emit("select-paste")}
                >Paste</blocky-button
              >
            </div>
          `
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
        <flipcel-panel-section title="Settings" data-interactive>
          ${this.renderToolSettings()}
        </flipcel-panel-section>
      `,
    );
  }
}
