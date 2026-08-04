import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { PopupWindow } from "../primitives/popup-window";
import { anchorPanelBelowTrigger, raisePanelZIndex } from "../primitives/panel-anchor";
import { getHelp, type HelpId } from "../help/catalog";
import { initHelpController } from "../help/help-controller";

/**
 * Compact anchored explanation for a control (hover / long-press help).
 */
@customElement("flipcel-help-popup")
export class FlipCelHelpPopup extends PopupWindow {
  @property({ type: String }) helpId: HelpId | "" = "";

  /** Anchor that opened this popup — outside dismiss ignores presses on it. */
  private helpAnchor: HTMLElement | null = null;

  static styles = css`
    ${PopupWindow.styles}

    :host {
      --panel-width: 240px;
      --panel-min-width: 180px;
      z-index: 1200;
      pointer-events: auto;
      --block-face-bg: var(--flipcel-accent, var(--panel-accent, #4a6fb5));
      --block-depth-color: var(--flipcel-accent, var(--panel-accent, #4a6fb5));
      --block-font-color: var(--flipcel-accent-contrast, #ffffff);
      --block-border: var(--flipcel-accent-hover, #3d5e9a);
      color: var(--flipcel-accent-contrast, #ffffff);
    }

    .help-title {
      margin: 0 0 6px;
      font-size: 13px;
      font-weight: 700;
      line-height: 1.25;
      color: var(--flipcel-accent-contrast, #ffffff);
    }

    .help-body {
      margin: 0;
      font-size: 12px;
      font-weight: 500;
      line-height: 1.4;
      color: color-mix(
        in srgb,
        var(--flipcel-accent-contrast, #ffffff) 88%,
        transparent
      );
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.pinned = true;
    this.showPinnedClose = false;
    this.masonry = false;
    this.draggable = false;
    this.resizable = false;
    // Bind gestures here (not App bootstrap) so hover/long-press survive
    // module HMR and don't depend on constructor ordering.
    initHelpController(this);
  }

  /** Compact tip — no scroll gutters (avoids spurious scroll dismiss). */
  protected override usesFaceScrollbar(): boolean {
    return false;
  }

  protected override usesFaceHScrollbar(): boolean {
    return false;
  }

  override hidePanel() {
    this.helpAnchor = null;
    super.hidePanel();
  }

  /**
   * Place near the control without anchor-move auto-dismiss.
   * Subpixel layout from sibling panels was collapsing the tip immediately.
   */
  override async showNearAnchor(anchor: HTMLElement) {
    this.pinned = true;
    this.helpAnchor = anchor;
    this.style.display = "";
    await this.updateComplete;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    anchorPanelBelowTrigger(this, anchor);
    raisePanelZIndex(this);
    this.playShowAnimation();
  }

  /**
   * Keep the tip open when the user presses the same control again
   * (hover re-entry / long-press release path).
   */
  protected override isOutsideDismissException(path: EventTarget[]): boolean {
    if (super.isOutsideDismissException(path)) return true;
    return this.helpAnchor !== null && path.includes(this.helpAnchor);
  }

  render() {
    const entry = getHelp(this.helpId);
    return this.renderPopupBlock(html`
      ${entry
        ? html`
            <p class="help-title">${entry.title}</p>
            <p class="help-body">${entry.body}</p>
          `
        : html`<p class="help-body">No help available.</p>`}
    `);
  }
}
