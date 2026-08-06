import { html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  wheelFrictionStore,
  wheelFrictionMotion,
  wheelFrictionTauMs,
  wheelDirectionStore,
  wheelDirectionSign,
  StoreController,
} from "../../state";
import { timelineStore } from "../../document/document";
import { FloatingPanel } from "../primitives/floating-panel";

// ============================================================
// ============================================================
// Wheel Panel (revolver-barrel jog wheel)
// ============================================================

/** Visual chamber count on the barrel; rolling past one steps one frame. */
const WHEEL_CHAMBERS = 12;
const WHEEL_DEG_PER_FRAME = 360 / WHEEL_CHAMBERS;
/** Coasting ends below this angular velocity (deg/ms). */
const WHEEL_COAST_STOP_VELOCITY = 0.02;
/** Above this |°/ms| (~8 fps), pegs become a rim streak. */
const WHEEL_STREAK_DEG_PER_MS = (8 * WHEEL_DEG_PER_FRAME) / 1000;
const WHEEL_RAD2DEG = 180 / Math.PI;
/** Hub floor (px); avoids blow-up at the exact center. */
const WHEEL_HUB_MIN_R = 14;
/** Lever exponent: 2 = full finger lever, 1 = no distance scaling (rim-normalized). */
const WHEEL_LEVER_EXPONENT = 1.25;

@customElement("flipcel-wheel-panel")
export class FlipCelWheelPanel extends FloatingPanel {
  @property({ type: Boolean, reflect: true }) override masonry = false;

  /** Timeline mirror — playhead ticks patch the hub; playing toggles Lit. */
  private timeline = { value: timelineStore.get() };
  private wheelFriction = new StoreController(this, wheelFrictionStore);
  private wheelDirection = new StoreController(this, wheelDirectionStore);
  /** Cumulative barrel rotation in degrees; grows clockwise without bound. */
  private rotationDeg = 0;
  @state() private dragging = false;
  @state() private coasting = false;

  private lastClientX = 0;
  private lastClientY = 0;
  /**
   * The notch (whole chamber count) the barrel last rested on. A frame step
   * fires the moment `round(rotationDeg / degPerFrame)` changes.
   */
  private lastNotch = 0;
  /** Last frame seen from the store, for wrap-aware playback sync. */
  private lastFrame = timelineStore.get().currentFrame;
  private unsubscribeTimeline: (() => void) | null = null;
  /** rAF throttle for frame commits while dragging (touch coalescing). */
  private notchStepRaf: number | null = null;
  /** Linear barrel spin while the timeline is playing. */
  private playbackRaf: number | null = null;
  private playbackLastTs = 0;
  private coastRaf: number | null = null;
  private lastCoastTs = 0;
  private angularVelocity = 0;
  private lastMoveTs = 0;
  /** Cached scrub-ring radius for the active drag (avoids layout each move). */
  private dragRimR = 106;
  /** Pegs → rim streak while spinning fast (playback / hard coast). */
  private streak = false;
  /**
   * True while our own frame-step event is being dispatched. The store
   * update it causes re-enters syncRotationToFrame synchronously; without
   * this flag the barrel would rotate twice per step.
   */
  private suppressSync = false;

  protected override usesFaceScrollbar(): boolean {
    return false;
  }

  protected override _isWhitespaceTarget(e: PointerEvent): boolean {
    const path = e.composedPath();
    for (const el of path) {
      if (el instanceof HTMLElement && el.hasAttribute("data-drag-handle")) {
        return true;
      }
    }
    return false;
  }

  updated(changedProperties: Map<string, unknown>) {
    // Keep the wheel a fixed circle — never adopt resize dimensions.
    if (this.blockWidth !== null) this.blockWidth = null;
    if (this.blockHeight !== null) this.blockHeight = null;
    this.syncWheelFrictionMotion();
    super.updated(changedProperties);
  }

  private syncWheelFrictionMotion() {
    const motion = wheelFrictionMotion(this.wheelFriction.value);
    this.style.setProperty("--wheel-settle-duration", `${motion.settleDurationMs}ms`);
    this.style.setProperty("--wheel-settle-easing", motion.settleEasing);
  }

  static styles = css`
    ${FloatingPanel.styles}

    :host {
      /* Reversed layout: barrel (pegs) on the outside, drag ring on the
         inside around the play-button hub. The barrel extends past the
         wheel circle by --barrel-outset; the grab ring fills the annular
         gap between the hub pill and the wheel edge. */
      --wheel-size: 180px;
      --barrel-outset: 16px;
      --grab-ring-inset: 30px;
      --panel-size: 240px;
      --panel-width: var(--panel-size);
      --panel-min-width: 0;
      --chamber-size: 19px;
      --chamber-outer-inset: 9px;
      height: var(--panel-size);
      min-height: var(--panel-size);
      max-height: var(--panel-size);
    }

    /* Stadium / circle panel shell. */
    .block {
      border-radius: calc(var(--panel-size) / 2);
      overflow: visible;
    }

    /* Fixed-size content; never show a scrollbar next to the wheel. */
    .face {
      border-radius: 50%;
      overflow: visible;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }

    .panel-form {
      align-items: center;
      justify-content: center;
      overflow: visible;
    }

    .wheel-wrap {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      overflow: visible;
    }

    .wheel {
      position: relative;
      width: var(--wheel-size);
      height: var(--wheel-size);
      border-radius: 50%;
      background: transparent;
      -webkit-tap-highlight-color: transparent;
    }

    /* Inner ring around the hub: this is the PANEL DRAG zone.
       No data-interactive, no scrub events — pointer events bubble
       up to the Block which starts a window drag. */
    .wheel-grab {
      position: absolute;
      inset: var(--grab-ring-inset);
      border-radius: 50%;
      z-index: 3;
      background: var(--block-depth-color, var(--flipcel-panel-depth));
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }

    .grab-handle-icon {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      color: var(--block-border, #555555);
    }

    .wheel.dragging .wheel-grab {
      cursor: grabbing;
    }

    /* Outer scrub ring: non-rotating hit target over the barrel.
       Captures pointer events for animation scrub / jog. */
    .scrub-ring {
      position: absolute;
      inset: calc(-1 * var(--barrel-outset) - 24px);
      border-radius: 50%;
      z-index: 1;
      cursor: grab;
      touch-action: none;
    }

    .wheel.dragging .scrub-ring {
      cursor: grabbing;
    }

    /* Barrel is now the OUTER ring: extends past the wheel circle. */
    .barrel {
      position: absolute;
      inset: calc(-1 * var(--barrel-outset));
      pointer-events: none;
      border-radius: 50%;
      transition: transform var(--wheel-settle-duration, 350ms)
        var(--wheel-settle-easing, cubic-bezier(0.175, 0.885, 0.32, 1.6));
      will-change: transform;
    }

    /* Drag, coast, and playback drive the barrel directly — no CSS lag. */
    .wheel.live .barrel {
      transition: none;
    }

    .chamber {
      position: absolute;
      top: 50%;
      left: 50%;
      width: var(--chamber-size);
      height: var(--chamber-size);
      margin: calc(var(--chamber-size) / -2) 0 0 calc(var(--chamber-size) / -2);
      border-radius: 50%;
      background: var(--block-depth-color, var(--flipcel-panel-depth));
      pointer-events: none;
      transition: opacity 120ms linear;
    }

    /* Fast spin: solid rim band matching peg outer/inner radii. */
    .barrel::after {
      content: "";
      position: absolute;
      inset: var(--chamber-outer-inset);
      border-radius: 50%;
      border: var(--chamber-size) solid
        var(--block-depth-color, var(--flipcel-panel-depth));
      box-sizing: border-box;
      opacity: 0;
      pointer-events: none;
      transition: opacity 120ms linear;
    }

    .wheel.streak .chamber {
      opacity: 0;
    }

    /* Pegs only cover ~half the rim — blended spin reads lighter. */
    .wheel.streak .barrel::after {
      opacity: 0.55;
    }

    /* Solid accent hub pill: the play button sits centered on the wheel's
       hub and the pill runs right to the inner grab ring edge, ending in
       the current frame number. */
    .hub-pill {
      --hub-pill-height: 44px;
      position: absolute;
      top: 50%;
      /* Left edge placed so the play half is centered on the wheel hub. */
      left: calc(50% - var(--hub-pill-height) / 2);
      transform: translateY(-50%);
      /* Width set so the CENTRE of the frame-number badge lands on
         the same radius as the CENTRE of the barrel pegs. */
      width: calc(var(--hub-pill-height) + var(--wheel-size) / 2 + var(--barrel-outset) - var(--chamber-size) / 2 - var(--chamber-outer-inset));
      height: var(--hub-pill-height);
      border-radius: 999px;
      overflow: hidden;
      display: flex;
      align-items: stretch;
      background: var(--flipcel-accent, #4a6fb5);
      z-index: 4;
      pointer-events: none;
    }

    .hub-play {
      flex: 0 0 auto;
      width: var(--hub-pill-height);
      min-width: 0;
      border: none;
      margin: 0;
      padding: 0;
      background: transparent;
      color: var(--flipcel-accent-contrast, #ffffff);
      font: inherit;
      font-size: 17px;
      line-height: 1;
      display: grid;
      place-items: center;
      cursor: pointer;
      pointer-events: auto;
      -webkit-tap-highlight-color: transparent;
    }

    .hub-play:hover {
      filter: brightness(0.92);
    }

    /* Shaded circle enclosing the frame number, inset at the pill's right end. */
    .hub-frame {
      --hub-frame-inset: 5px;
      flex: 0 0 auto;
      width: calc(var(--hub-pill-height) - var(--hub-frame-inset) * 2);
      height: calc(var(--hub-pill-height) - var(--hub-frame-inset) * 2);
      margin: var(--hub-frame-inset) var(--hub-frame-inset) var(--hub-frame-inset) auto;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.22);
      color: var(--flipcel-accent-contrast, #ffffff);
      display: grid;
      place-items: center;
      font-size: 14px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      line-height: 1;
      user-select: none;
      -webkit-user-select: none;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    // Custom chrome has no header X (close via dock toggle after re-docking).
    this.showPinnedClose = false;
    this.resizable = false;
    this.blockWidth = null;
    this.blockHeight = null;
    this.syncWheelFrictionMotion();
    this.timeline.value = timelineStore.get();
    const frame = this.timeline.value.currentFrame;
    this.lastFrame = frame;
    this.lastNotch = frame;
    this.rotationDeg = this.lastNotch * WHEEL_DEG_PER_FRAME;
    this.unsubscribeTimeline = timelineStore.subscribe((t) => {
      const prev = this.timeline.value;
      this.timeline.value = t;
      this.syncRotationToFrame(t.currentFrame, t.duration);
      this.updatePlaybackRotation(t);
      // Play/stop needs Lit; playhead-only only updates the hub number.
      if (prev.playing !== t.playing) {
        this.requestUpdate();
        return;
      }
      if (prev.currentFrame !== t.currentFrame) {
        this.syncHubFrame(t.currentFrame);
      }
    });
  }

  disconnectedCallback() {
    this.unsubscribeTimeline?.();
    this.unsubscribeTimeline = null;
    this.cancelNotchStepSchedule();
    this.stopPlaybackRotation();
    this.stopCoasting();
    super.disconnectedCallback();
  }

  /** Paint the barrel immediately — bypasses Lit so drags stay glued to the finger. */
  private setBarrelRotationLive(deg: number) {
    this.rotationDeg = deg;
    const barrel = this.renderRoot.querySelector<HTMLElement>(".barrel");
    if (barrel) barrel.style.transform = `rotate(${deg}deg)`;
  }

  /** Hub frame badge — patched without rebuilding chamber DOM. */
  private syncHubFrame(frame: number) {
    const el = this.renderRoot.querySelector(".hub-frame");
    if (el) el.textContent = String(frame + 1);
  }

  private syncStreak(on: boolean) {
    if (this.streak === on) return;
    this.streak = on;
    this.renderRoot.querySelector(".wheel")?.classList.toggle("streak", on);
  }

  private isBarrelLive(): boolean {
    return this.dragging || this.coasting || this.timeline.value.playing;
  }

  /** Nearest chamber angle on the same lap as `nearDeg`. */
  private chamberDegForNotch(notch: number, nearDeg: number): number {
    const base = notch * WHEEL_DEG_PER_FRAME;
    return base + Math.round((nearDeg - base) / 360) * 360;
  }

  /** Ease the barrel onto the current notch (revolver peg lock). */
  private settleToChamber() {
    if (this.isBarrelLive()) return;
    const target = this.chamberDegForNotch(this.lastNotch, this.rotationDeg);
    if (Math.abs(this.rotationDeg - target) < 0.05) {
      this.rotationDeg = target;
      this.setBarrelRotationLive(target);
      return;
    }
    // Lit may not have re-rendered yet after coasting stops — drop .live so CSS can run.
    this.renderRoot.querySelector<HTMLElement>(".wheel")?.classList.remove("live");
    this.rotationDeg = target;
    this.setBarrelRotationLive(target);
  }

  private cancelNotchStepSchedule() {
    if (this.notchStepRaf !== null) {
      cancelAnimationFrame(this.notchStepRaf);
      this.notchStepRaf = null;
    }
  }

  /** Commit frame steps at most once per display frame while dragging. */
  private scheduleNotchSteps() {
    if (this.notchStepRaf !== null) return;
    this.notchStepRaf = requestAnimationFrame(() => {
      this.notchStepRaf = null;
      this.emitNotchSteps();
    });
  }

  private flushNotchSteps() {
    this.cancelNotchStepSchedule();
    this.emitNotchSteps();
  }

  private emitStep(delta: number) {
    this.suppressSync = true;
    try {
      this.dispatchEvent(
        new CustomEvent("frame-step", { detail: delta, bubbles: true, composed: true }),
      );
    } finally {
      this.suppressSync = false;
    }
  }

  private emitNotchSteps() {
    const notch = Math.round(this.rotationDeg / WHEEL_DEG_PER_FRAME);
    if (notch !== this.lastNotch) {
      const steps = notch - this.lastNotch;
      this.lastNotch = notch;
      this.emitStep(steps * wheelDirectionSign(this.wheelDirection.value));
    }
  }

  /**
   * Keep the barrel aligned when the playhead moves while paused or scrubbed.
   * During playback the rAF loop drives rotation instead.
   */
  private syncRotationToFrame(frame: number, duration: number) {
    if (frame === this.lastFrame) return;
    let df = frame - this.lastFrame;
    if (duration > 1 && Math.abs(df) > duration / 2) {
      df -= Math.sign(df) * duration;
    }
    this.lastFrame = frame;
    if (this.suppressSync || this.dragging || this.coasting) return;
    const notchDelta = df * wheelDirectionSign(this.wheelDirection.value);
    if (timelineStore.get().playing) {
      this.lastNotch += notchDelta;
      return;
    }
    this.lastNotch += notchDelta;
    this.settleToChamber();
  }

  private updatePlaybackRotation(t: { playing: boolean }) {
    if (t.playing && !this.dragging && !this.coasting) {
      if (this.playbackRaf === null) {
        this.playbackLastTs = performance.now();
        this.playbackRaf = requestAnimationFrame(this.playbackTick);
      }
    } else {
      this.stopPlaybackRotation();
    }
  }

  private stopPlaybackRotation() {
    const wasPlaying = this.playbackRaf !== null;
    if (this.playbackRaf !== null) {
      cancelAnimationFrame(this.playbackRaf);
      this.playbackRaf = null;
    }
    this.syncStreak(false);
    if (wasPlaying && !this.isBarrelLive()) {
      this.settleToChamber();
    }
  }

  private stopCoasting() {
    if (this.coastRaf !== null) {
      cancelAnimationFrame(this.coastRaf);
      this.coastRaf = null;
    }
    this.coasting = false;
  }

  private startCoasting(velocity: number) {
    this.stopCoasting();
    this.angularVelocity = velocity;
    this.coasting = true;
    this.lastCoastTs = performance.now();
    this.coastRaf = requestAnimationFrame(this.coastTick);
  }

  private coastTick = (now: number) => {
    const dt = now - this.lastCoastTs;
    this.lastCoastTs = now;
    this.setBarrelRotationLive(this.rotationDeg + this.angularVelocity * dt);
    this.emitNotchSteps();
    this.angularVelocity *= Math.exp(-dt / wheelFrictionTauMs(this.wheelFriction.value));
    this.syncStreak(Math.abs(this.angularVelocity) > WHEEL_STREAK_DEG_PER_MS);
    if (Math.abs(this.angularVelocity) < WHEEL_COAST_STOP_VELOCITY) {
      this.stopCoasting();
      this.syncStreak(false);
      this.settleToChamber();
      return;
    }
    this.coastRaf = requestAnimationFrame(this.coastTick);
  };

  /** Constant-rate spin: one chamber per timeline frame, no easing. */
  private playbackTick = (now: number) => {
    const t = timelineStore.get();
    if (!t.playing || this.dragging) {
      this.stopPlaybackRotation();
      return;
    }
    const dt = now - this.playbackLastTs;
    this.playbackLastTs = now;
    const degPerMs =
      ((t.frameRate * WHEEL_DEG_PER_FRAME) / 1000) *
      wheelDirectionSign(this.wheelDirection.value);
    this.setBarrelRotationLive(this.rotationDeg + degPerMs * dt);
    this.lastNotch = Math.round(this.rotationDeg / WHEEL_DEG_PER_FRAME);
    this.syncStreak(Math.abs(degPerMs) > WHEEL_STREAK_DEG_PER_MS);
    this.playbackRaf = requestAnimationFrame(this.playbackTick);
  };

  /** Outer scrub-ring radius in screen pixels (used for lever sensitivity). */
  private wheelRimRadius(): number {
    const ring = this.renderRoot.querySelector<HTMLElement>(".scrub-ring");
    return ring ? ring.getBoundingClientRect().width / 2 : 106;
  }

  /** Finger offset from wheel center (screen plane). */
  private wheelOffset(e: PointerEvent): { px: number; py: number } {
    const grab = e.currentTarget as HTMLElement;
    const rect = grab.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return { px: e.clientX - cx, py: e.clientY - cy };
  }

  /**
   * Virtual dial with rim-normalized lever: denom = r^exp · R^(2−exp) so
   * sensitivity at the rim matches exp=2 while distance coupling softens.
   */
  private wheelScrubDeg(
    anchorPx: number,
    anchorPy: number,
    dx: number,
    dy: number,
    rimR: number,
  ): number {
    const r = Math.max(Math.hypot(anchorPx, anchorPy), WHEEL_HUB_MIN_R);
    const denom =
      Math.pow(r, WHEEL_LEVER_EXPONENT) *
      Math.pow(rimR, 2 - WHEEL_LEVER_EXPONENT);
    return ((anchorPx * dy - anchorPy * dx) / denom) * WHEEL_RAD2DEG;
  }

  private onWheelDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    this.dragging = true;
    if (this.timeline.value.playing) {
      this.dispatchEvent(
        new CustomEvent("play-toggle", { bubbles: true, composed: true }),
      );
    }
    this.stopPlaybackRotation();
    this.stopCoasting();
    this.cancelNotchStepSchedule();
    this.dragRimR = this.wheelRimRadius();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Pointer already released (fast tap) — drag still works uncaptured.
    }
    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;
    this.angularVelocity = 0;
    this.lastMoveTs = e.timeStamp;
    e.preventDefault();
  };

  private onWheelMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastClientX;
    const dy = e.clientY - this.lastClientY;
    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;

    const { px, py } = this.wheelOffset(e);
    const scrubDeg = this.wheelScrubDeg(px - dx, py - dy, dx, dy, this.dragRimR);
    this.setBarrelRotationLive(this.rotationDeg + scrubDeg);

    const dt = e.timeStamp - this.lastMoveTs;
    if (dt > 0 && dt < 200) {
      this.angularVelocity = this.angularVelocity * 0.5 + (scrubDeg / dt) * 0.5;
    }
    this.lastMoveTs = e.timeStamp;
    this.syncStreak(Math.abs(this.angularVelocity) > WHEEL_STREAK_DEG_PER_MS);
    this.scheduleNotchSteps();
  };

  private onWheelUp = (e: PointerEvent) => {
    if (!this.dragging) return;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    this.flushNotchSteps();
    const throwRelease =
      Math.abs(this.angularVelocity) >= WHEEL_COAST_STOP_VELOCITY;
    // Clear drag before settle — settleToChamber no-ops while isBarrelLive().
    this.dragging = false;
    if (throwRelease) {
      this.startCoasting(this.angularVelocity);
    } else {
      this.syncStreak(false);
      this.settleToChamber();
    }
    this.updatePlaybackRotation(timelineStore.get());
  };

  render() {
    const t = this.timeline.value;
    const chambers = Array.from({ length: WHEEL_CHAMBERS }, (_, i) => i);
    return html`
      <div class="block" data-interactive>
        <div class="face">
          <div class="panel-form">
            <div class="wheel-wrap">
              <div
                class="wheel ${this.dragging ? "dragging" : ""} ${this.isBarrelLive()
                  ? "live"
                  : ""} ${this.streak ? "streak" : ""}"
              >
                <div class="barrel" style="transform: rotate(${this.rotationDeg}deg)">
                  ${chambers.map(
                    (i) => html`
                      <div
                        class="chamber"
                        style="transform: rotate(${i * WHEEL_DEG_PER_FRAME}deg)
                          translateY(calc((var(--wheel-size) / 2 + var(--barrel-outset)) * -1 + var(--chamber-size) / 2 + var(--chamber-outer-inset)))"
                      ></div>
                    `,
                  )}
                </div>
                <div
                  class="wheel-grab"
                  data-drag-handle
                  title="Drag panel window"
                >
                  <svg class="grab-handle-icon" viewBox="0 0 120 120" fill="none">
                    <path
                      d="M 42.3 21.9 A 42 42 0 0 1 77.8 21.9"
                      stroke="currentColor"
                      stroke-width="7"
                      stroke-linecap="round"
                    />
                  </svg>
                </div>
                <div
                  class="scrub-ring"
                  data-interactive
                  title="Drag to spin or scrub the playhead"
                  @pointerdown=${this.onWheelDown}
                  @pointermove=${this.onWheelMove}
                  @pointerup=${this.onWheelUp}
                  @pointercancel=${this.onWheelUp}
                ></div>
                <div class="hub-pill">
                  <button
                    type="button"
                    class="hub-play ${t.playing ? "on" : ""}"
                    aria-label=${t.playing ? "Stop" : "Play"}
                    title=${t.playing ? "Stop" : "Play"}
                    data-interactive
                    @pointerdown=${(e: Event) => e.stopPropagation()}
                    @click=${() =>
                      this.dispatchEvent(
                        new CustomEvent("play-toggle", { bubbles: true, composed: true }),
                      )}
                  >${t.playing ? html`&#9632;` : html`&#9654;`}</button>
                  <div class="hub-frame">${t.currentFrame + 1}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
