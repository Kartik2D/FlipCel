import { getHelp, type HelpId } from "./catalog";
import type { FlipCelHelpPopup } from "../panels/help-popup";

const HELP_ATTR = "data-help";
const OWNS_HOLD_ATTR = "data-owns-long-press";
const SUPPRESS_CLICK_ATTR = "data-help-suppress-click";

/** Match tools-panel / timeline hold timing. */
const HOVER_SHOW_MS = 400;
const HOVER_HIDE_MS = 200;
const LONG_PRESS_MS = 400;
const MOVE_SLOP_PX = 10;

export type BindHelpOptions = {
  ownsLongPress?: boolean;
};

/**
 * Cursor hover + long-press (mouse and touch) help tips.
 *
 * If a control already owns long-press (`data-owns-long-press`), help never
 * steals that gesture — only hover can show a tip there.
 */
export class HelpController {
  readonly popup: FlipCelHelpPopup;

  private hoverShowTimer: ReturnType<typeof setTimeout> | null = null;
  private hoverHideTimer: ReturnType<typeof setTimeout> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;

  private hoverAnchor: HTMLElement | null = null;
  private holdAnchor: HTMLElement | null = null;
  private holdOrigin: { x: number; y: number } | null = null;
  private holdOpened = false;
  /** Tip was opened by hover — next cursor move dismisses it. */
  private hoverTipActive = false;
  private hoverShowPos: { x: number; y: number } | null = null;
  private lastPointerPos: { x: number; y: number } | null = null;
  private activeAnchor: HTMLElement | null = null;
  private suppressClickEl: HTMLElement | null = null;
  private pointerOverPopup = false;
  private holdListenersAttached = false;
  /** True while a pointer button is down — pause hover tracking. */
  private pointerDown = false;

  constructor(popup: FlipCelHelpPopup) {
    this.popup = popup;
    this.attach();
  }

  bindHelp(el: HTMLElement, helpId: HelpId | string, opts?: BindHelpOptions) {
    el.setAttribute(HELP_ATTR, helpId);
    if (opts?.ownsLongPress) el.setAttribute(OWNS_HOLD_ATTR, "");
    else el.removeAttribute(OWNS_HOLD_ATTR);
  }

  unbindHelp(el: HTMLElement) {
    el.removeAttribute(HELP_ATTR);
    el.removeAttribute(OWNS_HOLD_ATTR);
    if (this.activeAnchor === el || this.hoverAnchor === el) this.hide();
  }

  show(anchor: HTMLElement, helpId: string, source: "hover" | "hold" = "hover") {
    const entry = getHelp(helpId);
    if (!entry) return;
    this.clearHoverShowTimer();
    this.clearHoverHideTimer();
    this.activeAnchor = anchor;
    this.hoverTipActive = source === "hover";
    this.hoverShowPos =
      source === "hover" && this.lastPointerPos
        ? { ...this.lastPointerPos }
        : null;
    this.popup.helpId = entry.id;
    void this.popup.showNearAnchor(anchor);
  }

  hide() {
    this.clearHoverShowTimer();
    this.clearHoverHideTimer();
    this.clearHoldTimer();
    this.detachHoldListeners();
    this.activeAnchor = null;
    this.hoverAnchor = null;
    this.holdOpened = false;
    this.hoverTipActive = false;
    this.hoverShowPos = null;
    if (this.popup.style.display !== "none") {
      this.popup.hidePanel();
    }
  }

  private attach() {
    // Hit-test hover — avoids shadow-DOM mouseout killing the show timer.
    document.addEventListener("pointermove", this.onPointerMove, true);
    document.addEventListener("pointerdown", this.onPointerDown, true);
    document.addEventListener("pointerup", this.onPointerUpGlobal, true);
    document.addEventListener("pointercancel", this.onPointerUpGlobal, true);
    document.addEventListener("click", this.onClickCapture, true);

    this.popup.addEventListener("pointerenter", this.onPopupEnter);
    this.popup.addEventListener("pointerleave", this.onPopupLeave);
  }

  dispose() {
    document.removeEventListener("pointermove", this.onPointerMove, true);
    document.removeEventListener("pointerdown", this.onPointerDown, true);
    document.removeEventListener("pointerup", this.onPointerUpGlobal, true);
    document.removeEventListener("pointercancel", this.onPointerUpGlobal, true);
    document.removeEventListener("click", this.onClickCapture, true);
    this.detachHoldListeners();
    this.popup.removeEventListener("pointerenter", this.onPopupEnter);
    this.popup.removeEventListener("pointerleave", this.onPopupLeave);
    this.hide();
  }

  private onPopupEnter = () => {
    this.pointerOverPopup = true;
    this.clearHoverHideTimer();
  };

  private onPopupLeave = () => {
    this.pointerOverPopup = false;
    this.scheduleHoverHide();
  };

  private onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    this.lastPointerPos = { x: e.clientX, y: e.clientY };

    // Hover tip: any real cursor movement after it appears dismisses it.
    if (this.hoverTipActive && !this.holdOpened) {
      const origin = this.hoverShowPos;
      if (!origin) {
        this.hide();
        return;
      }
      const dx = e.clientX - origin.x;
      const dy = e.clientY - origin.y;
      if (dx * dx + dy * dy >= MOVE_SLOP_PX * MOVE_SLOP_PX) {
        this.hide();
        return;
      }
    }

    if (this.pointerDown || this.holdOpened) return;

    const el = this.helpTargetAtPoint(e.clientX, e.clientY);
    if (el === this.hoverAnchor) {
      this.clearHoverHideTimer();
      return;
    }

    if (el) {
      this.clearHoverHideTimer();
      this.hoverAnchor = el;
      const helpId = el.getAttribute(HELP_ATTR);
      if (!helpId || !getHelp(helpId)) return;
      this.clearHoverShowTimer();
      this.hoverShowTimer = setTimeout(() => {
        this.hoverShowTimer = null;
        if (this.hoverAnchor !== el || this.pointerDown) return;
        this.show(el, helpId, "hover");
      }, HOVER_SHOW_MS);
      return;
    }

    // Left help controls — keep tip if pointer is over the popup itself.
    if (this.pointerOverPopup) return;
    if (this.hoverAnchor || this.activeAnchor) {
      this.clearHoverShowTimer();
      this.scheduleHoverHide();
    }
  };

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;

    this.pointerDown = true;
    // Pressing cancels a pending hover tip.
    this.clearHoverShowTimer();

    const el = this.helpTargetFromEvent(e) ?? this.helpTargetAtPoint(e.clientX, e.clientY);
    if (!el) return;

    // Existing long-press wins: do not start help hold, and dismiss any tip
    // so only the control's own hold UI (e.g. tool settings) remains.
    if (this.elementOwnsLongPress(el)) {
      if (this.activeAnchor === el || this.hoverAnchor === el) {
        this.hide();
      } else {
        this.hoverAnchor = null;
      }
      return;
    }

    const helpId = el.getAttribute(HELP_ATTR);
    if (!helpId || !getHelp(helpId)) return;

    this.clearHoldTimer();
    this.holdOpened = false;
    this.holdAnchor = el;
    this.holdOrigin = { x: e.clientX, y: e.clientY };

    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (this.holdAnchor !== el) return;
      this.holdOpened = true;
      this.suppressClickEl = el;
      el.setAttribute(SUPPRESS_CLICK_ATTR, "");
      this.show(el, helpId, "hold");
      try {
        navigator.vibrate?.(10);
      } catch {
        /* ignore */
      }
    }, LONG_PRESS_MS);

    this.attachHoldListeners();
  };

  private onPointerUpGlobal = () => {
    this.pointerDown = false;
  };

  private onHoldMove = (e: PointerEvent) => {
    if (this.holdOpened) return;
    const origin = this.holdOrigin;
    if (!origin) return;
    const dx = e.clientX - origin.x;
    const dy = e.clientY - origin.y;
    if (dx * dx + dy * dy >= MOVE_SLOP_PX * MOVE_SLOP_PX) {
      this.clearHoldTimer();
      this.holdAnchor = null;
      this.holdOrigin = null;
      this.detachHoldListeners();
    }
  };

  private onHoldUp = () => {
    this.detachHoldListeners();
    if (!this.holdOpened) {
      this.clearHoldTimer();
      this.holdAnchor = null;
      this.holdOrigin = null;
    }
  };

  private attachHoldListeners() {
    if (this.holdListenersAttached) return;
    this.holdListenersAttached = true;
    window.addEventListener("pointermove", this.onHoldMove, true);
    window.addEventListener("pointerup", this.onHoldUp, true);
    window.addEventListener("pointercancel", this.onHoldUp, true);
  }

  private detachHoldListeners() {
    if (!this.holdListenersAttached) return;
    this.holdListenersAttached = false;
    window.removeEventListener("pointermove", this.onHoldMove, true);
    window.removeEventListener("pointerup", this.onHoldUp, true);
    window.removeEventListener("pointercancel", this.onHoldUp, true);
  }

  private onClickCapture = (e: MouseEvent) => {
    const el = this.suppressClickEl;
    if (!el) return;
    const path = e.composedPath();
    if (path.includes(el)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    el.removeAttribute(SUPPRESS_CLICK_ATTR);
    this.suppressClickEl = null;
  };

  private scheduleHoverHide() {
    this.clearHoverHideTimer();
    this.hoverHideTimer = setTimeout(() => {
      this.hoverHideTimer = null;
      if (this.pointerOverPopup || this.holdOpened) return;
      this.hoverAnchor = null;
      this.hide();
    }, HOVER_HIDE_MS);
  }

  private clearHoverShowTimer() {
    if (this.hoverShowTimer !== null) {
      clearTimeout(this.hoverShowTimer);
      this.hoverShowTimer = null;
    }
  }

  private clearHoverHideTimer() {
    if (this.hoverHideTimer !== null) {
      clearTimeout(this.hoverHideTimer);
      this.hoverHideTimer = null;
    }
  }

  private clearHoldTimer() {
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }

  private elementOwnsLongPress(el: HTMLElement): boolean {
    if (el.hasAttribute(OWNS_HOLD_ATTR)) return true;
    const prop = (el as HTMLElement & { ownsLongPress?: boolean }).ownsLongPress;
    return prop === true;
  }

  private helpTargetFromEvent(e: Event): HTMLElement | null {
    for (const node of e.composedPath()) {
      if (!(node instanceof HTMLElement)) continue;
      if (node === this.popup) continue;
      const id = node.getAttribute(HELP_ATTR);
      if (id) return node;
    }
    return null;
  }

  /** Deep hit-test through open shadow roots, then walk up for data-help. */
  private helpTargetAtPoint(x: number, y: number): HTMLElement | null {
    let el: Element | null = document.elementFromPoint(x, y);
    if (!el) return null;

    // Pierce open shadow roots to the deepest element under the cursor.
    for (;;) {
      const root: ShadowRoot | null = el.shadowRoot;
      if (!root) break;
      const nested: Element | null = root.elementFromPoint(x, y);
      if (!nested || nested === el) break;
      el = nested;
    }

    return this.helpTargetFromNode(el);
  }

  private helpTargetFromNode(start: Element | null): HTMLElement | null {
    let cur: Element | null = start;
    while (cur) {
      if (cur instanceof HTMLElement) {
        if (cur === this.popup || this.popup.contains(cur)) return null;
        const id = cur.getAttribute(HELP_ATTR);
        if (id) return cur;
      }
      const parent: Element | null = cur.parentElement;
      if (parent) {
        cur = parent;
        continue;
      }
      const root = cur.getRootNode();
      cur = root instanceof ShadowRoot ? root.host : null;
    }
    return null;
  }
}

let shared: HelpController | null = null;

export function initHelpController(popup: FlipCelHelpPopup): HelpController {
  // Same popup already wired — keep existing listeners (Lit may re-connect).
  if (shared?.popup === popup) return shared;
  if (shared) shared.dispose();
  shared = new HelpController(popup);
  return shared;
}

export function getHelpController(): HelpController | null {
  return shared;
}

// Vite HMR: drop old listeners, then re-bind to the live popup.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    shared?.dispose();
    shared = null;
  });
  import.meta.hot.accept(() => {
    const el = document.getElementById("help-popup");
    if (el) initHelpController(el as FlipCelHelpPopup);
  });
}
