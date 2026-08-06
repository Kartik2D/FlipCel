import { html, css, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { Block } from "./block";
import { phosphorIcon } from "../icons/phosphor";
import {
  FLIPCEL_MOTION_OVERSHOOT_MS,
  FLIPCEL_PANEL_SHOW_KEYFRAMES,
} from "../motion";

// ============================================================
// Floating Panel Base Class
// ============================================================

type PanelModeSize = { width: number; height: number };

export class FloatingPanel extends Block {
  @property({ type: Boolean, reflect: true }) pinned = false;
  /** When true, the header always shows a close (X) control. */
  @property({ type: Boolean }) showPinnedClose = true;
  /**
   * Compact “mini window” mode — panels hide secondary chrome while keeping
   * their core content. Opt in per panel via `showsMiniToggle()`.
   */
  @property({ type: Boolean, reflect: true }) mini = false;

  /** Last resized size for full vs mini — restored when toggling modes. */
  private modeSizes: { full: PanelModeSize | null; mini: PanelModeSize | null } = {
    full: null,
    mini: null,
  };
  /**
   * Arrange `flipcel-panel-section` groups in a responsive masonry (multi-column)
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
      max-width: calc(100vw - 16px);
      max-height: calc(100vh - 16px);
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      touch-action: auto;
      overscroll-behavior: none;

      --block-font-color: var(--flipcel-text-primary, #1a1a1a);
      --panel-accent: var(--flipcel-accent, #4a6fb5);
      --panel-accent-hover: var(--flipcel-accent-hover, #3d5e9a);
      --panel-accent-muted: var(--flipcel-accent-muted, rgba(74, 111, 181, 0.35));
      --panel-track-bg: var(--flipcel-track-bg, #cfcfcf);
      --panel-track-focus: var(--flipcel-track-bg, #b8b8b8);
    }

    .block {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      max-height: 100%;
      height: auto;
      transform-origin: center center;
      transition: transform var(--flipcel-motion-quad-duration, 220ms)
        var(--flipcel-motion-quad-easing, cubic-bezier(0.45, 0, 0.55, 1));
    }

    /* Grabbed + over dock: shrink with quad in-out to show it can re-dock / minimize. */
    :host([dragging][dock-hover]) .block {
      transform: scale(var(--flipcel-panel-dock-hover-scale, 0.88));
    }

    /* Shown from dock / reveal — overshoot pop-in on the shell. */
    :host([showing]) .block {
      transition: none;
      animation: flipcel-panel-show var(--flipcel-motion-overshoot-duration, 420ms)
        var(--flipcel-motion-overshoot-easing, cubic-bezier(0.22, 1.7, 0.36, 1)) both;
    }

    @keyframes flipcel-panel-show {
      0% {
        transform: scale(0.88);
        opacity: 0;
      }
      100% {
        transform: scale(1);
        opacity: 1;
      }
    }

    .face {
      flex: 1 1 auto;
      min-height: 0;
      height: auto;
      overflow-x: auto;
      overflow-y: auto;
      overscroll-behavior: none;
    }

    /* Fixed title bar; only .face scrolls beneath it. Footer sits below. */
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
      /* Footer owns the bottom corners. */
      border-radius: 0;
    }

    .panel-body > .face-scrollbar {
      top: 6px;
      bottom: 6px;
    }

    /*
     * Compact bottom chrome — houses the horizontal face scrollbar with a
     * little inset around the track (same idea as the vertical gutter).
     */
    .panel-footer {
      position: relative;
      z-index: 20;
      flex: 0 0 auto;
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: flex-start;
      gap: 4px;
      width: 100%;
      min-width: 0;
      height: var(--scrollbar-gutter);
      min-height: var(--scrollbar-gutter);
      max-height: var(--scrollbar-gutter);
      box-sizing: border-box;
      margin: 0;
      padding: 0 6px;
      background: var(--block-face-bg);
      border-radius: 0 0 calc(var(--block-radius) - var(--block-border-width, 0px))
        calc(var(--block-radius) - var(--block-border-width, 0px));
    }

    .panel-footer-content {
      position: relative;
      z-index: 2;
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: center;
      gap: 4px;
      flex: 0 0 auto;
      min-width: 0;
      max-width: 40%;
    }

    .panel-footer > .face-hscrollbar {
      position: relative;
      z-index: 2;
      flex: 1 1 auto;
      align-self: center;
      min-width: 0;
      height: var(--scrollbar-size);
      margin: 0;
    }

    /* Resize hits fill the thin footer corners (still wide enough to grab). */
    .panel-footer > .resize-left,
    .panel-footer > .resize-right {
      height: 100%;
      width: max(28px, 22%);
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

    .panel-form > flipcel-panel-section {
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
      color: var(--flipcel-text-primary, #1a1a1a);
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
      --panel-header-control-gap: 6px;
      position: relative;
      z-index: 20;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto minmax(
          var(--panel-header-end-min, var(--panel-header-control-size)),
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
        var(--panel-header-control-size) + (2 * var(--flipcel-block-face-padding, 12px))
      );
      padding: var(--flipcel-block-face-padding, 12px);
      background: var(--block-face-bg);
      border-radius: calc(var(--block-radius) - var(--block-border-width, 2px))
        calc(var(--block-radius) - var(--block-border-width, 2px)) 0 0;
    }

    .panel-header.has-mini.has-close {
      --panel-header-end-min: calc(
        (2 * var(--panel-header-control-size)) + var(--panel-header-control-gap)
      );
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
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: flex-end;
      gap: var(--panel-header-control-gap, 6px);
      width: auto;
      min-width: var(--panel-header-control-size, 18px);
      height: var(--panel-header-control-size, 18px);
    }

    .panel-header-close-spacer {
      display: block;
      width: var(--panel-header-control-size, 18px);
      height: var(--panel-header-control-size, 18px);
      flex-shrink: 0;
    }

    .panel-header.has-close .panel-title,
    .panel-header.has-mini .panel-title {
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

    .panel-header-close,
    .panel-header-mini {
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
      flex-shrink: 0;
      -webkit-tap-highlight-color: transparent;
    }

    .panel-header-close svg,
    .panel-header-mini svg {
      display: block;
      flex-shrink: 0;
    }

    .panel-header-close:hover,
    .panel-header-mini:hover {
      filter: brightness(0.96);
    }

    .panel-header-close:focus,
    .panel-header-mini:focus {
      outline: none;
    }

    .panel-header-mini[aria-pressed="true"] {
      background: var(--flipcel-accent, #4a6fb5);
      color: var(--flipcel-accent-contrast, #ffffff);
      filter: none;
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

    /* Pairwise button rows: at most two across, then wrap.
       Lone buttons stay one column (do not span the full row). */
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
      color: var(--flipcel-text-secondary, #333333);
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
      border-radius: var(--flipcel-content-radius);
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
    }

    .toggle span {
      flex: 1;
      min-width: 0;
      color: var(--flipcel-text-secondary, #333333);
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
      /* Don't clip: WebKit often drops input::after thumbs when overflow is hidden. */
      overflow: visible;
      border-radius: 999px;
      border: 1.5px solid var(--flipcel-toggle-border, #999999);
      background: var(--flipcel-toggle-track, #d4d4d4);
      cursor: pointer;
      transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
    }

    .toggle input[type="checkbox"]::after {
      content: "";
      display: block;
      position: absolute;
      top: 50%;
      left: 2px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: var(--flipcel-toggle-thumb, #ffffff);
      box-shadow: var(--flipcel-shadow-soft, 0 2px 4px rgba(0, 0, 0, 0.12));
      transform: translateY(-50%);
      transition: transform 120ms ease, background-color 120ms ease;
      pointer-events: none;
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
      color: var(--flipcel-text-muted, #666);
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

  /** Horizontal face bar lives in the compact footer strip. */
  protected override usesFaceHScrollbar(): boolean {
    return this.usesFaceScrollbar();
  }

  protected dragUsesMinimumMovementThreshold(): boolean {
    return !this.pinned;
  }

  protected onDragCommitted() {
    if (!this.pinned) {
      // Pulling away from the dock — hide the dock toggle until closed or re-docked.
      // Don't replay the show animation: the panel is already visible, and the
      // entrance keyframes start at opacity: 0 (brief flash).
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

  protected override onDragMove() {
    if (!this.canPreviewDockHover()) {
      this.clearDockHover();
      return;
    }
    this.setDockHover(this.isOverTopDock());
  }

  protected override onDragEnded() {
    this.clearDockHover();
  }

  /** Floating (pinned) non-popup panels preview a shrink when dragged over the dock. */
  protected canPreviewDockHover(): boolean {
    return this.pinned && !this.hasAttribute("data-popup");
  }

  private setDockHover(over: boolean) {
    if (over) this.setAttribute("dock-hover", "");
    else this.removeAttribute("dock-hover");
  }

  private clearDockHover() {
    this.removeAttribute("dock-hover");
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

  /** Hit-test the drag pointer against the top dock bounds for re-dock drops. */
  protected isOverTopDock(): boolean {
    const dock = document.querySelector<HTMLElement>("flipcel-top-bar-panel");
    if (!dock || dock.style.display === "none") return false;

    const dockRect = dock.getBoundingClientRect();
    // Small slack so the drop feels forgiving without growing into a large zone.
    const pad = 8;
    const { x, y } = this.dragClient;
    return (
      x >= dockRect.left - pad &&
      x <= dockRect.right + pad &&
      y >= dockRect.top - pad &&
      y <= dockRect.bottom + pad
    );
  }

  hidePanel() {
    this.clearShowAnimation();
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

  private showAnimationClearTimeout: ReturnType<typeof setTimeout> | null = null;
  private showAnimationTarget: HTMLElement | null = null;

  private onShowAnimationEnd = (e: AnimationEvent) => {
    if (e.animationName !== FLIPCEL_PANEL_SHOW_KEYFRAMES) return;
    this.clearShowAnimation();
  };

  private clearShowAnimation() {
    if (this.showAnimationClearTimeout !== null) {
      clearTimeout(this.showAnimationClearTimeout);
      this.showAnimationClearTimeout = null;
    }
    this.showAnimationTarget?.removeEventListener("animationend", this.onShowAnimationEnd);
    this.showAnimationTarget = null;
    this.removeAttribute("showing");
  }

  /**
   * Shrink the panel if it exceeds the viewport, and nudge pixel-positioned
   * hosts back on-screen. Called when panels spawn via {@link playShowAnimation}.
   */
  fitToViewport(margin = 8) {
    if (this.style.display === "none") return;

    const maxW = Math.max(120, window.innerWidth - margin * 2);
    const maxH = Math.max(120, window.innerHeight - margin * 2);
    const rect = this.getBoundingClientRect();
    if (rect.width < 1 && rect.height < 1) return;

    const width = this.blockWidth ?? rect.width;
    const height = this.blockHeight ?? rect.height;

    if (width > maxW) this.blockWidth = maxW;
    if (height > maxH) this.blockHeight = maxH;

    const fittedW = Math.min(width, maxW);
    const fittedH = Math.min(height, maxH);

    // Only adjust explicit pixel placement (dock CSS vars stay alone).
    if (this.style.left) {
      const left = parseFloat(this.style.left);
      if (!Number.isNaN(left)) {
        const maxLeft = window.innerWidth - fittedW - margin;
        if (left > maxLeft) this.style.left = `${Math.max(margin, maxLeft)}px`;
        else if (left < margin) this.style.left = `${margin}px`;
      }
    }
    if (this.style.top) {
      const top = parseFloat(this.style.top);
      if (!Number.isNaN(top)) {
        const maxTop = window.innerHeight - fittedH - margin;
        if (top > maxTop) this.style.top = `${Math.max(margin, maxTop)}px`;
        else if (top < margin) this.style.top = `${margin}px`;
      }
    }
  }

  /**
   * Play the overshoot entrance on a newly visible panel.
   * Call after setting `display` (and any anchoring) so the first paint can animate.
   */
  playShowAnimation() {
    if (!this.playsShowAnimation()) return;
    if (this.style.display === "none") return;

    this.fitToViewport();

    this.clearShowAnimation();
    // Force restart if shown again quickly.
    void this.offsetWidth;
    this.setAttribute("showing", "");

    const block = this.renderRoot.querySelector<HTMLElement>(".block");
    if (block) {
      this.showAnimationTarget = block;
      block.addEventListener("animationend", this.onShowAnimationEnd);
    }
    this.showAnimationClearTimeout = setTimeout(() => {
      this.showAnimationClearTimeout = null;
      this.clearShowAnimation();
    }, FLIPCEL_MOTION_OVERSHOOT_MS + 80);
  }

  /** Docks / always-on chrome can opt out. */
  protected playsShowAnimation(): boolean {
    return true;
  }

  protected override getFaceScrollbarMount(): HTMLElement | null {
    return (
      this.renderRoot.querySelector<HTMLElement>(".panel-body") ??
      super.getFaceScrollbarMount()
    );
  }

  protected override getFaceHScrollbarMount(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>(".panel-footer");
  }

  protected override getFaceScrollTarget(): HTMLElement | null {
    return (
      this.renderRoot.querySelector<HTMLElement>(".panel-body > .face") ??
      super.getFaceScrollTarget()
    );
  }

  /** Standard floating-panel shell: chrome header + scrollable body + footer. */
  protected renderFloatingBlock(
    title: string | undefined,
    content: TemplateResult,
    footer?: TemplateResult | typeof nothing,
  ) {
    return html`
      <div class="block">
        ${this.renderDragHandlePill(title)}
        <div class="panel-body">
          <div class="face">
            <div class="panel-form">${content}</div>
          </div>
        </div>
        ${this.renderPanelFooter(footer)}
      </div>
    `;
  }

  /**
   * Compact bottom chrome under the scrollable face (scrollbar-gutter tall).
   * Hosts resize handles + the horizontal face scrollbar; subclasses can
   * pass extra content or override `renderPanelFooterContent()`.
   */
  protected renderPanelFooter(content?: TemplateResult | typeof nothing) {
    const inner = content === undefined ? this.renderPanelFooterContent() : content;
    return html`
      <div class="panel-footer">
        ${this.renderResizeHandles()}
        ${inner !== nothing
          ? html`<div class="panel-footer-content">${inner}</div>`
          : nothing}
      </div>
    `;
  }

  /** Optional footer actions / status. Default is chrome-only (+ h-scrollbar). */
  protected renderPanelFooterContent(): TemplateResult | typeof nothing {
    return nothing;
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

  /** Panels that support compact mini-window mode opt in here. */
  protected showsMiniToggle(): boolean {
    return false;
  }

  private persistModeSize(mode: "full" | "mini") {
    const rect = this.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    this.modeSizes[mode] = { width: rect.width, height: rect.height };
  }

  private applyModeSize(mode: "full" | "mini") {
    const saved = this.modeSizes[mode];
    if (!saved) return;
    this.blockWidth = saved.width;
    this.blockHeight = saved.height;
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    super.willUpdate(changed);
    if (!this.showsMiniToggle() || !changed.has("mini")) return;
    const prev = changed.get("mini") as boolean | undefined;
    // Initial render — nothing to swap yet.
    if (prev === undefined) return;
    // Layout still reflects the previous mode; stash it, then restore the other.
    this.persistModeSize(prev ? "mini" : "full");
    this.applyModeSize(this.mini ? "mini" : "full");
  }

  /**
   * Title bar row: title (left), drag pill (center), mini + close (right).
   * Close is always shown when `showPinnedClose` is set (not gated on detach).
   */
  protected renderDragHandlePill(title?: string) {
    const showClose = this.showPinnedClose;
    const showMini = this.showsMiniToggle();
    const showPill = this.draggable && this.showsDragHandlePill();
    // Whole top bar (pill + title chrome) is the move handle when draggable.
    const headerDraggable =
      this.draggable && (showPill || this.headerActsAsDragHandle());
    if (!showPill && !headerDraggable && !title && !showClose && !showMini) {
      return html``;
    }

    return html`
      <div
        class="panel-header ${title ? "has-title" : ""} ${showMini ? "has-mini" : ""} ${showClose ? "has-close" : ""} ${headerDraggable ? "is-drag-handle" : ""}"
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
          ${showMini ? this.renderPanelMiniToggle() : nothing}
          ${showClose ? this.renderPanelClose() : nothing}
        </div>
      </div>
    `;
  }

  protected renderPanelTitle(title: string) {
    return html`<h3 class="panel-title"><span>${title}</span></h3>`;
  }

  protected renderPanelMiniToggle() {
    return html`
      <button
        type="button"
        class="panel-header-mini"
        title=${this.mini ? "Expand panel" : "Mini window — hide secondary sections"}
        aria-label=${this.mini ? "Expand panel" : "Mini window"}
        aria-pressed=${this.mini ? "true" : "false"}
        data-interactive
        @click=${(e: Event) => {
          e.stopPropagation();
          this.mini = !this.mini;
        }}
      >
        ${phosphorIcon("mini-window", 14)}
      </button>
    `;
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
