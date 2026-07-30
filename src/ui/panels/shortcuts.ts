import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { getTool } from "../../tools/registry";
import { paintModeAccent, type PaintModeAccent } from "../../tools/paint-mode";
import {
  toolStore,
  toolSettingsStore,
  modifiersStore,
  StoreController,
} from "../../state";
import { timelineStore } from "../../document/document";
import { FloatingPanel } from "../primitives/floating-panel";
import { dockChipStyles, TOP_BAR_SHORTCUT_CHIPS, type DockInfoChip } from "./dock-chrome";
import type { SettingsSchema } from "../../tools/types";

// ============================================================
// Shortcuts Panel (mode / frame / zoom quick actions)
// ============================================================

@customElement("inkwell-shortcuts-panel")
export class InkwellShortcutsPanel extends FloatingPanel {
  @property({ type: Number }) zoomLevel = 100;

  private tool = new StoreController(this, toolStore);
  private settings = new StoreController(this, toolSettingsStore);
  private modifiers = new StoreController(this, modifiersStore);
  private timeline = new StoreController(this, timelineStore);

  protected override usesFaceScrollbar(): boolean {
    return false;
  }

  protected override playsShowAnimation(): boolean {
    return false;
  }

  static styles = css`
    ${FloatingPanel.styles}
    ${dockChipStyles}

    :host {
      --panel-top: max(8px, calc(env(safe-area-inset-top, 0px) + 2px));
      --panel-left: auto;
      --panel-right: max(8px, env(safe-area-inset-right, 0px));
      --panel-width: auto;
      --panel-min-width: 0;
      --block-face-bg: var(--inkwell-topbar-surface, var(--inkwell-panel-surface, #ffffff));
      z-index: 1200;
      width: auto;
      --inkwell-shadow-panel: var(--inkwell-dock-shadow);
      --inkwell-dock-row-h: 44px;
      --inkwell-dock-control: 44px;
    }

    .face {
      overflow: hidden;
      min-height: calc(
        var(--inkwell-dock-row-h) + (2 * var(--inkwell-block-face-padding))
      );
    }

    .dock-status {
      min-height: var(--inkwell-dock-row-h);
      align-items: center;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.pinned = true;
    this.showPinnedClose = false;
  }

  private emitDock(name: string) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
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
    return this.modifiers.value.shift
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

  render() {
    return html`
      <div class="block">
        <div class="face">
          <div class="dock-status">
            ${TOP_BAR_SHORTCUT_CHIPS.map((kind) =>
              this.renderDockWidget(this.buildInfoChip(kind)),
            )}
          </div>
        </div>
      </div>
    `;
  }
}
