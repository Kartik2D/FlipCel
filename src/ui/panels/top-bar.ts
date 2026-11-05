import { html, css, nothing, type PropertyValues } from "lit";
import { customElement, state } from "lit/decorators.js";
import { getTool } from "../../tools/registry";
import {
  colorStore,
  toolStore,
  StoreController,
} from "../../state";
import {
  editContextStore,
  type EditContextState,
} from "../../state/document-ui";
import { FloatingPanel } from "../primitives/floating-panel";
import { phosphorIcon, PANEL_ICON_MAP } from "../icons/phosphor";
import { anchorPanelBelowTrigger, raisePanelZIndex } from "../primitives/panel-anchor";
import {
  animateCenteredScaleX,
  FLIPCEL_MOTION_OVERSHOOT_MS,
} from "../motion";
import {
  PANEL_VISIBILITY_DEFAULTS,
  TOP_BAR_PANEL_IDS,
  type PanelVisibility,
  type ToggleablePanel,
} from "./dock-chrome";

// ============================================================
// Top Bar — panel-icon dock
// ============================================================

@customElement("flipcel-top-bar-panel")
export class FlipCelTopBarPanel extends FloatingPanel {
  @state() private panelVisibility: PanelVisibility[] = PANEL_VISIBILITY_DEFAULTS.map((p) => ({
    ...p,
  }));
  /** Buttons that should play pop-in on their next paint. */
  @state() private enteringPanelIds: string[] = [];

  private dockColor = new StoreController(this, colorStore);
  private tool = new StoreController(this, toolStore);
  @state() private editContext: EditContextState = { path: [], inPlace: false };
  private unsubEditContext: (() => void) | null = null;
  private readonly outsidePointerHandler = (e: PointerEvent) => this.closePanelsOnOutsideClick(e);
  private readonly panelVisibilityChangeHandler = (e: Event) =>
    this.onPanelVisibilityChange(
      e as CustomEvent<{ id: string; visible: boolean; detached?: boolean }>,
    );

  private dockResizeToken = 0;
  private knownTriggerIds = new Set<string>();
  private skipNextDockMotion = true;

  /** In-flight dock-button drag that may spawn a floating panel on leave. */
  private dockBtnGesture: {
    id: string;
    pointerId: number;
    spawned: boolean;
    pointerDown: boolean;
    startX: number;
    startY: number;
    lastEvent: PointerEvent;
  } | null = null;
  /** After a drag-out spawn, ignore the synthetic click on the toggle. */
  private suppressDockBtnClick = false;

  private readonly onDockBtnGestureMove = (e: PointerEvent) => {
    const gesture = this.dockBtnGesture;
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    gesture.lastEvent = e;
    if (gesture.spawned) return;
    const dx = e.clientX - gesture.startX;
    const dy = e.clientY - gesture.startY;
    // Clicks jitter a few px; don't treat that as pull-out (panel-under-cursor).
    if (dx * dx + dy * dy < 12 * 12) return;
    if (!this.isPointerOutsideDock(e.clientX, e.clientY)) return;
    gesture.spawned = true;
    this.suppressDockBtnClick = true;
    void this.spawnPanelFromDockButton(gesture.id);
  };

  private readonly onDockBtnGestureEnd = (e: PointerEvent) => {
    const gesture = this.dockBtnGesture;
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    gesture.lastEvent = e;
    gesture.pointerDown = false;
    this.clearDockBtnGestureListeners();
    // Keep gesture while spawn is in flight so layout can use last coords.
    if (!gesture.spawned) this.dockBtnGesture = null;
  };

  protected override usesFaceScrollbar(): boolean {
    return false;
  }

  /** Dock itself is not a redock drop target preview. */
  protected override canPreviewDockHover(): boolean {
    return false;
  }

  protected override playsShowAnimation(): boolean {
    return false;
  }

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      /* Below Safari iOS / iPadOS chrome; env() needs viewport-fit=cover. */
      --panel-top: max(8px, calc(env(safe-area-inset-top, 0px) + 2px));
      --panel-left: 0;
      --panel-right: 0;
      transform: none;
      --panel-width: auto;
      --panel-min-width: 0;
      --block-face-bg: var(--flipcel-topbar-surface, var(--flipcel-panel-surface, #ffffff));
      z-index: 1200;
      width: 100%;
      height: calc(
        var(--flipcel-dock-row-h) + (2 * var(--flipcel-block-face-padding))
      );
      max-width: none;
      pointer-events: none;
      /* Slightly lighter than the full floating-panels default on compact docks. */
      --flipcel-shadow-panel: var(--flipcel-dock-shadow);
      /* Panel row; icon / control column width. */
      --flipcel-dock-row-h: 40px;
      --flipcel-dock-control: 40px;
    }

    .block {
      overflow: visible;
      flex: 0 0 auto;
      height: auto;
      width: fit-content;
      max-width: 100%;
      max-height: none;
      pointer-events: auto;
    }

    .dock-icons {
      position: absolute;
      left: 50%;
      top: 0;
      transform: translateX(-50%);
    }

    /* Edit-in-place breadcrumb: Scene › Symbol — sits under the icon dock. */
    .context-crumbs {
      position: absolute;
      left: 50%;
      top: calc(var(--flipcel-dock-row-h) + (2 * var(--flipcel-block-face-padding)) + 6px);
      transform: translateX(-50%);
    }

    .context-crumbs .bar {
      height: 28px;
      min-height: 28px;
      max-height: 28px;
      gap: 2px;
      align-items: center;
    }

    .crumb {
      appearance: none;
      margin: 0;
      border: none;
      border-radius: var(--flipcel-content-radius);
      padding: 0 8px;
      height: 100%;
      background: transparent;
      color: var(--flipcel-panel-border, #8a8a8a);
      font: inherit;
      font-size: var(--flipcel-block-font-size, 11px);
      font-weight: 600;
      letter-spacing: var(--flipcel-letter-spacing, -0.011em);
      cursor: pointer;
      white-space: nowrap;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
    }

    .crumb:hover {
      background: var(--flipcel-panel-depth, #070707);
      color: #ffffff;
    }

    .crumb[aria-current="location"] {
      color: #ffffff;
      cursor: default;
    }

    .crumb[aria-current="location"]:hover {
      background: transparent;
    }

    .crumb-sep {
      color: var(--flipcel-panel-border, #8a8a8a);
      opacity: 0.7;
      font-size: var(--flipcel-block-font-size, 11px);
    }

    .crumb-exit {
      margin-left: 4px;
      padding: 0 6px;
    }

    .face {
      /* Visible so entering buttons can overshoot outside the bar. */
      overflow: visible;
      min-height: calc(
        var(--flipcel-dock-row-h) + (2 * var(--flipcel-block-face-padding))
      );
    }

    .bar {
      position: relative;
      display: flex;
      flex-direction: row;
      flex-wrap: nowrap;
      align-items: stretch;
      gap: var(--flipcel-space-2, 8px);
      height: var(--flipcel-dock-row-h);
      min-height: var(--flipcel-dock-row-h);
      max-height: var(--flipcel-dock-row-h);
      box-sizing: border-box;
    }

    .dock-group {
      display: flex;
      flex-direction: row;
      flex-wrap: nowrap;
      align-items: stretch;
      gap: 6px;
      min-width: 0;
    }

    .dock-group-panels {
      /* Keep panel buttons at their intrinsic width (no crush / overlap). */
      flex: 0 0 auto;
    }

    .dock-btn {
      appearance: none;
      margin: 0;
      border: none;
      border-radius: var(--flipcel-content-radius);
      box-sizing: border-box;
      height: 100%;
      min-height: 0;
      align-self: stretch;
      padding: 0 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0;
      background: var(--flipcel-panel-depth, #070707);
      color: var(--flipcel-panel-border, #8a8a8a);
      font: inherit;
      font-size: var(--flipcel-block-font-size, 11px);
      font-weight: 500;
      letter-spacing: var(--flipcel-letter-spacing, -0.011em);
      cursor: grab;
      -webkit-tap-highlight-color: transparent;
      touch-action: none;
      user-select: none;
      transform-origin: center center;
    }

    .dock-btn:active {
      cursor: grabbing;
    }

    .dock-btn:hover {
      filter: brightness(0.97);
    }

    .dock-btn[aria-pressed="true"] {
      background: var(--flipcel-accent, #4a6fb5);
      color: var(--flipcel-accent-contrast, #ffffff);
      filter: none;
    }

    .dock-btn-flex {
      flex: 0 1 auto;
      min-width: 0;
    }

    .dock-btn-icon {
      flex: 0 0 var(--flipcel-dock-control);
      min-width: var(--flipcel-dock-control);
      max-width: var(--flipcel-dock-control);
      padding: 0;
    }

    .dock-btn-icon .btn-content {
      display: flex;
      width: 100%;
      height: 100%;
      line-height: 0;
    }

    .dock-btn-icon .btn-content svg {
      display: block;
      width: 100%;
      height: 100%;
    }

    .dock-btn-color {
      /* Ink swatch — background set inline from the color store. */
      color: transparent;
    }

    .dock-btn-color[aria-pressed="true"] {
      box-shadow: inset 0 0 0 2px var(--flipcel-accent-contrast, #ffffff);
      color: transparent;
    }

    .dock-btn-enter {
      animation: dock-btn-pop-in var(--flipcel-motion-overshoot-duration, 420ms)
        var(--flipcel-motion-overshoot-easing, cubic-bezier(0.22, 1.7, 0.36, 1)) both;
    }

    @keyframes dock-btn-pop-in {
      0% {
        transform: scale(0.55);
        opacity: 0;
      }
      100% {
        transform: scale(1);
        opacity: 1;
      }
    }

    .btn-content {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .btn-content svg {
      flex-shrink: 0;
    }
    .btn-content-text {
      display: block;
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
      padding: 0 4px;
      text-align: center;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.pinned = true;
    this.showPinnedClose = false;
    this.initializePanelVisibility();
    this.unsubEditContext?.();
    try {
      this.unsubEditContext = editContextStore.subscribe((value) => {
        this.editContext = value;
      });
      this.editContext = editContextStore.get();
    } catch {
      this.unsubEditContext = null;
    }
    document.addEventListener("pointerdown", this.outsidePointerHandler, true);
    document.addEventListener("panel-visibility-change", this.panelVisibilityChangeHandler as EventListener);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubEditContext?.();
    this.unsubEditContext = null;
    this.clearDockBtnGestureListeners();
    this.dockBtnGesture = null;
    document.removeEventListener("pointerdown", this.outsidePointerHandler, true);
    document.removeEventListener(
      "panel-visibility-change",
      this.panelVisibilityChangeHandler as EventListener,
    );
  }

  firstUpdated(_changed: PropertyValues<this>) {
    super.firstUpdated(_changed);
    this.positionAllVisiblePanels();
    for (const panel of this.visiblePanelTriggers()) {
      this.knownTriggerIds.add(panel.id);
    }
    this.skipNextDockMotion = false;
  }

  /** Apply defaults: hide closed panels; float default-open ones at their CSS positions. */
  private initializePanelVisibility() {
    this.panelVisibility = this.panelVisibility.map((panel) => {
      const el = document.getElementById(panel.id) as ToggleablePanel | null;
      if (!el) return { ...panel, visible: false, detached: false };
      if (panel.visible) {
        el.style.display = "";
        // Detached defaults are already floating — pinned so dock-hover / redock work immediately.
        el.pinned = true;
        return { ...panel, detached: true };
      }
      el.style.display = "none";
      el.pinned = false;
      return { ...panel, visible: false, detached: false };
    });
  }

  /** Restore dock layout and panel positions/sizes. Keeps Settings open. */
  resetUi() {
    for (const { id } of PANEL_VISIBILITY_DEFAULTS) {
      (document.getElementById(id) as ToggleablePanel | null)?.resetLayout();
    }
    this.panelVisibility = PANEL_VISIBILITY_DEFAULTS.map((p) =>
      p.id === "universal-panel" ? { ...p, visible: true, detached: true } : { ...p },
    );
    this.initializePanelVisibility();

    for (const id of [
      "history-panel",
      "keyboard-shortcuts-panel",
      "tool-settings-panel",
    ]) {
      const el = document.getElementById(id) as ToggleablePanel | null;
      if (!el) continue;
      el.resetLayout();
      el.hidePanel();
    }
  }

  private iconsDockEl(): HTMLElement | null {
    return this.renderRoot.querySelector(".dock-icons");
  }

  /** Grow/shrink the icon dock from center with overshoot around a content change. */
  private async runDockResizeAnimation(mutate: () => void) {
    if (this.skipNextDockMotion) {
      mutate();
      return;
    }

    const token = ++this.dockResizeToken;
    const fromEl = this.iconsDockEl();
    const fromWidth = fromEl?.offsetWidth ?? 0;
    mutate();
    await this.updateComplete;
    if (token !== this.dockResizeToken) return;
    const el = this.iconsDockEl();
    if (!el) return;
    await animateCenteredScaleX(el, fromWidth, undefined, {
      baseTransform: "translateX(-50%)",
      isCurrent: () => token === this.dockResizeToken,
    });
  }

  private markEntering(ids: string[]) {
    if (ids.length === 0) return;
    this.enteringPanelIds = [...new Set([...this.enteringPanelIds, ...ids])];
    window.setTimeout(() => {
      this.enteringPanelIds = this.enteringPanelIds.filter((id) => !ids.includes(id));
      for (const id of ids) this.knownTriggerIds.add(id);
    }, FLIPCEL_MOTION_OVERSHOOT_MS + 40);
  }

  /** Drop the toggle immediately; dock width still animates closed. */
  private beginButtonExit(id: string, applyVisibility: () => void) {
    void this.runDockResizeAnimation(() => {
      applyVisibility();
      this.knownTriggerIds.delete(id);
    });
  }

  private clearDockBtnGestureListeners() {
    window.removeEventListener("pointermove", this.onDockBtnGestureMove);
    window.removeEventListener("pointerup", this.onDockBtnGestureEnd);
    window.removeEventListener("pointercancel", this.onDockBtnGestureEnd);
  }

  private isPointerOutsideDock(clientX: number, clientY: number): boolean {
    const blocks = this.renderRoot.querySelectorAll(".block");
    if (blocks.length === 0) return true;
    return [...blocks].every((el) => {
      const r = el.getBoundingClientRect();
      return (
        clientX < r.left ||
        clientX > r.right ||
        clientY < r.top ||
        clientY > r.bottom
      );
    });
  }

  private onDockBtnPointerDown(id: string, e: PointerEvent) {
    if (e.button !== 0) return;
    // New gesture — drop any stale suppress from a prior drag-out whose
    // click never fired (button was removed from the dock mid-gesture).
    this.suppressDockBtnClick = false;
    this.clearDockBtnGestureListeners();
    this.dockBtnGesture = {
      id,
      pointerId: e.pointerId,
      spawned: false,
      pointerDown: true,
      startX: e.clientX,
      startY: e.clientY,
      lastEvent: e,
    };
    window.addEventListener("pointermove", this.onDockBtnGestureMove);
    window.addEventListener("pointerup", this.onDockBtnGestureEnd);
    window.addEventListener("pointercancel", this.onDockBtnGestureEnd);
  }

  private onDockBtnClick(id: string, triggerEl: HTMLElement, e: Event) {
    if (this.suppressDockBtnClick) {
      e.preventDefault();
      e.stopPropagation();
      this.suppressDockBtnClick = false;
      return;
    }
    void this.togglePanel(id, triggerEl);
  }

  /**
   * Cursor left the dock while dragging a toggle: spawn/detach the panel under
   * the pointer and continue the gesture as a window drag.
   */
  private async spawnPanelFromDockButton(id: string) {
    const el = document.getElementById(id) as ToggleablePanel | null;
    const panel = this.panelVisibility.find((p) => p.id === id);
    if (!el || !panel || panel.detached) {
      this.suppressDockBtnClick = false;
      this.clearDockBtnGestureListeners();
      this.dockBtnGesture = null;
      return;
    }

    this.panelVisibility.forEach((p) => {
      if (p.id === id || !p.visible || p.detached) return;
      const otherEl = document.getElementById(p.id) as ToggleablePanel | null;
      if (!otherEl || otherEl.pinned) return;
      otherEl.hidePanel();
    });

    el.pinned = true;
    el.style.visibility = "";
    el.style.display = "";
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    const gesture = this.dockBtnGesture?.id === id ? this.dockBtnGesture : null;
    const pointer = gesture?.lastEvent;
    const stillDragging = gesture?.pointerDown === true;

    // Released during layout — this was a click, not a pull-out.
    if (!stillDragging || !pointer) {
      this.suppressDockBtnClick = false;
      this.clearDockBtnGestureListeners();
      this.dockBtnGesture = null;
      const trigger = this.renderRoot.querySelector<HTMLElement>(
        `[data-panel-trigger="${id}"]`,
      );
      el.pinned = false;
      if (trigger) anchorPanelBelowTrigger(el, trigger);
      raisePanelZIndex(el);
      el.playShowAnimation();
      this.panelVisibility = this.panelVisibility.map((p) =>
        p.id === id ? { ...p, visible: true, detached: false } : p,
      );
      return;
    }

    const rect = el.getBoundingClientRect();
    const grabOffsetX = rect.width / 2;
    const grabOffsetY = Math.min(28, Math.max(14, rect.height * 0.12));

    this.beginButtonExit(id, () => {
      this.panelVisibility = this.panelVisibility.map((p) =>
        p.id === id ? { ...p, visible: true, detached: true } : p,
      );
    });

    raisePanelZIndex(el);
    el.beginExternalDrag(pointer, { grabOffsetX, grabOffsetY });
    el.playShowAnimation();

    this.clearDockBtnGestureListeners();
    this.dockBtnGesture = null;
  }

  private togglePanel(id: string, triggerEl?: HTMLElement) {
    const el = document.getElementById(id) as ToggleablePanel | null;
    if (!el) return;
    const panel = this.panelVisibility.find((p) => p.id === id);
    if (!panel) return;

    // Trust the DOM, not panel.visible — a failed open used to leave
    // display set and visibility hidden, so the next click hid it again.
    const closed =
      el.style.display === "none" || el.style.visibility === "hidden";
    if (!closed) {
      el.hidePanel();
      return;
    }

    this.panelVisibility.forEach((p) => {
      if (p.id === id || !p.visible || p.detached) return;
      const otherEl = document.getElementById(p.id) as ToggleablePanel | null;
      if (!otherEl || otherEl.pinned) return;
      otherEl.hidePanel();
    });

    // Show first. Awaiting updateComplete left the panel visibility:hidden
    // forever when the timeline update rejected or never settled, and the
    // entrance animation's opacity:0 frame then ate canvas clicks.
    el.pinned = false;
    el.style.visibility = "";
    el.style.display = "";
    if (triggerEl) anchorPanelBelowTrigger(el, triggerEl);
    raisePanelZIndex(el);
    el.playShowAnimation?.();
    this.panelVisibility = this.panelVisibility.map((p) =>
      p.id === id ? { ...p, visible: true, detached: false } : p,
    );
    requestAnimationFrame(() => {
      if (el.style.display === "none" || !triggerEl) return;
      anchorPanelBelowTrigger(el, triggerEl);
    });
  }

  private onPanelVisibilityChange(
    e: CustomEvent<{ id: string; visible: boolean; detached?: boolean }>,
  ) {
    const { id, visible, detached } = e.detail;
    const prev = this.panelVisibility.find((p) => p.id === id);
    if (!prev) return;

    // Dropped back on the dock: restore the toggle and minimize the panel.
    if (prev.detached && detached === false && visible) {
      this.suppressDockBtnClick = false;
      const apply = () => {
        this.panelVisibility = this.panelVisibility.map((panel) =>
          panel.id === id ? { ...panel, visible: false, detached: false } : panel,
        );
        const el = document.getElementById(id) as ToggleablePanel | null;
        if (el) {
          el.pinned = false;
          el.style.display = "none";
        }
      };
      void this.runDockResizeAnimation(() => {
        apply();
        this.markEntering([id]);
      });
      return;
    }

    // Dragged free of the dock — pop the toggle out, then drop it.
    if (!prev.detached && detached === true) {
      this.beginButtonExit(id, () => {
        this.panelVisibility = this.panelVisibility.map((panel) =>
          panel.id === id ? { ...panel, visible: true, detached: true } : panel,
        );
      });
      return;
    }

    // Close / other visibility updates — animate when the toggle appears or leaves.
    const nextDetached =
      detached === true ? true : visible ? (detached ?? prev.detached) : false;
    const wasShown = !prev.detached;
    const willBeShown = !nextDetached;

    const apply = () => {
      this.panelVisibility = this.panelVisibility.map((panel) => {
        if (panel.id !== id) return panel;
        if (detached === true) {
          return { ...panel, visible: true, detached: true };
        }
        return {
          ...panel,
          visible,
          detached: visible ? (detached ?? panel.detached) : false,
        };
      });
    };

    if (!wasShown && willBeShown) {
      void this.runDockResizeAnimation(() => {
        apply();
        this.markEntering([id]);
      });
      return;
    }

    if (wasShown && !willBeShown) {
      this.beginButtonExit(id, apply);
      return;
    }

    apply();
  }

  private closePanelsOnOutsideClick(e: PointerEvent) {
    const path = e.composedPath();
    let changed = false;
    this.panelVisibility.forEach((panel) => {
      if (!panel.visible || panel.detached) return;
      const el = document.getElementById(panel.id) as ToggleablePanel | null;
      if (!el) return;
      // Own panel, its dock toggle, or a nested popup (import/color/help).
      if (path.includes(el)) return;
      const keepOpen = path.some(
        (node) =>
          node instanceof HTMLElement &&
          (node.getAttribute("data-panel-trigger") === panel.id ||
            node.hasAttribute("data-popup")),
      );
      if (keepOpen) return;
      el.hidePanel();
      changed = true;
    });

    if (changed) this.requestUpdate();
  }

  private positionAllVisiblePanels() {
    this.panelVisibility.forEach((panel) => {
      if (!panel.visible || panel.detached) return;
      const trigger = this.renderRoot.querySelector<HTMLElement>(
        `[data-panel-trigger="${panel.id}"]`,
      );
      const panelEl = document.getElementById(panel.id) as ToggleablePanel | null;
      if (!panelEl || !trigger) return;
      anchorPanelBelowTrigger(panelEl, trigger);
    });
  }

  private renderPanelTriggerContent(panelId: string) {
    if (panelId === "color-panel") return nothing;
    if (panelId === "tools-panel") {
      const currentToolName = getTool(this.tool.value)?.name ?? "Tools";
      return html`<span class="btn-content btn-content-text">${currentToolName}</span>`;
    }
    return html`<span class="btn-content">${phosphorIcon(PANEL_ICON_MAP[panelId], 14)}</span>`;
  }

  /** Panel toggle buttons in dock order (detached panels drop out until closed). */
  private visiblePanelTriggers(): PanelVisibility[] {
    return TOP_BAR_PANEL_IDS.map((id) => this.panelVisibility.find((p) => p.id === id)).filter(
      (p): p is PanelVisibility => p != null && !p.detached,
    );
  }

  private renderPanelGroup(panelTriggers: PanelVisibility[]) {
    if (panelTriggers.length === 0) return nothing;

    const currentToolName = getTool(this.tool.value)?.name ?? "Tools";
    const entering = new Set(this.enteringPanelIds);
    return html`
      <div class="dock-group dock-group-panels">
        ${panelTriggers.map((panel) => {
          const isTools = panel.id === "tools-panel";
          const isColor = panel.id === "color-panel";
          const className = [
            "dock-btn",
            isTools ? "dock-btn-flex" : "dock-btn-icon",
            isColor ? "dock-btn-color" : "",
            entering.has(panel.id) ? "dock-btn-enter" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const style = isColor ? `background:${this.dockColor.value}` : nothing;
          const helpId =
            panel.id === "file-panel"
              ? "dock.file"
              : panel.id === "universal-panel"
              ? "dock.settings"
              : panel.id === "layers-panel"
                ? "dock.layers"
                : panel.id === "wheel-panel"
                  ? "dock.wheel"
                  : panel.id === "view-panel"
                    ? "dock.view"
                    : panel.id === "assist-panel"
                      ? "dock.assist"
                      : panel.id === "library-panel"
                        ? "dock.library"
                      : panel.id === "tools-panel"
                        ? "dock.tools"
                        : panel.id === "color-panel"
                          ? "dock.color"
                          : nothing;
          return html`
            <button
              type="button"
              data-panel-trigger=${panel.id}
              class=${className}
              data-help=${helpId}
              data-interactive
              aria-label=${isTools ? currentToolName : panel.label}
              aria-pressed=${panel.visible ? "true" : "false"}
              style=${style}
              @pointerdown=${(e: PointerEvent) =>
                this.onDockBtnPointerDown(panel.id, e)}
              @click=${(e: Event) =>
                this.onDockBtnClick(panel.id, e.currentTarget as HTMLElement, e)}
            >
              ${this.renderPanelTriggerContent(panel.id)}
            </button>
          `;
        })}
      </div>
    `;
  }

  private emitExitTo(depth: number) {
    this.dispatchEvent(
      new CustomEvent("context-exit-to", { detail: depth, bubbles: true, composed: true }),
    );
  }

  /** Scene › Symbol A › Symbol B — tap a crumb to exit back to it; Esc exits one. */
  private renderContextCrumbs() {
    const path = this.editContext.path;
    const inPlace = this.editContext.inPlace;
    if (path.length === 0) return nothing;
    const last = path.length;
    return html`
      <div class="block context-crumbs" data-interactive>
        <div class="face">
          <div class="bar">
            <button type="button" class="crumb" data-interactive @click=${() => this.emitExitTo(0)}>
              Scene
            </button>
            ${path.map((crumb, i) => {
              const depth = i + 1;
              const current = depth === last;
              return html`
                <span class="crumb-sep" aria-hidden="true">›</span>
                <button
                  type="button"
                  class="crumb"
                  data-interactive
                  aria-current=${current ? "location" : nothing}
                  title=${current
                    ? inPlace
                      ? "Editing in place (Esc to exit)"
                      : "Editing symbol (Esc to exit)"
                    : `Back to ${crumb.name}`}
                  @click=${() => {
                    if (!current) this.emitExitTo(depth);
                  }}
                >
                  ${crumb.name}
                </button>
              `;
            })}
            <button
              type="button"
              class="crumb crumb-exit"
              data-interactive
              aria-label="Exit symbol"
              title="Exit symbol (Esc)"
              @click=${() => this.emitExitTo(last - 1)}
            >
              ${phosphorIcon("x", 12)}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  render() {
    const panelTriggers = this.visiblePanelTriggers();
    return html`
      ${panelTriggers.length > 0
        ? html`
            <div class="block dock-icons">
              <div class="face">
                <div class="bar">${this.renderPanelGroup(panelTriggers)}</div>
              </div>
            </div>
          `
        : nothing}
      ${this.renderContextCrumbs()}
    `;
  }
}
