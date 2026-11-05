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

  /* Three picker variants on one equal-width tab row. */
  .variant-tabs {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
    width: 100%;
    min-width: 0;
  }

  .variant-tabs > blocky-button {
    width: 100%;
    max-width: 100%;
    min-width: 0;
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

    private renderSwatches() {
      const colors = this.documentColors.value;
      const activeColor = this.color.trim().toLowerCase();
      const showRecolor = this.showDocumentColorRecolor();

      return html`
        <flipcel-panel-section data-interactive>
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
          <div class="swatches-wrap">
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
          </div>
        </flipcel-panel-section>
      `;
    }

    protected renderColorPickerContent() {
      const prefs = this.pickerPrefs.value;
      const activeVariant = exactVariantId(prefs) || PICKER_VARIANTS[0].id;
      const showVariantTabs = this.showPickerVariantTabs();
      const showDocumentSwatches = this.showDocumentColorSwatches();

      return html`
        ${showVariantTabs
          ? html`
              <flipcel-panel-section title="Picker" data-interactive>
                <div class="variant-tabs">
                  ${PICKER_VARIANTS.map(
                    (v) => html`
                      <blocky-button
                        flat
                        stretch
                        ?active=${v.id === activeVariant}
                        @click=${() => this.onVariantChange(v.id)}
                        >${v.label}</blocky-button
                      >
                    `,
                  )}
                </div>
              </flipcel-panel-section>
            `
          : nothing}
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
        ${this.showHexField() ? this.renderHexField() : nothing}
        ${showDocumentSwatches ? this.renderSwatches() : nothing}
      `;
    }

    protected showPickerVariantTabs(): boolean {
      return !this.mini;
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
      --panel-width: 288px;
      /* Tabs + square plane + hex + one swatch row, no scroll. */
      --panel-height: 500px;
      height: var(--panel-height);
      min-height: 280px;
      --picker-border-width: 2px;
      --picker-border-color: var(--block-border, #9f9f9f);
      --picker-slider-width: 20px;
      --picker-gap: 10px;
      --picker-circle-size: 36vmin;
    }

    :host([mini]) {
      --panel-width: 204px;
      --panel-min-width: 204px;
      --panel-height: 208px;
      min-height: 208px;
    }

    .picker-wrap {
      flex: 1 1 auto;
      min-height: 200px;
    }

    :host([mini]) .picker-wrap {
      min-height: 132px;
    }
  `;

  protected override getResizeMinWidth(): number {
    return this.mini ? 204 : super.getResizeMinWidth();
  }

  protected override getResizeMinHeight(_width: number): number {
    return this.mini ? 208 : 280;
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
