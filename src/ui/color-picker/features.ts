import { html, css, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { customElement, property, state } from "lit/decorators.js";
import {
  colorStore,
  prevColorStore,
  colorPanelPrefsStore,
  documentColorsStore,
  normalizeColorPanelPrefs,
  StoreController,
  type ColorPanelPrefs,
} from "../../state";
import { FloatingPanel } from "../primitives/floating-panel";
import { PopupWindow } from "../primitives/popup-window";

// ============================================================
// Color Panel (generic configurable picker)
// ============================================================

/** Each entry fixes colour space, geometry, and plane axes for the picker. */
interface PickerVariant {
  id: string;
  label: string;
  prefs: ColorPanelPrefs;
}

const PICKER_VARIANTS: PickerVariant[] = [
  {
    id: "hsv1",
    label: "hsv1",
    prefs: { space: "hsv", geometry: "square", planeX: "s", planeY: "v" },
  },
  {
    id: "okhsl1",
    label: "okhsl1",
    prefs: { space: "okhsl", geometry: "circle", planeX: "h", planeY: "s" },
  },
  {
    id: "okhsl2",
    label: "okhsl2",
    prefs: { space: "okhsl", geometry: "square", planeX: "h", planeY: "l" },
  },
];

function parseHexColor(raw: string, allowShort = false): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hex = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (/^#[0-9a-f]{6}$/i.test(hex)) return hex.toLowerCase();
  if (allowShort && /^#[0-9a-f]{3}$/i.test(hex)) {
    const r = hex[1];
    const g = hex[2];
    const b = hex[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

function exactVariantId(prefs: ColorPanelPrefs): string {
  return (
    PICKER_VARIANTS.find(
      (v) =>
        v.prefs.space === prefs.space &&
        v.prefs.geometry === prefs.geometry &&
        v.prefs.planeX === prefs.planeX &&
        v.prefs.planeY === prefs.planeY,
    )?.id ?? ""
  );
}

const colorPickerSharedStyles = css`
  .panel-body > .face {
    overflow: hidden;
  }

  .panel-body .panel-form {
    height: 100%;
    min-height: 0;
    gap: 10px;
  }

  /* Picker variants plus Palette, one equal-width tab row. */
  .variant-tabs {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
    width: 100%;
    min-width: 0;
  }

  .variant-tabs > blocky-button {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    --block-face-padding: 5px 2px;
  }

  .picker-wrap {
    width: 100%;
    min-width: 0;
    min-height: 0;
  }

  .hex-input {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    font: inherit;
    font-variant-numeric: tabular-nums;
    padding: 5px 8px;
    margin: 0;
    border: none;
    border-radius: var(--flipcel-content-radius);
    background-color: var(--block-depth-color, #bcbcbc);
    color: var(--block-border, #555555);
  }

  .hex-input:focus {
    outline: none;
    box-shadow: 0 0 0 2px var(--panel-accent-muted, rgba(74, 111, 181, 0.35));
  }

  .doc-colors-header {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: 0;
    min-width: 0;
  }

  .doc-colors-header h3 {
    margin: 0;
    flex: 1 1 auto;
    min-width: 0;
  }

  .swatches-wrap {
    flex: 0 0 auto;
    width: 100%;
    min-width: 0;
  }

  .swatches-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    min-height: var(--picker-slider-width);
  }

  .swatch {
    appearance: none;
    display: block;
    width: var(--picker-slider-width);
    height: var(--picker-slider-width);
    flex: 0 0 var(--picker-slider-width);
    padding: 0;
    border-radius: var(--flipcel-content-radius);
    border: var(--picker-border-width) solid var(--picker-border-color);
    box-sizing: border-box;
    overflow: hidden;
    cursor: pointer;
  }

  .swatch:hover {
    filter: brightness(1.05);
  }

  .swatch[active] {
    box-shadow: inset 0 0 0 3px var(--panel-accent);
  }

  /* Palette tab fills the picker slot. Swatches scroll inside it. */
  .palette-view {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--flipcel-space-2, 8px);
    box-sizing: border-box;
    border-radius: var(--flipcel-content-radius);
    background: var(
      --flipcel-panel-inset-bg,
      color-mix(
        in srgb,
        var(--flipcel-panel-depth, #d4d4d4) 45%,
        var(--block-face-bg, var(--flipcel-panel-surface, #ffffff))
      )
    );
    padding: var(--flipcel-space-2, 8px);
    overflow: hidden;
  }

  .palette-view .swatches-wrap {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }

  .palette-view .swatches-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(32px, 1fr));
    gap: 6px;
    align-content: start;
  }

  .palette-view .swatch {
    width: 100%;
    height: auto;
    aspect-ratio: 1;
    flex: none;
  }

  .palette-empty {
    margin: 0;
    color: var(--flipcel-text-muted, #666);
    font-style: italic;
  }
`;

type PanelConstructor = abstract new (...args: any[]) => FloatingPanel;

function ColorPickerFeatures<T extends PanelConstructor>(Base: T) {
  abstract class ColorPickerFeaturesClass extends Base {
    constructor(...args: any[]) {
      super(...args);
    }

    @property({ type: String }) color = "#037ffc";
    @state() protected prevColor = "#000000";
    /** When on, picker changes remap the selected document color everywhere. */
    @state() private recolorEnabled = false;
    /** Main panel tab. Picker prefs stay put so leaving Palette restores the variant. */
    @state() private paletteOpen = false;
    /** Document swatch hex currently targeted by Recolor (fixed during a drag). */
    @state() private recolorFrom: string | null = null;
    private hexFocused = false;
    private hexDraft = "";

    protected pickerPrefs = new StoreController(this, colorPanelPrefsStore);
    protected documentColors = new StoreController(this, documentColorsStore);
    private unsubscribeColor?: () => void;
    private unsubscribePrevColor?: () => void;

    connectedCallback() {
      super.connectedCallback();
      this.unsubscribeColor = colorStore.subscribe((c) => {
        if (this.color !== c) this.color = c;
      });
      this.unsubscribePrevColor = prevColorStore.subscribe((p) => {
        this.prevColor = p;
      });

      /* If persisted prefs don't match any of the new variants (legacy HSV/HSL
         state), snap to the first variant so the UI isn't inconsistent. */
      const prefs = colorPanelPrefsStore.get();
      if (!exactVariantId(prefs)) {
        colorPanelPrefsStore.set(normalizeColorPanelPrefs({ ...PICKER_VARIANTS[0].prefs }));
      }
    }

    disconnectedCallback() {
      super.disconnectedCallback();
      this.unsubscribeColor?.();
      this.unsubscribePrevColor?.();
    }

    protected emitColorEvent(name: string, detail?: unknown) {
      this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
    }

    private onVariantChange(id: string) {
      this.paletteOpen = false;
      const variant = PICKER_VARIANTS.find((v) => v.id === id);
      if (!variant) return;
      colorPanelPrefsStore.set(normalizeColorPanelPrefs({ ...variant.prefs }));
    }

    private toggleRecolor() {
      this.recolorEnabled = !this.recolorEnabled;
      if (!this.recolorEnabled) {
        this.recolorFrom = null;
        this.emitColorEvent("document-recolor-cancel");
        return;
      }
      const hex = this.color.trim().toLowerCase();
      if (this.documentColors.value.some((c) => c === hex)) {
        this.recolorFrom = hex;
      }
    }

    private selectSwatch(color: string) {
      const hex = color.trim().toLowerCase();
      this.color = hex;
      this.recolorFrom = hex;
      colorStore.set(hex);
      prevColorStore.set(hex);
      // Selecting a swatch only targets it — do not remap the document yet.
      this.emitColorEvent("color-change", hex);
      this.emitColorEvent("color-change-end", hex);
    }

    private emitPickerColor(color: string, end: boolean) {
      const from = this.recolorEnabled ? this.recolorFrom : null;
      if (from && from !== color.trim().toLowerCase()) {
        this.emitColorEvent(end ? "document-recolor-end" : "document-recolor", {
          from,
          to: color,
        });
        if (end) this.recolorFrom = color.trim().toLowerCase();
        return;
      }
      this.emitColorEvent(end ? "color-change-end" : "color-change", color);
    }

    private applyHex(raw: string, end: boolean): boolean {
      const hex = parseHexColor(raw, end);
      if (!hex) return false;
      this.color = hex;
      colorStore.set(hex);
      this.emitPickerColor(hex, end);
      if (end) prevColorStore.set(hex);
      return true;
    }

    private commitHex() {
      this.applyHex(this.hexDraft, true);
      this.hexFocused = false;
      this.requestUpdate();
    }

    private renderHexField() {
      return html`
        <input
          class="hex-input"
          type="text"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          maxlength="7"
          aria-label="Hex color"
          data-interactive
          .value=${this.hexFocused ? this.hexDraft : this.color}
          @focus=${(e: Event) => {
            this.hexFocused = true;
            this.hexDraft = this.color;
            (e.target as HTMLInputElement).select();
          }}
          @input=${(e: Event) => {
            this.hexDraft = (e.target as HTMLInputElement).value;
            this.applyHex(this.hexDraft, false);
          }}
          @blur=${() => this.commitHex()}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      `;
    }

    private renderSwatchGrid() {
      const colors = this.documentColors.value;
      if (colors.length === 0) {
        return html`<p class="palette-empty">No document colors yet</p>`;
      }
      const activeColor = this.color.trim().toLowerCase();
      return html`
        <div class="swatches-grid">
          ${repeat(
            colors,
            (color) => color,
            (color) => html`
              <button
                type="button"
                class="swatch"
                style="background:${color}"
                title=${color}
                ?active=${color === activeColor}
                @click=${() => this.selectSwatch(color)}
              ></button>
            `,
          )}
        </div>
      `;
    }

    private renderDocColorsHeader() {
      const showRecolor = this.showDocumentColorRecolor();
      return html`
        <div class="doc-colors-header">
          <h3>Document Colors</h3>
          ${showRecolor
            ? html`
                <blocky-button
                  flat
                  ?active=${this.recolorEnabled}
                  title=${this.recolorEnabled
                    ? "Recolor on. Changing the picker remaps the selected document color everywhere"
                    : "Recolor off. Select a document color, then enable to remap it"}
                  @click=${() => this.toggleRecolor()}
                  >Recolor</blocky-button
                >
              `
            : nothing}
        </div>
      `;
    }

    /** Stage popup: swatches under the picker. */
    private renderSwatches() {
      return html`
        <flipcel-panel-section data-interactive>
          ${this.renderDocColorsHeader()}
          <div class="swatches-wrap">${this.renderSwatchGrid()}</div>
        </flipcel-panel-section>
      `;
    }

    /** Main panel Palette tab: document colors fill the picker slot. */
    private renderPalette() {
      return html`
        <div class="palette-view" data-interactive>
          ${this.renderDocColorsHeader()}
          <div class="swatches-wrap">${this.renderSwatchGrid()}</div>
        </div>
      `;
    }

    protected renderColorPickerContent() {
      const prefs = this.pickerPrefs.value;
      const activeVariant = exactVariantId(prefs) || PICKER_VARIANTS[0].id;
      const showVariantTabs = this.showPickerVariantTabs();
      const showPalette = showVariantTabs && this.paletteOpen;
      /* Popup has no tabs, so document colors stay under the picker. */
      const showDocumentSwatches = !showVariantTabs && this.showDocumentColorSwatches();
      const variantTabs = html`
        <div class="variant-tabs">
          ${PICKER_VARIANTS.map(
            (v) => html`
              <blocky-button
                flat
                stretch
                ?active=${!this.paletteOpen && v.id === activeVariant}
                @click=${() => this.onVariantChange(v.id)}
                >${v.label}</blocky-button
              >
            `,
          )}
          <blocky-button
            flat
            stretch
            ?active=${this.paletteOpen}
            @click=${() => {
              this.paletteOpen = true;
            }}
            >palette</blocky-button
          >
        </div>
      `;

      return html`
        ${showVariantTabs
          ? this.mini
            ? variantTabs
            : html`
                <flipcel-panel-section title="Picker" data-interactive>
                  ${variantTabs}
                </flipcel-panel-section>
              `
          : nothing}
        ${showPalette
          ? this.renderPalette()
          : html`
              <div class="picker-wrap">
                <generic-color-picker
                  .color=${this.color}
                  .prevColor=${this.prevColor}
                  .prefs=${prefs}
                  @input=${(e: CustomEvent<{ value: string }>) => {
                    this.emitPickerColor(e.detail.value, false);
                  }}
                  @change=${(e: CustomEvent<{ value: string }>) => {
                    const color = e.detail.value;
                    this.color = color;
                    colorStore.set(color);
                    prevColorStore.set(color);
                    this.emitPickerColor(color, true);
                  }}
                ></generic-color-picker>
              </div>
            `}
        ${this.showHexField() ? this.renderHexField() : nothing}
        ${showDocumentSwatches ? this.renderSwatches() : nothing}
      `;
    }

    protected showPickerVariantTabs(): boolean {
      return true;
    }

    protected showDocumentColorSwatches(): boolean {
      return !this.mini;
    }

    protected showHexField(): boolean {
      return !this.mini;
    }

    /** Main color panel exposes Recolor; stage popup does not. */
    protected showDocumentColorRecolor(): boolean {
      return true;
    }
  }

  return ColorPickerFeaturesClass;
}

@customElement("flipcel-color-panel")
export class FlipCelColorPanel extends ColorPickerFeatures(FloatingPanel) {
  /** Picker flex-fills the panel; keep a single-column stack. */
  @property({ type: Boolean, reflect: true }) override masonry = false;

  protected override showsMiniToggle(): boolean {
    return true;
  }

  static styles = css`
    ${FloatingPanel.styles}
    ${colorPickerSharedStyles}

    :host {
      /* Floor that fits the tab row, a square wheel beside the slider, and the hex field.
         Wider than this only adds slack beside the tabs; taller only letterboxes the circle. */
      --panel-width: 264px;
      --panel-min-width: 264px;
      --panel-height: 396px;
      height: var(--panel-height);
      min-height: var(--panel-height);
      --picker-border-width: 2px;
      --picker-border-color: var(--block-border, #9f9f9f);
      --picker-slider-width: 20px;
      --picker-gap: 10px;
      --picker-circle-size: 36vmin;
    }

    :host([mini]) {
      --panel-width: 248px;
      --panel-min-width: 248px;
      /* Tab row plus the wheel. Palette uses the same body. */
      --panel-height: 256px;
      min-height: 248px;
    }

    :host([mini]) .variant-tabs {
      gap: 4px;
    }

    :host([mini]) .variant-tabs > blocky-button {
      --block-font-size: 11px;
      --block-face-padding: 4px 0;
    }

    .picker-wrap {
      flex: 1 1 auto;
      min-height: 200px;
    }

    :host([mini]) .picker-wrap {
      min-height: 0;
    }
  `;

  protected override getResizeMinWidth(): number {
    return this.mini ? 248 : 264;
  }

  protected override getResizeMinHeight(_width: number): number {
    return this.mini ? 248 : 396;
  }

  render() {
    return this.renderFloatingBlock("Color", this.renderColorPickerContent());
  }
}

@customElement("flipcel-color-popup")
export class FlipCelColorPopup extends ColorPickerFeatures(PopupWindow) {
  static styles = css`
    ${PopupWindow.styles}
    ${colorPickerSharedStyles}

    :host {
      --panel-width: 204px;
      --picker-border-width: 2px;
      --picker-border-color: var(--block-border, #9f9f9f);
      --picker-slider-width: 16px;
      --picker-handle-size: 10px;
      --picker-gap: 6px;
      --picker-circle-size: 28vmin;
    }

    .picker-wrap {
      flex: 0 0 auto;
      height: 132px;
      min-height: 0;
    }

    .panel-form {
      gap: 8px;
    }
  `;

  protected showPickerVariantTabs(): boolean {
    return false;
  }

  protected showDocumentColorRecolor(): boolean {
    return false;
  }

  render() {
    return this.renderPopupBlock(this.renderColorPickerContent());
  }
}
