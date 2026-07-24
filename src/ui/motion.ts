/**
 * Shared motion tokens — bounce timing/easing for floating UI (pinned close control,
 * panel snap-back when a drag does not commit, etc.).
 *
 * Registers CSS custom properties on `:root` so Lit `css` templates can use the same values.
 */

export const INKWELL_MOTION_BOUNCE_MS = 380;

/** Overshoot-friendly easing (matches previous close-button animation). */
export const INKWELL_MOTION_BOUNCE_EASING = "cubic-bezier(0.34, 1.25, 0.64, 1)";

export const INKWELL_CSS_VAR_BOUNCE_DURATION = "--inkwell-motion-bounce-duration";

export const INKWELL_CSS_VAR_BOUNCE_EASING = "--inkwell-motion-bounce-easing";

function registerInkwellMotionCssVars() {
  const root = document.documentElement;
  root.style.setProperty(INKWELL_CSS_VAR_BOUNCE_DURATION, `${INKWELL_MOTION_BOUNCE_MS}ms`);
  root.style.setProperty(INKWELL_CSS_VAR_BOUNCE_EASING, INKWELL_MOTION_BOUNCE_EASING);
}

registerInkwellMotionCssVars();

/**
 * Name of @keyframes in Block styles — same milestones as `floating-close-bounce-in` (0 / 55 / 78 / 100%),
 * but on translate() so snap-back overshoots and settles like the close button scale.
 */
export const INKWELL_PANEL_SNAP_BACK_KEYFRAMES = "inkwell-panel-snap-back";

/** Full `animation` shorthand; host sets `--inkwell-snap-x` / `--inkwell-snap-y` before applying. */
export const INKWELL_PANEL_SNAP_ANIMATION = `${INKWELL_PANEL_SNAP_BACK_KEYFRAMES} var(${INKWELL_CSS_VAR_BOUNCE_DURATION}) var(${INKWELL_CSS_VAR_BOUNCE_EASING}) both`;
