/**
 * Viewport margins for framing the stage so top-bar docks do not cover it.
 * Tuned against `inkwell-top-bar-panel` (row height, face padding, edge offset).
 *
 * These values are used directly for insets (no hidden minimum % of viewport),
 * so changing the constants below actually changes framing.
 */

/** Matches one dock row + 2× `--inkwell-block-face-padding` + slack. */
const DOCK_ROW_BLOCK_PX = 44 + 10 + 10 + 10;

/** Minimum `--panel-top` (see top-bar panel). */
const DOCK_TOP_OFFSET_PX = 8;

/** Breathing room below the dock strip. */
const DOCK_TOP_EXTRA_PX = 10;

/** Bottom margin so the stage does not sit flush against the window edge. */
const FIT_BOTTOM_MARGIN_PX = 16;

/** Horizontal reserve per side so the stage stays centered (corner docks / breathing room). */
const DOCK_SIDE_RESERVE_PX = 160;

/** Do not use more than this fraction of viewport height for the top inset (safety on short windows). */
const TOP_INSET_MAX_FRAC = 0.42;

/** Do not use more than this fraction of total width per side for horizontal insets. */
const SIDE_INSET_MAX_FRAC = 0.22;

/**
 * Pixels to reserve on each side of the viewport when fitting the stage rect.
 */
export function getStageFitViewportInsets(viewportWidth: number, viewportHeight: number): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  const dockTop = DOCK_TOP_OFFSET_PX + DOCK_ROW_BLOCK_PX + DOCK_TOP_EXTRA_PX;
  const top = Math.min(viewportHeight * TOP_INSET_MAX_FRAC, dockTop);

  const sideMax = Math.floor(viewportWidth * SIDE_INSET_MAX_FRAC);
  const side = Math.min(sideMax, Math.max(0, DOCK_SIDE_RESERVE_PX));

  return {
    top,
    right: side,
    bottom: FIT_BOTTOM_MARGIN_PX,
    left: side,
  };
}
