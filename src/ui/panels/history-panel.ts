import { html, css, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { historyStateStore } from "../../document/history";
import { StoreController } from "../../state";
import { FloatingPanel } from "../primitives/floating-panel";
import { raisePanelZIndex } from "../primitives/panel-anchor";

/**
 * Undo history window — lists document snapshots and jumps to any entry.
 * Opened from Settings (not the top dock).
 */
@customElement("inkwell-history-panel")
export class InkwellHistoryPanel extends FloatingPanel {
  private history = new StoreController(this, historyStateStore);

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      --panel-width: 260px;
      --panel-min-width: 200px;
    }

    .history-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .history-empty {
      margin: 0;
      padding: 4px 2px;
      color: var(--inkwell-text-muted, #666);
      font-style: italic;
    }

    .history-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      margin: 0;
      padding: 7px 8px;
      border: none;
      border-radius: var(--inkwell-content-radius, 6px);
      background: transparent;
      color: var(--inkwell-text-primary, #1a1a1a);
      font: inherit;
      font-weight: 600;
      text-align: left;
      cursor: pointer;
      box-sizing: border-box;
    }

    .history-item:hover {
      background: color-mix(
        in srgb,
        var(--panel-accent, #4a6fb5) 14%,
        transparent
      );
    }

    .history-item:focus {
      outline: none;
    }

    .history-item:focus-visible {
      box-shadow: inset 0 0 0 2px var(--panel-accent-muted, rgba(74, 111, 181, 0.35));
    }

    .history-item[aria-current="step"] {
      background: var(--panel-accent, #4a6fb5);
      color: #ffffff;
    }

    .history-item[aria-current="step"]:hover {
      background: var(--panel-accent-hover, #3d5e9a);
      filter: none;
    }

    .history-item.is-future {
      color: var(--inkwell-text-muted, #666);
      font-weight: 500;
    }

    .history-item.is-future[aria-current="step"] {
      color: #ffffff;
      font-weight: 600;
    }

    .history-label {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .history-index {
      flex: 0 0 auto;
      font-variant-numeric: tabular-nums;
      font-size: 11px;
      opacity: 0.7;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.pinned = true;
    this.showPinnedClose = true;
    this.masonry = false;
  }

  /** Settings-toggled window — never re-dock into the top bar. */
  protected override canPreviewDockHover(): boolean {
    return false;
  }

  protected override onDragCommitted() {
    this.pinned = true;
  }

  /** Open as a pinned floating window near the settings panel when possible. */
  async show(anchor?: HTMLElement | null) {
    this.pinned = true;
    this.style.display = "";
    raisePanelZIndex(this);

    // Keep a prior placement (including after the user dragged the window).
    if (this.style.left) {
      this.playShowAnimation();
      return;
    }

    this.style.right = "auto";
    this.style.bottom = "auto";
    await this.updateComplete;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    const width = this.offsetWidth || 260;
    const height = this.offsetHeight || 200;
    const margin = 8;

    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      let left = rect.right + 10;
      let top = rect.top;
      if (left + width > window.innerWidth - margin) {
        left = Math.max(margin, rect.left - width - 10);
      }
      if (top + height > window.innerHeight - margin) {
        top = Math.max(margin, window.innerHeight - height - margin);
      }
      this.style.left = `${Math.max(margin, left)}px`;
      this.style.top = `${Math.max(margin, top)}px`;
      this.playShowAnimation();
      return;
    }

    this.style.left = `${Math.max(margin, window.innerWidth - width - 24)}px`;
    this.style.top = `${Math.max(margin, 72)}px`;
    this.playShowAnimation();
  }

  private emitGoTo(index: number) {
    this.dispatchEvent(
      new CustomEvent("history-goto", {
        detail: index,
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    const { entries } = this.history.value;
    // Newest first.
    const newestFirst = [...entries].reverse();

    return this.renderFloatingBlock(
      "History",
      html`
        <inkwell-panel-section data-interactive>
          ${newestFirst.length === 0
            ? html`<p class="history-empty">No history yet</p>`
            : html`
                <ul class="history-list" role="listbox" aria-label="History">
                  ${newestFirst.map(
                    (entry) => html`
                      <li>
                        <button
                          type="button"
                          class="history-item ${entry.isFuture ? "is-future" : ""}"
                          role="option"
                          aria-selected=${entry.isCurrent ? "true" : "false"}
                          aria-current=${entry.isCurrent ? "step" : nothing}
                          data-interactive
                          @click=${() => this.emitGoTo(entry.index)}
                        >
                          <span class="history-label">${entry.label}</span>
                          <span class="history-index">${entry.index + 1}</span>
                        </button>
                      </li>
                    `,
                  )}
                </ul>
              `}
        </inkwell-panel-section>
      `,
    );
  }
}
