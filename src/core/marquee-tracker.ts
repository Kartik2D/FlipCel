import type { Point } from "./types";

export type MarqueeShape = "rect" | "lasso";

export class MarqueeTracker {
  private startPoint: Point | null = null;
  private currentPoint: Point | null = null;
  private lassoPoints: Point[] = [];
  private dragThresholdPx: number;

  constructor(dragThresholdPx = 6) {
    this.dragThresholdPx = dragThresholdPx;
  }

  start(point: Point): void {
    this.startPoint = point;
    this.currentPoint = point;
    this.lassoPoints = [point];
  }

  update(point: Point, shape: MarqueeShape): void {
    if (!this.startPoint) return;
    this.currentPoint = point;
    if (shape === "lasso") this.lassoPoints.push(point);
  }

  reset(): void {
    this.startPoint = null;
    this.currentPoint = null;
    this.lassoPoints = [];
  }

  isTracking(): boolean {
    return this.startPoint !== null && this.currentPoint !== null;
  }

  hasActiveMarquee(shape: MarqueeShape): boolean {
    if (!this.startPoint || !this.currentPoint) return false;
    if (shape === "lasso") {
      if (this.lassoPoints.length < 2) return false;
      const first = this.lassoPoints[0];
      const last = this.lassoPoints[this.lassoPoints.length - 1];
      const dx = last.x - first.x;
      const dy = last.y - first.y;
      return dx * dx + dy * dy >= this.dragThresholdPx * this.dragThresholdPx;
    }
    const dx = this.currentPoint.x - this.startPoint.x;
    const dy = this.currentPoint.y - this.startPoint.y;
    return dx * dx + dy * dy >= this.dragThresholdPx * this.dragThresholdPx;
  }

  getStartPoint(): Point | null {
    return this.startPoint;
  }

  getCurrentPoint(): Point | null {
    return this.currentPoint;
  }

  getLassoPoints(): Point[] {
    return this.lassoPoints;
  }
}
