import { html, css, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { type ToolId, getTool } from "../../tools/registry";
import { toolStore, StoreController } from "../../state";
import { FloatingPanel } from "../primitives/floating-panel";
import { phosphorIcon } from "../icons/phosphor";
import type { InkwellToolSettingsPanel } from "./tool-settings-panel";

// ============================================================
// Tools Panel — compact icon rail (not a titled floating panel)
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

  protected override showsDragHandlePill(): boolean {
    return false;
  }

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      --panel-width: 56px;
      --panel-min-width: 48px;
    }

    .panel-body > .face {
      border-radius: calc(var(--block-radius) - var(--block-border-width, 0px));
    }

    .tools-shell {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      min-width: 0;
    }

    .tools-drag {
      align-self: center;
      width: 2.5rem;
      height: 7px;
      border-radius: 999px;
      background: var(--block-border, #555555);
      flex-shrink: 0;
      cursor: grab;
    }

    :host([dragging]) .tools-drag {
      cursor: grabbing;
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

  /** Title-less shell: grab pill + body only (no close control). */
  private renderToolsBlock(content: TemplateResult) {
    return html`
      <div class="block">
        <div class="panel-body">
          <div class="face">
            ${this.renderResizeHandles()}
            <div class="panel-form">
              <div class="tools-shell">
                <div
                  class="tools-drag"
                  data-drag-handle
                  title="Drag to move"
                  aria-hidden="true"
                ></div>
                ${content}
              </div>
            </div>
          </div>
        </div>
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
