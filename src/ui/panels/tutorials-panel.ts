import { html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { FloatingPanel } from "../primitives/floating-panel";
import { raisePanelZIndex } from "../primitives/panel-anchor";
import {
  TUTORIAL_ARTICLES,
  getTutorial,
  type TutorialId,
  type TutorialSection,
} from "../help/tutorials";

/**
 * Tutorials window — short flow articles (not button tip catalog).
 * Opened from Settings (not the top dock).
 */
@customElement("flipcel-tutorials-panel")
export class FlipCelTutorialsPanel extends FloatingPanel {
  @state() private openId: TutorialId | null = null;

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      --panel-width: 360px;
      --panel-min-width: 260px;
    }

    .intro {
      margin: 0 0 10px;
      font-size: 12px;
      font-weight: 500;
      line-height: 1.45;
      color: var(--flipcel-text-muted, #666);
    }

    .article-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin: 0;
      padding: 0;
    }

    .article-link {
      display: flex;
      flex-direction: column;
      gap: 3px;
      width: 100%;
      margin: 0;
      padding: 9px 10px;
      border: none;
      border-radius: var(--flipcel-content-radius, 6px);
      background: transparent;
      color: var(--flipcel-text-primary, #1a1a1a);
      font: inherit;
      text-align: left;
      cursor: pointer;
      box-sizing: border-box;
    }

    .article-link:hover {
      background: color-mix(
        in srgb,
        var(--panel-accent, #4a6fb5) 14%,
        transparent
      );
    }

    .article-link:focus {
      outline: none;
    }

    .article-link:focus-visible {
      box-shadow: inset 0 0 0 2px var(--panel-accent-muted, rgba(74, 111, 181, 0.35));
    }

    .article-link-title {
      font-weight: 700;
      line-height: 1.3;
    }

    .article-link-summary {
      font-size: 12px;
      font-weight: 500;
      line-height: 1.4;
      color: var(--flipcel-text-secondary, #333);
    }

    .header-back {
      appearance: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      margin: 0;
      padding: 0 6px;
      min-width: var(--panel-header-control-size, 26px);
      height: var(--panel-header-control-size, 26px);
      border: none;
      border-radius: var(--flipcel-content-radius, 6px);
      background: transparent;
      color: var(--flipcel-text-primary, #1a1a1a);
      font: inherit;
      font-size: 14px;
      font-weight: 700;
      line-height: 1;
      cursor: pointer;
      box-sizing: border-box;
    }

    .header-back:hover {
      background: color-mix(
        in srgb,
        var(--panel-accent, #4a6fb5) 16%,
        transparent
      );
    }

    .header-back:focus {
      outline: none;
    }

    .header-back:focus-visible {
      box-shadow: inset 0 0 0 2px var(--panel-accent-muted, rgba(74, 111, 181, 0.35));
    }

    .panel-title-row {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 4px;
      min-width: 0;
      max-width: 100%;
    }

    .panel-title-row .panel-title {
      min-width: 0;
    }

    .article-section {
      margin: 0 0 10px;
      font-size: 12px;
      font-weight: 500;
      line-height: 1.5;
      color: var(--flipcel-text-secondary, #333);
    }

    .article-section:last-child {
      margin-bottom: 0;
    }

    .steps-title {
      margin: 0 0 4px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--flipcel-text-muted, #666);
    }

    .steps {
      margin: 0;
      padding: 0 0 0 1.2em;
    }

    .steps li {
      margin: 0 0 5px;
    }

    .steps li:last-child {
      margin-bottom: 0;
    }

    .note {
      margin: 0 0 10px;
      padding: 8px 10px;
      border-radius: var(--flipcel-content-radius, 6px);
      background: color-mix(
        in srgb,
        var(--panel-accent, #4a6fb5) 16%,
        transparent
      );
      font-size: 12px;
      font-weight: 500;
      line-height: 1.45;
      color: var(--flipcel-text-primary, #1a1a1a);
    }

    .note:last-child {
      margin-bottom: 0;
    }

    .hint-footer {
      margin: 12px 0 0;
      padding-top: 10px;
      border-top: 1px solid
        color-mix(in srgb, var(--flipcel-text-muted, #666) 28%, transparent);
      font-size: 11px;
      font-weight: 500;
      line-height: 1.4;
      color: var(--flipcel-text-muted, #666);
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.pinned = true;
    this.showPinnedClose = true;
    this.masonry = false;
  }

  protected override canPreviewDockHover(): boolean {
    return false;
  }

  protected override onDragCommitted() {
    this.pinned = true;
  }

  /** Back control lives in the title bar when reading an article. */
  protected override renderPanelTitle(title: string) {
    if (!this.openId) {
      return html`<h3 class="panel-title"><span>${title}</span></h3>`;
    }
    return html`
      <div class="panel-title-row">
        <button
          type="button"
          class="header-back"
          data-interactive
          title="All tutorials"
          aria-label="Back to all tutorials"
          @click=${(e: Event) => {
            e.stopPropagation();
            this.backToList();
          }}
        >
          ←
        </button>
        <h3 class="panel-title"><span>${title}</span></h3>
      </div>
    `;
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

    const width = this.offsetWidth || 360;
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

    this.style.left = `${Math.max(margin, window.innerWidth - width - 16)}px`;
    this.style.top = "22%";
    this.playShowAnimation();
  }

  private openArticle(id: TutorialId) {
    this.openId = id;
  }

  private backToList() {
    this.openId = null;
  }

  private renderSection(section: TutorialSection) {
    if (section.type === "p") {
      return html`<p class="article-section">${section.text}</p>`;
    }
    if (section.type === "note") {
      return html`<p class="note">${section.text}</p>`;
    }
    return html`
      <div class="article-section">
        ${section.title
          ? html`<p class="steps-title">${section.title}</p>`
          : nothing}
        <ol class="steps">
          ${section.items.map((item) => html`<li>${item}</li>`)}
        </ol>
      </div>
    `;
  }

  private renderList() {
    return html`
      <p class="intro">
        Quick how-tos. Hover any control for a one-line tip.
      </p>
      <div class="article-list">
        ${TUTORIAL_ARTICLES.map(
          (article) => html`
            <button
              type="button"
              class="article-link"
              @click=${() => this.openArticle(article.id)}
            >
              <span class="article-link-title">${article.title}</span>
              <span class="article-link-summary">${article.summary}</span>
            </button>
          `,
        )}
      </div>
    `;
  }

  private renderArticle(id: TutorialId) {
    const article = getTutorial(id);
    if (!article) return this.renderList();
    return html`
      ${article.sections.map((s) => this.renderSection(s))}
      <p class="hint-footer">
        Hover toolbar controls anytime for short tips.
      </p>
    `;
  }

  render() {
    const article = this.openId ? getTutorial(this.openId) : null;
    const title = article?.title ?? "Tutorials";
    return this.renderFloatingBlock(
      title,
      this.openId ? this.renderArticle(this.openId) : this.renderList(),
    );
  }
}
