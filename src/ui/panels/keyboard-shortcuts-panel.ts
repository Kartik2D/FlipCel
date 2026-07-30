import { html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { StoreController } from "../../state";
import {
  type ChordBinding,
  type ModifierId,
  type ShortcutActionId,
  chordFromEvent,
  formatBinding,
  formatModifier,
  getShortcutActions,
  resetAllShortcuts,
  setBinding,
  setShortcutsCaptureActive,
  shortcutsStore,
} from "../../input/shortcuts";
import { FloatingPanel } from "../primitives/floating-panel";
import { raisePanelZIndex } from "../primitives/panel-anchor";

const MODIFIER_OPTIONS: readonly ModifierId[] = ["shift", "alt", "ctrl", "meta"];

/**
 * Keyboard Shortcuts window — remappable chords and modifier actions.
 * Opened from Settings (not the top dock).
 */
@customElement("flipcel-keyboard-shortcuts-panel")
export class FlipCelKeyboardShortcutsPanel extends FloatingPanel {
  private shortcuts = new StoreController(this, shortcutsStore);

  @state() private capturingId: ShortcutActionId | null = null;
  @state() private captureError: string | null = null;

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      /* Wide masonry default — Tools / Edit / Modifiers sit side by side. */
      --panel-width: 600px;
      --panel-min-width: 280px;
    }

    .binding-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin: 0;
      padding: 0;
    }

    .binding-row {
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-height: 28px;
    }

    .binding-label {
      flex: 1 1 auto;
      min-width: 0;
      color: var(--flipcel-text-secondary, #333333);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .binding-chip {
      appearance: none;
      flex: 0 0 auto;
      min-width: 3.5rem;
      margin: 0;
      padding: 4px 8px;
      border: var(--block-border-width, var(--flipcel-block-border-width, 2px)) solid
        var(--block-border, #555555);
      border-radius: var(--flipcel-content-radius);
      background: var(--flipcel-panel-inset-bg, #2a2a2a);
      color: var(--flipcel-text-primary, #f0f0f0);
      font: inherit;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.02em;
      cursor: pointer;
      box-sizing: border-box;
    }

    .binding-chip:hover {
      filter: brightness(1.05);
    }

    .binding-chip:focus {
      outline: none;
    }

    .binding-chip:focus-visible {
      box-shadow: inset 0 0 0 2px var(--panel-accent-muted, rgba(74, 111, 181, 0.35));
    }

    .binding-chip.is-capturing {
      background: var(--panel-accent, #4a6fb5);
      color: #ffffff;
      border-color: var(--panel-accent, #4a6fb5);
    }

    .capture-error {
      margin: 4px 0 0;
      color: var(--flipcel-danger, #e85d5d);
      font-size: 11px;
    }

    .capture-hint {
      margin: 4px 0 0;
      color: var(--flipcel-text-muted, #999);
      font-size: 11px;
    }

    .mod-row {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 0 0 10px;
    }

    .mod-row:last-child {
      margin-bottom: 0;
    }

    .mod-label {
      color: var(--flipcel-text-secondary, #333333);
    }

    .mod-options {
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 4px;
    }

    .footer-row {
      display: flex;
      flex-direction: row;
      gap: 8px;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.pinned = true;
    this.showPinnedClose = true;
    this.masonry = true;
  }

  disconnectedCallback() {
    this.stopCapture();
    super.disconnectedCallback();
  }

  override hidePanel() {
    this.stopCapture();
    this.captureError = null;
    super.hidePanel();
  }

  protected override canPreviewDockHover(): boolean {
    return false;
  }

  protected override onDragCommitted() {
    this.pinned = true;
  }

  async show(anchor?: HTMLElement | null) {
    this.pinned = true;
    this.style.display = "";
    raisePanelZIndex(this);

    if (this.style.left) {
      this.playShowAnimation();
      return;
    }

    this.style.right = "auto";
    this.style.bottom = "auto";
    await this.updateComplete;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    const width = this.offsetWidth || 600;
    const height = this.offsetHeight || 280;
    const margin = 8;

    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      let left = rect.right + 10;
      let top = rect.top;
      if (left + width > window.innerWidth - margin) {
        left = Math.max(margin, rect.left - width - 10);
      }
      if (top + height > window.innerHeight - margin) {
        top = Math.max(margin, window.innerHeight - height - margin);
      }
      this.style.left = `${Math.max(margin, left)}px`;
      this.style.top = `${Math.max(margin, top)}px`;
      this.playShowAnimation();
      return;
    }

    this.style.left = `${Math.max(margin, window.innerWidth - width - 24)}px`;
    this.style.top = `${Math.max(margin, 72)}px`;
    this.playShowAnimation();
  }

  private stopCapture() {
    if (this.capturingId) {
      window.removeEventListener("keydown", this.onCaptureKeyDown, true);
      setShortcutsCaptureActive(false);
    }
    this.capturingId = null;
  }

  private startCapture(actionId: ShortcutActionId) {
    if (this.capturingId === actionId) {
      this.stopCapture();
      this.captureError = null;
      return;
    }
    this.stopCapture();
    this.capturingId = actionId;
    this.captureError = null;
    setShortcutsCaptureActive(true);
    window.addEventListener("keydown", this.onCaptureKeyDown, true);
  }

  private onCaptureKeyDown = (e: KeyboardEvent) => {
    if (!this.capturingId) return;

    // Ignore bare modifier presses — wait for a real key.
    if (
      e.key === "Shift" ||
      e.key === "Control" ||
      e.key === "Alt" ||
      e.key === "Meta"
    ) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Escape") {
      this.stopCapture();
      this.captureError = null;
      return;
    }

    const binding: ChordBinding = chordFromEvent(e);
    const error = setBinding(this.capturingId, binding);
    if (error) {
      this.captureError = error;
      return;
    }

    this.stopCapture();
    this.captureError = null;
  };

  private setModifierAction(actionId: "mod.paintMode" | "mod.wheelPan", modifier: ModifierId) {
    this.stopCapture();
    this.captureError = null;
    setBinding(actionId, { kind: "modifier", modifier });
  }

  private onResetAll() {
    this.stopCapture();
    this.captureError = null;
    resetAllShortcuts();
  }

  private renderChordRow(id: ShortcutActionId, label: string) {
    const binding = this.shortcuts.value[id];
    const capturing = this.capturingId === id;
    const chipLabel =
      capturing ? "Press key…" : binding ? formatBinding(binding) : "—";
    return html`
      <div class="binding-row">
        <span class="binding-label">${label}</span>
        <button
          type="button"
          class="binding-chip ${capturing ? "is-capturing" : ""}"
          data-interactive
          title=${capturing ? "Press a key, or Escape to cancel" : "Click to rebind"}
          @click=${() => this.startCapture(id)}
        >
          ${chipLabel}
        </button>
      </div>
    `;
  }

  private renderModifierRow(id: "mod.paintMode" | "mod.wheelPan", label: string) {
    const binding = this.shortcuts.value[id];
    const current = binding?.kind === "modifier" ? binding.modifier : "shift";
    return html`
      <div class="mod-row">
        <span class="mod-label">${label}</span>
        <div class="mod-options">
          ${MODIFIER_OPTIONS.map(
            (mod) => html`
              <blocky-button
                flat
                ?active=${current === mod}
                @click=${() => this.setModifierAction(id, mod)}
                >${formatModifier(mod)}</blocky-button
              >
            `,
          )}
        </div>
      </div>
    `;
  }

  render() {
    const actions = getShortcutActions();
    const tools = actions.filter((a) => a.group === "tools");
    const edit = actions.filter((a) => a.group === "edit");

    return this.renderFloatingBlock(
      "Keyboard Shortcuts",
      html`
        <flipcel-panel-section title="Tools" data-interactive>
          <div class="binding-list">
            ${tools.map((a) => this.renderChordRow(a.id, a.label))}
          </div>
          ${this.capturingId?.startsWith("tool.")
            ? html`<p class="capture-hint">Press a key (Escape to cancel)</p>`
            : nothing}
          ${this.captureError && this.capturingId?.startsWith("tool.")
            ? html`<p class="capture-error">${this.captureError}</p>`
            : nothing}
        </flipcel-panel-section>

        <flipcel-panel-section title="Edit" data-interactive>
          <div class="binding-list">
            ${edit.map((a) => this.renderChordRow(a.id, a.label))}
          </div>
          ${this.capturingId?.startsWith("edit.")
            ? html`<p class="capture-hint">Press a shortcut (Escape to cancel)</p>`
            : nothing}
          ${this.captureError && this.capturingId?.startsWith("edit.")
            ? html`<p class="capture-error">${this.captureError}</p>`
            : nothing}
        </flipcel-panel-section>

        <flipcel-panel-section title="Modifiers" data-interactive>
          ${this.renderModifierRow("mod.paintMode", "Paint mode toggle")}
          ${this.renderModifierRow("mod.wheelPan", "Wheel pan")}
        </flipcel-panel-section>

        <flipcel-panel-section data-interactive>
          <div class="footer-row">
            <blocky-button flat @click=${() => this.onResetAll()}
              >Reset all</blocky-button
            >
          </div>
        </flipcel-panel-section>
      `,
    );
  }
}
