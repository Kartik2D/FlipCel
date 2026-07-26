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

  .row {
    flex: 0 0 auto;
  }

  .picker-wrap {
    width: 100%;
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
  }

  .swatch {
    appearance: none;
    display: block;
    width: var(--picker-slider-width);
    height: var(--picker-slider-width);
    flex: 0 0 var(--picker-slider-width);
    padding: 0;
    border-radius: var(--panel-control-radius, 8px);
    border: var(--picker-border-width) solid var(--picker-border-color);
    box-sizing: border-box;
    overflow: hidden;
    cursor: pointer;
  }

  .swatch:hover {
    filter: brightness(1.05);
  }

  .swatch[active] {
    outline: 2px solid var(--panel-accent);
    outline-offset: 1px;
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

    private selectSwatch(color: string) {
      this.color = color;
      colorStore.set(color);
      prevColorStore.set(color);
      this.emitColorEvent("color-change", color);
      this.emitColorEvent("color-change-end", color);
    }

    private renderSwatches() {
      const colors = this.documentColors.value;
      if (colors.length === 0) return nothing;

      const activeColor = this.color.trim().toLowerCase();

      return html`
        <inkwell-panel-section data-interactive>
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
                <div class="row">
                  ${PICKER_VARIANTS.map(
                    (v) => html`
                      <blocky-button
                        flat
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
              this.emitColorEvent("color-change", this.color);
            }}
            @change=${() => {
              prevColorStore.set(this.color);
              this.emitColorEvent("color-change-end", this.color);
            }}
          ></generic-color-picker>
        </div>
        ${showDocumentSwatches ? this.renderSwatches() : nothing}
      `;
    }

    protected showPickerVariantTabs(): boolean {
      return true;
    }

    protected showDocumentColorSwatches(): boolean {
      return true;
    }
  }

  return ColorPickerFeaturesClass;
}

@customElement("inkwell-color-panel")
export class InkwellColorPanel extends ColorPickerFeatures(FloatingPanel) {
  /** Picker flex-fills the panel; keep a single-column stack. */
  @property({ type: Boolean, reflect: true }) override masonry = false;

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

  render() {
    return this.renderPopupBlock(this.renderColorPickerContent());
  }
}
