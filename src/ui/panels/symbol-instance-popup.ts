import { html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { PopupWindow } from "../primitives/popup-window";
import { anchorPanelBelowTrigger, raisePanelZIndex } from "../primitives/panel-anchor";
import { SYMBOL_PLAY_MODES, type SymbolPlayMode } from "../../document/symbols";

export interface SymbolInstancePopupModel {
  symbolId: string;
  symbolName: string;
  duration: number;
  tags: Array<{ id: string; name: string; start: number; end: number }>;
  mode: SymbolPlayMode;
  /** 0-based. */
  firstFrame: number;
  /** Other symbols this instance may swap to (cycles already filtered out). */
  swapCandidates: Array<{ id: string; name: string }>;
}

export interface InstancePlaybackDetail {
  mode: SymbolPlayMode;
  firstFrame: number;
}

const MODE_LABEL: Record<SymbolPlayMode, string> = {
  loop: "Loop",
  once: "Play Once",
  single: "Single Frame",
};

/**
 * Per-instance symbol settings, opened from the "Symbol…" contextual action
 * when exactly one instance is selected. Changes apply live; the host
 * snapshots history per change.
 *
 * Events: instance-playback-change ({ mode, firstFrame }), instance-swap
 * ({ symbolId }), instance-edit, instance-reset-pivot.
 */
@customElement("flipcel-symbol-instance-popup")
export class FlipCelSymbolInstancePopup extends PopupWindow {
  static styles = css`
    ${PopupWindow.styles}

    :host {
      --panel-width: 230px;
      font-size: 12px;
    }

    .name-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 24px;
    }

    .name {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 700;
      color: var(--flipcel-text-primary, #1a1a1a);
    }

    .hint {
      margin: 0;
      color: var(--flipcel-text-secondary, #6b6b6b);
      font-weight: 500;
      line-height: 1.3;
    }

    .mode-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .frame-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .frame-row > span {
      flex: 1 1 auto;
      color: var(--flipcel-text-secondary, #333);
    }

    .frame-input {
      width: 52px;
      padding: 3px 4px;
      border: 1px solid var(--flipcel-panel-border, #8a8a8a);
      border-radius: 4px;
      font: inherit;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }

    .swap-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 160px;
      overflow: auto;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .swap-item {
      width: 100%;
      padding: 6px 8px;
      border: none;
      border-radius: var(--flipcel-content-radius, 6px);
      background: transparent;
      color: var(--flipcel-text-primary, #1a1a1a);
      font: inherit;
      font-weight: 600;
      text-align: left;
      cursor: pointer;
    }

    .swap-item:hover {
      background: color-mix(in srgb, var(--panel-accent, #4a6fb5) 14%, transparent);
    }

    .tag-select {
      width: 100%;
      font: inherit;
      padding: 3px 4px;
    }

    .row {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
    }
  `;

  @state() private model: SymbolInstancePopupModel | null = null;
  @state() private swapping = false;

  async openFor(model: SymbolInstancePopupModel, anchor: HTMLElement): Promise<void> {
    this.model = model;
    this.swapping = false;
    this.style.display = "";
    await this.updateComplete;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    anchorPanelBelowTrigger(this, anchor);
    raisePanelZIndex(this);
    this.playShowAnimation();
  }

  /** Refresh displayed values after the host applied a change (e.g. swap). */
  setModel(model: SymbolInstancePopupModel): void {
    this.model = model;
  }

  private emit(name: string, detail?: unknown) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private setPlayback(patch: Partial<InstancePlaybackDetail>) {
    if (!this.model) return;
    const maxFrame = Math.max(0, this.model.duration - 1);
    const next: InstancePlaybackDetail = {
      mode: patch.mode ?? this.model.mode,
      firstFrame: Math.max(0, Math.min(maxFrame, Math.round(patch.firstFrame ?? this.model.firstFrame))),
    };
    if (next.mode === this.model.mode && next.firstFrame === this.model.firstFrame) return;
    this.model = { ...this.model, ...next };
    this.emit("instance-playback-change", next);
  }

  render() {
    const m = this.model;
    if (!m) return this.renderPopupBlock(html``);
    const frame1 = m.firstFrame + 1;
    const currentTag = m.tags.find((t) => t.start === m.firstFrame)?.id ?? "";

    if (this.swapping) {
      return this.renderPopupBlock(html`
        <div class="name-row">
          <span class="name">Swap ${m.symbolName}</span>
          <blocky-button flat @click=${() => (this.swapping = false)}>Back</blocky-button>
        </div>
        ${m.swapCandidates.length === 0
          ? html`<p class="hint">No other symbols to swap to.</p>`
          : html`
              <ul class="swap-list" role="listbox" aria-label="Swap symbol">
                ${m.swapCandidates.map(
                  (c) => html`
                    <li>
                      <button
                        type="button"
                        class="swap-item"
                        role="option"
                        data-interactive
                        @click=${() => {
                          this.swapping = false;
                          this.emit("instance-swap", { symbolId: c.id });
                        }}
                      >
                        ${c.name}
                      </button>
                    </li>
                  `,
                )}
              </ul>
            `}
      `);
    }

    return this.renderPopupBlock(html`
      <div class="name-row">
        <span class="name" title=${m.symbolName}>${m.symbolName}</span>
        <blocky-button flat @click=${() => (this.swapping = true)}>Swap</blocky-button>
      </div>
      <div class="mode-row">
        ${SYMBOL_PLAY_MODES.map(
          (mode) => html`
            <blocky-button
              flat
              stretch
              ?accent=${m.mode === mode}
              @click=${() => this.setPlayback({ mode })}
              >${MODE_LABEL[mode]}</blocky-button
            >
          `,
        )}
      </div>
      <div class="frame-row">
        <span>First frame</span>
        <blocky-button
          flat
          ?disabled=${m.firstFrame <= 0}
          @click=${() => this.setPlayback({ firstFrame: m.firstFrame - 1 })}
          >−</blocky-button
        >
        <input
          class="frame-input"
          type="number"
          min="1"
          max=${m.duration}
          step="1"
          .value=${String(frame1)}
          data-interactive
          @change=${(e: Event) => {
            const v = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(v)) this.setPlayback({ firstFrame: v - 1 });
          }}
        />
        <blocky-button
          flat
          ?disabled=${m.firstFrame >= m.duration - 1}
          @click=${() => this.setPlayback({ firstFrame: m.firstFrame + 1 })}
          >+</blocky-button
        >
      </div>
      ${m.tags.length > 0
        ? html`
            <select
              class="tag-select"
              data-interactive
              .value=${currentTag}
              @change=${(e: Event) => {
                const id = (e.target as HTMLSelectElement).value;
                const tag = m.tags.find((t) => t.id === id);
                if (tag) this.setPlayback({ firstFrame: tag.start });
              }}
            >
              <option value="">Start at tag…</option>
              ${m.tags.map(
                (t) => html`<option value=${t.id} ?selected=${t.id === currentTag}>
                  ${t.name} (${t.start + 1}–${t.end + 1})
                </option>`,
              )}
            </select>
          `
        : nothing}
      <div class="row">
        <blocky-button flat accent @click=${() => this.emit("instance-edit")}
          >Edit Symbol</blocky-button
        >
        <blocky-button flat @click=${() => this.emit("instance-reset-pivot")}
          >Reset Pivot</blocky-button
        >
      </div>
    `);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "flipcel-symbol-instance-popup": FlipCelSymbolInstancePopup;
  }
}
