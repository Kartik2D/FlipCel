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
  dockColorDepthStripColor,
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
    this.onPanelVisibilityChange(e as CustomEvent<{ id: string; visible: boolean }>);

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
      --inkwell-dock-face-pt: 6px;
      --inkwell-dock-face-pb: 8px;
    }

    .face {
      overflow: hidden;
      padding: var(--inkwell-dock-face-pt) 12px var(--inkwell-dock-face-pb);
      min-height: calc(
        var(--inkwell-dock-row-h) + var(--inkwell-dock-face-pt) + var(--inkwell-dock-face-pb)
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

    .bar > blocky-button {
      height: 100%;
      min-height: 0;
      align-self: stretch;
    }

    /* Let the tool label collapse with ellipsis when the bar hits max-width; 96px min was clipping. */
    .bar > blocky-button.dock-btn-flex {
      flex: 0 1 auto;
      min-width: 0;
    }

    /* Icon-only and color: fixed size, never flex-shrink (avoids right-edge clip). */
    .bar > blocky-button.dock-btn-icon {
      flex: 0 0 var(--inkwell-dock-control);
      min-width: var(--inkwell-dock-control);
      max-width: var(--inkwell-dock-control);
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
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.01em;
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

  /** 3D chrome for dock color toggle: face = ink, depth strip = slightly offset for contrast. */
  private dockColorBlockChromeStyle(): string {
    const c = this.dockColor.value;
    return `--block-face-bg: ${c}; --block-depth-color: ${dockColorDepthStripColor(c)};`;
  }

  private initializeAllPanelsHidden() {
    this.panelVisibility = this.panelVisibility.map((panel) => {
      const el = document.getElementById(panel.id) as ToggleablePanel | null;
      if (el) {
        el.style.display = "none";
      }
      return { ...panel, visible: false };
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
      if (p.id === id || !p.visible) return;
      const otherEl = document.getElementById(p.id) as ToggleablePanel | null;
      if (!otherEl || otherEl.pinned) return;
      otherEl.hidePanel();
    });

    el.style.display = "";
    await el.updateComplete;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    if (triggerEl) {
      anchorPanelBelowTrigger(el, triggerEl);
    }
    raisePanelZIndex(el);
    this.panelVisibility = this.panelVisibility.map((p) =>
      p.id === id ? { ...p, visible: true } : p,
    );
  }

  private onPanelVisibilityChange(e: CustomEvent<{ id: string; visible: boolean }>) {
    const { id, visible } = e.detail;
    this.panelVisibility = this.panelVisibility.map((panel) =>
      panel.id === id ? { ...panel, visible } : panel,
    );
  }

  private closePanelsOnOutsideClick(e: PointerEvent) {
    const path = e.composedPath();
    const clickedInsidePanel = path.some(
      (node) => node instanceof HTMLElement && node.hasAttribute("data-panel"),
    );
    if (clickedInsidePanel) return;

    let changed = false;
    this.panelVisibility.forEach((panel) => {
      if (!panel.visible) return;
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
      if (!panel.visible) return;
      const trigger = this.renderRoot.querySelector<HTMLElement>(
        `blocky-button[data-panel-trigger="${panel.id}"]`,
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

  /** Panel toggle buttons in dock order. */
  private visiblePanelTriggers(): PanelVisibility[] {
    return TOP_BAR_PANEL_IDS.map((id) => this.panelVisibility.find((p) => p.id === id))
      .filter((p): p is PanelVisibility => Boolean(p));
  }

  render() {
    const currentToolName = getTool(this.tool.value).name;
    const panelTriggers = this.visiblePanelTriggers();
    return html`
      <div class="block">
        <div class="face">
          <div class="bar">
            ${panelTriggers.map(
                (panel) => html`
                  <blocky-button
                    data-panel-trigger=${panel.id}
                    class=${panel.id === "tools-panel" ? "dock-btn-flex" : "dock-btn-icon"}
                    title=${panel.id === "tools-panel" ? currentToolName : panel.label}
                    data-interactive
                    stretch
                    style=${panel.id === "color-panel" ? this.dockColorBlockChromeStyle() : nothing}
                    ?active=${panel.visible}
                    @click=${(e: Event) =>
                      this.togglePanel(panel.id, e.currentTarget as HTMLElement)}
                    >${this.renderPanelTriggerContent(panel.id)}</blocky-button
                  >
                `,
              )}
          </div>
        </div>
      </div>
    `;
  }
}
