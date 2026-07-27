import { LitElement, html, css, nothing } from "lit";
import type { InkwellScrollbar } from "./scrollbar";
import { property } from "lit/decorators.js";
import {
  INKWELL_MOTION_BOUNCE_MS,
  INKWELL_PANEL_SNAP_ANIMATION,
  INKWELL_PANEL_SNAP_BACK_KEYFRAMES,
} from "../motion";

// ============================================================
// Base Block Component
// ============================================================

type ResizeCorner = "left" | "right" | null;

export class Block extends LitElement {
  @property({ type: Boolean, reflect: true }) active = false;
  @property({ type: Boolean }) draggable = false;
  @property({ type: Boolean }) resizable = false;
  @property({ type: Number }) blockWidth: number | null = null;
  @property({ type: Number }) blockHeight: number | null = null;

  /** Pointer movement below this (px) ends drag without committing (click / jitter). */
  private static readonly DRAG_COMMIT_MIN_PX = 12;

  // Drag state
  private _isDragging = false;
  private _dragOffset = { x: 0, y: 0 };
  private _dragPointerStart = { x: 0, y: 0 };
  private _dragLastClient = { x: 0, y: 0 };
  private _dragStyleSnapshot: {
    left: string;
    top: string;
    right: string;
    bottom: string;
    zIndex: string;
  } | null = null;

  private _snapBackClearTimeout: ReturnType<typeof setTimeout> | null = null;

  private _onSnapBackAnimationEnd = (e: AnimationEvent) => {
    if (e.animationName !== INKWELL_PANEL_SNAP_BACK_KEYFRAMES) return;
    this.removeEventListener("animationend", this._onSnapBackAnimationEnd);
    this._finishSnapBackAnimationCleanup();
  };

  // Resize state (protected for subclass override)
  protected _isResizing = false;
  protected _resizeCorner: ResizeCorner = null;
  protected _resizeStart = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };

  static styles = css`
    :host {
      /* Design tokens */
      --block-depth: 7px;
      /* Corner resize hit zone (taller/wider than the visible depth lip). */
      --block-resize-hit: 22px;
      --block-depth-color: var(--inkwell-panel-depth, #bcbcbc);
      --block-border: var(--inkwell-panel-border, #555555);
      --block-radius: 10px;
      --block-face-bg: var(--inkwell-panel-surface, #ffffff);
      --block-face-padding: 10px;
      --block-font: var(--inkwell-font, system-ui, sans-serif);
      --block-font-size: 12px;
      --block-font-weight: 500;
      --block-font-color: var(--inkwell-text-secondary, #6b6b6b);
      --scrollbar-size: 8px;
      --scrollbar-gutter: calc(var(--scrollbar-size) + 4px);

      display: block;
      box-sizing: border-box;
      padding: 0;
      font-family: var(--block-font);
      font-size: var(--block-font-size);
      font-weight: var(--block-font-weight);
      line-height: 1.35;
      color: var(--block-font-color);
    }

    /* Native scrollbars are hidden everywhere; scrolling surfaces get a
       guttered <inkwell-scrollbar> instead (see ensureFaceScrollbar). */
    :host,
    * {
      scrollbar-width: none;
    }

    *::-webkit-scrollbar {
      display: none;
    }

    /* Vertical scrollbar gutter for the .face scroller, injected by the
       base class so every panel gets it for free. */
    .face-scrollbar {
      position: absolute;
      top: 8px;
      bottom: calc(var(--block-depth) + 8px);
      right: 4px;
      z-index: 30;
    }

    .face[data-vscroll-gutter] {
      padding-right: calc(var(--block-face-padding) + var(--scrollbar-gutter));
    }

    :host([dragging]) {
      cursor: grabbing;
      user-select: none;
    }

    :host([resizing]) {
      user-select: none;
    }

    .block {
      box-sizing: border-box;
      background: var(--block-depth-color);
      border: 2px solid var(--block-border);
      border-radius: var(--block-radius);
      padding: 0 0 var(--block-depth) 0;
      height: 100%;
      box-shadow: var(--inkwell-shadow-panel, 0 0 10px rgba(5, 0, 0, 0.3));
      position: relative;
      overflow: hidden;
    }

    .face {
      position: relative;
      box-sizing: border-box;
      background: var(--block-face-bg);
      border-radius: calc(var(--block-radius) - 2px);
      padding: var(--block-face-padding);
      height: 100%;
      /* Clip to radius only — do NOT use overflow:auto here. That makes every
         Block (including blocky-button) a wheel scrollport and breaks scroll
         chaining to real parents. Panels opt into scrolling in FloatingPanel. */
      overflow: hidden;
    }

    /* Resize corners live inside .face: above the face fill, under content. */
    .resize-left,
    .resize-right {
      position: absolute;
      /* Reach into the block depth lip below the face. */
      bottom: calc(-1 * var(--block-depth));
      width: max(32px, 30%);
      height: var(--block-resize-hit);
      z-index: 1;
    }

    /* Panel body / slotted chrome sits above the resize hit zones. */
    .panel-form,
    .face-content {
      position: relative;
      z-index: 2;
    }

    slot::slotted(*) {
      position: relative;
      z-index: 2;
    }

    .resize-left {
      left: 0;
      cursor: nesw-resize;
      border-bottom-left-radius: calc(var(--block-radius) - 2px);
    }

    .resize-right {
      right: 0;
      cursor: nwse-resize;
      border-bottom-right-radius: calc(var(--block-radius) - 2px);
    }

    /* Same timing breakpoints as .floating-close (0 / 55 / 78 / 100%) — overshoot + settle on translate */
    @keyframes inkwell-panel-snap-back {
      0% {
        transform: translate(var(--inkwell-snap-x, 0px), var(--inkwell-snap-y, 0px));
      }
      55% {
        transform: translate(
          calc(var(--inkwell-snap-x, 0px) * -0.1),
          calc(var(--inkwell-snap-y, 0px) * -0.1)
        );
      }
      78% {
        transform: translate(
          calc(var(--inkwell-snap-x, 0px) * 0.04),
          calc(var(--inkwell-snap-y, 0px) * 0.04)
        );
      }
      100% {
        transform: translate(0, 0);
      }
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener("pointerdown", this._onPointerDown);
    this.addEventListener("pointermove", this._onPointerHover);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("pointerdown", this._onPointerDown);
    this.removeEventListener("pointermove", this._onPointerHover);
    this._finishSnapBackAnimationCleanup();
    this._cleanupDrag();
    this._cleanupResize();
  }

  protected _isWhitespaceTarget(e: PointerEvent): boolean {
    const path = e.composedPath();

    // Compact popups: drag from a title-bar handle unless an interactive child was hit.
    for (const el of path) {
      if (el === this) break;
      if (el instanceof HTMLElement) {
        if (el.hasAttribute("data-interactive")) return false;
        const tag = el.tagName.toLowerCase();
        if (tag === "button" || tag === "input" || tag === "blocky-button") return false;
        if (el.hasAttribute("data-drag-handle")) return true;
      }
    }

    const blockEl = this.renderRoot.querySelector(".block");
    const faceEl = this.renderRoot.querySelector(".face");

    for (const el of path) {
      if (el === blockEl || el === faceEl) return true;
      if (el === this) return true;
      if (el instanceof HTMLElement) {
        // Block if element is explicitly marked as interactive
        if (el.hasAttribute("data-interactive")) {
          return false;
        }
        const tag = el.tagName.toLowerCase();
        if (tag === "button" || tag === "input" || tag === "blocky-button") {
          return false;
        }
        if (tag === "h3" || tag === "span" || tag === "p") continue;
      }
    }
    return false;
  }

  private _getResizeCorner(e: PointerEvent): ResizeCorner {
    if (!this.resizable) return null;

    // Only the dedicated handle elements count — geometric hit-testing used
    // to steal clicks from face content where the oversized zones overlap.
    for (const node of e.composedPath()) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.classList.contains("resize-left")) return "left";
      if (node.classList.contains("resize-right")) return "right";
    }
    return null;
  }

  private _onPointerHover = (e: PointerEvent) => {
    if (this._isDragging || this._isResizing) return;

    const corner = this._getResizeCorner(e);
    if (corner === "left") {
      this.style.cursor = "nesw-resize";
    } else if (corner === "right") {
      this.style.cursor = "nwse-resize";
    } else {
      this.style.cursor = "";
    }
  };

  private _onPointerDown = (e: PointerEvent) => {
    // Check for resize first
    const corner = this._getResizeCorner(e);
    if (corner) {
      this._startResize(e, corner);
      return;
    }

    // Otherwise, handle drag
    if (!this.draggable) return;
    if (!this._isWhitespaceTarget(e)) return;
    this._startDrag(e);
  };

  // ============================================================
  // Drag Logic
  // ============================================================

  private _startDrag(e: PointerEvent) {
    e.preventDefault();
    this._isDragging = true;
    this.setAttribute("dragging", "");

    this._dragPointerStart = { x: e.clientX, y: e.clientY };
    this._dragLastClient = { x: e.clientX, y: e.clientY };
    this._dragStyleSnapshot = {
      left: this.style.getPropertyValue("left"),
      top: this.style.getPropertyValue("top"),
      right: this.style.getPropertyValue("right"),
      bottom: this.style.getPropertyValue("bottom"),
      zIndex: this.style.getPropertyValue("z-index"),
    };

    // Bring panel to top
    const allPanels = document.querySelectorAll<HTMLElement>("[data-panel]");
    let maxZIndex = 1000;
    allPanels.forEach((panel) => {
      const zIndex = parseInt(
        window.getComputedStyle(panel).zIndex || "1000",
        10
      );
      if (zIndex > maxZIndex) maxZIndex = zIndex;
    });
    this.style.zIndex = `${maxZIndex + 1}`;

    const rect = this.getBoundingClientRect();
    this._dragOffset = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };

    window.addEventListener("pointermove", this._onDragMove);
    window.addEventListener("pointerup", this._onDragEnd);
    window.addEventListener("pointercancel", this._onDragEnd);
  }

  private _onDragMove = (e: PointerEvent) => {
    if (!this._isDragging) return;

    this._dragLastClient = { x: e.clientX, y: e.clientY };

    const newLeft = e.clientX - this._dragOffset.x;
    const newTop = e.clientY - this._dragOffset.y;

    this.style.left = `${newLeft}px`;
    this.style.top = `${newTop}px`;
    this.style.right = "auto";
    this.style.bottom = "auto";
  };

  private _clearSnapBackTimeout() {
    if (this._snapBackClearTimeout !== null) {
      clearTimeout(this._snapBackClearTimeout);
      this._snapBackClearTimeout = null;
    }
  }

  private _finishSnapBackAnimationCleanup() {
    this._clearSnapBackTimeout();
    this.removeEventListener("animationend", this._onSnapBackAnimationEnd);
    this.style.removeProperty("animation");
    this.style.removeProperty("transform");
    this.style.removeProperty("--inkwell-snap-x");
    this.style.removeProperty("--inkwell-snap-y");
  }

  private _restorePreDragLayout(
    snap: {
      left: string;
      top: string;
      right: string;
      bottom: string;
      zIndex: string;
    },
  ) {
    const apply = (prop: "left" | "top" | "right" | "bottom" | "zIndex", val: string) => {
      const css = prop === "zIndex" ? "z-index" : prop;
      if (val.trim()) this.style.setProperty(css, val);
      else this.style.removeProperty(css);
    };
    apply("left", snap.left);
    apply("top", snap.top);
    apply("right", snap.right);
    apply("bottom", snap.bottom);
    apply("zIndex", snap.zIndex);
  }

  private _onDragEnd = () => {
    const snapshot = this._dragStyleSnapshot;

    const dx = this._dragLastClient.x - this._dragPointerStart.x;
    const dy = this._dragLastClient.y - this._dragPointerStart.y;
    const useMoveThreshold = this.dragUsesMinimumMovementThreshold();
    const movedEnough =
      !useMoveThreshold ||
      Math.hypot(dx, dy) >= Block.DRAG_COMMIT_MIN_PX;

    this._dragStyleSnapshot = null;

    if (movedEnough) {
      this._applyPercentagePosition();
      this.onDragCommitted();
      this._cleanupDrag();
      return;
    }

    this._cleanupDrag();

    if (!snapshot) return;

    const rectBefore = this.getBoundingClientRect();
    this._restorePreDragLayout(snapshot);
    const rectAfter = this.getBoundingClientRect();
    const sx = rectBefore.left - rectAfter.left;
    const sy = rectBefore.top - rectAfter.top;

    this.style.setProperty("--inkwell-snap-x", `${sx}px`);
    this.style.setProperty("--inkwell-snap-y", `${sy}px`);

    this.removeEventListener("animationend", this._onSnapBackAnimationEnd);
    this.addEventListener("animationend", this._onSnapBackAnimationEnd);

    requestAnimationFrame(() => {
      this.style.animation = INKWELL_PANEL_SNAP_ANIMATION;
    });

    this._clearSnapBackTimeout();
    this._snapBackClearTimeout = setTimeout(() => {
      this._snapBackClearTimeout = null;
      this._finishSnapBackAnimationCleanup();
    }, INKWELL_MOTION_BOUNCE_MS + 200);
  };

  private _applyPercentagePosition() {
    const rect = this.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const nearLeft = centerX < vw / 2;
    const nearTop = centerY < vh / 2;

    if (nearLeft) {
      const leftPercent = (rect.left / vw) * 100;
      this.style.left = `${leftPercent}%`;
      this.style.right = "auto";
    } else {
      const rightPercent = ((vw - rect.right) / vw) * 100;
      this.style.right = `${rightPercent}%`;
      this.style.left = "auto";
    }

    if (nearTop) {
      const topPercent = (rect.top / vh) * 100;
      this.style.top = `${topPercent}%`;
      this.style.bottom = "auto";
    } else {
      const bottomPercent = ((vh - rect.bottom) / vh) * 100;
      this.style.bottom = `${bottomPercent}%`;
      this.style.top = "auto";
    }
  }

  private _cleanupDrag() {
    this._isDragging = false;
    this.removeAttribute("dragging");
    window.removeEventListener("pointermove", this._onDragMove);
    window.removeEventListener("pointerup", this._onDragEnd);
    window.removeEventListener("pointercancel", this._onDragEnd);
  }

  // ============================================================
  // Resize Logic
  // ============================================================

  private _startResize(e: PointerEvent, corner: ResizeCorner) {
    e.preventDefault();
    e.stopPropagation();

    this._isResizing = true;
    this._resizeCorner = corner;
    this.setAttribute("resizing", "");

    const rect = this.getBoundingClientRect();
    this._resizeStart = {
      x: e.clientX,
      y: e.clientY,
      width: rect.width,
      height: rect.height,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    };

    // Switch to pixel positioning immediately so resize works correctly
    // regardless of which corner the panel was anchored to
    this.style.left = `${rect.left}px`;
    this.style.top = `${rect.top}px`;
    this.style.right = "auto";
    this.style.bottom = "auto";

    // Initialize blockWidth/blockHeight if not set
    if (this.blockWidth === null) this.blockWidth = rect.width;
    if (this.blockHeight === null) this.blockHeight = rect.height;

    // Bring panel to top
    const allPanels = document.querySelectorAll<HTMLElement>("[data-panel]");
    let maxZIndex = 1000;
    allPanels.forEach((panel) => {
      const zIndex = parseInt(
        window.getComputedStyle(panel).zIndex || "1000",
        10
      );
      if (zIndex > maxZIndex) maxZIndex = zIndex;
    });
    this.style.zIndex = `${maxZIndex + 1}`;

    window.addEventListener("pointermove", this._onResizeMove);
    window.addEventListener("pointerup", this._onResizeEnd);
  }

  protected getResizeMinWidth(): number {
    return 100;
  }

  protected getResizeMinHeight(_width: number): number {
    return 80;
  }

  protected getResizeMaxHeight(_width: number): number {
    return Number.POSITIVE_INFINITY;
  }

  protected _onResizeMove = (e: PointerEvent) => {
    if (!this._isResizing) return;

    const minWidth = this.getResizeMinWidth();

    // Calculate new bounds based on which corner is being dragged
    // The dragged corner follows the cursor, opposite corner stays fixed
    let newLeft = this._resizeStart.left;
    let newTop = this._resizeStart.top;
    let newRight = this._resizeStart.right;
    let newBottom = e.clientY; // Bottom always follows cursor Y for bottom corners

    if (this._resizeCorner === "right") {
      // Right corner: right edge follows cursor X, left edge stays fixed
      newRight = e.clientX;
    } else if (this._resizeCorner === "left") {
      // Left corner: left edge follows cursor X, right edge stays fixed
      newLeft = e.clientX;
    }

    // Calculate new dimensions
    let newWidth = newRight - newLeft;
    let newHeight = newBottom - newTop;

    // Enforce minimums
    if (newWidth < minWidth) {
      if (this._resizeCorner === "left") {
        newLeft = newRight - minWidth;
      }
      newWidth = minWidth;
    }

    const minHeight = this.getResizeMinHeight(newWidth);
    if (newHeight < minHeight) {
      newHeight = minHeight;
    }
    newHeight = Math.min(newHeight, this.getResizeMaxHeight(newWidth));

    // Apply position and size
    this.style.left = `${newLeft}px`;
    this.style.top = `${newTop}px`;
    this.blockWidth = newWidth;
    this.blockHeight = newHeight;

    this.requestUpdate();
  };

  private _onResizeEnd = () => {
    this._applyPercentagePosition();
    this._cleanupResize();
  };

  /**
   * When true, a drag shorter than DRAG_COMMIT_MIN_PX is reverted (e.g. dock-attached panels).
   * Floating panels should return false so any drag commits.
   */
  protected dragUsesMinimumMovementThreshold(): boolean {
    return false;
  }

  protected onDragCommitted() {
    // Subclasses can react when a drag operation commits a new position.
  }

  private _cleanupResize() {
    this._isResizing = false;
    this._resizeCorner = null;
    this.removeAttribute("resizing");
    window.removeEventListener("pointermove", this._onResizeMove);
    window.removeEventListener("pointerup", this._onResizeEnd);
  }

  updated(changedProperties: Map<string, unknown>) {
    super.updated(changedProperties);
    // Apply dimensions directly to host element style
    if (changedProperties.has("blockWidth") || changedProperties.has("blockHeight")) {
      if (this.blockWidth !== null) {
        this.style.width = `${this.blockWidth}px`;
      } else {
        this.style.removeProperty("width");
      }
      if (this.blockHeight !== null) {
        this.style.height = `${this.blockHeight}px`;
      } else {
        this.style.removeProperty("height");
      }
    }
    this.ensureFaceScrollbar();
  }

  protected faceScrollbar: InkwellScrollbar | null = null;

  /**
   * Opt-in face scrollbar. Default off so compact Blocks (buttons) are not
   * scroll containers. FloatingPanel turns this on for scrollable panels.
   */
  protected usesFaceScrollbar(): boolean {
    return false;
  }

  protected getFaceScrollbarMount(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>(".block");
  }

  protected getFaceScrollTarget(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>(".face");
  }

  protected ensureFaceScrollbar() {
    if (!this.usesFaceScrollbar()) {
      this.faceScrollbar?.remove();
      this.faceScrollbar = null;
      return;
    }
    const mount = this.getFaceScrollbarMount();
    const face = this.getFaceScrollTarget();
    if (!mount || !face) return;
    if (!this.faceScrollbar || this.faceScrollbar.parentElement !== mount) {
      const bar = document.createElement("inkwell-scrollbar") as InkwellScrollbar;
      bar.orientation = "vertical";
      bar.classList.add("face-scrollbar");
      bar.setAttribute("data-interactive", "");
      mount.appendChild(bar);
      this.faceScrollbar = bar;
    }
    this.faceScrollbar.target = face;
  }

  /** Corner resize hit targets — render inside `.face`, under content. */
  protected renderResizeHandles() {
    if (!this.resizable) return nothing;
    return html`
      <div class="resize-left"></div>
      <div class="resize-right"></div>
    `;
  }

  render() {
    return html`
      <div class="block">
        <div class="face">
          ${this.renderResizeHandles()}
          <slot></slot>
        </div>
      </div>
    `;
  }
}
