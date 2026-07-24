/**
 * Type Definitions
 *
 * Shared TypeScript interfaces used across all modules:
 * - Point: x, y coordinates with optional pressure (for iPad Pencil)
 * - CanvasConfig: Viewport and pixel canvas dimensions for coordinate mapping
 * - Modifiers: Keyboard modifier key state
 *
 * Note: Tool-related types (DrawTool, DrawMode, ToolSettings) are defined in tools.ts
 */
export interface Point {
  x: number;
  y: number;
  pressure?: number;
}


export interface CanvasConfig {
  pixelWidth: number;
  pixelHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

/**
 * Keyboard modifier key state
 */
export interface Modifiers {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

/**
 * Pointer information for tracking active inputs
 */
export interface PointerInfo {
  id: number;
  x: number;
  y: number;
  pressure: number;
  pointerType: "mouse" | "touch" | "pen";
  button: number;
}
