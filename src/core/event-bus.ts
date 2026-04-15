/**
 * Event Bus
 *
 * A simple publish-subscribe pattern for decoupling components.
 * Allows different parts of the application to communicate without
 * direct dependencies on each other.
 */

type Handler<T = unknown> = (data: T) => void;

class EventBus {
  private handlers = new Map<string, Set<Handler>>();

  /**
   * Subscribe to an event
   * @returns Unsubscribe function
   */
  on<T>(event: string, handler: Handler<T>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as Handler);
    return () => this.handlers.get(event)?.delete(handler as Handler);
  }

  /**
   * Emit an event with data
   */
  emit<T>(event: string, data: T): void {
    this.handlers.get(event)?.forEach((h) => h(data));
  }

  /**
   * Remove all handlers for an event
   */
  off(event: string): void {
    this.handlers.delete(event);
  }

  /**
   * Remove all handlers for all events
   */
  clear(): void {
    this.handlers.clear();
  }
}

// Singleton instance
export const bus = new EventBus();

// Event name constants for type safety
export const Events = {
  // Tool lifecycle events
  TOOL_START: "tool:start",
  TOOL_MOVE: "tool:move",
  TOOL_END: "tool:end",
  TOOL_CANCEL: "tool:cancel",

  // Pointer events
  POINTER_MOVE: "pointer:move",

  // Camera events
  CAMERA_PAN: "camera:pan",
  CAMERA_ZOOM: "camera:zoom",
  CAMERA_ROTATE: "camera:rotate",

  /** Two-finger pinch began (cancel rotation snap-back, etc.). */
  PINCH_GESTURE_START: "input:pinch-start",
  /** Two-finger pinch ended (e.g. snap rotation near 0). */
  PINCH_GESTURE_END: "input:pinch-end",

  // Tool/modifier changes
  TOOL_CHANGE: "tool:change",
  MODIFIERS_CHANGE: "modifiers:change",

  // History events
  UNDO: "history:undo",
  REDO: "history:redo",
} as const;

// Type for event names
export type EventName = (typeof Events)[keyof typeof Events];

