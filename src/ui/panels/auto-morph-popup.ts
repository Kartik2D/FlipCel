import { html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { PopupWindow } from "../primitives/popup-window";
import {
  anchorPanelBelowTrigger,
  raisePanelZIndex,
} from "../primitives/panel-anchor";

/** Payload of the `auto-morph-apply` event. */
export interface AutoMorphApplyDetail {
  layerIds: string[];
  start: number;
  end: number;
  /** "every" = an inbetween on every frame of each hold gap. */
  mode: "every" | "divisions";
  /** Number of divisions per hold gap (divisions mode). */
  divisions: number;
}

/**
 * Compact popup opened from the frame-selection actions: morphs every hold
 * in the selection toward its next keyframe, either on every frame or at a
 * chosen number of divisions.
 */
@customElement("inkwell-auto-morph-popup")
export class InkwellAutoMorphPopup extends PopupWindow {
  static styles = css`
    ${PopupWindow.styles}

    :host {
      --panel-width: 210px;
      font-size: 12px;
    }

    .hint {
      margin: 0;
      color: var(--inkwell-text-secondary, #6b6b6b);
      font-weight: 500;
      line-height: 1.3;
    }

    .mode-row {
      display: flex;
      gap: 6px;
    }

    .divisions-row {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
  `;

  @state() private mode: "every" | "divisions" = "every";
  @state() private divisions = 4;

  private pending: { layerIds: string[]; start: number; end: number } | null =
    null;

  /**
   * Open near the triggering button, remembering the frame selection.
   *
   * Deliberately does NOT use showNearAnchor: the trigger lives inside the
   * timeline's transient frame-actions popover, which dismisses on the first
   * pointerdown outside the layers panel — i.e. the first click inside this
   * popup. showNearAnchor's anchor watch would see the trigger disconnect
   * and hide us mid-click, so we only borrow the anchor for positioning.
   */
  async openFor(
    sel: { layerIds: string[]; start: number; end: number },
    anchor: HTMLElement,
  ): Promise<void> {
    this.pending = {
      layerIds: [...sel.layerIds],
      start: sel.start,
      end: sel.end,
    };
    this.style.display = "";
    await this.updateComplete;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    anchorPanelBelowTrigger(this, anchor);
    raisePanelZIndex(this);
    this.playShowAnimation();
  }

  private apply() {
    const pending = this.pending;
    this.hidePanel();
    if (!pending) return;
    this.dispatchEvent(
      new CustomEvent<AutoMorphApplyDetail>("auto-morph-apply", {
        detail: { ...pending, mode: this.mode, divisions: this.divisions },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    return this.renderPopupBlock(html`
      <p class="hint">Morph holds to their next keyframe</p>
      <div class="mode-row">
        <blocky-button
          flat
          stretch
          ?accent=${this.mode === "every"}
          @click=${() => (this.mode = "every")}
        >Every frame</blocky-button>
        <blocky-button
          flat
          stretch
          ?accent=${this.mode === "divisions"}
          @click=${() => (this.mode = "divisions")}
        >Divisions</blocky-button>
      </div>
      ${this.mode === "divisions"
        ? html`
            <label class="divisions-row">
              <span>Divisions: ${this.divisions}</span>
              <input
                type="range"
                min="2"
                max="12"
                step="1"
                .value=${String(this.divisions)}
                @input=${(e: Event) => {
                  this.divisions = Number((e.target as HTMLInputElement).value);
                }}
              />
            </label>
          `
        : nothing}
      <blocky-button flat accent stretch @click=${() => this.apply()}
        >Apply</blocky-button
      >
    `);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "inkwell-auto-morph-popup": InkwellAutoMorphPopup;
  }
}
