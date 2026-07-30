import { html, css, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { type ToolId, getTool } from "../../tools/registry";
import { toolStore, StoreController } from "../../state";
import { FloatingPanel } from "../primitives/floating-panel";
import { phosphorIcon } from "../icons/phosphor";
import type { InkwellToolSettingsPanel } from "./tool-settings-panel";

// ============================================================
// Tools Panel — compact icon rail with a custom drag header
// ============================================================

const DOUBLE_TAP_MS = 350;

@customElement("inkwell-tools-panel")
export class InkwellToolsPanel extends FloatingPanel {
  @property({ type: Boolean, reflect: true }) override masonry = false;

  private tool = new StoreController(this, toolStore);

  /** Last tool icon tap, for touch double-tap → open settings. */
  private lastTap: { toolId: ToolId; time: number } | null = null;

  /** Panel tool order; pan is dock-only and omitted here. */
  private static readonly TOOLS: ToolId[] = [
    "select",
    "direct-select",
    "magic-move",
    "magic-morph",
    "brush",
    "lasso",
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
    ) as InkwellToolSettingsPanel | null;
    if (!panel) return;
    void panel.showNear(this);
  }

  private onToolActivate(toolId: ToolId) {
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
        title=${`${t.name} (double-tap for settings)`}
        aria-label=${t.name}
        ?active=${this.tool.value === toolId}
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
          ${InkwellToolsPanel.TOOLS.map((toolId) => this.renderToolButton(toolId))}
        </div>
      </div>
    `);
  }
}
