import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  themeModeStore,
  THEME_OPTIONS,
  THEMES,
  StoreController,
  type ThemeMode,
} from "../../state";
import { FloatingPanel } from "../primitives/floating-panel";
import { raisePanelZIndex } from "../primitives/panel-anchor";
import { renderThemePreview } from "../theme-preview";

/**
 * Launch chooser shown on every app start.
 * A blank document is already loaded underneath — dismiss / Create new keep it.
 * Normal floating window (no modal scrim); closing hides it for the session.
 */
@customElement("flipcel-startup-panel")
export class FlipCelStartupPanel extends FloatingPanel {
  @property({ type: Boolean }) canRestoreAutosave = false;

  private themeMode = new StoreController(this, themeModeStore);

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      --panel-width: 320px;
      z-index: 1100;
    }

    .block {
      flex: 0 0 auto;
      height: auto;
      min-height: 0;
    }

    .panel-body,
    .panel-body > .face {
      flex: 0 0 auto;
      min-height: 0;
      height: auto;
      overflow: visible;
    }

    .startup-welcome {
      margin: 0 0 var(--flipcel-space-3, 12px);
      padding: 0 var(--flipcel-space-1, 4px);
      text-align: center;
      font-size: 20px;
      font-weight: 600;
      line-height: 1.2;
      letter-spacing: -0.025em;
      color: var(--flipcel-text-primary, #1a1a1a);
    }

    .startup-theme-chip-btn {
      width: 72px;
    }

    .startup-theme-chip {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
      width: 100%;
      min-width: 0;
      padding: 2px 0;
      box-sizing: border-box;
    }

    .startup-theme-chip .theme-preview {
      display: block;
      width: 32px;
      height: 24px;
      flex: 0 0 auto;
      border-radius: 5px;
      overflow: hidden;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
    }

    .startup-theme-chip-label {
      font-size: 10px;
      line-height: 1.1;
      font-weight: 500;
      letter-spacing: var(--flipcel-letter-spacing, -0.011em);
      text-align: center;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .startup-actions {
      display: flex;
      flex-direction: column;
      gap: 10px;
      width: 100%;
    }

    .startup-actions blocky-button {
      width: 100%;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.pinned = true;
    this.showPinnedClose = true;
    this.draggable = true;
    this.resizable = false;
  }

  /** Open as a normal floating window, centered in the viewport. */
  async show() {
    this.pinned = true;
    this.style.display = "";
    this.style.right = "auto";
    this.style.bottom = "auto";
    raisePanelZIndex(this);
    await this.updateComplete;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const width = this.offsetWidth || 280;
    const height = this.offsetHeight || 140;
    this.style.left = `${Math.max(8, (window.innerWidth - width) / 2)}px`;
    this.style.top = `${Math.max(8, (window.innerHeight - height) / 2)}px`;
    this.playShowAnimation();
  }

  private dismiss() {
    this.hidePanel();
  }

  private loadFile() {
    this.dispatchEvent(
      new CustomEvent("startup-load-file", { bubbles: true, composed: true }),
    );
  }

  private restorePrevious() {
    this.dispatchEvent(
      new CustomEvent("startup-restore-autosave", { bubbles: true, composed: true }),
    );
  }

  private loadExample() {
    this.dispatchEvent(
      new CustomEvent("startup-load-example", { bubbles: true, composed: true }),
    );
    this.hidePanel();
  }

  private themeAriaLabel(mode: ThemeMode): string {
    return `Theme: ${THEMES[mode].label}`;
  }

  render() {
    return this.renderFloatingBlock(
      undefined,
      html`
        <h2 class="startup-welcome">Welcome to FlipCel</h2>

        <flipcel-panel-section data-interactive>
          <flipcel-scroll-strip
            label="Pick a theme"
            center-label
            flush
            rows="2"
          >
            ${THEME_OPTIONS.map(
              (mode) => html`
                <blocky-button
                  class="startup-theme-chip-btn"
                  flat
                  ?active=${this.themeMode.value === mode}
                  aria-label=${this.themeAriaLabel(mode)}
                  @click=${() => this.themeMode.set(mode)}
                >
                  <span class="startup-theme-chip">
                    ${renderThemePreview(mode)}
                    <span class="startup-theme-chip-label">${THEMES[mode].label}</span>
                  </span>
                </blocky-button>
              `,
            )}
          </flipcel-scroll-strip>
        </flipcel-panel-section>

        <flipcel-panel-section data-interactive>
          <div class="startup-actions">
            <blocky-button flat large accent stretch @click=${() => this.dismiss()}
              >Create new file</blocky-button
            >
            <blocky-button flat large playhead stretch @click=${() => this.loadExample()}
              >Open example file</blocky-button
            >
            <blocky-button flat large stretch @click=${() => this.loadFile()}
              >Open file</blocky-button
            >
            <blocky-button
              flat
              large
              stretch
              ?disabled=${!this.canRestoreAutosave}
              @click=${() => this.restorePrevious()}
              >Restore previous file</blocky-button
            >
          </div>
        </flipcel-panel-section>
      `,
    );
  }
}
