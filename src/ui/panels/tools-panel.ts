import { html, css, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { type ToolId, getTool } from "../../tools/registry";
import { toolStore, StoreController } from "../../state";
import { FloatingPanel } from "../primitives/floating-panel";
import { phosphorIcon } from "../icons/phosphor";
import type { FlipCelToolSettingsPanel } from "./tool-settings-panel";

// ============================================================
// Tools Panel — compact icon rail with a custom drag header
// ============================================================

const DOUBLE_TAP_MS = 350;
const HOLD_OPEN_MS = 400;
const HOLD_SLOP_PX = 10;

@customElement("flipcel-tools-panel")
export class FlipCelToolsPanel extends FloatingPanel {
  @property({ type: Boolean, reflect: true }) override masonry = false;

  private tool = new StoreController(this, toolStore);

  /** Last tool icon tap, for touch double-tap → open settings. */
  private lastTap: { toolId: ToolId; time: number } | null = null;

  /** Press-and-hold on a tool icon → open settings. */
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private holdToolId: ToolId | null = null;
  private holdOrigin: { x: number; y: number } | null = null;
  private holdOpened = false;
  private suppressNextClick = false;

  /** Panel tool order; pan is dock-only and omitted here. */
  private static readonly TOOLS: ToolId[] = [
    "select",
    "direct-select",
    "magic-move",
    "magic-morph",
    "brush",
    "lasso",
    "fill",
    "magnet",
    "eyedropper",
  ];

  connectedCallback() {
    super.connectedCallback();
    this.showPinnedClose = false;
    this.resizable = false;
  }

  /** Use the compact tools header instead of the standard titled bar. */
  protected override showsDragHandlePill(): boolean {
    return false;
  }

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      --panel-width: 56px;
      --panel-min-width: 48px;
      --tools-header-h: 28px;
    }

    /* Compact top bar — full-width grab, not the wide-panel header chrome. */
    .tools-header {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      box-sizing: border-box;
      width: 100%;
      height: var(--tools-header-h);
      min-height: var(--tools-header-h);
      padding: 0;
      margin: 0;
      background: var(--block-face-bg);
      border-radius: calc(var(--block-radius) - var(--block-border-width, 0px))
        calc(var(--block-radius) - var(--block-border-width, 0px)) 0 0;
      cursor: grab;
      -webkit-tap-highlight-color: transparent;
      touch-action: none;
      user-select: none;
    }

    :host([dragging]) .tools-header {
      cursor: grabbing;
    }

    .tools-drag-pill {
      width: 1.75rem;
      height: 5px;
      border-radius: 999px;
      background: var(--block-border, #555555);
      flex-shrink: 0;
      pointer-events: none;
    }

    .panel-body > .face {
      border-radius: 0 0 calc(var(--block-radius) - var(--block-border-width, 0px))
        calc(var(--block-radius) - var(--block-border-width, 0px));
    }

    .tools-rail {
      width: 100%;
      min-width: 0;
    }

    .tools-rail .grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 6px;
      width: 100%;
      min-width: 0;
    }

    .tools-rail .tool-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      line-height: 0;
    }

    .tools-rail .tool-icon svg {
      display: block;
    }
  `;

  private emit(name: string, detail?: unknown) {
    this.dispatchEvent(
      new CustomEvent(name, { detail, bubbles: true, composed: true }),
    );
  }

  private setTool(tool: ToolId) {
    this.tool.set(tool);
    this.emit("tool-change", tool);
  }

  private openToolSettings() {
    const panel = document.getElementById(
      "tool-settings-panel",
    ) as FlipCelToolSettingsPanel | null;
    if (!panel) return;
    void panel.showNear(this);
  }

  private clearHoldTimer() {
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    this.holdToolId = null;
    this.holdOrigin = null;
  }

  private onToolPointerDown(toolId: ToolId, e: PointerEvent) {
    if (e.button !== 0 && e.pointerType === "mouse") return;

    this.clearHoldTimer();
    this.holdOpened = false;
    this.holdToolId = toolId;
    this.holdOrigin = { x: e.clientX, y: e.clientY };

    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (this.holdToolId !== toolId) return;
      this.holdOpened = true;
      this.suppressNextClick = true;
      this.lastTap = null;
      this.setTool(toolId);
      this.openToolSettings();
      try {
        navigator.vibrate?.(10);
      } catch {
        /* ignore */
      }
    }, HOLD_OPEN_MS);

    const onMove = (ev: PointerEvent) => {
      const origin = this.holdOrigin;
      if (!origin || this.holdOpened) return;
      const dx = ev.clientX - origin.x;
      const dy = ev.clientY - origin.y;
      if (dx * dx + dy * dy >= HOLD_SLOP_PX * HOLD_SLOP_PX) {
        this.clearHoldTimer();
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      if (!this.holdOpened) this.clearHoldTimer();
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
  }

  private onToolActivate(toolId: ToolId) {
    if (this.suppressNextClick) {
      this.suppressNextClick = false;
      return;
    }

    const now = performance.now();
    const prev = this.lastTap;
    const isDouble =
      prev !== null &&
      prev.toolId === toolId &&
      now - prev.time <= DOUBLE_TAP_MS;

    this.setTool(toolId);

    if (isDouble) {
      this.lastTap = null;
      this.openToolSettings();
      return;
    }

    this.lastTap = { toolId, time: now };
  }

  private renderToolButton(toolId: ToolId): TemplateResult {
    const t = getTool(toolId);
    const icon = t.icon ?? "paint-brush";
    return html`
      <blocky-button
        flat
        title=${`${t.name} (hold or double-tap for settings)`}
        aria-label=${t.name}
        ?active=${this.tool.value === toolId}
        @pointerdown=${(e: PointerEvent) => this.onToolPointerDown(toolId, e)}
        @click=${() => this.onToolActivate(toolId)}
      >
        <span class="tool-icon">${phosphorIcon(icon, 18)}</span>
      </blocky-button>
    `;
  }

  /** Narrow-rail shell: custom top drag bar + tool icons + footer. */
  private renderToolsBlock(content: TemplateResult) {
    return html`
      <div class="block">
        <div
          class="tools-header"
          data-drag-handle
          title="Drag to move"
        >
          <div class="tools-drag-pill" aria-hidden="true"></div>
        </div>
        <div class="panel-body">
          <div class="face">
            <div class="panel-form">${content}</div>
          </div>
        </div>
        ${this.renderPanelFooter()}
      </div>
    `;
  }

  render() {
    return this.renderToolsBlock(html`
      <div class="tools-rail" data-interactive>
        <div class="grid">
          ${FlipCelToolsPanel.TOOLS.map((toolId) => this.renderToolButton(toolId))}
        </div>
      </div>
    `);
  }
}
