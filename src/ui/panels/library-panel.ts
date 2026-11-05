import { html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { StoreController, symbolLibraryStore, editContextStore } from "../../state";
import { FloatingPanel } from "../primitives/floating-panel";

/**
 * Symbol Library — every symbol in the document with a frame-0 thumbnail.
 * Tap a card to select it; the action row places / edits / duplicates /
 * deletes it. Double-tap the name to rename.
 *
 * Events (bubbling): symbol-place, symbol-edit, symbol-duplicate,
 * symbol-delete ({ id }), symbol-rename ({ id, name }).
 */
@customElement("flipcel-library-panel")
export class FlipCelLibraryPanel extends FloatingPanel {
  private library = new StoreController(this, symbolLibraryStore);
  private context = new StoreController(this, editContextStore);

  @state() private selectedId: string | null = null;
  @state() private editingId: string | null = null;
  @state() private editingName = "";
  private symbolDrag: {
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    ghost: HTMLElement | null;
    active: boolean;
  } | null = null;
  private suppressCardClick = false;

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      --panel-width: 240px;
      --panel-min-width: 200px;
    }

    .library-empty {
      margin: 0;
      padding: 4px 2px;
      color: var(--flipcel-text-muted, #666);
      font-style: italic;
    }

    .library-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(68px, 1fr));
      gap: 6px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .symbol-card {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 4px;
      width: 100%;
      margin: 0;
      padding: 4px;
      border: none;
      border-radius: var(--flipcel-content-radius, 6px);
      background: transparent;
      color: var(--flipcel-text-primary, #1a1a1a);
      font: inherit;
      text-align: center;
      cursor: grab;
      box-sizing: border-box;
      touch-action: none;
    }

    .symbol-card:hover {
      background: color-mix(in srgb, var(--panel-accent, #4a6fb5) 14%, transparent);
    }

    .symbol-card:focus {
      outline: none;
    }

    .symbol-card:focus-visible {
      box-shadow: inset 0 0 0 2px var(--panel-accent-muted, rgba(74, 111, 181, 0.35));
    }

    .symbol-card[aria-selected="true"] {
      background: var(--panel-accent, #4a6fb5);
      color: #ffffff;
    }

    .symbol-card.is-editing[aria-selected="true"] {
      box-shadow: inset 0 0 0 2px #ffffff;
    }

    .symbol-thumb {
      display: block;
      width: 100%;
      aspect-ratio: 1 / 1;
      border-radius: 4px;
      background:
        repeating-conic-gradient(rgba(0, 0, 0, 0.06) 0 25%, transparent 0 50%) 0 0 / 12px 12px,
        #ffffff;
      object-fit: contain;
      box-sizing: border-box;
    }

    .symbol-thumb.is-empty {
      background: rgba(0, 0, 0, 0.06);
    }

    .symbol-name {
      display: block;
      font-size: 11px;
      font-weight: 600;
      line-height: 1.2;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .symbol-meta {
      display: block;
      font-size: 10px;
      opacity: 0.7;
      font-variant-numeric: tabular-nums;
    }

    .symbol-rename {
      width: 100%;
      min-width: 0;
      padding: 2px 4px;
      border: 1px solid var(--panel-accent, #4a6fb5);
      border-radius: 4px;
      background: #ffffff;
      color: var(--flipcel-text-primary, #1a1a1a);
      font: inherit;
      font-size: 11px;
      box-sizing: border-box;
      text-align: center;
    }

    .library-actions {
      margin-top: 8px;
    }

    .library-actions .row + .row {
      margin-top: 8px;
    }
  `;

  private emit(name: string, detail?: unknown) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.clearSymbolDrag();
  }

  private onCardClick(id: string) {
    if (this.suppressCardClick) {
      this.suppressCardClick = false;
      return;
    }
    if (this.editingId && this.editingId !== id) this.editingId = null;
    this.selectedId = id;
  }

  private clearSymbolDrag() {
    window.removeEventListener("pointermove", this.onSymbolDragMove);
    window.removeEventListener("pointerup", this.onSymbolDragEnd);
    window.removeEventListener("pointercancel", this.onSymbolDragEnd);
    this.symbolDrag?.ghost?.remove();
    this.symbolDrag = null;
  }

  private onCardPointerDown(id: string, placeable: boolean, e: PointerEvent) {
    if (e.button !== 0 || !placeable) return;
    if ((e.target as HTMLElement).closest("input")) return;
    this.clearSymbolDrag();
    this.symbolDrag = {
      id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      ghost: null,
      active: false,
    };
    window.addEventListener("pointermove", this.onSymbolDragMove);
    window.addEventListener("pointerup", this.onSymbolDragEnd);
    window.addEventListener("pointercancel", this.onSymbolDragEnd);
  }

  private onSymbolDragMove = (e: PointerEvent) => {
    const drag = this.symbolDrag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.active) {
      if (dx * dx + dy * dy < 16) return;
      drag.active = true;
      const ghost = document.createElement("div");
      ghost.style.cssText =
        "position:fixed;width:48px;height:48px;margin:-24px 0 0 -24px;pointer-events:none;z-index:3000;opacity:0.9;border-radius:4px;overflow:hidden;background:#fff;";
      const thumb = this.library.value?.symbols.find((s) => s.id === drag.id)?.thumbnail;
      if (thumb) {
        const img = document.createElement("img");
        img.src = thumb;
        img.alt = "";
        img.style.cssText = "width:100%;height:100%;object-fit:contain;";
        ghost.appendChild(img);
      }
      document.body.appendChild(ghost);
      drag.ghost = ghost;
    }
    if (drag.ghost) {
      drag.ghost.style.left = `${e.clientX}px`;
      drag.ghost.style.top = `${e.clientY}px`;
    }
  };

  private onSymbolDragEnd = (e: PointerEvent) => {
    const drag = this.symbolDrag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { id, active } = drag;
    this.clearSymbolDrag();
    if (!active) return;
    this.suppressCardClick = true;
    if (e.type === "pointercancel") return;
    if (e.composedPath().includes(this)) return;
    const stage = document.getElementById("canvas-container");
    const rect = stage?.getBoundingClientRect();
    if (!rect || e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
      return;
    }
    this.emit("symbol-place", { id, clientX: e.clientX, clientY: e.clientY });
  };

  private onCardDblClick(id: string) {
    this.selectedId = id;
    this.emit("symbol-edit", { id });
  }

  private beginRename(id: string, name: string) {
    this.selectedId = id;
    this.editingId = id;
    this.editingName = name;
    this.updateComplete.then(() => {
      const input = this.renderRoot.querySelector<HTMLInputElement>(".symbol-rename");
      input?.focus();
      input?.select();
    });
  }

  private commitRename(id: string) {
    if (this.editingId !== id) return;
    const prev = this.library.value.symbols.find((s) => s.id === id)?.name ?? "";
    const next = this.editingName.trim();
    this.editingId = null;
    this.editingName = "";
    if (!next || next === prev) return;
    this.emit("symbol-rename", { id, name: next });
  }

  private onRenameKeydown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.editingId = null;
      this.editingName = "";
    }
  }

  render() {
    const symbols = this.library.value?.symbols ?? [];
    const editingPath = this.context.value?.path ?? [];
    const editingSymbolId = editingPath[editingPath.length - 1]?.symbolId ?? null;
    const selected = symbols.find((s) => s.id === this.selectedId) ?? null;
    const canDelete = !!selected && selected.usageCount === 0 && selected.id !== editingSymbolId;
    const canEdit = !!selected && !editingPath.some((p) => p.symbolId === selected.id);
    const canPlace = !!selected && selected.placeable;

    return this.renderFloatingBlock(
      "Library",
      html`
        <flipcel-panel-section title="Symbols" data-interactive>
          ${symbols.length === 0
            ? html`<p class="library-empty">
                No symbols yet. Select artwork and choose “To Symbol” (F8).
              </p>`
            : html`
                <ul class="library-grid" role="listbox" aria-label="Symbols">
                  ${symbols.map((entry) => {
                    const isSelected = entry.id === this.selectedId;
                    const isEditing = entry.id === editingSymbolId;
                    const renaming = entry.id === this.editingId;
                    return html`
                      <li>
                        <div
                          class="symbol-card ${isEditing ? "is-editing" : ""}"
                          role="option"
                          tabindex="0"
                          aria-selected=${isSelected ? "true" : "false"}
                          data-interactive
                          title=${entry.placeable ? `${entry.name} — drag onto the stage` : entry.name}
                          @pointerdown=${(e: PointerEvent) =>
                            this.onCardPointerDown(entry.id, entry.placeable, e)}
                          @click=${() => this.onCardClick(entry.id)}
                          @dblclick=${(e: Event) => {
                            if ((e.target as HTMLElement).closest(".symbol-name")) {
                              this.beginRename(entry.id, entry.name);
                            } else {
                              this.onCardDblClick(entry.id);
                            }
                          }}
                          @keydown=${(e: KeyboardEvent) => {
                            if (renaming) return;
                            if (e.key === "Enter") this.onCardDblClick(entry.id);
                          }}
                        >
                          ${entry.thumbnail
                            ? html`<img
                                class="symbol-thumb"
                                src=${entry.thumbnail}
                                alt=""
                                draggable="false"
                              />`
                            : html`<span class="symbol-thumb is-empty"></span>`}
                          ${renaming
                            ? html`<input
                                class="symbol-rename"
                                type="text"
                                data-interactive
                                .value=${this.editingName}
                                spellcheck="false"
                                autocomplete="off"
                                @input=${(e: Event) => {
                                  this.editingName = (e.target as HTMLInputElement).value;
                                }}
                                @blur=${() => this.commitRename(entry.id)}
                                @keydown=${(e: KeyboardEvent) => this.onRenameKeydown(e)}
                                @click=${(e: Event) => e.stopPropagation()}
                                @dblclick=${(e: Event) => e.stopPropagation()}
                              />`
                            : html`<span class="symbol-name">${entry.name}</span>`}
                          <span class="symbol-meta">
                            ${entry.duration}f · ${entry.usageCount} use${entry.usageCount === 1
                              ? ""
                              : "s"}
                          </span>
                        </div>
                      </li>
                    `;
                  })}
                </ul>
              `}
          ${selected
            ? html`
                <div class="library-actions">
                  <div class="row">
                    <blocky-button
                      flat
                      accent
                      ?disabled=${!canPlace}
                      title=${canPlace ? "Place at the center of the view" : "Placing this would loop the symbol"}
                      @click=${() => this.emit("symbol-place", { id: selected.id })}
                      >Place</blocky-button
                    >
                    <blocky-button
                      flat
                      ?disabled=${!canEdit}
                      @click=${() => this.emit("symbol-edit", { id: selected.id })}
                      >Edit</blocky-button
                    >
                  </div>
                  <div class="row">
                    <blocky-button
                      flat
                      @click=${() => this.emit("symbol-duplicate", { id: selected.id })}
                      >Duplicate</blocky-button
                    >
                    <blocky-button
                      flat
                      negative
                      ?disabled=${!canDelete}
                      title=${canDelete ? "" : "Symbol is in use"}
                      @click=${() => this.emit("symbol-delete", { id: selected.id })}
                      >Delete</blocky-button
                    >
                  </div>
                </div>
              `
            : nothing}
        </flipcel-panel-section>
      `,
    );
  }
}
