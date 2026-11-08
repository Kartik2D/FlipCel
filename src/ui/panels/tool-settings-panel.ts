import { html, css, svg, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { type ToolId, type SettingsSchema, type SettingDef, type RangeSetting, getTool } from "../../tools/registry";
import { paintModeAccent } from "../../tools/paint-mode";
import { isBrushTip, type BrushTip } from "../../tools/brush";
import { isShapeKind, shapeUnitOutline, shapeUsesPoints, type ShapeKind } from "../../tools/shape";
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
  /** Which brush-size handle is being dragged, so it stays above the other. */
  @state() private brushSizeDrag: "min" | "max" | null = null;

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

    .shape-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 6px;
      width: 100%;
      min-width: 0;
    }

    .shape-cell {
      appearance: none;
      display: grid;
      place-items: center;
      aspect-ratio: 1;
      margin: 0;
      padding: 4px;
      border: none;
      border-radius: var(--flipcel-content-radius);
      background: var(--block-depth-color, #bcbcbc);
      color: var(--block-border, #555555);
      cursor: pointer;
    }

    .shape-cell:hover {
      filter: brightness(0.97);
    }

    .shape-cell[active] {
      background: var(--flipcel-accent, #4a6fb5);
      color: var(--flipcel-accent-contrast, #ffffff);
    }

    .shape-cell svg {
      display: block;
      width: 68%;
      height: 68%;
    }

    /* Brush size: one track, min and max handles. Thumbs match the range inputs. */
    .range-pair {
      position: relative;
      height: 28px;
      touch-action: none;
      cursor: pointer;
    }

    .range-pair-track {
      position: absolute;
      left: 11px;
      right: 11px;
      top: 50%;
      height: 6px;
      transform: translateY(-50%);
      border-radius: 999px;
      background: var(--panel-track-bg);
    }

    .range-pair-fill {
      position: absolute;
      top: 0;
      bottom: 0;
      border-radius: 999px;
      background: var(--panel-accent);
    }

    .range-pair-thumb {
      position: absolute;
      top: 50%;
      width: 22px;
      height: 22px;
      margin: 0;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: var(--panel-accent);
      transform: translate(-50%, -50%);
      cursor: pointer;
    }

    .range-pair-thumb:hover,
    .range-pair-thumb[active] {
      background: var(--panel-accent-hover);
      z-index: 2;
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
    this.updateSettings(toolId, { [key]: value });
  }

  private updateSettings(toolId: ToolId, patch: Record<string, unknown>) {
    this.settings.update((s) => ({
      ...s,
      [toolId]: { ...s[toolId], ...patch },
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
      const preview = this.previewKind(def.options);
      if (preview) {
        return html`
          <label>
            <span>${label}</span>
            ${this.renderShapeGrid(toolId, key, def.options, selected, preview)}
          </label>
        `;
      }
      return html`
        <label>
          <span>${label}</span>
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

  /** Brush tips and the shape catalog get a preview grid instead of a menu. */
  private previewKind(options: readonly string[]): "tip" | "shape" | null {
    if (options.length > 0 && options.every((opt) => isBrushTip(opt))) return "tip";
    if (options.length > 0 && options.every((opt) => isShapeKind(opt))) return "shape";
    return null;
  }

  private renderShapeGrid(
    toolId: ToolId,
    key: string,
    options: readonly string[],
    selected: string,
    kind: "tip" | "shape",
  ): TemplateResult {
    const points = this.shapePoints(toolId);
    return html`
      <div class="shape-grid">
        ${options.map((opt) => {
          const name = this.formatLabel(opt);
          return html`
            <button
              type="button"
              class="shape-cell"
              title=${name}
              aria-label=${name}
              aria-pressed=${selected === opt ? "true" : "false"}
              ?active=${selected === opt}
              @click=${() => this.updateSetting(toolId, key, opt)}
            >
              ${kind === "tip" && isBrushTip(opt)
                ? this.tipPreviewSvg(opt)
                : isShapeKind(opt)
                  ? this.shapePreviewSvg(opt, points)
                  : nothing}
            </button>
          `;
        })}
      </div>
    `;
  }

  private shapePoints(toolId: ToolId): number {
    const settings = this.settings.value[toolId] as { points?: unknown } | undefined;
    const n = settings?.points;
    return typeof n === "number" && Number.isFinite(n) ? n : 5;
  }

  private formatLabel(key: string): string {
    return key
      .replace(/([A-Z])/g, " $1")
      .replace(/^./, (str) => str.toUpperCase())
      .trim();
  }

  private shapePreviewSvg(kind: ShapeKind, points: number): TemplateResult {
    if (kind === "circle") return this.tipPreviewSvg("circle");
    if (kind === "rect") {
      return svg`<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="2.4" y="3.4" width="11.2" height="9.2" rx="1"/></svg>`;
    }
    if (kind === "roundRect") {
      return svg`<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="2.2" y="3.2" width="11.6" height="9.6" rx="2.6"/></svg>`;
    }
    const verts = shapeUnitOutline(kind, points);
    if (!verts || verts.length === 0) return this.tipPreviewSvg("circle");
    const d =
      verts
        .map(([x, y], i) => {
          const px = (8 + x * 5.4).toFixed(2);
          const py = (8 + y * 5.4).toFixed(2);
          return `${i === 0 ? "M" : "L"}${px} ${py}`;
        })
        .join(" ") + " Z";
    return svg`<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d=${d} /></svg>`;
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

  private formatRangeValue(n: number, step: number): string {
    const digits = step < 1 ? 1 : 0;
    return String(Number(n.toFixed(digits)));
  }

  private snapRange(value: number, min: number, max: number, step: number): number {
    const steps = Math.round((value - min) / step);
    const snapped = Number((min + steps * step).toFixed(step < 1 ? 1 : 0));
    return Math.min(max, Math.max(min, snapped));
  }

  /** Brush pressure range: sizeMin and sizeMax share one track. */
  private renderBrushSizeRange(
    toolId: ToolId,
    minDef: RangeSetting,
    maxDef: RangeSetting,
    toolSettings: Record<string, unknown>,
  ): TemplateResult {
    const lo = Number(toolSettings.sizeMin ?? minDef.default);
    const hi = Number(toolSettings.sizeMax ?? maxDef.default);
    const span = minDef.max - minDef.min || 1;
    const loT = (lo - minDef.min) / span;
    const hiT = (hi - minDef.min) / span;
    const thumb = (end: "min" | "max", t: number, value: number) => html`
      <button
        type="button"
        class="range-pair-thumb"
        style="left: calc(11px + ${t} * (100% - 22px))"
        role="slider"
        aria-label=${end === "min" ? "Minimum size" : "Maximum size"}
        aria-valuemin=${end === "min" ? minDef.min : lo}
        aria-valuemax=${end === "min" ? hi : maxDef.max}
        aria-valuenow=${value}
        ?active=${this.brushSizeDrag === end}
        @keydown=${(e: KeyboardEvent) =>
          this.nudgeBrushSize(e, toolId, end, minDef, lo, hi)}
      ></button>
    `;
    return html`
      <label>
        <span>Size: ${this.formatRangeValue(lo, minDef.step)}–${this.formatRangeValue(hi, maxDef.step)}</span>
        <div
          class="range-pair"
          data-interactive
          @pointerdown=${(e: PointerEvent) =>
            this.onBrushSizeDown(e, toolId, minDef, lo, hi)}
        >
          <div class="range-pair-track">
            <div
              class="range-pair-fill"
              style="left:${loT * 100}%;width:${Math.max(0, hiT - loT) * 100}%"
            ></div>
          </div>
          ${thumb("min", loT, lo)}
          ${thumb("max", hiT, hi)}
        </div>
      </label>
    `;
  }

  private nudgeBrushSize(
    e: KeyboardEvent,
    toolId: ToolId,
    end: "min" | "max",
    def: RangeSetting,
    lo: number,
    hi: number,
  ) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const delta = def.step * (e.shiftKey ? 10 : 1) * dir;
    const next = this.snapRange((end === "min" ? lo : hi) + delta, def.min, def.max, def.step);
    if (end === "min") {
      this.updateSettings(toolId, { sizeMin: Math.min(next, hi) });
    } else {
      this.updateSettings(toolId, { sizeMax: Math.max(next, lo) });
    }
  }

  private onBrushSizeDown(
    e: PointerEvent,
    toolId: ToolId,
    def: RangeSetting,
    lo: number,
    hi: number,
  ) {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    const end = this.pickBrushSizeEnd(e, el, def, lo, hi);
    el.setPointerCapture(e.pointerId);
    this.brushSizeDrag = end;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      this.applyBrushSize(ev, el, toolId, def, end);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      this.brushSizeDrag = null;
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    this.applyBrushSize(e, el, toolId, def, end);
  }

  private pickBrushSizeEnd(
    e: PointerEvent,
    el: HTMLElement,
    def: RangeSetting,
    lo: number,
    hi: number,
  ): "min" | "max" {
    const value = this.brushSizeValue(e, el, def);
    const dMin = Math.abs(value - lo);
    const dMax = Math.abs(value - hi);
    if (Math.abs(dMin - dMax) <= def.step) {
      const mid = (lo + hi) / 2;
      return value < mid ? "min" : "max";
    }
    return dMin <= dMax ? "min" : "max";
  }

  private brushSizeValue(e: PointerEvent, el: HTMLElement, def: RangeSetting): number {
    const rect = el.getBoundingClientRect();
    const track = Math.max(1, rect.width - 22);
    const t = Math.max(0, Math.min(1, (e.clientX - rect.left - 11) / track));
    return def.min + t * (def.max - def.min);
  }

  private applyBrushSize(
    e: PointerEvent,
    el: HTMLElement,
    toolId: ToolId,
    def: RangeSetting,
    end: "min" | "max",
  ) {
    const settings = this.settings.value[toolId] as { sizeMin?: unknown; sizeMax?: unknown };
    const lo = Number(settings.sizeMin ?? def.min);
    const hi = Number(settings.sizeMax ?? def.max);
    const value = this.snapRange(this.brushSizeValue(e, el, def), def.min, def.max, def.step);
    if (end === "min") {
      this.updateSettings(toolId, { sizeMin: Math.min(value, hi) });
    } else {
      this.updateSettings(toolId, { sizeMax: Math.max(value, lo) });
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
      ${schemaKeys.map((key) => {
        const minDef = schema.sizeMin;
        const maxDef = schema.sizeMax;
        if (
          key === "sizeMax" &&
          minDef?.type === "range" &&
          maxDef?.type === "range"
        ) {
          return nothing;
        }
        if (
          key === "sizeMin" &&
          minDef?.type === "range" &&
          maxDef?.type === "range"
        ) {
          return this.renderBrushSizeRange(
            currentToolId,
            minDef,
            maxDef,
            toolSettings,
          );
        }
        return this.renderSetting(currentToolId, key, schema[key], toolSettings[key]);
      })}
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
