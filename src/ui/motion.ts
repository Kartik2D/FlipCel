/**
 * Shared UI motion system.
 *
 * Two primary eases:
 * 1. Quad in-out — smooth, no overshoot (panel shrink while dragging over dock)
 * 2. Fast-to-overshoot — snappy settle past target (dock resize, button pop, snap-back)
 *
 * Registers CSS custom properties on `:root` so Lit `css` templates and inline
 * transitions share the same tokens.
 */

/** 1 — Quadratic ease-in-out (approx.). */
export const FLIPCEL_MOTION_QUAD_MS = 220;
export const FLIPCEL_MOTION_QUAD_EASING = "cubic-bezier(0.45, 0, 0.55, 1)";

/** 2 — Fast attack with obvious overshoot settle. */
export const FLIPCEL_MOTION_OVERSHOOT_MS = 420;
export const FLIPCEL_MOTION_OVERSHOOT_EASING = "cubic-bezier(0.22, 1.7, 0.36, 1)";

/** @deprecated Prefer OVERSHOOT_* — kept for existing snap-back call sites. */
export const FLIPCEL_MOTION_BOUNCE_MS = FLIPCEL_MOTION_OVERSHOOT_MS;
/** @deprecated Prefer OVERSHOOT_* */
export const FLIPCEL_MOTION_BOUNCE_EASING = FLIPCEL_MOTION_OVERSHOOT_EASING;

export const FLIPCEL_CSS_VAR_QUAD_DURATION = "--flipcel-motion-quad-duration";
export const FLIPCEL_CSS_VAR_QUAD_EASING = "--flipcel-motion-quad-easing";
export const FLIPCEL_CSS_VAR_OVERSHOOT_DURATION = "--flipcel-motion-overshoot-duration";
export const FLIPCEL_CSS_VAR_OVERSHOOT_EASING = "--flipcel-motion-overshoot-easing";

/** Back-compat aliases → overshoot tokens. */
export const FLIPCEL_CSS_VAR_BOUNCE_DURATION = "--flipcel-motion-bounce-duration";
export const FLIPCEL_CSS_VAR_BOUNCE_EASING = "--flipcel-motion-bounce-easing";

/** Visual scale while a floating panel is dragged over the top dock. */
export const FLIPCEL_PANEL_DOCK_HOVER_SCALE = 0.88;
export const FLIPCEL_CSS_VAR_PANEL_DOCK_HOVER_SCALE = "--flipcel-panel-dock-hover-scale";

function registerFlipCelMotionCssVars() {
  const root = document.documentElement;
  root.style.setProperty(FLIPCEL_CSS_VAR_QUAD_DURATION, `${FLIPCEL_MOTION_QUAD_MS}ms`);
  root.style.setProperty(FLIPCEL_CSS_VAR_QUAD_EASING, FLIPCEL_MOTION_QUAD_EASING);
  root.style.setProperty(FLIPCEL_CSS_VAR_OVERSHOOT_DURATION, `${FLIPCEL_MOTION_OVERSHOOT_MS}ms`);
  root.style.setProperty(FLIPCEL_CSS_VAR_OVERSHOOT_EASING, FLIPCEL_MOTION_OVERSHOOT_EASING);
  // Aliases for older selectors / snap-back shorthand
  root.style.setProperty(FLIPCEL_CSS_VAR_BOUNCE_DURATION, `${FLIPCEL_MOTION_OVERSHOOT_MS}ms`);
  root.style.setProperty(FLIPCEL_CSS_VAR_BOUNCE_EASING, FLIPCEL_MOTION_OVERSHOOT_EASING);
  root.style.setProperty(FLIPCEL_CSS_VAR_PANEL_DOCK_HOVER_SCALE, String(FLIPCEL_PANEL_DOCK_HOVER_SCALE));
}

registerFlipCelMotionCssVars();

/**
 * Name of @keyframes in Block styles — same milestones as `floating-close-bounce-in` (0 / 55 / 78 / 100%),
 * but on translate() so snap-back overshoots and settles like the close button scale.
 */
export const FLIPCEL_PANEL_SNAP_BACK_KEYFRAMES = "flipcel-panel-snap-back";

/** Full `animation` shorthand; host sets `--flipcel-snap-x` / `--flipcel-snap-y` before applying. */
export const FLIPCEL_PANEL_SNAP_ANIMATION = `${FLIPCEL_PANEL_SNAP_BACK_KEYFRAMES} var(${FLIPCEL_CSS_VAR_OVERSHOOT_DURATION}) var(${FLIPCEL_CSS_VAR_OVERSHOOT_EASING}) both`;

/** Entrance pop when a panel is shown (overshoot scale). */
export const FLIPCEL_PANEL_SHOW_KEYFRAMES = "flipcel-panel-show";
export const FLIPCEL_PANEL_SHOW_ANIMATION = `${FLIPCEL_PANEL_SHOW_KEYFRAMES} var(${FLIPCEL_CSS_VAR_OVERSHOOT_DURATION}) var(${FLIPCEL_CSS_VAR_OVERSHOOT_EASING}) both`;

/**
 * Center-origin grow/shrink via scaleX FLIP.
 *
 * Snap layout to the new width immediately, invert with `scaleX(from/to)`, then
 * ease to `scaleX(1)` with overshoot so the dock expands/contracts from center.
 * Composes with a base transform (default `translateX(-50%)` for centered docks).
 *
 * Pass `isCurrent` when a newer animation may supersede this one — cleanup is
 * skipped so the newer run keeps control of inline styles.
 */
export function animateCenteredScaleX(
  el: HTMLElement,
  fromWidth: number,
  toWidth?: number,
  options?: {
    durationMs?: number;
    easing?: string;
    /** Kept under the animated scaleX (e.g. centering). */
    baseTransform?: string;
    isCurrent?: () => boolean;
  },
): Promise<void> {
  const durationMs = options?.durationMs ?? FLIPCEL_MOTION_OVERSHOOT_MS;
  const easing = options?.easing ?? FLIPCEL_MOTION_OVERSHOOT_EASING;
  const baseTransform = options?.baseTransform ?? "translateX(-50%)";
  const isCurrent = options?.isCurrent ?? (() => true);

  const previousTransition = el.style.transition;
  const previousTransform = el.style.transform;
  const previousOrigin = el.style.transformOrigin;

  // offsetWidth is layout size (ignores transform), so in-flight scaleX can't skew FLIP.
  const target =
    toWidth ??
    (() => {
      const prevWidth = el.style.width;
      el.style.width = "auto";
      const measured = el.offsetWidth;
      el.style.width = prevWidth;
      return measured;
    })();

  if (fromWidth < 0.5 || target < 0.5 || Math.abs(target - fromWidth) < 0.5) {
    return Promise.resolve();
  }

  const startScale = fromWidth / target;

  el.style.transition = "none";
  el.style.transformOrigin = "center center";
  el.style.transform = `${baseTransform} scaleX(${startScale})`;
  void el.offsetWidth;

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("transitionend", onEnd);
      window.clearTimeout(fallback);
      if (isCurrent()) {
        el.style.transition = previousTransition;
        el.style.transform = previousTransform;
        el.style.transformOrigin = previousOrigin;
      }
      resolve();
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target !== el || e.propertyName !== "transform") return;
      finish();
    };
    el.addEventListener("transitionend", onEnd);
    const fallback = window.setTimeout(finish, durationMs + 80);

    el.style.transition = `transform ${durationMs}ms ${easing}`;
    el.style.transform = `${baseTransform} scaleX(1)`;
  });
}
