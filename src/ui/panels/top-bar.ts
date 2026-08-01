import { html, css, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { getTool } from "../../tools/registry";
import { paintModeAccent, type PaintModeAccent } from "../../tools/paint-mode";
import type { SettingsSchema } from "../../tools/types";
import {
  colorStore,
  toolStore,
  toolSettingsStore,
  modifiersStore,
  documentNameStore,
  displayDocumentName,
  DEFAULT_DOCUMENT_NAME,
  StoreController,
} from "../../state";
import { timelineStore } from "../../document/document";
import { historyStateStore } from "../../document/history";
import {
  getModifierBinding,
  isModifierHeld,
  shortcutsStore,
} from "../../input/shortcuts";
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
  TOP_BAR_SHORTCUT_CHIPS,
  dockChipStyles,
  type DockInfoChip,
  type PanelVisibility,
  type ToggleablePanel,
} from "./dock-chrome";

// ============================================================
// Top Bar Panel — unified dock (file, panels, status)
// ============================================================

@customElement("flipcel-top-bar-panel")
export class FlipCelTopBarPanel extends FloatingPanel {
  @property({ type: Number }) zoomLevel = 100;

  @state() private panelVisibility: PanelVisibility[] = PANEL_VISIBILITY_DEFAULTS.map((p) => ({
    ...p,
  }));
  /** Buttons that should play pop-in on their next paint. */
  @state() private enteringPanelIds: string[] = [];
  @state() private renaming = false;
  @state() private editingName = "";

  private dockColor = new StoreController(this, colorStore);
  private tool = new StoreController(this, toolStore);
  private settings = new StoreController(this, toolSettingsStore);
  private modifiers = new StoreController(this, modifiersStore);
  private shortcuts = new StoreController(this, shortcutsStore);
  private timeline = new StoreController(this, timelineStore);
  private history = new StoreController(this, historyStateStore);
  private documentName = new StoreController(this, documentNameStore);
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
    lastEvent: PointerEvent;
  } | null = null;
  /** After a drag-out spawn, ignore the synthetic click on the toggle. */
  private suppressDockBtnClick = false;

  private readonly onDockBtnGestureMove = (e: PointerEvent) => {
    const gesture = this.dockBtnGesture;
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    gesture.lastEvent = e;
    if (gesture.spawned) return;
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
    ${dockChipStyles}

    :host {
      /* Below Safari iOS / iPadOS chrome; env() needs viewport-fit=cover. */
      --panel-top: max(8px, calc(env(safe-area-inset-top, 0px) + 2px));
      --panel-left: 50%;
      --panel-right: auto;
      transform: translateX(-50%);
      --panel-width: auto;
      --panel-min-width: 0;
      --block-face-bg: var(--flipcel-topbar-surface, var(--flipcel-panel-surface, #ffffff));
      z-index: 1200;
      width: auto;
      max-width: calc(100vw - 24px);
      /* Slightly lighter than the full floating-panels default on compact docks. */
      --flipcel-shadow-panel: var(--flipcel-dock-shadow);
      /* Panel row; icon / control column width. */
      --flipcel-dock-row-h: 44px;
      --flipcel-dock-control: 44px;
    }

    .block {
      overflow: visible;
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
      gap: 10px;
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

    .dock-group-status {
      /* Never shrink — shrinking panels under status caused chip overlap. */
      flex: 0 0 auto;
    }

    .dock-group-file {
      flex: 0 1 auto;
      min-width: 0;
      gap: 2px;
    }

    .dock-group-panels {
      /* Keep panel buttons at their intrinsic width (no crush / overlap). */
      flex: 0 0 auto;
    }

    .dock-sep {
      flex: 0 0 1px;
      align-self: stretch;
      margin: 6px 0;
      background: color-mix(in srgb, var(--flipcel-text-primary, #222) 14%, transparent);
    }

    .dock-status {
      min-height: var(--flipcel-dock-row-h);
      align-items: center;
      gap: 6px;
    }

    .dock-cell-icon {
      flex: 0 0 28px;
      width: 28px;
      min-width: 28px;
      max-width: 28px;
    }

    .dock-chip-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      min-height: var(--flipcel-dock-row-h);
      line-height: 0;
      color: var(--flipcel-text-primary, #222);
      padding: 0;
    }

    .dock-cell-filename {
      height: 100%;
      align-self: stretch;
      flex: 1 1 auto;
      width: auto;
      min-width: 0;
      max-width: 100%;
    }

    .dock-cell-filename .dock-chip-stacked {
      height: 100%;
      max-height: 100%;
      justify-content: center;
      overflow: hidden;
    }

    /* Match .dock-value metrics so rename doesn't reflow the dock. */
    .filename-input {
      display: block;
      width: 100%;
      min-width: 0;
      max-width: 126px;
      height: 1.15em;
      margin: 0;
      padding: 0;
      border: none;
      border-radius: 0;
      box-sizing: content-box;
      font: inherit;
      font-size: inherit;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      line-height: 1.15;
      color: var(--flipcel-text-primary, #222);
      background: transparent;
      outline: none;
      box-shadow: inset 0 -1.5px 0 var(--flipcel-accent, #4a6fb5);
      appearance: none;
      -webkit-appearance: none;
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
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.01em;
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
    document.addEventListener("pointerdown", this.outsidePointerHandler, true);
    document.addEventListener("panel-visibility-change", this.panelVisibilityChangeHandler as EventListener);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
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

  updated(changedProperties: Map<string, unknown>) {
    super.updated(changedProperties);
    if (!changedProperties.has("renaming") || !this.renaming) return;
    const input = this.renderRoot.querySelector<HTMLInputElement>("[data-filename-edit]");
    input?.focus();
    input?.select();
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

  private measureDockWidth(): number {
    return this.offsetWidth;
  }

  /** Grow/shrink the dock from center with overshoot around a content change. */
  private async runDockResizeAnimation(mutate: () => void) {
    if (this.skipNextDockMotion) {
      mutate();
      return;
    }

    const token = ++this.dockResizeToken;
    const fromWidth = this.measureDockWidth();
    mutate();
    await this.updateComplete;
    if (token !== this.dockResizeToken) return;
    await animateCenteredScaleX(this, fromWidth, undefined, {
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
    const rect = this.getBoundingClientRect();
    return (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    );
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
    el.style.display = "";
    await el.updateComplete;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    // Gesture may have ended while the panel was laying out — still spawn at
    // the last pointer position, and only continue dragging if still down.
    const gesture = this.dockBtnGesture?.id === id ? this.dockBtnGesture : null;
    const pointer = gesture?.lastEvent;
    const stillDragging = gesture?.pointerDown === true;

    const rect = el.getBoundingClientRect();
    const grabOffsetX = rect.width / 2;
    const grabOffsetY = Math.min(28, Math.max(14, rect.height * 0.12));

    this.beginButtonExit(id, () => {
      this.panelVisibility = this.panelVisibility.map((p) =>
        p.id === id ? { ...p, visible: true, detached: true } : p,
      );
    });

    raisePanelZIndex(el);
    if (pointer && stillDragging) {
      el.beginExternalDrag(pointer, { grabOffsetX, grabOffsetY });
    } else if (pointer) {
      el.style.left = `${pointer.clientX - grabOffsetX}px`;
      el.style.top = `${pointer.clientY - grabOffsetY}px`;
      el.style.right = "auto";
      el.style.bottom = "auto";
    }
    el.playShowAnimation();

    this.clearDockBtnGestureListeners();
    this.dockBtnGesture = null;
  }

  private async togglePanel(id: string, triggerEl?: HTMLElement) {
    const el = document.getElementById(id) as ToggleablePanel | null;
    if (!el) return;
    const panel = this.panelVisibility.find((p) => p.id === id);
    if (!panel) return;

    const newVisible = !panel.visible;
    if (!newVisible) {
      el.hidePanel();
      return;
    }

    this.panelVisibility.forEach((p) => {
      if (p.id === id || !p.visible || p.detached) return;
      const otherEl = document.getElementById(p.id) as ToggleablePanel | null;
      if (!otherEl || otherEl.pinned) return;
      otherEl.hidePanel();
    });

    // Opening from the dock always re-docks the panel under the trigger.
    el.pinned = false;
    el.style.display = "";
    await el.updateComplete;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    if (triggerEl) {
      anchorPanelBelowTrigger(el, triggerEl);
    }
    raisePanelZIndex(el);
    el.playShowAnimation();
    this.panelVisibility = this.panelVisibility.map((p) =>
      p.id === id ? { ...p, visible: true, detached: false } : p,
    );
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
    const clickedInsidePanel = path.some(
      (node) => node instanceof HTMLElement && node.hasAttribute("data-panel"),
    );
    if (clickedInsidePanel) return;

    let changed = false;
    this.panelVisibility.forEach((panel) => {
      if (!panel.visible || panel.detached) return;
      const el = document.getElementById(panel.id) as ToggleablePanel | null;
      if (!el) return;
      const isPopup = el.hasAttribute("data-popup");
      if (el.pinned && !isPopup) return;
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
      const currentToolName = getTool(this.tool.value).name;
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

  private emitDock(name: string) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
  }

  private startRename(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.editingName = displayDocumentName(this.documentName.value);
    this.renaming = true;
  }

  private commitRename() {
    if (!this.renaming) return;
    const next = displayDocumentName(this.editingName);
    this.renaming = false;
    this.editingName = "";
    if (next === displayDocumentName(this.documentName.value)) return;
    documentNameStore.set(next || DEFAULT_DOCUMENT_NAME);
  }

  private cancelRename() {
    this.renaming = false;
    this.editingName = "";
  }

  private onRenameKeydown(e: KeyboardEvent) {
    // Keep tool/edit shortcuts from seeing rename keystrokes (shadow-retargeted).
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.cancelRename();
    }
  }

  private renderActionChip(opts: {
    icon: TemplateResult;
    title: string;
    disabled?: boolean;
    onClick: () => void;
  }) {
    return html`
      <div class="dock-cell dock-cell-icon">
        <button
          type="button"
          class="dock-chip dock-chip-icon dock-chip-reset"
          title=${opts.title}
          aria-label=${opts.title}
          ?disabled=${opts.disabled ?? false}
          data-interactive
          @click=${opts.onClick}
        >
          ${opts.icon}
        </button>
      </div>
    `;
  }

  private renderFilenameChip() {
    const filename = displayDocumentName(this.documentName.value);

    if (this.renaming) {
      return html`
        <div class="dock-cell dock-cell-filename">
          <div class="dock-chip dock-chip-stacked">
            <span class="dock-prefix">file</span>
            <input
              type="text"
              class="filename-input dock-value"
              data-filename-edit
              data-interactive
              .value=${this.editingName}
              aria-label="Rename file"
              spellcheck="false"
              autocomplete="off"
              @input=${(e: Event) => {
                this.editingName = (e.target as HTMLInputElement).value;
              }}
              @keydown=${(e: KeyboardEvent) => this.onRenameKeydown(e)}
              @blur=${() => this.commitRename()}
              @pointerdown=${(e: Event) => e.stopPropagation()}
            />
          </div>
        </div>
      `;
    }

    return html`
      <div class="dock-cell dock-cell-filename">
        <button
          type="button"
          class="dock-chip dock-chip-stacked dock-chip-reset"
          title="Click to rename"
          aria-label="Rename file, current name ${filename}"
          data-interactive
          @click=${(e: Event) => this.startRename(e)}
        >
          <span class="dock-prefix">file</span>
          <span class="dock-value">${filename}</span>
        </button>
      </div>
    `;
  }

  private effectivePaintMode(): string | null {
    const tool = getTool(this.tool.value);
    const key = tool.dockModeSetting;
    if (!key) return null;
    const def = (tool.settings as SettingsSchema)[key];
    if (!def || def.type !== "toggle") return null;
    const options = def.options as readonly string[];
    const raw = String(
      (this.settings.value[tool.id] as Record<string, unknown>)?.[key] ?? def.default,
    );
    const paintMod = getModifierBinding("mod.paintMode", this.shortcuts.value);
    return isModifierHeld(this.modifiers.value, paintMod)
      ? options[(options.indexOf(raw) + 1) % options.length]
      : raw;
  }

  private effectivePaintModeLabel(): string {
    const mode = this.effectivePaintMode();
    if (!mode) return "—";
    if (mode === "subtract") return "Sub";
    return mode.charAt(0).toUpperCase() + mode.slice(1);
  }

  private renderDockWidget(opts: {
    label: string;
    value: string;
    title: string;
    onClick?: () => void;
    modeAccent?: PaintModeAccent | null;
  }) {
    const valueClass = opts.modeAccent
      ? `dock-value mode-${opts.modeAccent}`
      : "dock-value";
    const inner = html`
      <span class="dock-prefix">${opts.label}</span>
      <span class=${valueClass}>${opts.value}</span>
    `;
    return html`
      <div class="dock-cell">
        ${opts.onClick
          ? html`
              <button
                type="button"
                class="dock-chip dock-chip-stacked dock-chip-reset"
                title=${opts.title}
                aria-label=${opts.title}
                data-interactive
                @click=${opts.onClick}
              >${inner}</button>
            `
          : html`
              <span class="dock-chip dock-chip-stacked" title=${opts.title}
                >${inner}</span
              >
            `}
      </div>
    `;
  }

  private buildInfoChip(kind: DockInfoChip) {
    switch (kind) {
      case "mode": {
        const mode = this.effectivePaintMode();
        return {
          label: "mode",
          value: this.effectivePaintModeLabel(),
          title: "Click to cycle paint mode",
          onClick: () => this.emitDock("mode-cycle"),
          modeAccent: mode ? paintModeAccent(mode) : null,
        };
      }
      case "frame": {
        const t = this.timeline.value;
        return {
          label: "frame",
          value: String(t.currentFrame + 1),
          title: t.playing ? "Pause" : "Play",
          onClick: () => this.emitDock("play-toggle"),
        };
      }
      case "zoom":
        return {
          label: "zoom",
          value: `${this.zoomLevel}%`,
          title: "Fit stage in view",
          onClick: () => this.emitDock("zoom-reset"),
        };
    }
  }

  private renderFileGroup() {
    const { canUndo, canRedo } = this.history.value;
    return html`
      <div class="dock-group dock-group-file">
        ${this.renderFilenameChip()}
        ${this.renderActionChip({
          icon: phosphorIcon("arrow-counter-clockwise", 16),
          title: "Undo",
          disabled: !canUndo,
          onClick: () => this.emitDock("undo"),
        })}
        ${this.renderActionChip({
          icon: phosphorIcon("arrow-clockwise", 16),
          title: "Redo",
          disabled: !canRedo,
          onClick: () => this.emitDock("redo"),
        })}
      </div>
    `;
  }

  private renderPanelGroup(panelTriggers: PanelVisibility[]) {
    if (panelTriggers.length === 0) return nothing;

    const currentToolName = getTool(this.tool.value).name;
    const entering = new Set(this.enteringPanelIds);
    return html`
      <div class="dock-sep" aria-hidden="true"></div>
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
          return html`
            <button
              type="button"
              data-panel-trigger=${panel.id}
              class=${className}
              title=${isTools ? currentToolName : panel.label}
              data-interactive
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
      <div class="dock-sep" aria-hidden="true"></div>
    `;
  }

  private renderStatusGroup() {
    return html`
      <div class="dock-group dock-group-status dock-status">
        ${TOP_BAR_SHORTCUT_CHIPS.map((kind) =>
          this.renderDockWidget(this.buildInfoChip(kind)),
        )}
      </div>
    `;
  }

  render() {
    const panelTriggers = this.visiblePanelTriggers();
    return html`
      <div class="block">
        <div class="face">
          <div class="bar">
            ${this.renderFileGroup()}
            ${this.renderPanelGroup(panelTriggers)}
            ${panelTriggers.length === 0
              ? html`<div class="dock-sep" aria-hidden="true"></div>`
              : nothing}
            ${this.renderStatusGroup()}
          </div>
        </div>
      </div>
    `;
  }
}
