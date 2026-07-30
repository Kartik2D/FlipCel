import { LitElement, html, css, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";

// ============================================================
// Inkwell Scrollbar — generic custom scrollbar
// ============================================================

/**
 * A generic custom scrollbar that mirrors an external scroll container.
 *
 * Point it at a scroller either by assigning the `target` property or by
 * setting the `for` attribute to a selector resolved within the element's
 * root (document or shadow root). The component tracks the target's scroll
 * and size (including content growth), supports thumb dragging plus
 * track-jump, and hides itself while the content fits.
 *
 * Layout is left to the consumer: the host is a plain block that can be
 * placed in flow (like the timeline's frames scrollbar) or docked in a
 * gutter beside the scroll target (like panel faces).
 */
@customElement("inkwell-scrollbar")
export class InkwellScrollbar extends LitElement {
  /** Scroll axis this bar mirrors. */
  @property({ reflect: true }) orientation: "horizontal" | "vertical" =
    "horizontal";
  /** Selector for the scroll container, resolved in this element's root. */
  @property({ attribute: "for" }) forSelector = "";
  /**
   * Keep the bar visible when the content fits: the thumb stretches to
   * fill the whole track instead of the bar hiding itself.
   */
  @property({ type: Boolean, reflect: true }) persistent = false;
  /**
   * When true, reserves space on the scroll target so content does not sit
   * under the bar (sets `data-vscroll-gutter` / `data-hscroll-gutter`).
   */
  @property({ type: Boolean }) gutter = true;

  static styles = css`
    :host {
      --scrollbar-size: 8px;
      --scrollbar-gutter: calc(var(--scrollbar-size) + 8px);
      --scrollbar-track-bg: var(--block-depth-color, var(--inkwell-panel-depth, rgba(120, 120, 120, 0.16)));
      --scrollbar-thumb-bg: color-mix(
        in srgb,
        var(--block-border, #555555) 55%,
        transparent
      );
      --scrollbar-thumb-bg-hover: color-mix(
        in srgb,
        var(--block-border, #555555) 75%,
        transparent
      );
      display: block;
      position: relative;
      touch-action: none;
      cursor: pointer;
    }

    :host([orientation="horizontal"]) {
      height: var(--scrollbar-size);
    }

    :host([orientation="vertical"]) {
      width: var(--scrollbar-size);
    }

    :host([data-hidden]) {
      visibility: hidden;
    }

    .track {
      position: absolute;
      inset: 0;
      border-radius: 999px;
      background: var(--scrollbar-track-bg);
    }

    .thumb {
      position: absolute;
      border-radius: 999px;
      background: var(--scrollbar-thumb-bg);
      cursor: grab;
    }

    :host([orientation="horizontal"]) .thumb {
      top: 0;
      bottom: 0;
      left: 0;
      width: 24px;
    }

    :host([orientation="vertical"]) .thumb {
      left: 0;
      right: 0;
      top: 0;
      height: 24px;
    }

    .thumb:hover {
      background: var(--scrollbar-thumb-bg-hover);
    }

    .thumb:active {
      cursor: grabbing;
    }
  `;

  private _target: HTMLElement | null = null;
  /** Thumb-drag state: pointer position and scroll offset at drag start. */
  private drag: { start: number; startScroll: number } | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** Re-registers child resize observation when the target's children change. */
  private childListObserver: MutationObserver | null = null;

  /** The scroll container this bar mirrors. */
  get target(): HTMLElement | null {
    return this._target;
  }

  set target(el: HTMLElement | null) {
    if (el === this._target) return;
    this.detachFromTarget();
    this._target = el;
    this.attachToTarget();
  }

  private get horizontal(): boolean {
    return this.orientation !== "vertical";
  }

  connectedCallback() {
    super.connectedCallback();
    this.resolveForSelector();
    this.attachToTarget();
  }

  disconnectedCallback() {
    this.detachFromTarget();
    super.disconnectedCallback();
  }

  firstUpdated() {
    // `for` targets rendered after this element in the same template pass
    // may not have existed at connect time.
    if (!this._target) this.resolveForSelector();
    this.sync();
  }

  updated(changed: PropertyValues) {
    super.updated(changed);
    if (changed.has("forSelector")) this.resolveForSelector();
    if (changed.has("orientation") || changed.has("persistent") || changed.has("gutter")) {
      this.sync();
    }
  }

  private resolveForSelector() {
    if (!this.forSelector) return;
    const root = this.getRootNode() as Document | ShadowRoot;
    const el = root.querySelector?.(this.forSelector);
    if (el instanceof HTMLElement) this.target = el;
  }

  private attachToTarget() {
    const t = this._target;
    if (!t || !this.isConnected) return;
    t.addEventListener("scroll", this.onTargetScroll, { passive: true });
    this.resizeObserver = new ResizeObserver(() => this.sync());
    this.observeSizes();
    this.childListObserver = new MutationObserver(() => {
      this.observeSizes();
      this.sync();
    });
    this.childListObserver.observe(t, { childList: true });
    this.sync();
  }

  private detachFromTarget() {
    const t = this._target;
    if (t) this.clearGutterAttributes(t);
    this._target?.removeEventListener("scroll", this.onTargetScroll);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.childListObserver?.disconnect();
    this.childListObserver = null;
    this.drag = null;
  }

  /** Watches the bar, the viewport, and its children (content growth). */
  private observeSizes() {
    const ro = this.resizeObserver;
    const t = this._target;
    if (!ro || !t) return;
    ro.disconnect();
    ro.observe(this);
    ro.observe(t);
    for (const child of Array.from(t.children)) ro.observe(child);
  }

  private onTargetScroll = () => this.sync();

  private clearGutterAttributes(t: HTMLElement) {
    // Only clear this bar's axis — panels often mount both V and H bars
    // on the same scroll target.
    if (this.horizontal) {
      t.removeAttribute("data-hscroll-gutter");
    } else {
      t.removeAttribute("data-vscroll-gutter");
    }
  }

  private syncGutterAttributes(visible: boolean) {
    const t = this._target;
    if (!t) return;
    if (!this.gutter) {
      this.clearGutterAttributes(t);
      return;
    }
    if (this.horizontal) {
      t.toggleAttribute("data-hscroll-gutter", visible);
    } else {
      t.toggleAttribute("data-vscroll-gutter", visible);
    }
  }

  private thumbEl(): HTMLElement | null {
    return this.renderRoot?.querySelector<HTMLElement>(".thumb") ?? null;
  }

  /** Repaints the thumb from scroll geometry (no re-render). */
  private sync() {
    const t = this._target;
    const thumb = this.thumbEl();
    if (!t || !thumb) return;
    const h = this.horizontal;
    const view = h ? t.clientWidth : t.clientHeight;
    const content = h ? t.scrollWidth : t.scrollHeight;
    const needed = content > view + 1 && view > 0;
    const visible = needed || this.persistent;
    this.toggleAttribute("data-hidden", !visible);
    this.syncGutterAttributes(visible);
    if (!needed && !this.persistent) return;

    const trackLen = h ? this.clientWidth : this.clientHeight;
    const thumbLen = needed
      ? Math.min(trackLen, Math.max(24, (view / content) * trackLen))
      : trackLen;
    const maxScroll = Math.max(0, content - view);
    const travel = trackLen - thumbLen;
    const scrollPos = h ? t.scrollLeft : t.scrollTop;
    const offset = maxScroll > 0 ? (scrollPos / maxScroll) * travel : 0;
    if (h) {
      thumb.style.width = `${thumbLen}px`;
      thumb.style.transform = `translateX(${offset}px)`;
    } else {
      thumb.style.height = `${thumbLen}px`;
      thumb.style.transform = `translateY(${offset}px)`;
    }
  }

  private setScroll(value: number) {
    const t = this._target;
    if (!t) return;
    if (this.horizontal) t.scrollLeft = value;
    else t.scrollTop = value;
  }

  private onPointerDown = (e: PointerEvent) => {
    const t = this._target;
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    const track = e.currentTarget as HTMLElement;
    const thumb = this.thumbEl();
    track.setPointerCapture(e.pointerId);
    const h = this.horizontal;
    const pointer = h ? e.clientX : e.clientY;

    // Clicking the track (not the thumb) jumps so the thumb centers under
    // the pointer, then the same drag continues from there.
    if (thumb && e.composedPath()[0] !== thumb) {
      const trackRect = track.getBoundingClientRect();
      const thumbRect = thumb.getBoundingClientRect();
      const trackLen = h ? trackRect.width : trackRect.height;
      const thumbLen = h ? thumbRect.width : thumbRect.height;
      const trackStart = h ? trackRect.left : trackRect.top;
      const travel = Math.max(1, trackLen - thumbLen);
      const ratio = (pointer - trackStart - thumbLen / 2) / travel;
      const maxScroll = h
        ? t.scrollWidth - t.clientWidth
        : t.scrollHeight - t.clientHeight;
      this.setScroll(Math.max(0, Math.min(1, ratio)) * maxScroll);
    }
    this.drag = {
      start: pointer,
      startScroll: h ? t.scrollLeft : t.scrollTop,
    };
  };

  private onPointerMove = (e: PointerEvent) => {
    const drag = this.drag;
    const t = this._target;
    const thumb = this.thumbEl();
    if (!drag || !t || !thumb) return;
    e.preventDefault();
    const h = this.horizontal;
    const trackLen = h ? this.clientWidth : this.clientHeight;
    const thumbRect = thumb.getBoundingClientRect();
    const thumbLen = h ? thumbRect.width : thumbRect.height;
    const travel = Math.max(1, trackLen - thumbLen);
    const maxScroll = h
      ? t.scrollWidth - t.clientWidth
      : t.scrollHeight - t.clientHeight;
    const pointer = h ? e.clientX : e.clientY;
    this.setScroll(drag.startScroll + ((pointer - drag.start) * maxScroll) / travel);
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.drag) return;
    this.drag = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  render() {
    return html`
      <div
        class="track"
        part="track"
        @pointerdown=${this.onPointerDown}
        @pointermove=${this.onPointerMove}
        @pointerup=${this.onPointerUp}
        @pointercancel=${this.onPointerUp}
      >
        <div class="thumb" part="thumb"></div>
      </div>
    `;
  }
}
