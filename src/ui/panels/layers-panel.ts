import { html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import {
  layerStore,
  generateLayerId,
  STAGE_LAYER_ID,
  StoreController,
  isLayerEffectivelyVisible,
} from "../../state";
import { timelineStore } from "../../document/document";
import { FloatingPanel } from "../primitives/floating-panel";
import { phosphorIcon } from "../icons/phosphor";
import { timelinePanelStyles } from "./timeline/styles";
import type { LayersFrameSelection, ReverseMarker } from "./timeline/types";
import {
  clampFrameMoveDelta,
  clampFrameToDuration,
  collectReverseMarkers,
  keyframeSpanEnd,
  keyframeSpanLength,
  layerActionDetail,
  normalizeLayersFrameSelection,
  shiftedFrameRange,
} from "./timeline/helpers";

// ============================================================
// Layers Panel
// ============================================================

@customElement("flipcel-layers-panel")
export class FlipCelLayersPanel extends FloatingPanel {
  @property({ type: Boolean, reflect: true }) override masonry = false;

  private layers = new StoreController(this, layerStore);
  private timeline = new StoreController(this, timelineStore);
  @state() private editingLayerId: string | null = null;
  @state() private editingName = "";
  /**
   * Custom pointer-drag reorder for layer rows. The preview is pure CSS
   * transforms — the DOM is never reordered mid-drag, so Lit's keyed repeat
   * stays the sole owner of the list and re-renders the committed order
   * from the store on release.
   */
  private rowDrag: {
    pointerId: number;
    fromIndex: number;
    toIndex: number;
    startY: number;
    /** Drag activated (moved past a small threshold from the handle). */
    active: boolean;
    /** The row being dragged (preview class + transform target). */
    el: HTMLElement;
  } | null = null;
  /** Swallows the row click that fires right after a completed drag. */
  private suppressRowClick = false;

  protected override usesFaceScrollbar(): boolean {
    return false;
  }

  protected override showsMiniToggle(): boolean {
    return true;
  }

  static styles = css`
    ${FloatingPanel.styles}
    ${timelinePanelStyles}

    :host {
      --panel-width: 480px;
      /* Row/frame pitch (layer rows, row controls, timeline cells). */
      --layers-row-size: 42px;
      /* Compact chrome: add/delete, keyframe tools, playback buttons. */
      --layers-control-size: 24px;
      --layers-side-width: 248px;
    }

    /* Mini: tighter rows, narrower layer column so frames get more width. */
    :host([mini]) {
      --layers-row-size: 28px;
      --layers-control-size: 22px;
      --layers-side-width: 148px;
      --frame-cell-w: 16px;
    }

    :host([mini]) .layers-body {
      gap: 4px;
    }

    :host([mini]) .layer-list,
    :host([mini]) .strip-list {
      gap: 2px;
    }

    :host([mini]) .frame-cell {
      border-radius: 3px;
      height: calc(var(--layers-row-size) - 2px);
    }

    :host([mini]) .layer-name-cell {
      padding: 0 6px;
    }

    :host([mini]) .layer-control,
    :host([mini]) .layer-name-cell {
      border-radius: 4px;
    }

    /* Mini bottom chrome: layer +/- + playhead scrubber (start → end). */
    :host([mini]) .mini-bottom-bar {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 4px;
      flex: 0 0 auto;
      min-width: 0;
      height: var(--layers-control-size);
    }

    :host([mini]) .mini-layer-actions {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 3px;
      flex: 0 0 auto;
    }

    :host([mini]) .mini-scrubber {
      position: relative;
      flex: 1 1 auto;
      min-width: 0;
      height: var(--layers-control-size);
      border-radius: 6px;
      background: var(--block-depth-color, var(--flipcel-panel-depth));
      overflow: hidden;
      touch-action: none;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
    }

    :host([mini]) .mini-scrubber-marks {
      position: absolute;
      inset: 0;
      z-index: 1;
      pointer-events: none;
    }

    :host([mini]) .mini-scrubber-mark {
      position: absolute;
      top: 50%;
      transform: translate(-50%, -50%);
      font-size: 9px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      line-height: 1;
      color: var(--flipcel-text-muted, #666);
      white-space: nowrap;
    }

    :host([mini]) .mini-scrubber-mark.current {
      color: var(--flipcel-playhead, #f2c14e);
    }

    :host([mini]) .mini-scrubber-thumb {
      position: absolute;
      top: 2px;
      bottom: 2px;
      z-index: 2;
      width: 10px;
      border-radius: 4px;
      background: var(--flipcel-playhead, #f2c14e);
      /* Keep the thumb fully inside the clipped track at both ends. */
      left: calc(
        5px + (var(--mini-scrub-t, 0) * (100% - 10px))
      );
      transform: translateX(-50%);
      pointer-events: none;
      box-shadow: var(--flipcel-shadow-soft, 0 1px 3px rgba(0, 0, 0, 0.25));
    }

    :host([mini]) .mini-scrubber:active {
      cursor: grabbing;
    }

    .block {
      height: 100%;
      min-height: 0;
    }

    .panel-body > .face {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    .panel-form {
      flex: 1 1 auto;
      height: auto;
      min-height: 0;
    }

    .layers-header {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      width: 100%;
      min-width: 0;
    }

    .header-group {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
    }

    .layer-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex: 0 0 auto;
      overflow: visible;
      margin: 0;
      min-width: 0;
    }

    .layer-item {
      display: grid;
      grid-template-columns:
        var(--layers-control-size)
        minmax(0, 1fr)
        auto;
      align-items: center;
      gap: 4px;
      height: var(--layers-row-size);
      min-width: 0;
      flex: 0 0 auto;
      cursor: pointer;
      color: var(--block-border, var(--flipcel-panel-border));
    }

    .layer-row-controls {
      display: flex;
      align-items: stretch;
      gap: 3px;
      height: 100%;
      min-width: 0;
    }

    .layer-row-controls .layer-control {
      width: var(--layers-control-size);
      flex: 0 0 auto;
    }

    .layer-drag-handle {
      width: 100%;
      height: 100%;
      cursor: grab;
      touch-action: none;
    }

    .layer-drag-handle:active,
    .layer-item.dragging .layer-drag-handle {
      cursor: grabbing;
    }

    .layer-item.hidden,
    .layer-item.locked {
      opacity: 0.5;
    }

    /* Row being drag-reordered: lifted above its siblings, which animate
       out of the way (transitions only while a drag is live so committed
       re-renders snap instantly). */
    .layer-item.dragging {
      position: relative;
      z-index: 5;
      cursor: grabbing;
      filter: brightness(0.96);
      box-shadow: var(--flipcel-shadow-soft, 0 6px 18px rgba(0, 0, 0, 0.18));
    }

    .layer-list.reordering .layer-item:not(.dragging) {
      transition: transform 120ms ease;
    }

    .layer-action-button,
    .layer-control,
    .layer-name-cell {
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 0;
      border-radius: 6px;
      background: var(--block-depth-color, var(--flipcel-panel-depth));
      color: var(--block-border, var(--flipcel-panel-border));
    }

    .layer-control,
    .layer-name-cell {
      min-height: var(--layers-row-size);
    }

    .layer-action-button {
      min-height: var(--layers-control-size);
    }

    .layer-action-button,
    .layer-control {
      padding: 0;
      border: none;
      cursor: pointer;
    }

    .layer-action-button {
      width: var(--layers-control-size);
      height: var(--layers-control-size);
      flex: 0 0 auto;
      font: inherit;
      font-size: 16px;
      font-weight: 700;
      line-height: 1;
      color: var(--flipcel-text-muted, #666);
    }

    .layer-action-button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .layer-delete-current:hover:not(:disabled) {
      background: var(--flipcel-negative, #9a4545);
      color: var(--flipcel-negative-contrast, #ffffff);
      filter: none;
    }

    .layer-name-cell {
      justify-content: flex-start;
      padding: 0 8px;
      grid-column: 2;
      min-width: 0;
    }

    .layer-name-cell {
      gap: 5px;
    }

    .layer-item:hover:not(.active) .layer-control,
    .layer-item:hover:not(.active) .layer-name-cell,
    .layer-action-button:hover:not(:disabled) {
      filter: brightness(0.97);
    }

    .layer-item.active .layer-control,
    .layer-item.active .layer-name-cell {
      background: var(--flipcel-accent, var(--panel-accent, #b5a04a));
      color: var(--flipcel-accent-contrast, #ffffff);
    }

    .layer-name-cell {
      overflow: hidden;
    }

    .layer-name {
      flex: 1;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }

    .layer-item.active .layer-name {
      color: var(--flipcel-accent-contrast, #ffffff);
    }

    .layer-name-input {
      flex: 1;
      min-width: 0;
      margin: 0;
      box-sizing: border-box;
      font: inherit;
      color: inherit;
      background: color-mix(in srgb, var(--flipcel-panel-surface) 55%, transparent);
      border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
      border-radius: 4px;
      padding: 1px 5px;
    }

    .layer-item.active .layer-name-input {
      background: color-mix(in srgb, var(--flipcel-accent-contrast, #fff) 14%, transparent);
      border-color: color-mix(in srgb, var(--flipcel-accent-contrast, #fff) 42%, transparent);
    }

    .visibility-btn,
    .lock-btn,
    .solo-btn {
      width: 100%;
      height: 100%;
      color: inherit;
    }

    .solo-btn {
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.02em;
    }

    .solo-btn.on {
      background: var(--flipcel-accent, var(--panel-accent, #b5a04a));
      color: var(--flipcel-accent-contrast, #ffffff);
    }

    .visibility-btn svg,
    .lock-btn svg,
    .layer-action-button svg {
      display: block;
    }

    .layer-item:not(.active) .visibility-btn:hover:not(:disabled),
    .layer-item:not(.active) .lock-btn:hover:not(:disabled),
    .layer-item:not(.active) .solo-btn:hover:not(:disabled) {
      filter: brightness(0.88);
    }

    .visibility-btn.dim,
    .lock-btn.dim {
      opacity: 0.72;
    }

    .layer-item.active .visibility-btn:hover:not(:disabled),
    .layer-item.active .lock-btn:hover:not(:disabled),
    .layer-item.active .solo-btn:hover:not(:disabled) {
      background: color-mix(in srgb, var(--flipcel-accent-contrast, #fff) 32%, transparent);
      filter: none;
    }

    .layer-item.active .solo-btn.on:hover:not(:disabled) {
      background: color-mix(in srgb, var(--flipcel-accent-contrast, #fff) 42%, transparent);
    }
  `;

  /** True while the playhead (or ruler) is being scrubbed. */
  private scrubbing = false;
  /** Last frame-cell tap, for double-tap (toggle keyframe hold) detection. */
  private lastCellTap: { layerId: string; frame: number; time: number } | null = null;
  /** Timestamp of the last tap inside the frame-range highlight (for double-tap dismiss). */
  private lastSelectionTapTime: number | null = null;
  /** Selected frame range across one or more layer rows (inclusive). */
  @state() private frameSelection: LayersFrameSelection | null = null;
  /** When on (default), selecting a frame range enters Edit Multiple Frames. */
  @state() private emfPreferred = false;
  /** Whether the range actions popover is visible (highlight can persist without it). */
  @state() private frameActionsOpen = false;
  /** Spinning keyframe markers while a frame-range reverse is previewed. */
  @state() private reverseAnimation: {
    layerIds: string[];
    start: number;
    end: number;
    markersByLayerId: Record<string, ReverseMarker[]>;
  } | null = null;
  private reverseSpinLayersRemaining = 0;
  /** Live frame offset while dragging the selection to a new time. */
  @state() private moveDelta = 0;
  /**
   * Frame-cell gesture state. A press starts as a "tap"; horizontal motion
   * past half a cell turns it into "select" (drag out a range) or, when the
   * press landed inside the current selection, "move" (drag the block).
   */
  private cellDrag: {
    layerId: string;
    anchorLayerIndex: number;
    anchor: number;
    startX: number;
    startY: number;
    mode: "tap" | "select" | "move";
    /** Selection bounds at drag start; set only in move mode. */
    base: { start: number; end: number; layerIds: string[] } | null;
    /** Locked rows: playhead navigate only — no range select/move. */
    lockedNav?: boolean;
  } | null = null;
  /** Live duplicate preview while dragging from the frame-actions popover. */
  private duplicatePlacement: {
    layerIds: string[];
    sourceStart: number;
    sourceEnd: number;
    anchor: number;
    pointerId: number;
  } | null = null;
  private frameActionDrag: {
    kind: "duplicate";
    pointerId: number;
    startX: number;
    startY: number;
    dragging: boolean;
    anchorFrame: number;
    layerIds: string[];
    sourceStart: number;
    sourceEnd: number;
  } | null = null;
  private readonly frameActionDragCapture = { capture: true };
  private suppressFrameActionClick: string | null = null;
  /** Screen position for the frame-actions popover (fixed; avoids overflow clipping). */
  @state() private frameActionsAnchor: { x: number; y: number } | null = null;
  /** Last frame seen in updated(), to auto-scroll the playhead into view. */
  private lastSeenFrame = -1;

  private emit(name: string, detail?: unknown) {
    this.dispatchEvent(
      new CustomEvent(name, { detail, bubbles: true, composed: true })
    );
  }

  /** Called by the app after a non-drag duplicate. */
  setFrameSelection(
    sel: { layerId?: string; layerIds?: string[]; start: number; end: number } | null,
  ) {
    this.frameSelection = normalizeLayersFrameSelection(sel);
    this.pruneLockedFromFrameSelection();
    this.duplicatePlacement = null;
    this.moveDelta = 0;
    this.frameActionsOpen = this.frameSelection !== null;
  }

  private displayLayerIds(): string[] {
    return this.layers.value.layers
      .filter((layer) => layer.kind !== "stage")
      .reverse()
      .map((layer) => layer.id);
  }

  private isLayerLocked(layerId: string): boolean {
    return !!this.layers.value.layers.find((l) => l.id === layerId)?.locked;
  }

  /** Drop locked layers from the frame-range selection (or clear it). */
  private pruneLockedFromFrameSelection() {
    const sel = this.frameSelection;
    if (!sel) return;
    const layerIds = sel.layerIds.filter((id) => !this.isLayerLocked(id));
    if (layerIds.length === 0) {
      this.clearFrameSelection();
      return;
    }
    if (
      layerIds.length === sel.layerIds.length &&
      !this.isLayerLocked(sel.anchorLayerId)
    ) {
      return;
    }
    const anchorLayerId = layerIds.includes(sel.anchorLayerId)
      ? sel.anchorLayerId
      : layerIds[0]!;
    this.frameSelection = { ...sel, layerIds, anchorLayerId };
  }

  private layerRowPitch(): number {
    const row = this.renderRoot.querySelector<HTMLElement>(".strip-row");
    if (row) {
      const list = row.parentElement;
      const rowRect = row.getBoundingClientRect();
      if (list) {
        const gap = Number.parseFloat(getComputedStyle(list).rowGap || "0") || 4;
        return rowRect.height + gap;
      }
      return rowRect.height + 4;
    }
    const raw = getComputedStyle(this).getPropertyValue("--layers-row-size");
    const parsed = Number.parseFloat(raw);
    return (Number.isFinite(parsed) ? parsed : 42) + 4;
  }

  private layerIndexFromPointer(e: PointerEvent): number {
    const rows = Array.from(this.renderRoot.querySelectorAll<HTMLElement>(".strip-row"));
    if (rows.length === 0) return 0;
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect();
      if (e.clientY < rect.bottom) return i;
    }
    return rows.length - 1;
  }

  /** Begin a drag-duplicate preview (no document change until release). */
  beginDuplicateDragPreview(
    layerIds: string[],
    sourceStart: number,
    sourceEnd: number,
    anchorFrame: number,
    pointerId: number,
  ) {
    this.duplicatePlacement = {
      layerIds: [...layerIds],
      sourceStart,
      sourceEnd,
      anchor: anchorFrame,
      pointerId,
    };
    this.moveDelta = 0;
    this.requestUpdate();
  }

  private bindFrameActionDragListeners() {
    window.addEventListener(
      "pointermove",
      this.onFrameActionDragMove,
      this.frameActionDragCapture,
    );
    window.addEventListener(
      "pointerup",
      this.onFrameActionDragUp,
      this.frameActionDragCapture,
    );
    window.addEventListener(
      "pointercancel",
      this.onFrameActionDragCancel,
      this.frameActionDragCapture,
    );
  }

  private unbindFrameActionDragListeners() {
    window.removeEventListener(
      "pointermove",
      this.onFrameActionDragMove,
      this.frameActionDragCapture,
    );
    window.removeEventListener(
      "pointerup",
      this.onFrameActionDragUp,
      this.frameActionDragCapture,
    );
    window.removeEventListener(
      "pointercancel",
      this.onFrameActionDragCancel,
      this.frameActionDragCapture,
    );
  }

  private cancelFrameActionDrag() {
    this.unbindFrameActionDragListeners();
    this.frameActionDrag = null;
    this.duplicatePlacement = null;
    this.moveDelta = 0;
  }

  private showFrameActionsForSelection(): boolean {
    return (
      this.frameActionsOpen &&
      this.frameSelection !== null &&
      this.cellDrag === null &&
      this.frameActionDrag === null &&
      this.duplicatePlacement === null &&
      this.reverseAnimation === null &&
      this.moveDelta === 0
    );
  }

  /** Pin the popover above the selection box in viewport coordinates. */
  private syncFrameActionsAnchor() {
    if (!this.showFrameActionsForSelection()) {
      if (this.frameActionsAnchor !== null) this.frameActionsAnchor = null;
      return;
    }
    const sel = this.frameSelection;
    if (!sel) return;
    const el = this.renderRoot.querySelector<HTMLElement>(
      `.strip-row[data-layer-id="${sel.anchorLayerId}"] .frame-selection`,
    );
    if (!el) {
      if (this.frameActionsAnchor !== null) this.frameActionsAnchor = null;
      return;
    }
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const popW = 150;
    const popH = 44;
    let x = rect.left + rect.width / 2;
    let y = rect.top - 4;
    x = Math.max(margin + popW / 2, Math.min(window.innerWidth - margin - popW / 2, x));
    y = Math.max(margin + popH, Math.min(window.innerHeight - margin, y));
    const next = { x, y };
    if (
      this.frameActionsAnchor?.x === next.x &&
      this.frameActionsAnchor?.y === next.y
    ) {
      return;
    }
    this.frameActionsAnchor = next;
  }

  private onFrameActionDuplicateClick() {
    const sel = this.frameSelection;
    if (!sel || sel.layerIds.length === 0) return;
    this.emit("frames-duplicate", layerActionDetail(sel));
  }

  private onFrameActionAutoMorphClick(anchor: HTMLElement) {
    const sel = this.frameSelection;
    if (!sel || sel.layerIds.length === 0) return;
    this.emit("frames-auto-morph", { ...layerActionDetail(sel), anchor });
  }

  private onFrameActionReverseClick() {
    const sel = this.frameSelection;
    if (!sel || this.reverseAnimation) return;
    if (sel.end <= sel.start) return;
    this.beginReverseAnimation(sel);
  }

  private beginReverseAnimation(sel: LayersFrameSelection) {
    const markersByLayerId: Record<string, ReverseMarker[]> = {};
    for (const layerId of sel.layerIds) {
      const track = this.timeline.value.tracks.find((t) => t.id === layerId);
      const markers = collectReverseMarkers(
        track?.keyframes ?? [],
        sel.start,
        sel.end,
        this.timeline.value.duration,
      );
      if (markers.length > 0) {
        markersByLayerId[layerId] = markers;
      }
    }
    const layersWithMarkers = Object.keys(markersByLayerId);
    if (layersWithMarkers.length === 0) {
      this.emit("frames-reverse", layerActionDetail(sel));
      return;
    }
    this.reverseSpinLayersRemaining = layersWithMarkers.length;
    this.reverseAnimation = {
      layerIds: sel.layerIds,
      start: sel.start,
      end: sel.end,
      markersByLayerId,
    };
  }

  private onReverseSpinEnd = (e: AnimationEvent) => {
    if (e.animationName !== "timeline-reverse-spin" || e.target !== e.currentTarget) return;
    this.reverseSpinLayersRemaining = Math.max(0, this.reverseSpinLayersRemaining - 1);
    if (this.reverseSpinLayersRemaining > 0) return;
    const anim = this.reverseAnimation;
    if (!anim) return;
    this.reverseAnimation = null;
    this.emit("frames-reverse", {
      layerIds: anim.layerIds,
      start: anim.start,
      end: anim.end,
    });
  };

  private renderReverseSpinOverlay(layerId: string) {
    const anim = this.reverseAnimation;
    if (!anim || !anim.layerIds.includes(layerId)) return nothing;
    const markers = anim.markersByLayerId[layerId];
    if (!markers?.length) return nothing;

    const pivotF = (anim.start + anim.end + 1) / 2;
    const markerEls = markers.map((marker) => {
      const centerF =
        marker.kind === "dot" ? marker.fromF : marker.fromF + (marker.len - 1) / 2;
      const style = `--center-f: ${centerF}; --pivot-f: ${pivotF}; --sel-start: ${anim.start}; --sel-end: ${anim.end}`;
      if (marker.kind === "dot") {
        return html`<div
          class="span-dot ${marker.blank ? "" : "span-dot--filled"}"
          style=${`${style}`}
        ></div>`;
      }
      return html`<div
        class="span-pill"
        style=${`${style}; --len: ${marker.len}`}
      ></div>`;
    });

    return html`
      <div class="span-overlay reverse-overlay">
        <div
          class="reverse-spin"
          style="--pivot-f: ${pivotF}; --sel-start: ${anim.start}; --sel-end: ${anim.end}"
          @animationend=${this.onReverseSpinEnd}
        >
          ${markerEls}
        </div>
      </div>
    `;
  }

  private onFrameActionDeleteClick() {
    const sel = this.frameSelection;
    if (!sel) return;
    this.clearFrameSelection();
    this.emit("keyframe-remove", {
      layerIds: sel.layerIds,
      start: sel.start,
      end: sel.end,
    });
  }

  private onFrameActionDuplicateDown(e: PointerEvent) {
    const sel = this.frameSelection;
    if (!sel || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    this.frameActionDrag = {
      kind: "duplicate",
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      anchorFrame: Math.max(
        sel.start,
        Math.min(sel.end, this.frameFromPointer(e)),
      ),
      layerIds: [...sel.layerIds],
      sourceStart: sel.start,
      sourceEnd: sel.end,
    };
    this.bindFrameActionDragListeners();
    this.requestUpdate();
  }

  private updateDuplicatePlacementFromPointer(e: PointerEvent) {
    const placement = this.duplicatePlacement;
    if (!placement) return;

    e.preventDefault();
    const frame = this.frameFromPointer(e);
    const duration = this.timeline.value.duration;
    const raw = frame - placement.anchor;
    const next = clampFrameMoveDelta(
      raw,
      placement.sourceStart,
      placement.sourceEnd,
      duration,
    );
    if (next !== this.moveDelta) {
      this.moveDelta = next;
    }
    this.ensureFrameVisible(frame);
  }

  private onFrameActionDragMove = (e: PointerEvent) => {
    const drag = this.frameActionDrag;
    if (drag) {
      if (e.pointerId !== drag.pointerId) return;
      const dx = Math.abs(e.clientX - drag.startX);
      const dy = Math.abs(e.clientY - drag.startY);
      const thresholdX = this.frameCellWidth() * 0.6;
      const thresholdY = this.layerRowPitch() * 0.6;
      if (!drag.dragging) {
        if (dx < thresholdX && dy < thresholdY) return;
        drag.dragging = true;
        this.emit("frames-duplicate-drag-start", {
          layerIds: drag.layerIds,
          start: drag.sourceStart,
          end: drag.sourceEnd,
        });
        this.beginDuplicateDragPreview(
          drag.layerIds,
          drag.sourceStart,
          drag.sourceEnd,
          drag.anchorFrame,
          drag.pointerId,
        );
        this.frameActionDrag = null;
      } else {
        return;
      }
    }

    const placement = this.duplicatePlacement;
    if (placement && e.pointerId !== placement.pointerId) return;
    this.updateDuplicatePlacementFromPointer(e);
  };

  private onFrameActionDragUp = (e: PointerEvent) => {
    const drag = this.frameActionDrag;
    if (drag) {
      if (e.pointerId !== drag.pointerId) return;
      if (!drag.dragging) {
        this.suppressFrameActionClick = "duplicate";
        this.onFrameActionDuplicateClick();
      }
      this.frameActionDrag = null;
      this.unbindFrameActionDragListeners();
      this.requestUpdate();
      return;
    }

    const placement = this.duplicatePlacement;
    if (placement) {
      if (e.pointerId !== placement.pointerId) return;
      this.suppressFrameActionClick = "duplicate";
      this.finalizeDuplicatePlacement();
    }
    this.frameActionDrag = null;
    this.unbindFrameActionDragListeners();
    this.requestUpdate();
  };

  private onFrameActionDragCancel = (e: PointerEvent) => {
    const activePointerId =
      this.duplicatePlacement?.pointerId ?? this.frameActionDrag?.pointerId;
    if (activePointerId !== undefined && e.pointerId !== activePointerId) return;
    this.duplicatePlacement = null;
    this.moveDelta = 0;
    this.frameActionDrag = null;
    this.unbindFrameActionDragListeners();
    this.requestUpdate();
  };

  private readonly globalFrameDuplicateDragEndHandler = (e: Event) => {
    if (!this.duplicatePlacement) return;
    this.onFrameActionDragUp(e as PointerEvent);
  };

  private finalizeDuplicatePlacement() {
    const placement = this.duplicatePlacement;
    if (!placement) return;
    const delta = this.moveDelta;
    this.duplicatePlacement = null;
    this.moveDelta = 0;
    if (delta === 0) return;
    this.emit("frames-duplicate-drag-end", {
      layerIds: placement.layerIds,
      start: placement.sourceStart,
      end: placement.sourceEnd,
      delta,
    });
  }

  private renderFrameActionsPopover(sel: { start: number; end: number }) {
    if (!this.frameActionsAnchor) return nothing;
    const len = sel.end - sel.start + 1;
    const { x, y } = this.frameActionsAnchor;
    return html`
      <div
        class="frame-actions-fixed"
        style="left: ${x}px; top: ${y}px"
        data-interactive
        @pointerdown=${(e: Event) => e.stopPropagation()}
      >
        <div class="frame-actions-shell">
          <div class="frame-actions-face">
            <button
              type="button"
              class="frame-action-btn draggable"
              title="Duplicate (drag to place)"
              aria-label="Duplicate"
              @pointerdown=${this.onFrameActionDuplicateDown}
              @click=${() => {
                if (this.suppressFrameActionClick === "duplicate") {
                  this.suppressFrameActionClick = null;
                  return;
                }
                if (this.frameActionDrag) return;
                this.onFrameActionDuplicateClick();
              }}
            ><span>Duplicate</span><span class="frame-action-drag-hint" aria-hidden="true">↔</span></button>
            <button
              type="button"
              class="frame-action-btn"
              title="Reverse frame order"
              aria-label="Reverse"
              ?disabled=${len < 2 || this.reverseAnimation !== null}
              @click=${() => this.onFrameActionReverseClick()}
            >Reverse</button>
            <button
              type="button"
              class="frame-action-btn"
              title="Auto morph: fill holds with morphs toward their next keyframe"
              aria-label="Auto morph"
              @click=${(e: Event) =>
                this.onFrameActionAutoMorphClick(e.currentTarget as HTMLElement)}
            >Morph</button>
            <button
              type="button"
              class="frame-action-btn negative"
              title="Delete keyframes"
              aria-label="Delete"
              @click=${() => this.onFrameActionDeleteClick()}
            >Delete</button>
          </div>
        </div>
      </div>
    `;
  }

  private onEmfPreferredToggle() {
    this.emfPreferred = !this.emfPreferred;
    const sel = this.frameSelection;
    if (this.emfPreferred) {
      if (sel) {
        this.emit("frames-edit-multiple", {
          ...layerActionDetail(sel),
          enabled: true,
        });
      }
    } else if (this.timeline.value.editMultipleFrames) {
      this.emit("frames-edit-multiple", {
        ...(sel ? layerActionDetail(sel) : { start: 0, end: 0 }),
        enabled: false,
      });
    }
  }

  /** Current timeline frame-range selection, if any. */
  getFrameSelection(): LayersFrameSelection | null {
    return this.frameSelection;
  }

  /** Whether the EMF preference toggle is on (auto-enter on range select). */
  isEmfPreferred(): boolean {
    return this.emfPreferred;
  }

  private maybeEnterEmfForSelection() {
    const sel = this.frameSelection;
    if (!sel || !this.emfPreferred) return;
    this.emit("frames-edit-multiple", {
      ...layerActionDetail(sel),
      enabled: true,
    });
  }

  private selectLayer(layerId: string) {
    this.emit("layer-select", layerId);
  }

  updated(changedProperties: Map<string, unknown>) {
    super.updated(changedProperties);

    // Locked layers cannot stay in a frame-range selection.
    this.pruneLockedFromFrameSelection();

    // Follow the playhead during playback.
    const frame = this.timeline.value.currentFrame;
    if (frame !== this.lastSeenFrame) {
      this.lastSeenFrame = frame;
      if (!this.scrubbing) this.ensureFrameVisible(frame);
    }

    // Duration and frame changes move the strip's ruler/flag; scrolling is
    // handled by the viewport's @scroll listener.
    this.syncTimelineStrip();

    void this.updateComplete.then(() => this.syncFrameActionsAnchor());

    if (!changedProperties.has("editingLayerId") || !this.editingLayerId) return;
    void this.updateComplete.then(() => {
      const input = this.renderRoot.querySelector<HTMLInputElement>(
        `[data-layer-edit="${this.editingLayerId}"]`,
      );
      input?.focus();
      input?.select();
    });
  }

  // ---- Playhead scrubbing --------------------------------------------

  private framesViewportEl(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>(".frames-viewport");
  }

  /**
   * Keeps the fixed timeline strip mirroring the frames viewport: the
   * ruler numbers are translated by the scroll offset and the playhead
   * flag is placed over the current frame (it slides out of the strip
   * when the frame is scrolled out of view — intended). Imperative so
   * horizontal scrolling never forces a Lit re-render.
   */
  private syncTimelineStrip = () => {
    const vp = this.framesViewportEl();
    if (!vp) return;
    const scrollLeft = vp.scrollLeft;
    const ruler = this.renderRoot.querySelector<HTMLElement>(".strip-ruler-content");
    if (ruler) ruler.style.transform = `translateX(${-scrollLeft}px)`;
    const flag = this.renderRoot.querySelector<HTMLElement>(".strip-playhead");
    if (flag) {
      const x =
        (this.timeline.value.currentFrame + 0.5) * this.frameCellWidth() - scrollLeft;
      flag.style.left = `${x}px`;
    }
  };

  private onFramesViewportScroll = () => {
    this.syncTimelineStrip();
    // Scroll dismisses the actions popup but keeps the range highlight.
    if (this.frameActionsOpen && !this.cellDrag) {
      this.dismissFrameActionsPopup();
    } else {
      this.syncFrameActionsAnchor();
    }
  };

  private onLayerScroll = () => {
    if (this.frameActionsOpen && !this.cellDrag) {
      this.dismissFrameActionsPopup();
    } else {
      this.syncFrameActionsAnchor();
    }
  };

  private dismissFrameActionsPopup() {
    if (!this.frameActionsOpen && this.frameActionsAnchor === null) return;
    this.frameActionsOpen = false;
    this.frameActionsAnchor = null;
  }

  /** Dismiss the range popup when pointerdown lands outside it (selection stays). */
  private onFrameActionsOutsidePointerDown = (e: PointerEvent) => {
    if (!this.frameActionsOpen || this.cellDrag || this.frameActionDrag) return;
    for (const node of e.composedPath()) {
      if (
        node instanceof HTMLElement &&
        node.classList.contains("frame-actions-fixed")
      ) {
        return;
      }
    }
    this.dismissFrameActionsPopup();
  };

  /** Clear the frame-range selection (and leave EMF if it was on). */
  private clearFrameSelection() {
    const sel = this.frameSelection;
    if (sel && this.timeline.value.editMultipleFrames) {
      this.emit("frames-edit-multiple", {
        ...layerActionDetail(sel),
        enabled: false,
      });
    }
    this.frameSelection = null;
    this.frameActionsOpen = false;
    this.frameActionsAnchor = null;
    this.lastSelectionTapTime = null;
  }

  private frameCellWidth(): number {
    const raw = getComputedStyle(this).getPropertyValue("--frame-cell-w");
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 15;
  }

  private frameFromPointer(e: PointerEvent): number {
    const content = this.renderRoot.querySelector<HTMLElement>(".frames-content");
    if (!content) return 0;
    const rect = content.getBoundingClientRect();
    const frame = Math.floor((e.clientX - rect.left) / this.frameCellWidth());
    return clampFrameToDuration(frame, this.timeline.value.duration);
  }

  private scrubTo(e: PointerEvent) {
    const frame = this.frameFromPointer(e);
    if (frame !== this.timeline.value.currentFrame) {
      this.emit("frame-select", { frame, navigateOnly: true });
    }
    this.ensureFrameVisible(frame);
  }

  /** Nudge the frames viewport so `frame` is fully visible. */
  private ensureFrameVisible(frame: number) {
    const vp = this.framesViewportEl();
    if (!vp) return;
    const cellW = this.frameCellWidth();
    const x = frame * cellW;
    if (x < vp.scrollLeft) {
      vp.scrollLeft = x;
    } else if (x + cellW > vp.scrollLeft + vp.clientWidth) {
      vp.scrollLeft = x + cellW - vp.clientWidth;
    }
  }

  private onScrubDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.scrubbing = true;
    this.scrubTo(e);
  };

  private onScrubMove = (e: PointerEvent) => {
    if (!this.scrubbing) return;
    e.preventDefault();
    this.scrubTo(e);
  };

  private onScrubUp = (e: PointerEvent) => {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  /** Mini scrubber: left = first frame, right = last frame. */
  private frameFromMiniScrubber(e: PointerEvent): number {
    const track = this.renderRoot.querySelector<HTMLElement>(".mini-scrubber");
    if (!track) return 0;
    const duration = this.timeline.value.duration;
    if (duration <= 1) return 0;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    return clampFrameToDuration(Math.round(t * (duration - 1)), duration);
  }

  private scrubMiniTo(e: PointerEvent) {
    const frame = this.frameFromMiniScrubber(e);
    if (frame !== this.timeline.value.currentFrame) {
      this.emit("frame-select", { frame, navigateOnly: true });
    }
    this.ensureFrameVisible(frame);
  }

  private onMiniScrubDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.scrubbing = true;
    this.scrubMiniTo(e);
  };

  private onMiniScrubMove = (e: PointerEvent) => {
    if (!this.scrubbing) return;
    e.preventDefault();
    this.scrubMiniTo(e);
  };

  private onMiniScrubUp = (e: PointerEvent) => {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  // ---- Frame range selection + move ------------------------------------

  private onCellDown(layerId: string, frame: number, e: PointerEvent) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const displayIds = this.displayLayerIds();
    const anchorLayerIndex = displayIds.indexOf(layerId);
    if (this.isLayerLocked(layerId)) {
      this.cellDrag = {
        layerId,
        anchorLayerIndex: anchorLayerIndex >= 0 ? anchorLayerIndex : 0,
        anchor: frame,
        startX: e.clientX,
        startY: e.clientY,
        mode: "tap",
        base: null,
        lockedNav: true,
      };
      return;
    }
    const sel = this.frameSelection;
    const inSelection =
      sel !== null &&
      sel.layerIds.includes(layerId) &&
      frame >= sel.start &&
      frame <= sel.end;
    this.cellDrag = {
      layerId,
      anchorLayerIndex: anchorLayerIndex >= 0 ? anchorLayerIndex : 0,
      anchor: frame,
      startX: e.clientX,
      startY: e.clientY,
      mode: "tap",
      base: inSelection
        ? { start: sel.start, end: sel.end, layerIds: [...sel.layerIds] }
        : null,
    };
  }

  private onCellMove = (e: PointerEvent) => {
    const drag = this.cellDrag;
    if (!drag || drag.lockedNav) return;

    if (drag.mode === "tap") {
      const dx = Math.abs(e.clientX - drag.startX);
      const dy = Math.abs(e.clientY - drag.startY);
      const thresholdX = this.frameCellWidth() * 0.6;
      const thresholdY = this.layerRowPitch() * 0.6;
      if (dx < thresholdX && dy < thresholdY) return;
      drag.mode = drag.base !== null && dx > dy ? "move" : "select";
      if (drag.mode === "select") {
        // Replacing the range dismisses EMF; a fresh selection gets a new popup.
        if (this.timeline.value.editMultipleFrames && this.frameSelection) {
          this.emit("frames-edit-multiple", {
            ...layerActionDetail(this.frameSelection),
            enabled: false,
          });
        }
        this.frameActionsOpen = false;
      }
    }
    e.preventDefault();

    const frame = this.frameFromPointer(e);
    if (drag.mode === "select") {
      const displayIds = this.displayLayerIds();
      if (displayIds.length === 0) return;
      const layerIndex = this.layerIndexFromPointer(e);
      const layerStart = Math.min(drag.anchorLayerIndex, layerIndex);
      const layerEnd = Math.max(drag.anchorLayerIndex, layerIndex);
      const layerIds = displayIds
        .slice(layerStart, layerEnd + 1)
        .filter((id) => !this.isLayerLocked(id));
      if (layerIds.length === 0) return;
      const start = Math.min(drag.anchor, frame);
      const end = Math.max(drag.anchor, frame);
      const cur = this.frameSelection;
      if (
        !cur ||
        cur.anchorLayerId !== drag.layerId ||
        cur.start !== start ||
        cur.end !== end ||
        cur.layerIds.length !== layerIds.length ||
        cur.layerIds.some((id, i) => id !== layerIds[i])
      ) {
        this.frameSelection = {
          start,
          end,
          layerIds,
          anchorLayerId: drag.layerId,
        };
      }
      // Keep the playhead under the pointer while drag-selecting a range.
      if (frame !== this.timeline.value.currentFrame) {
        this.emit("frame-select", { frame, navigateOnly: true });
      }
    } else if (drag.base) {
      // Keep at least one frame of the block on the timeline.
      const duration = this.timeline.value.duration;
      const raw = frame - drag.anchor;
      this.moveDelta = clampFrameMoveDelta(
        raw,
        drag.base.start,
        drag.base.end,
        duration,
      );
    }
    this.ensureFrameVisible(frame);
  };

  private onCellUp = (e: PointerEvent) => {
    const drag = this.cellDrag;
    if (!drag) return;
    this.cellDrag = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);

    if (drag.lockedNav) {
      // Locked layers: move the playhead only — no range select / hold toggle.
      this.emit("frame-select", {
        frame: drag.anchor,
        navigateOnly: true,
      });
      this.requestUpdate();
      return;
    }

    if (drag.mode === "tap") {
      const sel = this.frameSelection;
      const inSelection =
        sel !== null &&
        sel.layerIds.includes(drag.layerId) &&
        drag.anchor >= sel.start &&
        drag.anchor <= sel.end;

      if (inSelection) {
        const now = performance.now();
        if (
          this.lastSelectionTapTime !== null &&
          now - this.lastSelectionTapTime < 350
        ) {
          // Double-tap the highlight: dismiss the range selection.
          this.clearFrameSelection();
          this.lastCellTap = null;
          this.emit("frame-select", {
            frame: drag.anchor,
            layerId: drag.layerId,
            navigateOnly: true,
          });
        } else {
          // Single tap: reopen the actions popup; keep playhead navigation quiet.
          this.lastSelectionTapTime = now;
          this.frameActionsOpen = true;
          this.lastCellTap = null;
          this.emit("frame-select", {
            frame: drag.anchor,
            layerId: drag.layerId,
            navigateOnly: true,
          });
        }
      } else {
        // Tap outside deselects the range (and leaves EMF if it was on).
        this.clearFrameSelection();
        this.emit("frame-select", { frame: drag.anchor, layerId: drag.layerId });

        const now = performance.now();
        const last = this.lastCellTap;
        if (
          last &&
          last.layerId === drag.layerId &&
          last.frame === drag.anchor &&
          now - last.time < 350
        ) {
          this.lastCellTap = null;
          this.emit("keyframe-hold-toggle", {
            frame: drag.anchor,
            layerId: drag.layerId,
          });
        } else {
          this.lastCellTap = { layerId: drag.layerId, frame: drag.anchor, time: now };
        }
      }
    } else if (drag.mode === "move" && drag.base) {
      const delta = this.moveDelta;
      this.moveDelta = 0;
      if (delta !== 0) {
        const anchorLayerId =
          this.frameSelection?.anchorLayerId ?? drag.layerId;
        this.emit("frames-move", {
          layerIds: drag.base.layerIds,
          start: drag.base.start,
          end: drag.base.end,
          delta,
        });
        const shifted = shiftedFrameRange(
          drag.base.start,
          drag.base.end,
          delta,
          this.timeline.value.duration,
        );
        this.frameSelection = {
          ...shifted,
          layerIds: drag.base.layerIds,
          anchorLayerId,
        };
        this.frameActionsOpen = true;
        this.maybeEnterEmfForSelection();
      } else if (this.frameSelection) {
        // Click (no move) on the highlighted range reopens the actions popup.
        this.frameActionsOpen = true;
      }
    } else if (drag.mode === "select") {
      this.frameActionsOpen = this.frameSelection !== null;
      this.lastSelectionTapTime = null;
      // Multi-layer range: activate the layer under the pointer at release
      // (the last layer the selection reached). Single-layer keeps the anchor.
      if (this.frameSelection) {
        const displayIds = this.displayLayerIds();
        const endIndex = this.layerIndexFromPointer(e);
        const endLayerId =
          displayIds[endIndex] ?? this.frameSelection.anchorLayerId;
        const activateId = this.isLayerLocked(endLayerId)
          ? this.frameSelection.anchorLayerId
          : endLayerId;
        const frame = this.frameFromPointer(e);
        this.emit("frame-select", {
          frame,
          layerId: activateId,
          navigateOnly: true,
        });
        this.maybeEnterEmfForSelection();
      }
    }

    // cellDrag is not @state — re-render so the actions popover can appear.
    this.requestUpdate();
  };

  private onCellCancel = (e: PointerEvent) => {
    if (!this.cellDrag) return;
    this.cellDrag = null;
    this.moveDelta = 0;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    this.requestUpdate();
  };

  private startLayerRename(layerId: string, currentName: string, e: Event) {
    e.stopPropagation();
    this.editingLayerId = layerId;
    this.editingName = currentName;
  }

  private commitLayerRename(layerId: string) {
    if (this.editingLayerId !== layerId) return;
    const prev =
      this.layers.value.layers.find((l) => l.id === layerId)?.name ?? "";
    const next = this.editingName.trim();
    this.editingLayerId = null;
    this.editingName = "";
    if (!next || next === prev) return;
    this.emit("layer-rename", { id: layerId, name: next });
  }

  private onRenameKeydown(_layerId: string, e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.editingLayerId = null;
      this.editingName = "";
    }
  }

  private cancelLayerRename() {
    this.editingLayerId = null;
    this.editingName = "";
  }

  private toggleVisibility(layerId: string, e: Event) {
    e.stopPropagation();
    this.emit("layer-visibility-toggle", layerId);
  }

  private toggleLock(layerId: string, e: Event) {
    e.stopPropagation();
    this.emit("layer-lock-toggle", layerId);
  }

  private toggleSolo(layerId: string, e: Event) {
    e.stopPropagation();
    this.emit("layer-solo-toggle", layerId);
  }

  private deleteCurrentLayer() {
    const layerId = this.layers.value.activeLayerId;
    // Don't allow deleting the last regular layer (Stage doesn't count).
    const nonStage = this.layers.value.layers.filter((l) => l.kind !== "stage");
    if (layerId === STAGE_LAYER_ID || nonStage.length <= 1) return;
    this.emit("layer-delete", layerId);
  }

  private addLayer() {
    const newId = generateLayerId();
    const nonStage = this.layers.value.layers.filter((l) => l.kind !== "stage");
    const layerNumber = nonStage.length + 1;
    this.emit("layer-add", { id: newId, name: `Layer ${layerNumber}` });
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("pointerup", this.globalFrameDuplicateDragEndHandler);
    window.addEventListener("pointercancel", this.globalFrameDuplicateDragEndHandler);
    window.addEventListener("blur", this.globalFrameDuplicateDragEndHandler);
    window.addEventListener("pointerdown", this.onFrameActionsOutsidePointerDown, true);
  }

  disconnectedCallback() {
    window.removeEventListener("pointerup", this.globalFrameDuplicateDragEndHandler);
    window.removeEventListener("pointercancel", this.globalFrameDuplicateDragEndHandler);
    window.removeEventListener("blur", this.globalFrameDuplicateDragEndHandler);
    window.removeEventListener("pointerdown", this.onFrameActionsOutsidePointerDown, true);
    this.cancelFrameActionDrag();
    this.cancelRowDrag();
    super.disconnectedCallback();
  }

  // ---- Layer row drag-reorder ------------------------------------------

  /** Row pitch in the list: row height + the list's 4px gap. */
  private rowPitch(): number {
    const raw = getComputedStyle(this).getPropertyValue("--layers-row-size");
    const size = Number.parseFloat(raw);
    return (Number.isFinite(size) && size > 0 ? size : 42) + 4;
  }

  private layerRowEls(): HTMLElement[] {
    return Array.from(
      this.renderRoot.querySelectorAll<HTMLElement>(".layer-list .layer-item"),
    );
  }

  /** Starts from the row's dedicated drag handle. */
  private onRowDown(index: number, e: PointerEvent) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const handle = e.currentTarget as HTMLElement;
    const row = handle.closest<HTMLElement>(".layer-item");
    if (!row) return;
    // Capture on the row: its move/up handlers then receive the whole drag.
    row.setPointerCapture(e.pointerId);
    this.rowDrag = {
      pointerId: e.pointerId,
      fromIndex: index,
      toIndex: index,
      startY: e.clientY,
      active: false,
      el: row,
    };
  }

  private activateRowDrag() {
    const drag = this.rowDrag;
    if (!drag || drag.active) return;
    drag.active = true;
    this.cancelLayerRename();
    drag.el.classList.add("dragging");
    drag.el.closest(".layer-list")?.classList.add("reordering");
  }

  private onRowMove = (e: PointerEvent) => {
    const drag = this.rowDrag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dy = e.clientY - drag.startY;

    if (!drag.active) {
      if (Math.abs(dy) < 4) return;
      this.activateRowDrag();
    }
    e.preventDefault();

    const rows = this.layerRowEls();
    const pitch = this.rowPitch();
    drag.toIndex = Math.max(
      0,
      Math.min(rows.length - 1, drag.fromIndex + Math.round(dy / pitch)),
    );

    // Preview: the dragged row follows the pointer, displaced rows shift by
    // one pitch. DOM order never changes.
    rows.forEach((row, i) => {
      if (i === drag.fromIndex) {
        row.style.transform = `translateY(${dy}px)`;
      } else if (drag.fromIndex < drag.toIndex && i > drag.fromIndex && i <= drag.toIndex) {
        row.style.transform = `translateY(${-pitch}px)`;
      } else if (drag.fromIndex > drag.toIndex && i >= drag.toIndex && i < drag.fromIndex) {
        row.style.transform = `translateY(${pitch}px)`;
      } else {
        row.style.transform = "";
      }
    });
  };

  private onRowUp = (e: PointerEvent) => {
    const drag = this.rowDrag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { active, fromIndex, toIndex } = drag;
    this.cancelRowDrag();
    if (!active) return; // plain tap: let the row's @click select the layer

    this.suppressRowClick = true;
    setTimeout(() => (this.suppressRowClick = false), 0);
    if (toIndex === fromIndex) return;

    // The list holds regular layers only, top layer first; Stage renders
    // outside it and always sits at the bottom of the stack.
    const ids = this.layers.value.layers
      .filter((l) => l.kind !== "stage")
      .reverse()
      .map((l) => l.id);
    if (fromIndex >= ids.length || toIndex >= ids.length) return;
    const [moved] = ids.splice(fromIndex, 1);
    ids.splice(toIndex, 0, moved);
    this.emit("layer-reorder", {
      order: [...ids, STAGE_LAYER_ID],
      movedId: moved,
    });
  };

  /** Tear down drag state and the transform/class preview. */
  private cancelRowDrag = () => {
    const drag = this.rowDrag;
    if (!drag) return;
    this.rowDrag = null;
    drag.el.releasePointerCapture?.(drag.pointerId);
    drag.el.classList.remove("dragging");
    drag.el.closest(".layer-list")?.classList.remove("reordering");
    for (const row of this.layerRowEls()) row.style.transform = "";
  };

  /**
   * A layer's frames: a flat row of clickable squares, with the span
   * markers (a dot per single-frame keyframe, a pill per held span; hollow /
   * outlined when blank) drawn in a single overlay on top. `keyframes` is
   * sorted ascending and may be empty (all frames empty).
   */
  private renderFrameStrip(
    layerId: string,
    keyframes: Array<{ frame: number; blank: boolean; holdUntil: number }>,
    duration: number,
    currentFrame: number,
  ) {
    const sel = this.frameSelection;
    const selected =
      sel !== null && sel.layerIds.includes(layerId)
        ? { start: sel.start, end: sel.end }
        : null;
    const cells = Array.from({ length: duration }, (_, f) => html`
      <button
        type="button"
        class="frame-cell ${f === currentFrame ? "current" : ""} ${
          selected && f >= selected.start && f <= selected.end ? "in-selection" : ""
        }"
        title=${`Frame ${f + 1}`}
        @pointerdown=${(e: PointerEvent) => this.onCellDown(layerId, f, e)}
        @pointermove=${this.onCellMove}
        @pointerup=${this.onCellUp}
        @pointercancel=${this.onCellCancel}
        @click=${(e: Event) => {
          // Don't bubble into the row's layer-select (which switches tools);
          // taps are handled in onCellUp.
          e.stopPropagation();
        }}
      ></button>
    `);

    const dup =
      this.duplicatePlacement?.layerIds.includes(layerId) ? this.duplicatePlacement : null;
    const reversing =
      this.reverseAnimation?.layerIds.includes(layerId) ? this.reverseAnimation : null;
    const cellMoving = selected !== null && this.moveDelta !== 0 && dup === null;
    const dupDelta = dup ? this.moveDelta : 0;
    const dupPreviewing = dup !== null && dupDelta !== 0;

    const moving = cellMoving;
    const spans = keyframes.map((kf) => {
      const spanEnd = keyframeSpanEnd(kf, duration);
      const len = keyframeSpanLength(kf, duration);
      // While the selection is being dragged, the part of the artwork that
      // is leaving fades out (its would-be position renders as a ghost).
      const leaving =
        moving && selected && kf.frame <= selected.end && spanEnd >= selected.start
          ? "moving-out"
          : "";
      const reverseHidden =
        reversing &&
        kf.frame <= reversing.end &&
        spanEnd >= reversing.start
          ? "reverse-hidden"
          : "";
      // A one-frame span is just a keyframe: a dot (hollow when blank —
      // blank keyframes are always single-frame).
      if (len === 1) {
        return html`<div class="span-dot ${kf.blank ? "" : "span-dot--filled"} ${leaving} ${reverseHidden}" style="--f: ${kf.frame}"></div>`;
      }
      // Held span: pill from the keyframe to its hold end.
      return html`<div class="span-pill ${leaving} ${reverseHidden}" style="--f: ${kf.frame}; --len: ${len}"></div>`;
    });

    // Would-be frames while dragging the selection: the selected slice of
    // each span, shifted by the current delta and clipped to the timeline.
    const ghosts = cellMoving && selected
      ? keyframes.flatMap((kf) => {
          const spanEnd = keyframeSpanEnd(kf, duration);
          const from = Math.max(kf.frame, selected.start);
          const to = Math.min(spanEnd, selected.end);
          if (to < from) return [];
          const shiftedFrom = clampFrameToDuration(from + this.moveDelta, duration);
          const shiftedTo = clampFrameToDuration(to + this.moveDelta, duration);
          if (shiftedTo < shiftedFrom) return [];
          const len = shiftedTo - shiftedFrom + 1;
          if (len === 1) {
            return [
              html`<div class="span-dot ${kf.blank ? "" : "span-dot--filled"}" style="--f: ${shiftedFrom}"></div>`,
            ];
          }
          return [
            html`<div class="span-pill" style="--f: ${shiftedFrom}; --len: ${len}"></div>`,
          ];
        })
      : null;

    const dupGhosts = dupPreviewing && dup
      ? keyframes.flatMap((kf) => {
          const spanEnd = keyframeSpanEnd(kf, duration);
          const from = Math.max(kf.frame, dup.sourceStart);
          const to = Math.min(spanEnd, dup.sourceEnd);
          if (to < from) return [];
          const shiftedFrom = clampFrameToDuration(from + dupDelta, duration);
          const shiftedTo = clampFrameToDuration(to + dupDelta, duration);
          if (shiftedTo < shiftedFrom) return [];
          const len = shiftedTo - shiftedFrom + 1;
          if (len === 1) {
            return [
              html`<div class="span-dot ${kf.blank ? "" : "span-dot--filled"}" style="--f: ${shiftedFrom}"></div>`,
            ];
          }
          return [
            html`<div class="span-pill" style="--f: ${shiftedFrom}; --len: ${len}"></div>`,
          ];
        })
      : null;

    return html`
      <div class="frame-strip">
        <div class="frame-cells">${cells}</div>
        <div class="span-overlay">${spans}</div>
        ${this.renderReverseSpinOverlay(layerId)}
        ${ghosts ? html`<div class="span-overlay ghost-overlay">${ghosts}</div>` : nothing}
        ${dupGhosts ? html`<div class="span-overlay ghost-overlay">${dupGhosts}</div>` : nothing}
        ${selected && !dupPreviewing
          ? html`<div
              class="frame-selection ${cellMoving ? "moving" : ""} ${reversing ? "reversing" : ""} ${
                this.timeline.value.editMultipleFrames ? "emf-on" : ""
              }"
              style="--f: ${selected.start + (cellMoving ? this.moveDelta : 0)}; --len: ${
                selected.end - selected.start + 1
              }"
            ></div>`
          : nothing}
        ${selected && dupPreviewing
          ? html`<div
              class="frame-selection"
              style="--f: ${selected.start}; --len: ${selected.end - selected.start + 1}"
            ></div>`
          : nothing}
        ${dupPreviewing && dup
          ? html`<div
              class="frame-selection duplicating"
              style="--f: ${dup.sourceStart + dupDelta}; --len: ${
                dup.sourceEnd - dup.sourceStart + 1
              }"
            ></div>`
          : nothing}
      </div>
    `;
  }

  private renderLayerActionButtons(activeLayerId: string, nonStageCount: number) {
    return html`
      <button
        type="button"
        class="layer-action-button"
        title="Add layer above selected"
        aria-label="Add layer"
        @click=${() => this.addLayer()}
      >+</button>
      <button
        type="button"
        class="layer-action-button layer-delete-current"
        title="Delete current layer"
        aria-label="Delete current layer"
        ?disabled=${activeLayerId === STAGE_LAYER_ID || nonStageCount <= 1}
        @click=${() => this.deleteCurrentLayer()}
      >${phosphorIcon("trash", 14)}</button>
    `;
  }

  /** Frame numbers along the mini scrubber: 1, then every 5th, plus the end. */
  private miniScrubberMarks(duration: number) {
    if (duration <= 0) return [] as number[];
    const marks = new Set<number>([1]);
    for (let n = 5; n < duration; n += 5) marks.add(n);
    marks.add(duration);
    return [...marks].sort((a, b) => a - b);
  }

  private renderKeyframeActions() {
    const t = this.timeline.value;
    return html`
      <div class="timeline-keyframe-actions">
        <button type="button" class="tl-btn" title="Insert keyframe (copies current artwork)"
          @click=${() => this.emit("keyframe-add", { blank: false })}>K</button>
        <button type="button" class="tl-btn" title="Insert blank keyframe"
          @click=${() => this.emit("keyframe-add", { blank: true })}>B</button>
        <button type="button" class="tl-btn"
          title="Delete selected frames (or the frame at the playhead)"
          @click=${() => {
            const sel = this.frameSelection;
            this.clearFrameSelection();
            if (!sel) {
              this.emit("keyframe-remove", null);
              return;
            }
            this.emit("keyframe-remove", {
              layerIds: sel.layerIds,
              start: sel.start,
              end: sel.end,
            });
          }}>C</button>
        <button type="button" class="tl-btn ${t.autoHold ? "on" : ""}"
          title="Auto hold: new keyframes extend the previous keyframe's hold"
          @click=${() => this.emit("auto-hold-toggle")}>AH</button>
        <button type="button" class="tl-btn ${this.emfPreferred ? "on" : ""}"
          title="Edit Multiple Frames: when on, selecting a frame range edits those frames together on stage"
          @click=${() => this.onEmfPreferredToggle()}>EMF</button>
      </div>
    `;
  }

  private renderPlaybackActions() {
    const t = this.timeline.value;
    return html`
      <span class="playback-fps-group">
        <span class="fps-field playback-fps">
          fps
          <input
            type="number"
            min="1"
            max="60"
            .value=${String(t.frameRate)}
            @change=${(e: Event) => {
              const value = Number((e.target as HTMLInputElement).value);
              if (Number.isFinite(value)) this.emit("frame-rate-change", value);
            }}
          />
        </span>
        <button
          type="button"
          class="tl-btn playback-rt ${t.realTimeLock ? "on" : ""}"
          title="Lock timings to real time: changing fps rescales keyframes so the animation keeps its wall-clock speed (e.g. 30 to 60 fps makes every frame a two-frame hold)"
          @click=${() => this.emit("real-time-lock-toggle")}
        >RT</button>
      </span>
      <button
        type="button"
        class="tl-btn playback-play ${t.playing ? "on" : ""}"
        title=${t.playing ? "Stop" : "Play"}
        @click=${() => this.emit("play-toggle")}
      >${t.playing ? html`&#9632;` : html`&#9654;`}</button>
      <span class="frame-counter playback-frames">
        ${t.currentFrame + 1}/<input
          class="duration-input"
          type="number"
          min="1"
          max="9999"
          title="Total frames (shrinking deletes trailing keyframes)"
          .value=${String(t.duration)}
          @change=${(e: Event) => {
            const value = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(value)) this.emit("duration-set", value);
          }}
        />
      </span>
    `;
  }

  render() {
    const { layers, activeLayerId, soloLayerId } = this.layers.value;
    const t = this.timeline.value;
    // Regular layers only, top layer first; the Stage layer stays in the
    // document as the fixed background but has no row in the panel.
    const displayLayers = layers.filter((l) => l.kind !== "stage").reverse();
    const nonStageCount = displayLayers.length;
    const frames = Array.from({ length: t.duration }, (_, i) => i);
    const keyframesByTrack = new Map(
      t.tracks.map((track) => [track.id, track.keyframes]),
    );

    return html`
      <div class="block">
        ${this.renderDragHandlePill("Layers")}
        <div class="panel-body">
          <div class="face">
            <div class="panel-form">
            ${this.mini
              ? nothing
              : html`
                  <flipcel-panel-section data-interactive>
                    <div class="layers-header">
                      ${this.renderPlaybackActions()}
                    </div>
                  </flipcel-panel-section>
                `}
            ${this.mini
              ? nothing
              : html`
                  <div class="timeline-row">
                    <div class="header-group timeline-actions">
                      <div class="timeline-layer-actions">
                        ${this.renderLayerActionButtons(activeLayerId, nonStageCount)}
                      </div>
                      ${this.renderKeyframeActions()}
                    </div>
                    <div
                      class="timeline-strip"
                      data-interactive
                      style="--timeline-frames: ${t.duration}"
                    >
                      <flipcel-scrollbar
                        class="frames-scrollbar"
                        orientation="horizontal"
                        for=".frames-viewport"
                        persistent
                        .gutter=${false}
                      ></flipcel-scrollbar>
                      <div
                        class="strip-ruler"
                        @pointerdown=${this.onScrubDown}
                        @pointermove=${this.onScrubMove}
                        @pointerup=${this.onScrubUp}
                        @pointercancel=${this.onScrubUp}
                      >
                        <div class="strip-ruler-content">
                          ${frames.map(
                            (f) => html`
                              <div
                                class="ruler-cell ${f === t.currentFrame ? "current" : ""}"
                                title=${`Go to frame ${f + 1}`}
                                @click=${() =>
                                  this.emit("frame-select", {
                                    frame: f,
                                    navigateOnly: true,
                                  })}
                              >
                                ${f === 0 || (f + 1) % 5 === 0 || f === t.currentFrame
                                  ? f + 1
                                  : ""}
                              </div>
                            `,
                          )}
                        </div>
                      </div>
                      <div
                        class="strip-playhead"
                        title="Drag to scrub"
                        @pointerdown=${this.onScrubDown}
                        @pointermove=${this.onScrubMove}
                        @pointerup=${this.onScrubUp}
                        @pointercancel=${this.onScrubUp}
                      ></div>
                    </div>
                  </div>
                `}
            <div class="layer-scroll-wrap">
              <div class="layer-scroll" @scroll=${this.onLayerScroll}>
              <div class="layers-body">
                <div class="side-column">
                  <div class="layer-list">
                    ${repeat(
                      displayLayers,
                      (layer) => layer.id,
                      (layer, i) => {
                        const effectivelyVisible = isLayerEffectivelyVisible(
                          layer,
                          soloLayerId,
                        );
                        const soloOn = soloLayerId === layer.id;
                        return html`
                        <div
                          class="layer-item ${layer.id === activeLayerId ? "active" : ""} ${!effectivelyVisible ? "hidden" : ""} ${layer.locked ? "locked" : ""}"
                          data-layer-id=${layer.id}
                          data-interactive
                          @pointermove=${this.onRowMove}
                          @pointerup=${this.onRowUp}
                          @pointercancel=${this.cancelRowDrag}
                          @click=${() => {
                            if (this.suppressRowClick) return;
                            this.selectLayer(layer.id);
                          }}
                        >
                          <div
                            class="layer-control layer-drag-handle"
                            title="Drag to reorder"
                            @pointerdown=${(e: PointerEvent) => this.onRowDown(i, e)}
                          >
                            ${phosphorIcon("dots-six-vertical", 14)}
                          </div>
                          <div class="layer-name-cell">
                            ${this.editingLayerId === layer.id
                              ? html`
                                  <input
                                    type="text"
                                    class="layer-name-input"
                                    data-layer-edit=${layer.id}
                                    .value=${this.editingName}
                                    aria-label="Layer name"
                                    @input=${(e: Event) => {
                                      this.editingName = (e.target as HTMLInputElement).value;
                                    }}
                                    @keydown=${(e: KeyboardEvent) =>
                                      this.onRenameKeydown(layer.id, e)}
                                    @blur=${() => this.commitLayerRename(layer.id)}
                                    @click=${(e: Event) => e.stopPropagation()}
                                    @pointerdown=${(e: Event) => e.stopPropagation()}
                                  />
                                `
                              : html`
                                  <span
                                    class="layer-name"
                                    title="Double-click to rename"
                                    @dblclick=${(e: Event) =>
                                      this.startLayerRename(layer.id, layer.name, e)}
                                    >${layer.name}</span
                                  >
                                `}
                          </div>
                          <div class="layer-row-controls">
                            <button
                              type="button"
                              class="layer-control solo-btn ${soloOn ? "on" : ""}"
                              @click=${(e: Event) => this.toggleSolo(layer.id, e)}
                              title="${soloOn ? "Exit solo" : "Solo layer"}"
                              aria-pressed=${soloOn}
                            >S</button>
                            <button
                              type="button"
                              class="layer-control lock-btn ${layer.locked ? "dim" : ""}"
                              @click=${(e: Event) => this.toggleLock(layer.id, e)}
                              title="${layer.locked ? "Unlock layer" : "Lock layer"}"
                            >
                              ${phosphorIcon(layer.locked ? "lock" : "lock-open", 14)}
                            </button>
                            <button
                              type="button"
                              class="layer-control visibility-btn ${!layer.visible ? "dim" : ""}"
                              @click=${(e: Event) => this.toggleVisibility(layer.id, e)}
                              title="${layer.visible ? "Hide layer" : "Show layer"}"
                            >
                              ${phosphorIcon(layer.visible ? "eye" : "eye-slash", 14)}
                            </button>
                          </div>
                        </div>
                      `;
                      }
                    )}
                  </div>
                </div>
                <div class="frames-viewport" @scroll=${this.onFramesViewportScroll}>
                  <div class="frames-content">
                    <div class="strip-list">
                      ${repeat(
                        displayLayers,
                        (layer) => layer.id,
                        (layer) => html`
                          <div
                            class="strip-row ${layer.id === activeLayerId ? "active" : ""} ${!isLayerEffectivelyVisible(layer, soloLayerId) ? "hidden" : ""} ${layer.locked ? "locked" : ""}"
                            data-layer-id=${layer.id}
                          >
                            ${this.renderFrameStrip(
                              layer.id,
                              keyframesByTrack.get(layer.id) ?? [],
                              t.duration,
                              t.currentFrame,
                            )}
                          </div>
                        `
                      )}
                    </div>
                    <div class="playhead" style="--f: ${t.currentFrame}"></div>
                  </div>
                </div>
              </div>
              </div>
              <flipcel-scrollbar
                class="layers-vscroll"
                orientation="vertical"
                for=".layer-scroll"
                data-interactive
              ></flipcel-scrollbar>
            </div>
            ${this.mini
              ? html`
                  <div class="mini-bottom-bar" data-interactive>
                    <div class="mini-layer-actions">
                      ${this.renderLayerActionButtons(activeLayerId, nonStageCount)}
                    </div>
                    <div
                      class="mini-scrubber"
                      title="Scrub playhead"
                      style="--mini-scrub-t:${t.duration <= 1
                        ? 0.5
                        : t.currentFrame / (t.duration - 1)}"
                      @pointerdown=${this.onMiniScrubDown}
                      @pointermove=${this.onMiniScrubMove}
                      @pointerup=${this.onMiniScrubUp}
                      @pointercancel=${this.onMiniScrubUp}
                    >
                      <div class="mini-scrubber-marks" aria-hidden="true">
                        ${this.miniScrubberMarks(t.duration).map((n) => {
                          const tMark =
                            t.duration <= 1 ? 0.5 : (n - 1) / (t.duration - 1);
                          return html`
                            <span
                              class="mini-scrubber-mark ${n === t.currentFrame + 1
                                ? "current"
                                : ""}"
                              style="left:calc(5px + ${tMark} * (100% - 10px))"
                              >${n}</span
                            >
                          `;
                        })}
                      </div>
                      <div class="mini-scrubber-thumb"></div>
                    </div>
                  </div>
                `
              : nothing}
          </div>
        </div>
        </div>
        ${this.renderPanelFooter()}
        ${this.frameSelection && this.showFrameActionsForSelection()
          ? this.renderFrameActionsPopover(this.frameSelection)
          : nothing}
      </div>
    `;
  }
}
