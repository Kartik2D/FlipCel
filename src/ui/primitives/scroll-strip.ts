import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { phosphorIcon } from "../icons/phosphor";

/**
 * Horizontal content strip with circular arrow buttons (no scrollbar).
 * When `label` is set, arrows sit on the title row; the viewport spans full width.
 * Wheel / trackpad gestures over the whole strip scroll horizontally.
 */
@customElement("inkwell-scroll-strip")
export class InkwellScrollStrip extends LitElement {
  /** Number of visible rows in the scrolling track (items fill row-first). */
  @property({ type: Number, reflect: true }) rows = 1;
  /** Optional title shown on the arrow row. */
  @property({ type: String }) label = "";
  /** Center the label between the arrows. */
  @property({ type: Boolean, reflect: true, attribute: "center-label" })
  centerLabel = false;
  /**
   * Bleed to cancel parent `--inkwell-block-face-padding` so the track is flush
   * with the group edge; header keeps matching inset padding.
   */
  @property({ type: Boolean, reflect: true }) flush = false;

  @state() private canScrollLeft = false;
  @state() private canScrollRight = false;

  private viewport: HTMLElement | null = null;
  private track: HTMLElement | null = null;
  private slotEl: HTMLSlotElement | null = null;
  private resizeObserver: ResizeObserver | null = null;

  /**
   * Map vertical trackpad swipes onto this horizontal strip. Native overflow-x
   * already handles deltaX; without this, deltaY would scroll a parent panel.
   */
  private readonly onWheel = (e: WheelEvent) => {
    const el = this.viewport;
    if (!el || this.hasAttribute("data-no-overflow")) return;

    const absX = Math.abs(e.deltaX);
    const absY = Math.abs(e.deltaY);
    // Let the browser handle explicit horizontal gestures natively.
    if (absX >= absY) return;

    const dx = e.deltaY;
    if (dx === 0) return;

    const max = Math.max(0, el.scrollWidth - el.clientWidth);
    const next = Math.min(max, Math.max(0, el.scrollLeft + dx));
    if (next === el.scrollLeft) return;

    e.preventDefault();
    el.scrollLeft = next;
    this.syncScrollState();
  };

  static styles = css`
    :host {
      display: block;
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
    }

    :host([flush]) {
      width: calc(100% + (2 * var(--inkwell-block-face-padding, 12px)));
      margin-inline: calc(-1 * var(--inkwell-block-face-padding, 12px));
    }

    .shell {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      min-width: 0;
    }

    .header {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr) 28px;
      align-items: center;
      column-gap: 6px;
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
    }

    :host([flush]) .header {
      padding-inline: var(--inkwell-block-face-padding, 12px);
    }

    .header-label {
      margin: 0;
      min-width: 0;
      font: inherit;
      font-weight: 600;
      line-height: 1.2;
      color: var(--inkwell-text-primary, #1a1a1a);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    :host([center-label]) .header-label {
      text-align: center;
    }

    .arrow {
      flex: 0 0 auto;
      box-sizing: border-box;
      width: 28px;
      height: 28px;
      margin: 0;
      padding: 0;
      border: none;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: var(--block-depth-color, var(--inkwell-panel-depth, #bcbcbc));
      color: var(--block-border, var(--inkwell-panel-border, #555555));
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      line-height: 0;
    }

    .arrow:hover:not(:disabled) {
      filter: brightness(0.97);
    }

    .arrow:disabled {
      opacity: 0.35;
      cursor: default;
      pointer-events: none;
    }

    .arrow svg {
      display: block;
    }

    .viewport {
      width: 100%;
      min-width: 0;
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: none;
      overscroll-behavior-x: contain;
    }

    .viewport::-webkit-scrollbar {
      display: none;
    }

    .track {
      display: grid;
      grid-auto-flow: row;
      gap: 6px;
      width: max-content;
      min-width: 100%;
      box-sizing: border-box;
      align-items: stretch;
      /* Inset chips from the flush viewport edges; scrolls with content. */
      padding-inline: var(--inkwell-block-face-padding, 12px);
    }

    :host([rows="1"]) .track {
      grid-auto-flow: column;
      grid-template-rows: none;
      grid-template-columns: none;
      display: flex;
      flex-direction: row;
      align-items: center;
    }

    ::slotted(*) {
      flex: 0 0 auto;
      min-width: 0;
    }

    :host([data-no-overflow]) .arrow {
      visibility: hidden;
      pointer-events: none;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener("wheel", this.onWheel, { passive: false });
  }

  firstUpdated() {
    this.viewport = this.renderRoot.querySelector(".viewport");
    this.track = this.renderRoot.querySelector(".track");
    this.slotEl = this.renderRoot.querySelector("slot");
    if (!this.viewport || !this.track) return;

    this.resizeObserver = new ResizeObserver(() => {
      this.updateTrackGrid();
      this.syncScrollState();
    });
    this.resizeObserver.observe(this.viewport);
    this.resizeObserver.observe(this.track);

    this.updateTrackGrid();
    this.syncScrollState();
  }

  private updateTrackGrid() {
    const track = this.track;
    const slot = this.slotEl;
    if (!track) return;

    const rowCount = Math.max(1, Math.round(this.rows));
    if (rowCount === 1) {
      track.style.gridTemplateRows = "";
      track.style.gridTemplateColumns = "";
      return;
    }

    const count = slot?.assignedElements({ flatten: true }).length ?? 0;
    const cols = Math.max(1, Math.ceil(count / rowCount));
    track.style.gridTemplateRows = `repeat(${rowCount}, auto)`;
    track.style.gridTemplateColumns = `repeat(${cols}, auto)`;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("wheel", this.onWheel);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  private syncScrollState() {
    const el = this.viewport;
    if (!el) return;
    const max = Math.max(0, el.scrollWidth - el.clientWidth);
    const left = el.scrollLeft;
    const epsilon = 1;
    this.canScrollLeft = left > epsilon;
    this.canScrollRight = left < max - epsilon;
    this.toggleAttribute("data-no-overflow", max <= epsilon);
  }

  private scrollByPage(direction: -1 | 1) {
    const el = this.viewport;
    if (!el) return;
    const step = Math.max(80, Math.round(el.clientWidth * 0.75));
    el.scrollBy({ left: direction * step, behavior: "smooth" });
    requestAnimationFrame(() => {
      this.syncScrollState();
      requestAnimationFrame(() => this.syncScrollState());
      window.setTimeout(() => this.syncScrollState(), 220);
    });
  }

  private renderArrow(direction: -1 | 1) {
    const left = direction < 0;
    return html`
      <button
        type="button"
        class="arrow"
        ?disabled=${left ? !this.canScrollLeft : !this.canScrollRight}
        aria-label=${left ? "Scroll left" : "Scroll right"}
        data-interactive
        @click=${() => this.scrollByPage(direction)}
      >
        ${phosphorIcon(left ? "caret-left" : "caret-right", 14)}
      </button>
    `;
  }

  render() {
    return html`
      <div class="shell" data-interactive>
        <div class="header">
          ${this.renderArrow(-1)}
          ${this.label
            ? html`<h3 class="header-label">${this.label}</h3>`
            : html`<span class="header-label" aria-hidden="true"></span>`}
          ${this.renderArrow(1)}
        </div>
        <div class="viewport" @scroll=${() => this.syncScrollState()}>
          <div class="track">
            <slot
              @slotchange=${() => {
                this.updateTrackGrid();
                this.syncScrollState();
              }}
            ></slot>
          </div>
        </div>
      </div>
    `;
  }
}
