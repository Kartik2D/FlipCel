import type { CanvasConfig, Point } from "./types";

export function pixelToViewport(point: Point, config: CanvasConfig): Point {
  return {
    x: (point.x / config.pixelWidth) * config.viewportWidth,
    y: (point.y / config.pixelHeight) * config.viewportHeight,
    pressure: point.pressure,
  };
}
