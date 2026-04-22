/**
 * Unified Input Manager
 *
 * Centralized input handling for all input types:
 * - Mouse (click, drag, wheel)
 * - Touch (single touch drawing, multitouch gestures)
 * - Pen/Stylus (pressure-sensitive drawing)
 * - Keyboard (hotkeys, modifier keys)
 *
 * State machine with gesture states:
 * - idle: No active input
 * - drawing: Single pointer tool action (brush, lasso, select drag)
 * - panning: Camera pan (middle mouse, pan tool, or shift+drag)
 * - pinching: Two-finger multitouch gesture (zoom/pan/rotate)
 *
 * Modifier key integration:
 * - Shift: Toggle add/subtract mode for brush/lasso
 * - Hotkeys: Defined per-tool in tools.ts
 */
import type { Point, CanvasConfig, Modifiers, PointerInfo } from "./types";
import { type ToolId, getToolByHotkey } from "./tools";
import { bus, Events } from "./event-bus";
import { getDrawingCrosshairCursorCss } from "./custom-cursor";

export type GestureState = "idle" | "drawing" | "panning" | "pinching";

export class UnifiedInputManager {
  private canvas: HTMLCanvasElement;
  private config: CanvasConfig;

  // Current tool
  private currentTool: ToolId = "brush";

  // Gesture state machine
  private gestureState: GestureState = "idle";

  // Active pointers tracking
  private activePointers: Map<number, PointerInfo> = new Map();
  private primaryPointerId: number | null = null;

  // Touch-draw deferral (prevents dots when user intended 2-finger navigation)
  private pendingTouchDraw: {
    pointerId: number;
    startScreenX: number;
    startScreenY: number;
    startTimeMs: number;
    lastClientX: number;
    lastClientY: number;
    lastPressure?: number;
  } | null = null;
  private readonly touchDrawCommitDistancePx = 6; // screen pixels
  private readonly touchDrawCommitDelayMs = 70; // grace period for second finger

  // Modifier keys state
  private modifiers: Modifiers = {
    shift: false,
    alt: false,
    ctrl: false,
    meta: false,
  };

  // Pressure handling
  private lastPressure: number | null = null;
  private pressureDeadzone = 0.08;

  // Multitouch gesture state
  private lastPinchDistance: number | null = null;
  private lastPinchCenter: { x: number; y: number } | null = null;
  private lastPinchAngle: number | null = null;
  // Pan state (for middle-click or pan tool)
  private panStartX = 0;
  private panStartY = 0;

  constructor(canvas: HTMLCanvasElement, config: CanvasConfig) {
    this.canvas = canvas;
    this.config = config;
    this.setupPointerListeners();
    this.setupKeyboardListeners();
    this.setupWheelListener();
    this.setupTouchPreventDefaults();
    this.updateCanvasCursor();
  }

  // ============================================================
  // Public API
  // ============================================================

  updateConfig(config: CanvasConfig) {
    this.config = config;
  }

  /**
   * Reset all in-flight pointer/gesture state without committing any stroke.
   *
   * Called after operations that reconfigure the input canvas (e.g. pixel
   * resolution change), which on some mobile browsers can silently
   * invalidate the canvas's active pointer captures and drop subsequent
   * pointerup events. Without this reset, a stale `primaryPointerId` /
   * `pendingTouchDraw` / `activePointers` entry can block the next
   * `pointerdown` from starting a fresh stroke, which manifests as
   * "drawing/tracing stopped working after moving the resolution slider".
   */
  resetInputState() {
    for (const pointerId of this.activePointers.keys()) {
      this.safeReleasePointerCapture(pointerId);
    }
    this.activePointers.clear();
    this.pendingTouchDraw = null;
    this.primaryPointerId = null;
    this.lastPressure = null;
    this.lastPinchDistance = null;
    this.lastPinchCenter = null;
    this.lastPinchAngle = null;
    if (this.gestureState !== "idle") {
      this.gestureState = "idle";
      this.updateCanvasCursor();
    }
  }

  setTool(tool: ToolId) {
    this.currentTool = tool;
    this.updateCanvasCursor();
  }

  getTool(): ToolId {
    return this.currentTool;
  }

  getModifiers(): Modifiers {
    return { ...this.modifiers };
  }

  getGestureState(): GestureState {
    return this.gestureState;
  }

  // ============================================================
  // Setup Event Listeners
  // ============================================================

  private setupPointerListeners() {
    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.canvas.addEventListener("pointercancel", this.handlePointerCancel);
    this.canvas.addEventListener("pointerleave", this.handlePointerLeave);

    // Prevent context menu on long press
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  private setupKeyboardListeners() {
    // Use document for keyboard events (works when canvas isn't focused)
    document.addEventListener("keydown", this.handleKeyDown);
    document.addEventListener("keyup", this.handleKeyUp);

    // Track window blur to reset modifiers
    window.addEventListener("blur", this.handleWindowBlur);
  }

  private setupWheelListener() {
    this.canvas.addEventListener("wheel", this.handleWheel, { passive: false });
  }

  private setupTouchPreventDefaults() {
    // Prevent default touch behaviors (scrolling, zooming page)
    this.canvas.addEventListener("touchstart", (e) => e.preventDefault(), {
      passive: false,
    });
    this.canvas.addEventListener("touchmove", (e) => e.preventDefault(), {
      passive: false,
    });

    // Prevent Safari gesture events
    this.canvas.addEventListener("gesturestart", (e) => e.preventDefault());
    this.canvas.addEventListener("gesturechange", (e) => e.preventDefault());
    this.canvas.addEventListener("gestureend", (e) => e.preventDefault());
  }

  // ============================================================
  // Pointer Event Handlers
  // ============================================================

  private handlePointerDown = (e: PointerEvent) => {
    const pointerInfo = this.createPointerInfo(e);
    this.activePointers.set(e.pointerId, pointerInfo);

    const screenCoords = this.getScreenCoords(e);

    // Check for multitouch (2+ pointers)
    if (this.activePointers.size >= 2) {
      if (this.gestureState !== "pinching") {
        this.startPinchGesture();
      }
      return;
    }

    // Middle mouse button always pans
    if (e.button === 1) {
      e.preventDefault();
      this.startPanning(screenCoords, e.pointerId);
      return;
    }

    // Primary button (left click / touch)
    if (e.button === 0) {
      // Pan tool = pan mode
      if (this.currentTool === "pan") {
        this.startPanning(screenCoords, e.pointerId);
        return;
      }

      // Other tools = drawing/tool action
      if (e.pointerType === "touch") {
        this.startPendingTouchDraw(e, screenCoords);
        return;
      }

      this.startDrawing(e);
    }
  };

  private handlePointerMove = (e: PointerEvent) => {
    const screenCoords = this.getScreenCoords(e);

    // Update pointer tracking
    if (this.activePointers.has(e.pointerId)) {
      const info = this.activePointers.get(e.pointerId)!;
      info.x = screenCoords.x;
      info.y = screenCoords.y;
      info.pressure = e.pressure;
    }

    // If we have a pending touch draw, decide whether to commit it.
    if (
      this.gestureState === "idle" &&
      this.pendingTouchDraw &&
      this.pendingTouchDraw.pointerId === e.pointerId &&
      this.activePointers.size === 1
    ) {
      this.maybeCommitPendingTouchDraw(e, screenCoords);
      // If we committed, the state is now "drawing" and subsequent moves will flow there.
      if (this.gestureState !== "idle") return;
    }

    // Handle based on gesture state
    switch (this.gestureState) {
      case "pinching":
        this.updatePinchGesture();
        break;

      case "panning":
        this.updatePanning(screenCoords);
        break;

      case "drawing":
        this.updateDrawing(e);
        break;

      case "idle":
        // Just update cursor position
        const point = this.normalizePoint(e.clientX, e.clientY, e.pressure);
        bus.emit(Events.POINTER_MOVE, point);
        break;
    }
  };

  private handlePointerUp = (e: PointerEvent) => {
    const wasActive = this.activePointers.has(e.pointerId);
    this.activePointers.delete(e.pointerId);

    if (!wasActive) return;

    // If we were still deferring a touch draw, end it without creating a dot.
    if (
      this.pendingTouchDraw &&
      this.pendingTouchDraw.pointerId === e.pointerId &&
      this.gestureState === "idle"
    ) {
      this.pendingTouchDraw = null;
      this.primaryPointerId = null;
      this.lastPressure = null;
      return;
    }

    // Check if we're ending multitouch
    if (this.gestureState === "pinching") {
      if (this.activePointers.size < 2) {
        this.endPinchGesture();
      }
      return;
    }

    // Check if this was the primary pointer
    if (e.pointerId === this.primaryPointerId) {
      if (this.gestureState === "panning") {
        this.endPanning(e.pointerId);
      } else if (this.gestureState === "drawing") {
        this.endDrawing();
      }
    }
  };

  private handlePointerCancel = (e: PointerEvent) => {
    this.activePointers.delete(e.pointerId);

    // Reset gesture state if needed
    if (this.gestureState === "pinching" && this.activePointers.size < 2) {
      this.endPinchGesture();
    } else if (e.pointerId === this.primaryPointerId) {
      if (this.gestureState === "drawing") {
        this.endDrawing();
      } else if (this.gestureState === "panning") {
        this.endPanning(e.pointerId);
      }
    }
  };

  private handlePointerLeave = (e: PointerEvent) => {
    // Only clear cursor for mouse, not for touch/pen that might leave temporarily
    if (e.pointerType === "mouse" && this.gestureState === "idle") {
      // Could emit a cursor hide event here if needed
    }
  };

  // ============================================================
  // Keyboard Event Handlers
  // ============================================================

  private handleKeyDown = (e: KeyboardEvent) => {
    // Ignore if typing in an input field
    if (this.isTypingInInput(e)) return;

    // Update modifier state
    const modifiersChanged = this.updateModifiers(e);
    if (modifiersChanged) {
      bus.emit(Events.MODIFIERS_CHANGE, this.getModifiers());
    }

    // Handle hotkeys (only on initial press, not repeat)
    if (!e.repeat) {
      this.handleHotkey(e);
    }
  };

  private handleKeyUp = (e: KeyboardEvent) => {
    const modifiersChanged = this.updateModifiers(e);
    if (modifiersChanged) {
      bus.emit(Events.MODIFIERS_CHANGE, this.getModifiers());
    }
  };

  private handleWindowBlur = () => {
    // Reset all modifiers when window loses focus
    const hadModifiers =
      this.modifiers.shift ||
      this.modifiers.alt ||
      this.modifiers.ctrl ||
      this.modifiers.meta;

    this.modifiers = { shift: false, alt: false, ctrl: false, meta: false };

    if (hadModifiers) {
      bus.emit(Events.MODIFIERS_CHANGE, this.getModifiers());
    }
  };

  private updateModifiers(e: KeyboardEvent): boolean {
    const prev = { ...this.modifiers };

    this.modifiers.shift = e.shiftKey;
    this.modifiers.alt = e.altKey;
    this.modifiers.ctrl = e.ctrlKey;
    this.modifiers.meta = e.metaKey;

    return (
      prev.shift !== this.modifiers.shift ||
      prev.alt !== this.modifiers.alt ||
      prev.ctrl !== this.modifiers.ctrl ||
      prev.meta !== this.modifiers.meta
    );
  }

  private handleHotkey(e: KeyboardEvent) {
    const key = e.key.toLowerCase();

    // Undo: Cmd+Z (Mac) or Ctrl+Z (Windows/Linux)
    if (key === "z" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (e.shiftKey) {
        // Redo: Cmd+Shift+Z or Ctrl+Shift+Z
        bus.emit(Events.REDO, null);
      } else {
        // Undo: Cmd+Z or Ctrl+Z
        bus.emit(Events.UNDO, null);
      }
      return;
    }

    // Tool selection hotkeys - use tool registry
    const tool = getToolByHotkey(key);
    if (tool && tool.id !== this.currentTool) {
      this.currentTool = tool.id as ToolId;
      this.updateCanvasCursor();
      bus.emit(Events.TOOL_CHANGE, this.currentTool);
    }
  }

  private isTypingInInput(e: KeyboardEvent): boolean {
    const target = e.target as HTMLElement;
    return (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable
    );
  }

  // ============================================================
  // Wheel Event Handler
  // ============================================================

  private handleWheel = (e: WheelEvent) => {
    e.preventDefault();

    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Normalize delta across browsers
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;

    // Shift+wheel = pan (uses both deltaX and deltaY for 2D scroll wheels)
    if (e.shiftKey) {
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
      bus.emit(Events.CAMERA_PAN, { deltaX: -dx, deltaY: -dy });
      return;
    }

    // Normal wheel = zoom
    const zoomFactor = 1 - delta * 0.001;
    const clampedFactor = Math.max(0.5, Math.min(2, zoomFactor));
    bus.emit(Events.CAMERA_ZOOM, { factor: clampedFactor, x, y });
  };

  // ============================================================
  // Drawing State Machine
  // ============================================================

  private startDrawing(e: PointerEvent) {
    if (this.gestureState !== "idle") return;

    this.gestureState = "drawing";
    this.primaryPointerId = e.pointerId;
    this.canvas.setPointerCapture(e.pointerId);

    this.lastPressure = null; // Reset for fresh stroke
    const point = this.normalizePoint(e.clientX, e.clientY, e.pressure);
    bus.emit(Events.TOOL_START, { point, tool: this.currentTool });
  }

  private updateDrawing(e: PointerEvent) {
    if (this.gestureState !== "drawing") return;
    if (e.pointerId !== this.primaryPointerId) return;

    const point = this.normalizePoint(e.clientX, e.clientY, e.pressure);
    bus.emit(Events.TOOL_MOVE, { point, tool: this.currentTool });
    bus.emit(Events.POINTER_MOVE, point);
  }

  private endDrawing() {
    if (this.gestureState !== "drawing") return;

    if (this.primaryPointerId !== null) {
      this.safeReleasePointerCapture(this.primaryPointerId);
    }

    bus.emit(Events.TOOL_END, this.currentTool);

    this.gestureState = "idle";
    this.primaryPointerId = null;
    this.lastPressure = null;
    this.updateCanvasCursor();
  }

  // ============================================================
  // Panning State Machine
  // ============================================================

  private startPanning(screenCoords: { x: number; y: number }, pointerId: number) {
    // Cancel any drawing in progress
    if (this.gestureState === "drawing") this.cancelActiveToolInteraction();
    if (this.pendingTouchDraw) this.cancelPendingTouchDraw();

    this.gestureState = "panning";
    this.primaryPointerId = pointerId;
    this.panStartX = screenCoords.x;
    this.panStartY = screenCoords.y;
    this.canvas.setPointerCapture(pointerId);
    this.updateCanvasCursor();
  }

  private updatePanning(screenCoords: { x: number; y: number }) {
    if (this.gestureState !== "panning") return;

    const deltaX = screenCoords.x - this.panStartX;
    const deltaY = screenCoords.y - this.panStartY;

    bus.emit(Events.CAMERA_PAN, { deltaX, deltaY });

    this.panStartX = screenCoords.x;
    this.panStartY = screenCoords.y;
  }

  private endPanning(pointerId: number) {
    if (this.gestureState !== "panning") return;

    this.safeReleasePointerCapture(pointerId);
    this.gestureState = "idle";
    this.primaryPointerId = null;
    this.updateCanvasCursor();
  }

  // ============================================================
  // Pinch Gesture (Multitouch)
  // ============================================================

  private startPinchGesture() {
    // Cancel any in-progress tool interaction without committing (prevents "dot" artifacts).
    if (this.gestureState === "drawing") this.cancelActiveToolInteraction();
    if (this.gestureState === "panning" && this.primaryPointerId !== null) {
      this.safeReleasePointerCapture(this.primaryPointerId);
    }
    if (this.pendingTouchDraw) this.cancelPendingTouchDraw();

    this.gestureState = "pinching";
    this.primaryPointerId = null;
    bus.emit(Events.PINCH_GESTURE_START, undefined);

    // Initialize pinch state from current touches
    const touches = Array.from(this.activePointers.values());
    if (touches.length >= 2) {
      this.lastPinchDistance = this.getDistance(touches[0], touches[1]);
      this.lastPinchCenter = this.getCenter(touches[0], touches[1]);
      this.lastPinchAngle = this.getAngle(touches[0], touches[1]);
    }
  }

  private updatePinchGesture() {
    if (this.gestureState !== "pinching") return;

    const touches = Array.from(this.activePointers.values());
    if (touches.length < 2) return;

    const currentDistance = this.getDistance(touches[0], touches[1]);
    const currentCenter = this.getCenter(touches[0], touches[1]);
    const currentAngle = this.getAngle(touches[0], touches[1]);

    // Pinch zoom - only update lastPinchDistance when we actually fire the callback
    if (this.lastPinchDistance !== null) {
      const zoomFactor = currentDistance / this.lastPinchDistance;
      if (Math.abs(zoomFactor - 1) > 0.01) {
        bus.emit(Events.CAMERA_ZOOM, {
          factor: zoomFactor,
          x: currentCenter.x,
          y: currentCenter.y,
        });
        this.lastPinchDistance = currentDistance;
      }
    } else {
      this.lastPinchDistance = currentDistance;
    }

    // Two-finger pan - only update lastPinchCenter when we actually fire the callback
    if (this.lastPinchCenter !== null) {
      const deltaX = currentCenter.x - this.lastPinchCenter.x;
      const deltaY = currentCenter.y - this.lastPinchCenter.y;
      if (Math.abs(deltaX) > 0.5 || Math.abs(deltaY) > 0.5) {
        bus.emit(Events.CAMERA_PAN, { deltaX, deltaY });
        this.lastPinchCenter = currentCenter;
      }
    } else {
      this.lastPinchCenter = currentCenter;
    }

    // Two-finger rotation - only update lastPinchAngle when we actually fire the callback
    if (this.lastPinchAngle !== null) {
      let deltaAngle = currentAngle - this.lastPinchAngle;
      // Normalize to [-PI, PI]
      if (deltaAngle > Math.PI) deltaAngle -= 2 * Math.PI;
      if (deltaAngle < -Math.PI) deltaAngle += 2 * Math.PI;

      if (Math.abs(deltaAngle) > 0.01) {
        bus.emit(Events.CAMERA_ROTATE, { delta: deltaAngle, x: currentCenter.x, y: currentCenter.y });
        this.lastPinchAngle = currentAngle;
      }
    } else {
      this.lastPinchAngle = currentAngle;
    }
  }

  private endPinchGesture() {
    bus.emit(Events.PINCH_GESTURE_END, undefined);

    this.gestureState = "idle";
    this.lastPinchDistance = null;
    this.lastPinchCenter = null;
    this.lastPinchAngle = null;
    this.updateCanvasCursor();
  }

  // ============================================================
  // Touch draw deferral + cancellation helpers
  // ============================================================

  private startPendingTouchDraw(e: PointerEvent, screenCoords: { x: number; y: number }) {
    if (this.gestureState !== "idle") return;

    // Do not start a stroke yet; wait for movement threshold.
    this.primaryPointerId = e.pointerId;
    this.pendingTouchDraw = {
      pointerId: e.pointerId,
      startScreenX: screenCoords.x,
      startScreenY: screenCoords.y,
      startTimeMs: performance.now(),
      lastClientX: e.clientX,
      lastClientY: e.clientY,
      lastPressure: e.pressure || undefined,
    };

    // Still update cursor position for feedback.
    const point = this.normalizePoint(e.clientX, e.clientY, e.pressure);
    bus.emit(Events.POINTER_MOVE, point);
  }

  private maybeCommitPendingTouchDraw(e: PointerEvent, screenCoords: { x: number; y: number }) {
    if (!this.pendingTouchDraw) return;
    if (this.primaryPointerId !== e.pointerId) return;

    this.pendingTouchDraw.lastClientX = e.clientX;
    this.pendingTouchDraw.lastClientY = e.clientY;
    this.pendingTouchDraw.lastPressure = e.pressure || undefined;

    const dx = screenCoords.x - this.pendingTouchDraw.startScreenX;
    const dy = screenCoords.y - this.pendingTouchDraw.startScreenY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    const elapsed = performance.now() - this.pendingTouchDraw.startTimeMs;

    // Commit conditions:
    // - either a larger motion immediately, or
    // - a smaller motion after a short grace period (lets users add a 2nd finger without drawing)
    const shouldCommit =
      dist >= this.touchDrawCommitDistancePx * 2 ||
      (dist >= this.touchDrawCommitDistancePx && elapsed >= this.touchDrawCommitDelayMs);

    if (!shouldCommit) {
      // Not committed yet; just move cursor.
      const point = this.normalizePoint(e.clientX, e.clientY, e.pressure);
      bus.emit(Events.POINTER_MOVE, point);
      return;
    }

    // Commit to a real stroke starting at the *current* position (avoids dot on gesture start).
    const pointerId = this.pendingTouchDraw.pointerId;
    this.pendingTouchDraw = null;

    this.gestureState = "drawing";
    this.primaryPointerId = pointerId;
    this.canvas.setPointerCapture(pointerId);

    this.lastPressure = null; // Reset for fresh stroke
    const point = this.normalizePoint(e.clientX, e.clientY, e.pressure);
    bus.emit(Events.TOOL_START, { point, tool: this.currentTool });
    bus.emit(Events.POINTER_MOVE, point);
  }

  private cancelPendingTouchDraw() {
    this.pendingTouchDraw = null;
    this.primaryPointerId = null;
    this.lastPressure = null;
  }

  private cancelActiveToolInteraction() {
    if (this.gestureState !== "drawing") return;

    if (this.primaryPointerId !== null) {
      this.safeReleasePointerCapture(this.primaryPointerId);
    }

    // Cancel without committing (no trace / no dot)
    bus.emit(Events.TOOL_CANCEL, this.currentTool);

    this.gestureState = "idle";
    this.primaryPointerId = null;
    this.lastPressure = null;
    this.updateCanvasCursor();
  }

  private safeReleasePointerCapture(pointerId: number) {
    try {
      // Can throw if capture was never set or already released
      this.canvas.releasePointerCapture(pointerId);
    } catch {
      // ignore
    }
  }

  // ============================================================
  // Coordinate Helpers
  // ============================================================

  private getScreenCoords(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  private normalizePoint(
    clientX: number,
    clientY: number,
    rawPressure?: number
  ): Point {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    // Map to pixel canvas coordinates
    const pixelX = (x / this.config.viewportWidth) * this.config.pixelWidth;
    const pixelY = (y / this.config.viewportHeight) * this.config.pixelHeight;

    return {
      x: pixelX,
      y: pixelY,
      pressure: this.sanitizePressure(rawPressure),
    };
  }

  private sanitizePressure(raw: number | undefined): number {
    if (typeof raw !== "number" || Number.isNaN(raw)) {
      return this.lastPressure ?? 0.5;
    }

    let p = Math.max(0, Math.min(1, raw));

    if (p < this.pressureDeadzone) {
      p = this.lastPressure ?? 0; // Mid-stroke: use last. Stroke start: use 0
    } else {
      p = (p - this.pressureDeadzone) / (1.0 - this.pressureDeadzone);
    }

    this.lastPressure = p;
    return p;
  }

  private createPointerInfo(e: PointerEvent): PointerInfo {
    const screenCoords = this.getScreenCoords(e);
    return {
      id: e.pointerId,
      x: screenCoords.x,
      y: screenCoords.y,
      pressure: e.pressure,
      pointerType: e.pointerType as "mouse" | "touch" | "pen",
      button: e.button,
    };
  }

  // ============================================================
  // Geometry Helpers (for multitouch)
  // ============================================================

  private getDistance(
    p1: { x: number; y: number },
    p2: { x: number; y: number }
  ): number {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private getCenter(
    p1: { x: number; y: number },
    p2: { x: number; y: number }
  ): { x: number; y: number } {
    return {
      x: (p1.x + p2.x) / 2,
      y: (p1.y + p2.y) / 2,
    };
  }

  private getAngle(
    p1: { x: number; y: number },
    p2: { x: number; y: number }
  ): number {
    return Math.atan2(p2.y - p1.y, p2.x - p1.x);
  }

  // ============================================================
  // Canvas Cursor
  // ============================================================

  private updateCanvasCursor() {
    if (this.gestureState === "panning") {
      this.canvas.style.cursor = "grabbing";
      return;
    }
    switch (this.currentTool) {
      case "pan":
        this.canvas.style.cursor = "grab";
        break;
      case "select":
        this.canvas.style.cursor = "default";
        break;
      case "eyedropper":
        this.canvas.style.cursor = "copy";
        break;
      case "brush":
      case "lasso":
      case "rect":
      case "circle":
      case "magnet":
        this.canvas.style.cursor = getDrawingCrosshairCursorCss();
        break;
      default:
        this.canvas.style.cursor = getDrawingCrosshairCursorCss();
    }
  }

  // ============================================================
  // Cleanup
  // ============================================================

  destroy() {
    // Remove pointer listeners
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerCancel);
    this.canvas.removeEventListener("pointerleave", this.handlePointerLeave);

    // Remove keyboard listeners
    document.removeEventListener("keydown", this.handleKeyDown);
    document.removeEventListener("keyup", this.handleKeyUp);
    window.removeEventListener("blur", this.handleWindowBlur);
  }
}
