import { html, css, nothing, type TemplateResult } from "lit";
import { FloatingPanel } from "./floating-panel";
import { anchorPanelBelowTrigger, raisePanelZIndex } from "./panel-anchor";

// ============================================================
// Popup Window Base Class
// ============================================================

/**
 * Compact floating window for small dialogs and settings.
 * No title bar — content only, anchored near a trigger, dismisses on outside click.
 */
export class PopupWindow extends FloatingPanel {
  private anchorEl: HTMLElement | null = null;
  private anchorSnapshot: {
    left: number;
    top: number;
    width: number;
    height: number;
  } | null = null;
  private anchorWatchRaf: number | null = null;

  private readonly outsidePointerHandler = (e: PointerEvent) => {
    if (this.style.display === "none") return;

    const path = e.composedPath();
    if (path.includes(this)) return;

    const clickedTrigger = path.some(
      (node) =>
        node instanceof HTMLElement && node.getAttribute("data-panel-trigger") === this.id,
    );
    if (clickedTrigger) return;

    this.hidePanel();
  };

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      --panel-width: 220px;
      --panel-min-width: 160px;
      --panel-max-height: min(70vh, 420px);
      --block-face-padding: 8px;
    }

    .panel-body > .face {
      border-radius: calc(var(--block-radius) - 2px);
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute("data-popup", "");
    document.addEventListener("pointerdown", this.outsidePointerHandler, true);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("pointerdown", this.outsidePointerHandler, true);
    this.stopAnchorWatch();
  }

  override hidePanel() {
    this.stopAnchorWatch();
    super.hidePanel();
  }

  private snapshotAnchorRect(el: HTMLElement) {
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }

  private anchorHasMoved(
    before: { left: number; top: number; width: number; height: number },
    after: { left: number; top: number; width: number; height: number },
  ): boolean {
    return (
      Math.abs(before.left - after.left) > 0.5 ||
      Math.abs(before.top - after.top) > 0.5 ||
      Math.abs(before.width - after.width) > 0.5 ||
      Math.abs(before.height - after.height) > 0.5
    );
  }

  private startAnchorWatch(anchor: HTMLElement) {
    this.stopAnchorWatch();
    this.anchorEl = anchor;
    this.anchorSnapshot = this.snapshotAnchorRect(anchor);

    const tick = () => {
      if (this.style.display === "none") {
        this.stopAnchorWatch();
        return;
      }

      const el = this.anchorEl;
      if (!el || !el.isConnected) {
        this.hidePanel();
        return;
      }

      const next = this.snapshotAnchorRect(el);
      if (this.anchorSnapshot && this.anchorHasMoved(this.anchorSnapshot, next)) {
        this.hidePanel();
        return;
      }

      this.anchorWatchRaf = requestAnimationFrame(tick);
    };

    this.anchorWatchRaf = requestAnimationFrame(tick);
  }

  private stopAnchorWatch() {
    if (this.anchorWatchRaf !== null) {
      cancelAnimationFrame(this.anchorWatchRaf);
      this.anchorWatchRaf = null;
    }
    this.anchorEl = null;
    this.anchorSnapshot = null;
  }

  protected onDragCommitted() {
    // Popups stay ephemeral so outside-click dismissal still works after drag.
  }

  protected showsDragHandlePill(): boolean {
    return false;
  }

  protected headerActsAsDragHandle(): boolean {
    return false;
  }

  /** Popup shell: scrollable body only, no title bar. */
  protected renderPopupBlock(content: TemplateResult) {
    return html`
      <div class="block">
        <div class="panel-body">
          <div class="face">
            <div class="panel-form">${content}</div>
          </div>
        </div>
        ${this.resizable
          ? html`<div class="resize-left"></div><div class="resize-right"></div>`
          : nothing}
      </div>
    `;
  }

  /** Open below an anchor (e.g. a contextual trigger). Dismisses on outside click. */
  async showNearAnchor(anchor: HTMLElement) {
    this.style.display = "";
    await this.updateComplete;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    anchorPanelBelowTrigger(this, anchor);
    raisePanelZIndex(this);
    this.startAnchorWatch(anchor);
  }
}
