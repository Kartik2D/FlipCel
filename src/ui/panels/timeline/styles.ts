import { css } from "lit";

export const timelinePanelStyles = css`
  :host {
    --frame-cell-w: 20px;
  }

  .playback-fps {
    justify-self: start;
  }

  .playback-fps-group {
    justify-self: start;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }

  .playback-play {
    justify-self: center;
  }

  .playback-frames {
    justify-self: end;
  }

  .timeline-actions {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    width: var(--layers-side-width, 168px);
    flex: 0 0 auto;
    gap: 4px;
    min-width: 0;
  }

  .timeline-layer-actions {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 3px;
    flex: 0 0 auto;
  }

  .timeline-keyframe-actions {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: flex-end;
    gap: 3px;
    flex: 1 1 auto;
    min-width: 0;
    margin-left: auto;
  }

  .timeline-actions .tl-btn {
    min-width: 24px;
    padding: 0 4px;
    font-size: 11px;
  }

  /* ---- Timeline (Flash-style frames grid merged into the layer rows) ---- */

  .tl-btn {
    min-width: 30px;
    height: var(--layers-control-size);
    padding: 0 7px;
    border: none;
    border-radius: 6px;
    background: var(--block-depth-color, var(--flipcel-panel-depth));
    color: var(--flipcel-text-muted, #666);
    font: inherit;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    -webkit-tap-highlight-color: transparent;
  }

  .tl-btn:hover {
    filter: brightness(0.95);
  }

  .tl-btn.on {
    background: var(--flipcel-accent, var(--panel-accent, #4a6fb5));
    color: var(--flipcel-accent-contrast, #ffffff);
  }

  .frame-counter {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    font-variant-numeric: tabular-nums;
    color: var(--flipcel-text-muted, #666);
    padding: 0 4px;
    white-space: nowrap;
  }

  .fps-field {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--flipcel-text-muted, #666);
  }

  .duration-input,
  .fps-field input {
    width: 40px;
    font: inherit;
    padding: 3px 4px;
    border: none;
    border-radius: 6px;
    background: var(--block-depth-color, var(--flipcel-panel-depth));
    color: var(--block-border, var(--flipcel-panel-border));
    text-align: center;
  }

  .duration-input:focus,
  .fps-field input:focus {
    outline: none;
    box-shadow: 0 0 0 2px var(--panel-accent-muted, rgba(74, 111, 181, 0.35));
  }

  /* Two real columns: a fixed name/controls column and a frames column
     that is the only horizontal scroller. Vertical scrolling happens in
     .layer-scroll and moves both columns together. Wheel + one-finger
     touch pan on the wrap apply both axes; long-press starts selection.
     The wrap is the positioning context for the guttered vertical scrollbar. */
  .layer-scroll-wrap {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    touch-action: none;
    --scrollbar-size: 8px;
    --scrollbar-gutter: calc(var(--scrollbar-size) + 8px);
  }

  .layer-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: none;
  }

  .layer-scroll[data-vscroll-gutter] {
    padding-right: var(--scrollbar-gutter);
  }

  .layers-vscroll {
    position: absolute;
    top: 0;
    bottom: 0;
    right: 0;
    z-index: 3;
  }

  .layers-body {
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    gap: 8px;
    min-width: 0;
  }

  .side-column {
    display: flex;
    flex-direction: column;
    width: var(--layers-side-width, 168px);
    flex: 0 0 auto;
  }

  .frames-viewport {
    flex: 1 1 auto;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior: none;
    /* Native scrollbar is replaced by .frames-scrollbar in the panel footer. */
    scrollbar-width: none;
    -ms-overflow-style: none;
  }

  .frames-viewport::-webkit-scrollbar {
    display: none;
  }

  /* Positioning context for the playhead so it scrolls with the frames.
     --playhead-f is updated imperatively on scrub/playback (no Lit rebuild). */
  .frames-content {
    position: relative;
    width: max-content;
    min-width: 100%;
    --playhead-f: 0;
  }

  .strip-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: max-content;
    min-width: 100%;
  }

  .strip-row {
    display: flex;
    align-items: center;
    height: var(--layers-row-size, var(--layers-control-size));
    width: max-content;
    min-width: 100%;
    flex: 0 0 auto;
  }

  .strip-row.hidden,
  .strip-row.locked {
    opacity: 0.5;
  }

  /* Two stacked layers: frame squares underneath, span overlay on top. */
  .frame-strip {
    position: relative;
    flex: 0 0 auto;
  }

  .frame-cells {
    display: flex;
    flex-direction: row;
    align-items: center;
  }

  .frame-cell,
  .ruler-cell {
    width: var(--frame-cell-w, 15px);
    flex: 0 0 var(--frame-cell-w, 15px);
    box-sizing: border-box;
  }

  /* Flat cells: each frame is its own rounded rect separated by a tiny
     gap. The margins keep the --frame-cell-w pitch so the ruler and span
     overlay stay aligned. */
  .frame-cell {
    width: calc(var(--frame-cell-w, 15px) - 2px);
    flex: 0 0 calc(var(--frame-cell-w, 15px) - 2px);
    height: calc(var(--layers-row-size, var(--layers-control-size)) - 4px);
    padding: 0;
    margin: 0 1px;
    border: none;
    border-radius: 4px;
    background: var(--flipcel-timeline-cell-bg, var(--block-depth-color, var(--flipcel-panel-depth)));
    cursor: pointer;
    touch-action: none;
    -webkit-tap-highlight-color: transparent;
  }

  .frame-cell.in-selection {
    cursor: grab;
  }

  .strip-row.active .frame-cell {
    background: var(
      --flipcel-timeline-active-row-bg,
      color-mix(in srgb, var(--flipcel-accent, #4a6fb5) 22%, var(--flipcel-panel-surface))
    );
  }

  .frame-cell:hover {
    filter: brightness(0.92);
  }

  /* Span overlay: a dot per single-frame keyframe (hollow when blank),
     a pill per held span. Positioned by --f (start frame) / --len
     (frames). Clicks fall through to the cells underneath. */
  .span-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    /* Above .frame-selection so keyframe markers stay readable on a range tint. */
    z-index: 2;
  }

  .span-pill {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    left: calc(var(--f) * var(--frame-cell-w, 15px) + 3px);
    width: calc(var(--len) * var(--frame-cell-w, 15px) - 6px);
    height: 6px;
    border-radius: 999px;
    background: var(--block-border, #555555);
    box-shadow: 0 0 0 1px var(--flipcel-panel-surface, #ffffff);
  }

  .span-dot {
    position: absolute;
    top: 50%;
    left: calc((var(--f) + 0.5) * var(--frame-cell-w, 15px));
    transform: translate(-50%, -50%);
    width: 6px;
    height: 6px;
    border-radius: 50%;
    box-sizing: border-box;
    border: 1.5px solid var(--block-border, #555555);
    box-shadow: 0 0 0 1px var(--flipcel-panel-surface, #ffffff);
  }

  /* Single-frame keyframe: filled dot instead of a crammed pill. */
  .span-dot--filled {
    background: var(--block-border, #555555);
  }

  .strip-row.active .span-pill {
    background: var(--flipcel-accent, #4a6fb5);
  }

  .strip-row.active .span-dot {
    border-color: var(--flipcel-accent, #4a6fb5);
  }

  .strip-row.active .span-dot--filled {
    background: var(--flipcel-accent, #4a6fb5);
  }

  /* Drag-selected frame range: accent box over the strip, positioned with
     the same --f / --len technique as .span-pill. Shifted live while the
     block is being dragged to a new time. */
  .frame-selection {
    position: absolute;
    top: 0;
    bottom: 0;
    left: calc(var(--f) * var(--frame-cell-w, 15px) + 1px);
    width: calc(var(--len) * var(--frame-cell-w, 15px) - 2px);
    border-radius: 4px;
    z-index: 1;
    background: color-mix(
      in srgb,
      var(--flipcel-timeline-selection-bg, var(--flipcel-accent, #4a6fb5)) 38%,
      transparent
    );
    box-shadow: inset 0 0 0 2px var(--flipcel-accent, #4a6fb5);
    /* Clicks pass through to cells; tapping inside the range reopens the popup. */
    pointer-events: none;
    transform-origin: center center;
  }

  /* Long-press armed: stronger overshoot than panel show. */
  .frame-selection.hold-pop {
    animation: frame-selection-hold-pop var(--flipcel-motion-overshoot-duration, 420ms)
      cubic-bezier(0.18, 2.8, 0.32, 1) both;
  }

  @keyframes frame-selection-hold-pop {
    0% {
      transform: scale(0.55);
      opacity: 0;
    }
    100% {
      transform: scale(1);
      opacity: 1;
    }
  }

  .frame-selection.moving {
    opacity: 0.75;
  }

  .frame-selection.duplicating {
    background: color-mix(
      in srgb,
      var(--flipcel-timeline-selection-bg, var(--flipcel-accent, #4a6fb5)) 28%,
      transparent
    );
    box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--flipcel-accent, #4a6fb5) 70%, transparent);
    border: 1px dashed var(--flipcel-accent, #4a6fb5);
  }

  /* Quick actions for a selected frame range (duplicate / reverse / delete). */
  .frame-actions-fixed {
    position: fixed;
    z-index: 2100;
    transform: translate(-50%, -100%);
    pointer-events: auto;
    font-family: var(--flipcel-font, system-ui, sans-serif);
    animation: frame-actions-pop-in 180ms cubic-bezier(0.34, 1.25, 0.64, 1) both;
  }

  @keyframes frame-actions-pop-in {
    0% { transform: translate(-50%, calc(-100% + 4px)) scale(0.85); opacity: 0; }
    100% { transform: translate(-50%, -100%) scale(1); opacity: 1; }
  }

  .frame-actions-shell {
    background: var(--flipcel-panel-depth, #bcbcbc);
    border: var(--flipcel-block-border-width, 0px) solid var(--flipcel-panel-border, #555555);
    border-radius: var(--flipcel-block-radius);
    padding: 0;
    box-shadow: var(--flipcel-shadow-panel, 0 0 10px rgba(5, 0, 0, 0.3));
    overflow: hidden;
  }

  .frame-actions-face {
    background: var(--flipcel-panel-surface, rgba(255, 253, 249, 0.94));
    border-radius: calc(
      var(--flipcel-block-radius) - var(--flipcel-block-border-width, 0px)
    );
    padding: 4px;
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .frame-action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    min-height: 28px;
    padding: 5px 8px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--flipcel-text-primary, #1a1a1a);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
    touch-action: none;
  }

  .frame-action-btn.draggable {
    cursor: grab;
  }

  .frame-action-btn:hover {
    background: var(--flipcel-accent-muted, rgba(77, 115, 215, 0.28));
  }

  .frame-action-btn.negative {
    color: var(--flipcel-negative, #af5b5b);
  }

  .frame-action-btn.negative:hover {
    background: var(--flipcel-panel-active-negative, rgba(255, 122, 122, 0.58));
  }

  .frame-action-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
    pointer-events: none;
  }

  .frame-action-btn.active {
    background: var(--flipcel-accent, #4a6fb5);
    color: #fff;
  }

  .frame-action-btn.active:hover {
    background: color-mix(in srgb, var(--flipcel-accent, #4a6fb5) 88%, #000);
    color: #fff;
  }

  .frame-action-drag-hint {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: -0.04em;
    opacity: 0.55;
  }

  /* Edit Multiple Frames: keep the range tint unmistakably accented while on. */
  .frame-selection.emf-on {
    background: color-mix(
      in srgb,
      var(--flipcel-accent, #4a6fb5) 34%,
      transparent
    );
    box-shadow:
      inset 0 0 0 2px var(--flipcel-accent, #4a6fb5),
      0 0 0 1px color-mix(in srgb, var(--flipcel-accent, #4a6fb5) 70%, transparent);
  }

  /* Move preview: the departing artwork fades in place while a ghost of
     the would-be frames travels with the selection box. */
  .span-pill.moving-out,
  .span-dot.moving-out {
    opacity: 0.25;
  }

  .span-pill.reverse-hidden,
  .span-dot.reverse-hidden {
    opacity: 0;
  }

  /* Reverse preview: spin keyframe markers 180° around the selection center. */
  .reverse-overlay {
    z-index: 6;
  }

  .reverse-spin {
    position: absolute;
    top: 50%;
    left: calc(var(--pivot-f) * var(--frame-cell-w, 15px));
    width: 0;
    height: 0;
    transform: rotate(0deg);
    animation: timeline-reverse-spin 480ms
      var(--flipcel-motion-bounce-easing, cubic-bezier(0.34, 1.25, 0.64, 1)) forwards;
  }

  @keyframes timeline-reverse-spin {
    to {
      transform: rotate(180deg);
    }
  }

  .reverse-spin .span-dot,
  .reverse-spin .span-pill {
    position: absolute;
    top: 0;
    left: calc((var(--center-f) + 0.5 - var(--pivot-f)) * var(--frame-cell-w, 15px));
  }

  .reverse-spin .span-dot {
    transform: translate(-50%, -50%);
  }

  .reverse-spin .span-pill {
    width: calc(var(--len) * var(--frame-cell-w, 15px) - 6px);
    height: 6px;
    transform: translate(-50%, -50%);
  }

  .frame-selection.reversing {
    opacity: 0;
  }

  .ghost-overlay {
    opacity: 0.6;
  }

  /* ---- Playhead: vertical line over the current frame ---- */

  .playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    left: calc((var(--playhead-f, 0) + 0.5) * var(--frame-cell-w, 15px));
    width: 0;
    z-index: 2;
    pointer-events: none;
  }

  .playhead::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: -1px;
    width: 2px;
    border-radius: 1px;
    background: var(--flipcel-playhead, #f2c14e);
    opacity: 0.85;
  }

  /* ---- Timeline strip: frame numbers + tags + playhead flag ----
     Fixed strip above the frames column. Horizontal scrollbar lives in
     the panel footer (see layers-panel footer styles). Tags share the
     same dark scrubber bed as the frame numbers. */
  /* Row holding the add/delete layer buttons (in the name-column slot)
     and the timeline strip next to them, over the frames column. */
  .timeline-row {
    position: relative;
    z-index: 2;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
    min-width: 0;
    overflow: visible;
  }

  .timeline-strip {
    position: relative;
    height: 22px;
    flex: 1 1 auto;
    min-width: 0;
    /* Never wider than the frames themselves (duration set inline). */
    max-width: calc(var(--timeline-frames, 1) * var(--frame-cell-w, 15px));
    overflow: visible;
    /* Clip left/right so a scrolled-away playhead can't paint over the
       layer buttons, but expand top/bottom so the flag can overhang. */
    clip-path: inset(-3px 0);
    border-radius: 6px;
    /* Dark track behind frame numbers / tags / scrubber. */
    background: var(--block-depth-color, var(--flipcel-panel-depth));
    touch-action: none;
    cursor: pointer;
  }

  /* Tags paint above frame numbers (same strip; z-order, not a second row). */
  .timeline-tags-layer {
    position: absolute;
    inset: 0;
    z-index: 3;
    overflow: hidden;
    border-radius: 6px;
    pointer-events: none;
  }

  .timeline-tags-content {
    position: relative;
    height: 100%;
    width: max-content;
    min-width: 100%;
    will-change: transform;
  }

  .frame-tag {
    position: absolute;
    top: 2px;
    bottom: 2px;
    z-index: 1;
    box-sizing: border-box;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 2px;
    min-width: 0;
    padding: 0 6px;
    border-radius: 4px;
    background: color-mix(
      in srgb,
      var(--flipcel-accent, #5a74d8) 55%,
      var(--block-face-bg, #383838)
    );
    color: var(--flipcel-accent-contrast, #ffffff);
    cursor: pointer;
    overflow: visible;
    user-select: none;
    pointer-events: auto;
  }

  .frame-tag:hover {
    filter: brightness(1.06);
  }

  .frame-tag.selected {
    outline: 1px solid color-mix(in srgb, #fff 55%, transparent);
    outline-offset: 0;
  }

  .frame-tag.resizing {
    z-index: 5;
    filter: brightness(1.1);
  }

  .frame-tag-edge {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 6px;
    z-index: 2;
    cursor: ew-resize;
    touch-action: none;
  }

  .frame-tag-edge.start {
    left: -2px;
  }

  .frame-tag-edge.end {
    right: -2px;
  }

  .frame-tag-name {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 10px;
    font-weight: 500;
    letter-spacing: var(--flipcel-letter-spacing, -0.011em);
    line-height: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tag-actions-fixed {
    position: fixed;
    z-index: 2100;
    transform: translate(-50%, -100%);
    pointer-events: auto;
    font-family: var(--flipcel-font, system-ui, sans-serif);
    animation: frame-actions-pop-in 180ms cubic-bezier(0.34, 1.25, 0.64, 1) both;
  }

  .tag-action-name {
    flex: 1 1 auto;
    min-width: 72px;
    max-width: 140px;
    height: 28px;
    margin: 0;
    padding: 0 8px;
    border: none;
    border-radius: 6px;
    box-sizing: border-box;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    color: var(--flipcel-text-primary, #1a1a1a);
    background: color-mix(in srgb, var(--flipcel-text-primary, #1a1a1a) 8%, transparent);
    outline: none;
  }

  .tag-action-name:focus {
    background: color-mix(in srgb, var(--flipcel-accent, #4a6fb5) 16%, transparent);
  }

  .strip-ruler {
    position: absolute;
    inset: 0;
    z-index: 1;
    overflow: hidden;
    pointer-events: none;
  }

  .strip-ruler-content {
    display: flex;
    flex-direction: row;
    align-items: center;
    height: 100%;
    width: max-content;
    min-width: 100%;
    will-change: transform;
  }

  .ruler-cell {
    font-size: 9px;
    line-height: 1;
    text-align: center;
    color: var(--flipcel-text-muted, #666);
    text-shadow: 0 0 3px var(--block-face-bg, rgba(255, 255, 255, 0.7));
    white-space: nowrap;
    overflow: visible;
    user-select: none;
  }

  .ruler-cell.current {
    color: var(--flipcel-playhead, #f2c14e);
    font-weight: 700;
  }

  /* Playhead flag on the ruler strip. */
  .strip-playhead {
    position: absolute;
    top: -3px;
    bottom: -3px;
    left: 0;
    transform: translateX(-50%);
    width: 20px;
    border-radius: 6px;
    background: var(--flipcel-playhead, #f2c14e);
    z-index: 6;
    cursor: grab;
    touch-action: none;
  }

  .strip-playhead::after {
    content: "";
    position: absolute;
    inset: -4px -8px;
  }

  .strip-playhead:active {
    cursor: grabbing;
  }
`;
