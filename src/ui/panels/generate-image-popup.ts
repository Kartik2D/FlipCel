import { html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { PopupWindow } from "../primitives/popup-window";
import { generateImageFile } from "../../import/generate-image";

export type GenerateImageReadyDetail = {
  file: File;
  anchor: HTMLElement | null;
};

type ChatMsg = { role: "user" | "assistant"; text: string };

/**
 * Prompt chat for AI image gen. On success, hands the File to image import.
 */
@customElement("flipcel-generate-image-popup")
export class FlipCelGenerateImagePopup extends PopupWindow {
  static styles = css`
    ${PopupWindow.styles}

    :host {
      --panel-width: 280px;
      --panel-min-width: 220px;
      font-size: 12px;
    }

    .hint {
      margin: 0;
      color: var(--flipcel-text-secondary, #6b6b6b);
      font-weight: 500;
      line-height: 1.3;
    }

    .messages {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-height: 72px;
      max-height: 200px;
      overflow-y: auto;
    }

    .msg {
      margin: 0;
      padding: 6px 8px;
      border-radius: var(--flipcel-content-radius, 6px);
      line-height: 1.3;
      max-width: 92%;
    }

    .msg.user {
      align-self: flex-end;
      background: var(--block-depth-color, #bcbcbc);
      color: var(--block-border, #555555);
    }

    .msg.assistant {
      align-self: flex-start;
      background: var(--flipcel-track-bg, #cfcfcf);
      color: var(--flipcel-text-primary, #1a1a1a);
    }

    textarea {
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      min-height: 56px;
      resize: none;
      font: inherit;
      padding: 5px 8px;
      margin: 0;
      border: none;
      border-radius: var(--flipcel-content-radius);
      background-color: var(--block-depth-color, #bcbcbc);
      color: var(--block-border, #555555);
    }

    textarea:focus {
      outline: none;
      box-shadow: 0 0 0 2px var(--panel-accent-muted, rgba(74, 111, 181, 0.35));
    }
  `;

  @state() private draft = "";
  @state() private busy = false;
  @state() private messages: ChatMsg[] = [];

  private gen = 0;
  private trigger: HTMLElement | null = null;

  async open(anchor: HTMLElement): Promise<void> {
    this.gen += 1;
    this.busy = false;
    this.draft = "";
    this.messages = [];
    this.trigger = anchor;
    await this.showNearAnchor(anchor);
  }

  override hidePanel() {
    this.gen += 1;
    this.busy = false;
    this.trigger = null;
    super.hidePanel();
  }

  private onDraftKeydown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void this.send();
    }
  }

  private async send() {
    const text = this.draft.trim();
    if (!text || this.busy) return;
    const gen = ++this.gen;
    this.draft = "";
    this.messages = [
      ...this.messages,
      { role: "user", text },
      { role: "assistant", text: "Generating…" },
    ];
    this.busy = true;
    try {
      const file = await generateImageFile(text);
      if (this.gen !== gen) return;
      const anchor = this.trigger;
      this.hidePanel();
      this.dispatchEvent(
        new CustomEvent<GenerateImageReadyDetail>("generate-image-ready", {
          detail: { file, anchor },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (err) {
      if (this.gen !== gen) return;
      const message = err instanceof Error ? err.message : "Generate failed.";
      this.messages = [
        ...this.messages.slice(0, -1),
        { role: "assistant", text: message },
      ];
      if (!this.draft) this.draft = text;
      this.busy = false;
    }
  }

  render() {
    return this.renderPopupBlock(html`
      <p class="hint">Describe an image, then import the result as vectors.</p>
      <div class="messages">
        ${this.messages.map(
          (msg) => html`<p class="msg ${msg.role}">${msg.text}</p>`,
        )}
      </div>
      <textarea
        data-interactive
        .value=${this.draft}
        ?disabled=${this.busy}
        placeholder="a red bicycle on a hill"
        aria-label="Image prompt"
        @input=${(e: Event) => {
          this.draft = (e.target as HTMLTextAreaElement).value;
        }}
        @keydown=${(e: KeyboardEvent) => this.onDraftKeydown(e)}
      ></textarea>
      <blocky-button
        flat
        accent
        stretch
        ?disabled=${this.busy || !this.draft.trim()}
        @click=${() => this.send()}
        >${this.busy ? "Generating…" : "Generate"}</blocky-button
      >
    `);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "flipcel-generate-image-popup": FlipCelGenerateImagePopup;
  }
}
