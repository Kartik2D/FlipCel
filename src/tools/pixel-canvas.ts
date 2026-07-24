/**
 * Pixel Canvas - Low-Resolution Drawing Surface
 *
 * Manages the low-resolution pixel canvas where strokes are temporarily drawn.
 * Acts as a context provider for tool behavior hooks.
 *
 * Key characteristics:
 * - Internal resolution: ~64-128px (auto-calculated, ~8x downscale from viewport)
 * - Display size: Full viewport (scaled up via CSS with image-rendering: pixelated)
 * - Purpose: Temporary drawing surface that gets cleared after successful tracing
 *
 * Key responsibilities:
 * - Provides ToolContext for tool behavior hooks
 * - Manages shared stroke state
 * - Provides ImageData for potrace conversion
 * - Clears canvas after successful vector tracing
 */
import type { Point, CanvasConfig } from "../geometry/types";
import type { ToolContext, ToolDefinition, ToolId, AllToolSettings } from "./registry";
import { getTool } from "./registry";

export class PixelCanvas {
  private ctx: CanvasRenderingContext2D;
  private config: CanvasConfig;
  private currentStroke: Point[] = [];
  private brushColor = "#000000";

  // Tool context shared with tool behavior hooks
  private toolContext: ToolContext;

  constructor(
    _canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    config: CanvasConfig
  ) {
    this.ctx = ctx;
    this.config = config;

    // Set up canvas context defaults
    this.ctx.fillStyle = this.brushColor;
    this.ctx.strokeStyle = this.brushColor;
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";

    // Create tool context
    this.toolContext = {
      ctx: this.ctx,
      stroke: this.currentStroke,
      clear: () => this.clear(),
      config: { pixelWidth: config.pixelWidth, pixelHeight: config.pixelHeight },
    };
  }

  updateConfig(config: CanvasConfig) {
    this.config = config;
    this.ctx.canvas.width = config.pixelWidth;
    this.ctx.canvas.height = config.pixelHeight;
    this.ctx.imageSmoothingEnabled = false;
    // Re-apply styles after canvas resize (resizing resets context state)
    this.ctx.fillStyle = this.brushColor;
    this.ctx.strokeStyle = this.brushColor;
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";

    // Update tool context config
    this.toolContext.config = {
      pixelWidth: config.pixelWidth,
      pixelHeight: config.pixelHeight,
    };
  }

  /**
   * Set the brush color for the drawing preview.
   * Note: The tracer only uses alpha for path extraction, but we display
   * the actual color so users can see what they're drawing.
   */
  setBrushColor(color: string) {
    this.brushColor = color;
    this.ctx.fillStyle = color;
    this.ctx.strokeStyle = color;
  }

  getBrushColor(): string {
    return this.brushColor;
  }

  // ============================================================
  // Tool Behavior Delegation
  // ============================================================

  /**
   * Start a tool action - delegates to tool.onStart
   */
  startTool(toolId: ToolId, point: Point, settings: AllToolSettings) {
    const tool = getTool(toolId) as ToolDefinition;
    const toolSettings = settings[toolId] as Record<string, unknown>;
    tool.onStart(this.toolContext, point, toolSettings as never);
  }

  /**
   * Continue a tool action - delegates to tool.onMove
   */
  moveTool(toolId: ToolId, point: Point, settings: AllToolSettings) {
    const tool = getTool(toolId) as ToolDefinition;
    const toolSettings = settings[toolId] as Record<string, unknown>;
    tool.onMove(this.toolContext, point, toolSettings as never);
  }

  /**
   * End a tool action - delegates to tool.onEnd
   */
  endTool(toolId: ToolId, settings: AllToolSettings): { points: Point[] } | null {
    const tool = getTool(toolId) as ToolDefinition;
    const toolSettings = settings[toolId] as Record<string, unknown>;
    return tool.onEnd(this.toolContext, toolSettings as never);
  }

  // ============================================================
  // Legacy API (for backwards compatibility during transition)
  // ============================================================

  /**
   * @deprecated Use startTool instead
   */
  startStroke(point: Point) {
    this.currentStroke = [point];
    this.toolContext.stroke = this.currentStroke;
    this.drawPoint(point, 4);
  }

  /**
   * @deprecated Use moveTool instead
   */
  addPoint(point: Point, sizeMin = 1, sizeMax = 4) {
    if (this.currentStroke.length === 0) {
      this.currentStroke = [point];
      this.toolContext.stroke = this.currentStroke;
      this.drawPoint(point, sizeMax);
      return;
    }

    const lastPoint = this.currentStroke[this.currentStroke.length - 1];
    this.currentStroke.push(point);

    const pressure = point.pressure ?? 1;
    const size = sizeMin + pressure * (sizeMax - sizeMin);

    this.ctx.beginPath();
    this.ctx.moveTo(lastPoint.x, lastPoint.y);
    this.ctx.lineWidth = size;
    this.ctx.lineTo(point.x, point.y);
    this.ctx.stroke();

    this.ctx.beginPath();
    this.ctx.arc(point.x, point.y, size / 2, 0, Math.PI * 2);
    this.ctx.fill();
  }

  private drawPoint(point: Point, size: number) {
    this.ctx.beginPath();
    this.ctx.arc(point.x, point.y, size / 2, 0, Math.PI * 2);
    this.ctx.fill();
  }

  /**
   * @deprecated Use endTool instead
   */
  endStroke(): { points: Point[] } | null {
    if (this.currentStroke.length === 0) {
      return null;
    }

    const stroke = { points: [...this.currentStroke] };
    this.currentStroke = [];
    this.toolContext.stroke = this.currentStroke;
    return stroke;
  }

  /**
   * @deprecated Use startTool with lasso instead
   */
  startLasso(point: Point) {
    this.currentStroke = [point];
    this.toolContext.stroke = this.currentStroke;
    this.drawLassoShape();
  }

  /**
   * @deprecated Use moveTool with lasso instead
   */
  addLassoPoint(point: Point) {
    if (this.currentStroke.length === 0) {
      this.currentStroke = [point];
      this.toolContext.stroke = this.currentStroke;
      this.drawLassoShape();
      return;
    }

    this.currentStroke.push(point);
    this.drawLassoShape();
  }

  private drawLassoShape() {
    this.clear();

    if (this.currentStroke.length < 2) {
      if (this.currentStroke.length === 1) {
        this.ctx.beginPath();
        this.ctx.arc(this.currentStroke[0].x, this.currentStroke[0].y, 1, 0, Math.PI * 2);
        this.ctx.fill();
      }
      return;
    }

    this.ctx.beginPath();
    this.ctx.moveTo(this.currentStroke[0].x, this.currentStroke[0].y);

    for (let i = 1; i < this.currentStroke.length; i++) {
      this.ctx.lineTo(this.currentStroke[i].x, this.currentStroke[i].y);
    }

    this.ctx.closePath();
    this.ctx.fill();
  }

  /**
   * @deprecated Use endTool with lasso instead
   */
  endLasso(): { points: Point[] } | null {
    if (this.currentStroke.length < 3) {
      this.currentStroke = [];
      this.toolContext.stroke = this.currentStroke;
      this.clear();
      return null;
    }

    const stroke = { points: [...this.currentStroke] };
    this.currentStroke = [];
    this.toolContext.stroke = this.currentStroke;
    return stroke;
  }

  // ============================================================
  // Utility Methods
  // ============================================================

  clear() {
    this.ctx.clearRect(0, 0, this.config.pixelWidth, this.config.pixelHeight);
  }

  getImageData(): ImageData {
    return this.ctx.getImageData(0, 0, this.config.pixelWidth, this.config.pixelHeight);
  }
}
