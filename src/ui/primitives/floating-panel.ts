import { html, css, nothing, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { Block } from "./block";
import { phosphorIcon } from "../icons/phosphor";

// ============================================================
// Floating Panel Base Class
// ============================================================

export class FloatingPanel extends Block {
  @property({ type: Boolean, reflect: true }) pinned = false;
  /** When true, the header always shows a close (X) control. */
  @property({ type: Boolean }) showPinnedClose = true;
  /**
   * Arrange `inkwell-panel-section` groups in a responsive masonry (multi-column)
   * layout when the panel is wide enough. Layers/tools opt out.
   */
  @property({ type: Boolean, reflect: true }) masonry = true;

  static styles = css`
    ${Block.styles}

    :host {
      position: fixed;
      z-index: 1000;
      top: var(--panel-top, auto);
      right: var(--panel-right, auto);
      bottom: var(--panel-bottom, auto);
      left: var(--panel-left, auto);
      /* Stable default width so content changes (toggles, tool schema) do not reflow the shell */
      width: var(--panel-width, 280px);
      min-width: var(--panel-min-width, 200px);
      min-height: var(--panel-min-height, auto);
      max-width: calc(100vw - 16px);
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      max-height: var(--panel-max-height, min(85vh, 720px));
      touch-action: auto;
      overscroll-behavior: none;

      --block-font-color: var(--inkwell-text-primary, #1a1a1a);
      --panel-accent: var(--inkwell-accent, #4a6fb5);
      --panel-accent-hover: var(--inkwell-accent-hover, #3d5e9a);
      --panel-accent-muted: var(--inkwell-accent-muted, rgba(74, 111, 181, 0.35));
      --panel-track-bg: var(--inkwell-track-bg, #cfcfcf);
      --panel-track-focus: var(--inkwell-track-bg, #b8b8b8);
    }

    .block {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      max-height: 100%;
      height: auto;
    }

    .face {
      flex: 1 1 auto;
      min-height: 0;
      height: auto;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: none;
    }

    /* Fixed title bar; only .panel-body scrolls beneath it. */
    .panel-body {
      position: relative;
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .panel-body > .face {
      flex: 1 1 auto;
      min-height: 0;
      border-radius: 0 0 calc(var(--block-radius) - var(--block-border-width, 0px))
        calc(var(--block-radius) - var(--block-border-width, 0px));
    }

    .panel-body > .face-scrollbar {
      top: 8px;
      bottom: 8px;
    }

    /* Form stack: use inside .face for sliders, fields, toggles */
    .panel-form {
      display: flex;
      flex-direction: column;
      gap: 12px;
      width: 100%;
      min-width: 0;
    }

    /* Responsive masonry: sections pack into columns as the panel widens. */
    :host([masonry]) .panel-form {
      display: block;
      columns: var(--panel-masonry-column-width, 200px);
      column-gap: 12px;
    }

    :host([masonry]) .panel-form > * {
      break-inside: avoid;
      page-break-inside: avoid;
      -webkit-column-break-inside: avoid;
      display: inline-block;
      width: 100%;
      max-width: 100%;
      margin: 0 0 12px;
      vertical-align: top;
      box-sizing: border-box;
    }

    :host([masonry]) .panel-form > *:last-child {
      margin-bottom: 0;
    }

    .panel-form section {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin: 0;
    }

    .panel-form > section {
      margin: 0;
    }

    .panel-form > inkwell-panel-section {
      flex: 0 0 auto;
    }

    section {
      margin-bottom: 12px;
    }
    section:last-child {
      margin-bottom: 0;
    }

    h3 {
      margin: 0;
      font: inherit;
      font-weight: 600;
      color: var(--inkwell-text-primary, #1a1a1a);
    }

    .panel-title {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      margin: 0;
      min-width: 0;
      min-height: 1.25em;
      font: inherit;
      font-size: 16px;
      font-weight: 600;
      line-height: 1.25;
    }

    .panel-title span {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      line-height: inherit;
    }

    /* Title bar row: title (left), drag pill (center), close (right).
       Sized from the close control, not the title — untitled panels match. */
    .panel-header {
      --panel-header-control-size: 26px;
      position: relative;
      z-index: 20;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto minmax(
          var(--panel-header-control-size),
          1fr
        );
      align-items: center;
      column-gap: 8px;
      width: 100%;
      min-width: 0;
      flex-shrink: 0;
      box-sizing: border-box;
      margin: 0;
      min-height: calc(
        var(--panel-header-control-size) + (2 * var(--inkwell-block-face-padding, 12px))
      );
      padding: var(--inkwell-block-face-padding, 12px);
      background: var(--block-face-bg);
      border-radius: calc(var(--block-radius) - var(--block-border-width, 2px))
        calc(var(--block-radius) - var(--block-border-width, 2px)) 0 0;
    }

    .panel-header-slot {
      display: flex;
      align-items: center;
      min-width: 0;
    }

    .panel-header-start {
      justify-self: start;
    }

    .panel-header-center {
      justify-self: center;
    }

    .panel-header-end {
      justify-self: end;
      width: var(--panel-header-control-size, 18px);
      min-width: var(--panel-header-control-size, 18px);
      height: var(--panel-header-control-size, 18px);
    }

    .panel-header-close-spacer {
      display: block;
      width: var(--panel-header-control-size, 18px);
      height: var(--panel-header-control-size, 18px);
      flex-shrink: 0;
    }

    .panel-header.has-close .panel-title {
      max-width: 100%;
      padding-right: 0;
    }

    .panel-header.is-drag-handle {
      cursor: grab;
    }

    :host([dragging]) .panel-header.is-drag-handle {
      cursor: grabbing;
    }

    /* Horizontal grab pill — flat, no shadow */
    .panel-drag-pill {
      width: 2.5rem;
      height: 7px;
      border-radius: 999px;
      background: var(--block-border, #555555);
      box-shadow: none;
      flex-shrink: 0;
      cursor: inherit;
      pointer-events: auto;
    }

    .panel-header-close {
      width: var(--panel-header-control-size, 18px);
      height: var(--panel-header-control-size, 18px);
      box-sizing: border-box;
      border: none;
      border-radius: 50%;
      background: var(--block-depth-color, #bcbcbc);
      color: var(--block-border, #555555);
      line-height: 0;
      display: grid;
      place-items: center;
      cursor: pointer;
      padding: 0;
      margin: 0;
      -webkit-tap-highlight-color: transparent;
    }

    .panel-header-close svg {
      display: block;
      flex-shrink: 0;
    }

    .panel-header-close:hover {
      filter: brightness(0.96);
    }

    .panel-header-close:focus {
      outline: none;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      width: 100%;
      min-width: 0;
    }

    .grid > blocky-button {
      min-width: 0;
      width: 100%;
      max-width: 100%;
      justify-self: stretch;
    }

    /* Pairwise button rows: at most two across, then wrap. */
    .row {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      align-items: stretch;
      min-width: 0;
      width: 100%;
    }
    .row > * {
      min-width: 0;
    }

    /* Lone control (e.g. "New File") still spans the full row. */
    .row > :only-child {
      grid-column: 1 / -1;
    }

    .row > blocky-button {
      width: 100%;
      max-width: 100%;
    }

    .panel-form label {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 0;
      min-width: 0;
    }

    .panel-form label > span:first-child {
      color: var(--inkwell-text-secondary, #333333);
    }

    /* Native selects: match flat panel buttons (depth grey, no shadow) */
    .panel-form select {
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
      font: inherit;
      padding: 6px 1.75rem 6px 10px;
      margin: 0;
      border: none;
      border-radius: var(--inkwell-content-radius);
      background-color: var(--block-depth-color, #bcbcbc);
      color: var(--block-border, #555555);
      cursor: pointer;
      appearance: none;
      -webkit-appearance: none;
      box-shadow: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 256 256'%3E%3Cpath fill='%23555555' d='M215.39 92.94a8 8 0 0 0-11.32 0L128 164 51.93 92.94a8 8 0 0 0-11.32 11.32l80 80a8 8 0 0 0 11.32 0l80-80a8 8 0 0 0 0-11.32Z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
      background-size: 10px;
    }

    .panel-form select:hover {
      filter: brightness(0.97);
    }

    .panel-form select:focus {
      outline: none;
    }

    .panel-form select:focus-visible {
      box-shadow: 0 0 0 2px var(--panel-accent-muted, rgba(74, 111, 181, 0.35));
    }

    .panel-form input[type="range"] {
      width: 100%;
      min-width: 0;
      height: 1.75rem;
      margin: 0;
      -webkit-appearance: none;
      appearance: none;
      background: transparent;
      cursor: pointer;
    }

    .panel-form input[type="range"]:focus {
      outline: none;
    }

    .panel-form input[type="range"]:focus-visible::-webkit-slider-thumb,
    .panel-form input[type="range"]:focus-visible::-moz-range-thumb {
      outline: none;
      box-shadow: none;
    }

    .panel-form input[type="range"]::-webkit-slider-runnable-track {
      height: 6px;
      border-radius: 999px;
      background: var(--panel-track-bg);
    }

    .panel-form input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 22px;
      height: 22px;
      margin-top: -8px;
      border-radius: 50%;
      background: var(--panel-accent);
      border: none;
      box-shadow: none;
    }

    .panel-form input[type="range"]:hover::-webkit-slider-thumb {
      background: var(--panel-accent-hover);
    }

    .panel-form input[type="range"]::-moz-range-track {
      height: 6px;
      border-radius: 999px;
      background: var(--panel-track-bg);
    }

    .panel-form input[type="range"]::-moz-range-thumb {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: var(--panel-accent);
      border: none;
      box-shadow: none;
    }

    .panel-form input[type="range"]:hover::-moz-range-thumb {
      background: var(--panel-accent-hover);
    }

    .toggle {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin: 0;
      min-height: 28px;
      overflow: hidden;
    }

    .toggle span {
      flex: 1;
      min-width: 0;
      color: var(--inkwell-text-secondary, #333333);
    }

    .toggle input[type="checkbox"] {
      appearance: none;
      -webkit-appearance: none;
      position: relative;
      width: 40px;
      height: 24px;
      margin: 0;
      flex: 0 0 auto;
      box-sizing: border-box;
      overflow: hidden;
      border-radius: 999px;
      border: 1.5px solid var(--inkwell-toggle-border, #999999);
      background: var(--inkwell-toggle-track, #d4d4d4);
      cursor: pointer;
      transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
    }

    .toggle input[type="checkbox"]::after {
      content: "";
      position: absolute;
      top: 50%;
      left: 2px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: var(--inkwell-toggle-thumb, #ffffff);
      box-shadow: var(--inkwell-shadow-soft, 0 2px 4px rgba(0, 0, 0, 0.12));
      transform: translateY(-50%);
      transition: transform 120ms ease, background-color 120ms ease;
    }

    .toggle input[type="checkbox"]:checked {
      background: var(--panel-accent, #4a6fb5);
      border-color: var(--panel-accent, #4a6fb5);
    }

    .toggle input[type="checkbox"]:checked::after {
      transform: translate(14px, -50%);
      background: #ffffff;
    }

    .toggle input[type="checkbox"]:focus {
      outline: none;
    }

    .toggle input[type="checkbox"]:focus-visible {
      box-shadow: inset 0 0 0 2px var(--panel-accent-muted, rgba(74, 111, 181, 0.35));
    }

    .hint {
      color: var(--inkwell-text-muted, #666);
      font-style: italic;
      margin: 0;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute('data-panel', '');
  }

  /** Scrollable panel bodies use the shared face scrollbar gutter. */
  protected override usesFaceScrollbar(): boolean {
    return true;
  }

  protected dragUsesMinimumMovementThreshold(): boolean {
    return !this.pinned;
  }

  protected onDragCommitted() {
    if (!this.pinned) {
      // Pulling away from the dock — hide the dock toggle until closed or re-docked.
      this.pinned = true;
      this.dispatchPanelDockState({ visible: true, detached: true });
      return;
    }

    // Already floating — dropping back onto the top dock reattaches it.
    if (this.isOverTopDock()) {
      this.pinned = false;
      this.dispatchPanelDockState({ visible: true, detached: false });
    }
  }

  private dispatchPanelDockState(detail: {
    visible: boolean;
    detached: boolean;
  }) {
    if (!this.id) return;
    this.dispatchEvent(
      new CustomEvent("panel-visibility-change", {
        detail: { id: this.id, ...detail },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Hit-test against the top dock (with a little slack below) for re-dock drops. */
  protected isOverTopDock(): boolean {
    const dock = document.querySelector<HTMLElement>("inkwell-top-bar-panel");
    if (!dock || dock.style.display === "none") return false;

    const dockRect = dock.getBoundingClientRect();
    const panelRect = this.getBoundingClientRect();
    const padX = 32;
    const padBottom = 56;
    const zoneLeft = dockRect.left - padX;
    const zoneRight = dockRect.right + padX;
    const zoneTop = 0;
    const zoneBottom = dockRect.bottom + padBottom;

    return !(
      panelRect.right < zoneLeft ||
      panelRect.left > zoneRight ||
      panelRect.bottom < zoneTop ||
      panelRect.top > zoneBottom
    );
  }

  hidePanel() {
    this.pinned = false;
    // Keep blockWidth/blockHeight so a resized panel restores its size on reopen.
    this.style.display = "none";
    this.dispatchEvent(
      new CustomEvent("panel-visibility-change", {
        detail: { id: this.id, visible: false, detached: false },
        bubbles: true,
        composed: true,
      }),
    );
  }

  protected override getFaceScrollbarMount(): HTMLElement | null {
    return (
      this.renderRoot.querySelector<HTMLElement>(".panel-body") ??
      super.getFaceScrollbarMount()
    );
  }

  protected override getFaceScrollTarget(): HTMLElement | null {
    return (
      this.renderRoot.querySelector<HTMLElement>(".panel-body > .face") ??
      super.getFaceScrollTarget()
    );
  }

  /** Standard floating-panel shell: chrome header + scrollable body. */
  protected renderFloatingBlock(title: string | undefined, content: TemplateResult) {
    return html`
      <div class="block">
        ${this.renderDragHandlePill(title)}
        <div class="panel-body">
          <div class="face">
            ${this.renderResizeHandles()}
            <div class="panel-form">${content}</div>
          </div>
        </div>
      </div>
    `;
  }

  /** Floating panels show a center grab pill; popups use the title bar instead. */
  protected showsDragHandlePill(): boolean {
    return true;
  }

  /** When true, the whole title bar is the drag handle (e.g. no dedicated pill). */
  protected headerActsAsDragHandle(): boolean {
    return false;
  }

  /**
   * Only the title bar / explicit `data-drag-handle` moves the panel — never the face.
   */
  protected override _isWhitespaceTarget(e: PointerEvent): boolean {
    const path = e.composedPath();
    for (const el of path) {
      if (el === this) break;
      if (!(el instanceof HTMLElement)) continue;
      if (el.hasAttribute("data-interactive")) return false;
      const tag = el.tagName.toLowerCase();
      if (tag === "button" || tag === "input" || tag === "blocky-button") return false;
      if (el.hasAttribute("data-drag-handle")) return true;
    }
    return false;
  }

  /**
   * Title bar row: title (left), drag pill (center), close (right).
   * Close is always shown when `showPinnedClose` is set (not gated on detach).
   */
  protected renderDragHandlePill(title?: string) {
    const showClose = this.showPinnedClose;
    const showPill = this.draggable && this.showsDragHandlePill();
    // Whole top bar (pill + title chrome) is the move handle when draggable.
    const headerDraggable =
      this.draggable && (showPill || this.headerActsAsDragHandle());
    if (!showPill && !headerDraggable && !title && !showClose) {
      return html``;
    }

    return html`
      <div
        class="panel-header ${title ? "has-title" : ""} ${showClose ? "has-close" : ""} ${headerDraggable ? "is-drag-handle" : ""}"
        ?data-drag-handle=${headerDraggable}
        title=${headerDraggable ? "Drag to move" : nothing}
      >
        <div class="panel-header-slot panel-header-start">
          ${title ? this.renderPanelTitle(title) : nothing}
        </div>
        <div class="panel-header-slot panel-header-center">
          ${showPill
            ? html`<div class="panel-drag-pill" title="Drag to move panel" aria-hidden="true"></div>`
            : nothing}
        </div>
        <div class="panel-header-slot panel-header-end">
          ${showClose ? this.renderPanelClose() : nothing}
        </div>
      </div>
    `;
  }

  protected renderPanelTitle(title: string) {
    return html`<h3 class="panel-title"><span>${title}</span></h3>`;
  }

  protected renderPanelClose() {
    return html`
      <button
        type="button"
        class="panel-header-close"
        title="Hide panel"
        aria-label="Hide panel"
        data-interactive
        @click=${(e: Event) => {
          e.stopPropagation();
          this.hidePanel();
        }}
      >
        ${phosphorIcon("x", 14)}
      </button>
    `;
  }
}
