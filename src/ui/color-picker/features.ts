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

  .doc-colors-label {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    font: inherit;
    font-weight: 600;
    color: var(--inkwell-text-primary, #1a1a1a);
  }

  .doc-colors-header blocky-button {
    flex: 0 0 auto;
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
  }

  .swatch {
    appearance: none;
    display: block;
    width: var(--picker-slider-width);
    height: var(--picker-slider-width);
    flex: 0 0 var(--picker-slider-width);
    padding: 0;
    border-radius: var(--inkwell-content-radius);
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

    private renderSwatches() {
      const colors = this.documentColors.value;
      if (colors.length === 0) return nothing;

      const activeColor = this.color.trim().toLowerCase();
      const showRecolor = this.showDocumentColorRecolor();

      return html`
        <inkwell-panel-section data-interactive>
          <div class="doc-colors-header">
            <h3 class="doc-colors-label">Document Colors</h3>
            ${showRecolor
              ? html`
                  <blocky-button
                    flat
                    ?active=${this.recolorEnabled}
                    title=${this.recolorEnabled
                      ? "Recolor on — changing the picker remaps the selected document color everywhere"
                      : "Recolor off — select a document color, then enable to remap it"}
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
        </inkwell-panel-section>
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
              <inkwell-panel-section data-interactive>
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
              </inkwell-panel-section>
            `
          : nothing}
        <div class="picker-wrap">
          <generic-color-picker
            .color=${this.color}
            .prevColor=${this.prevColor}
            .prefs=${prefs}
            @input=${(e: CustomEvent<{ value: string }>) => {
              this.color = e.detail.value;
              colorStore.set(this.color);
              this.emitPickerColor(this.color, false);
            }}
            @change=${() => {
              prevColorStore.set(this.color);
              this.emitPickerColor(this.color, true);
            }}
          ></generic-color-picker>
        </div>
        ${showDocumentSwatches ? this.renderSwatches() : nothing}
      `;
    }

    protected showPickerVariantTabs(): boolean {
      return !this.mini;
    }

    protected showDocumentColorSwatches(): boolean {
      return !this.mini;
    }

    /** Main color panel exposes Recolor; stage popup does not. */
    protected showDocumentColorRecolor(): boolean {
      return true;
    }
  }

  return ColorPickerFeaturesClass;
}

@customElement("inkwell-color-panel")
export class InkwellColorPanel extends ColorPickerFeatures(FloatingPanel) {
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
      --picker-border-width: 2px;
      --picker-border-color: var(--block-border, #9f9f9f);
      --picker-slider-width: 20px;
    }

    .picker-wrap {
      flex: 1 1 auto;
      min-height: 0;
    }
  `;

  render() {
    return this.renderFloatingBlock("Color", this.renderColorPickerContent());
  }
}

@customElement("inkwell-color-popup")
export class InkwellColorPopup extends ColorPickerFeatures(PopupWindow) {
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
