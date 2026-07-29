import { html, css, nothing, type PropertyValues } from "lit";
import { customElement, state } from "lit/decorators.js";
import { getTool } from "../../tools/registry";
import { colorStore, toolStore, StoreController } from "../../state";
import { FloatingPanel } from "../primitives/floating-panel";
import { phosphorIcon, PANEL_ICON_MAP } from "../icons/phosphor";
import { anchorPanelBelowTrigger, raisePanelZIndex } from "../primitives/panel-anchor";
import {
  PANEL_VISIBILITY_DEFAULTS,
  TOP_BAR_PANEL_IDS,
  type PanelVisibility,
  type ToggleablePanel,
} from "./dock-chrome";

// ============================================================
// Top Bar Panel (panel visibility toggles)
// ============================================================

@customElement("inkwell-top-bar-panel")
export class InkwellTopBarPanel extends FloatingPanel {
  @state() private panelVisibility: PanelVisibility[] = PANEL_VISIBILITY_DEFAULTS.map((p) => ({
    ...p,
  }));
  private dockColor = new StoreController(this, colorStore);
  private tool = new StoreController(this, toolStore);
  private readonly outsidePointerHandler = (e: PointerEvent) => this.closePanelsOnOutsideClick(e);
  private readonly panelVisibilityChangeHandler = (e: Event) =>
    this.onPanelVisibilityChange(
      e as CustomEvent<{ id: string; visible: boolean; detached?: boolean }>,
    );

  protected override usesFaceScrollbar(): boolean {
    return false;
  }

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      /* Below Safari iOS / iPadOS chrome; env() needs viewport-fit=cover. */
      --panel-top: max(8px, calc(env(safe-area-inset-top, 0px) + 2px));
      --panel-left: 50%;
      --panel-right: auto;
      transform: translateX(-50%);
      --panel-width: auto;
      --panel-min-width: 0;
      --block-face-bg: var(--inkwell-topbar-surface, var(--inkwell-panel-surface, #ffffff));
      z-index: 1200;
      width: auto;
      max-width: min(calc(100vw - 32px), 640px);
      /* Slightly lighter than the full floating-panels default on compact docks. */
      --inkwell-shadow-panel: var(--inkwell-dock-shadow);
      /* Panel row; icon / control column width. */
      --inkwell-dock-row-h: 44px;
      --inkwell-dock-control: 44px;
    }

    .face {
      overflow: hidden;
      min-height: calc(
        var(--inkwell-dock-row-h) + (2 * var(--inkwell-block-face-padding))
      );
    }

    .bar {
      display: flex;
      flex-direction: row;
      flex-wrap: nowrap;
      align-items: stretch;
      gap: 6px;
      height: var(--inkwell-dock-row-h);
      min-height: var(--inkwell-dock-row-h);
      max-height: var(--inkwell-dock-row-h);
      box-sizing: border-box;
    }

    .dock-btn {
      appearance: none;
      margin: 0;
      border: none;
      border-radius: var(--inkwell-content-radius);
      box-sizing: border-box;
      height: 100%;
      min-height: 0;
      align-self: stretch;
      padding: 0 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0;
      background: var(--inkwell-panel-depth, #070707);
      color: var(--inkwell-panel-border, #8a8a8a);
      font: inherit;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.01em;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
      user-select: none;
    }

    .dock-btn:hover {
      filter: brightness(0.97);
    }

    .dock-btn[aria-pressed="true"] {
      background: var(--inkwell-accent, #4a6fb5);
      color: var(--inkwell-accent-contrast, #ffffff);
      filter: none;
    }

    .dock-btn-flex {
      flex: 0 1 auto;
      min-width: 0;
    }

    .dock-btn-icon {
      flex: 0 0 var(--inkwell-dock-control);
      min-width: var(--inkwell-dock-control);
      max-width: var(--inkwell-dock-control);
      padding: 0;
    }

    .dock-btn-color {
      /* Ink swatch — background set inline from the color store. */
      color: transparent;
    }

    .dock-btn-color[aria-pressed="true"] {
      box-shadow: inset 0 0 0 2px var(--inkwell-accent-contrast, #ffffff);
      color: transparent;
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
    this.initializeAllPanelsHidden();
    document.addEventListener("pointerdown", this.outsidePointerHandler, true);
    document.addEventListener("panel-visibility-change", this.panelVisibilityChangeHandler as EventListener);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("pointerdown", this.outsidePointerHandler, true);
    document.removeEventListener(
      "panel-visibility-change",
      this.panelVisibilityChangeHandler as EventListener,
    );
  }

  firstUpdated(_changed: PropertyValues<this>) {
    super.firstUpdated(_changed);
    this.positionAllVisiblePanels();
  }

  private initializeAllPanelsHidden() {
    this.panelVisibility = this.panelVisibility.map((panel) => {
      const el = document.getElementById(panel.id) as ToggleablePanel | null;
      if (el) {
        el.style.display = "none";
        el.pinned = false;
      }
      return { ...panel, visible: false, detached: false };
    });
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
      this.panelVisibility = this.panelVisibility.map((panel) =>
        panel.id === id ? { ...panel, visible: false, detached: false } : panel,
      );
      const el = document.getElementById(id) as ToggleablePanel | null;
      if (el) {
        el.pinned = false;
        el.style.display = "none";
      }
      return;
    }

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

  render() {
    const currentToolName = getTool(this.tool.value).name;
    const panelTriggers = this.visiblePanelTriggers();
    return html`
      <div class="block">
        <div class="face">
          <div class="bar">
            ${panelTriggers.map((panel) => {
              const isTools = panel.id === "tools-panel";
              const isColor = panel.id === "color-panel";
              const className = [
                "dock-btn",
                isTools ? "dock-btn-flex" : "dock-btn-icon",
                isColor ? "dock-btn-color" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return html`
                <button
                  type="button"
                  data-panel-trigger=${panel.id}
                  class=${className}
                  title=${isTools ? currentToolName : panel.label}
                  data-interactive
                  aria-pressed=${panel.visible ? "true" : "false"}
                  style=${isColor ? `background:${this.dockColor.value}` : nothing}
                  @click=${(e: Event) =>
                    this.togglePanel(panel.id, e.currentTarget as HTMLElement)}
                >
                  ${this.renderPanelTriggerContent(panel.id)}
                </button>
              `;
            })}
          </div>
        </div>
      </div>
    `;
  }
}
