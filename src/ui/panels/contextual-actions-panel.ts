import { LitElement, html, css, nothing, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { ContextualActionMenuItem } from "../../editing/contextual-actions";

// ============================================================
// Functions Panel (appears on selection)
// ============================================================

@customElement("inkwell-functions-panel")
export class InkwellFunctionsPanel extends LitElement {
  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: Number }) x = 0;
  @property({ type: Number }) y = 0;
  @property({ attribute: false }) functions: ContextualActionMenuItem[] = [];
  private activeDrag:
    | {
        id: string;
        pointerId: number;
        startX: number;
        startY: number;
        dragging: boolean;
      }
    | null = null;
  private suppressClickForId: string | null = null;

  private _outsideClickHandler = (e: PointerEvent) => {
    if (!this.open) return;
    const path = e.composedPath();
    if (!path.includes(this)) {
      this.dismiss();
    }
  };

  static styles = css`
    :host {
      position: fixed;
      z-index: 2000;
      display: none;
      font-family: var(--inkwell-font, system-ui, sans-serif);
      font-size: 12px;
      font-weight: 600;
      color: var(--inkwell-text-secondary, #6b6b6b);
    }

    :host([open]) {
      display: block;
    }

    .fn-shell {
      background: var(--inkwell-panel-depth, #bcbcbc);
      border: var(--inkwell-block-border-width, 0px) solid var(--inkwell-panel-border, #555555);
      border-radius: var(--inkwell-block-radius);
      padding: 0;
      box-shadow: var(--inkwell-shadow-panel, 0 0 10px rgba(5, 0, 0, 0.3));
      position: relative;
      overflow: hidden;
      min-width: 0;
      animation: fn-pop-in 180ms cubic-bezier(0.34, 1.25, 0.64, 1) both;
    }

    @keyframes fn-pop-in {
      0% { transform: scale(0.85); opacity: 0; }
      100% { transform: scale(1); opacity: 1; }
    }

    .fn-face {
      background: var(--inkwell-panel-surface, rgba(255, 253, 249, 0.94));
      border-radius: calc(
        var(--inkwell-block-radius) - var(--inkwell-block-border-width, 0px)
      );
      padding: 4px;
      display: flex;
      align-items: center;
      gap: 2px;
    }

    .fn-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 3px;
      min-height: 28px;
      padding: 5px 8px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--inkwell-text-primary, #1a1a1a);
      font: inherit;
      line-height: 1;
      white-space: nowrap;
      cursor: pointer;
      transition: background 80ms ease;
    }

    .fn-btn.draggable {
      cursor: grab;
    }

    .fn-btn:hover {
      background: var(--inkwell-accent-muted, rgba(77, 115, 215, 0.28));
    }

    .fn-btn.negative { color: var(--inkwell-negative, #af5b5b); }
    .fn-btn.negative:hover { background: var(--inkwell-panel-active-negative, rgba(255, 122, 122, 0.58)); }

    .fn-drag-hint {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: -0.04em;
      opacity: 0.55;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("pointerdown", this._outsideClickHandler, true);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("pointerdown", this._outsideClickHandler, true);
  }

  show(x: number, y: number) {
    this.x = x;
    this.y = y;
    this.open = true;
    requestAnimationFrame(() => this.clampPosition());
  }

  setPosition(x: number, y: number) {
    this.x = x;
    this.y = y;
    if (this.open) {
      this.clampPosition();
    }
  }

  dismiss() {
    this.close("dismissed");
  }

  close(reason: "dismissed" | "hidden" = "hidden") {
    this.open = false;
    this.dispatchEvent(new CustomEvent("functions-close", {
      detail: { reason },
      bubbles: true,
      composed: true,
    }));
  }

  private clampPosition() {
    const margin = 8;
    const rect = this.getBoundingClientRect();
    const w = rect.width || 160;
    const h = rect.height || 120;
    let left = this.x - w / 2;
    let top = this.y;
    if (left + w > window.innerWidth - margin) left = window.innerWidth - margin - w;
    if (top + h > window.innerHeight - margin) top = window.innerHeight - margin - h;
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    this.style.left = `${left}px`;
    this.style.top = `${top}px`;
  }

  updated(changed: PropertyValues) {
    super.updated(changed);
    if (changed.has("x") || changed.has("y") || changed.has("open")) {
      this.clampPosition();
    }
  }

  private onFunction(id: string) {
    if (this.suppressClickForId === id) {
      this.suppressClickForId = null;
      return;
    }
    this.dispatchEvent(new CustomEvent("function-invoke", {
      detail: { id },
      bubbles: true,
      composed: true,
    }));
    this.close("hidden");
  }

  private onFunctionPointerDown(fn: ContextualActionMenuItem, e: PointerEvent) {
    if (!fn.draggable) return;
    this.activeDrag = {
      id: fn.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  private onFunctionPointerMove(fn: ContextualActionMenuItem, e: PointerEvent) {
    if (!fn.draggable || !this.activeDrag || this.activeDrag.id !== fn.id || this.activeDrag.pointerId !== e.pointerId) {
      return;
    }

    const dx = e.clientX - this.activeDrag.startX;
    const dy = e.clientY - this.activeDrag.startY;
    const dragDistanceSq = dx * dx + dy * dy;
    if (!this.activeDrag.dragging && dragDistanceSq >= 25) {
      this.activeDrag.dragging = true;
      this.dispatchEvent(new CustomEvent("function-drag-start", {
        detail: { id: fn.id, dx, dy },
        bubbles: true,
        composed: true,
      }));
    }

    if (!this.activeDrag.dragging) return;

    this.dispatchEvent(new CustomEvent("function-drag-move", {
      detail: { id: fn.id, dx, dy },
      bubbles: true,
      composed: true,
    }));
  }

  private onFunctionPointerUp(fn: ContextualActionMenuItem, e: PointerEvent) {
    if (!fn.draggable || !this.activeDrag || this.activeDrag.id !== fn.id || this.activeDrag.pointerId !== e.pointerId) {
      return;
    }

    const dx = e.clientX - this.activeDrag.startX;
    const dy = e.clientY - this.activeDrag.startY;
    const wasDragging = this.activeDrag.dragging;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    this.activeDrag = null;

    if (!wasDragging) return;

    this.suppressClickForId = fn.id;
    this.dispatchEvent(new CustomEvent("function-drag-end", {
      detail: { id: fn.id, dx, dy },
      bubbles: true,
      composed: true,
    }));
  }

  private onFunctionPointerCancel(fn: ContextualActionMenuItem, e: PointerEvent) {
    if (!fn.draggable || !this.activeDrag || this.activeDrag.id !== fn.id || this.activeDrag.pointerId !== e.pointerId) {
      return;
    }
    const wasDragging = this.activeDrag.dragging;
    const dx = e.clientX - this.activeDrag.startX;
    const dy = e.clientY - this.activeDrag.startY;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    this.activeDrag = null;
    if (!wasDragging) return;
    this.suppressClickForId = fn.id;
    this.dispatchEvent(new CustomEvent("function-drag-end", {
      detail: { id: fn.id, dx, dy },
      bubbles: true,
      composed: true,
    }));
  }

  render() {
    return html`
      <div class="fn-shell">
        <div class="fn-face">
          ${this.functions.map(
            (fn) => html`
              <button
                type="button"
                class="fn-btn ${fn.negative ? "negative" : ""} ${fn.draggable ? "draggable" : ""}"
                title=${fn.draggable ? `${fn.name} (drag to place)` : fn.name}
                aria-label=${fn.name}
                @pointerdown=${(e: PointerEvent) => this.onFunctionPointerDown(fn, e)}
                @pointermove=${(e: PointerEvent) => this.onFunctionPointerMove(fn, e)}
                @pointerup=${(e: PointerEvent) => this.onFunctionPointerUp(fn, e)}
                @pointercancel=${(e: PointerEvent) => this.onFunctionPointerCancel(fn, e)}
                @click=${() => this.onFunction(fn.id)}
              >
                <span>${fn.name}</span>
                ${fn.draggable
                  ? html`<span class="fn-drag-hint" aria-hidden="true">↔↕</span>`
                  : nothing}
              </button>
            `
          )}
        </div>
      </div>
    `;
  }
}
