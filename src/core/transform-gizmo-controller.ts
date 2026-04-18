import type { Camera } from "./camera";
import type { SelectionHandleId } from "./paper-renderer";
import type { Point } from "./types";

interface ScreenBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TransformGizmoDelegate {
  getScreenBounds(): ScreenBounds | null;
  getRotatePivotWorld(): Point | null;
  applyScale(incSX: number, incSY: number, worldAnchor: Point): void;
  applyRotate(degrees: number, worldPivot: Point): void;
}

export class TransformGizmoController {
  private delegate: TransformGizmoDelegate;
  private activeHandle: SelectionHandleId | null = null;
  private transformAnchorScreen: Point | null = null;
  private transformAnchorWorld: Point | null = null;
  private originalCornerScreen: Point | null = null;
  private lastTotalScaleX = 1;
  private lastTotalScaleY = 1;
  private rotateStartAngle = 0;
  private lastTotalRotation = 0;
  private rotatePivotWorld: Point | null = null;

  constructor(delegate: TransformGizmoDelegate) {
    this.delegate = delegate;
  }

  begin(handle: SelectionHandleId, viewportPoint: Point, camera: Camera): boolean {
    const bounds = this.delegate.getScreenBounds();
    if (!bounds) return false;

    this.activeHandle = handle;
    if (handle === "rotate") {
      const pivotWorld = this.delegate.getRotatePivotWorld();
      if (!pivotWorld) {
        this.reset();
        return false;
      }
      this.rotatePivotWorld = pivotWorld;
      const screenPivot = camera.worldToScreen(pivotWorld.x, pivotWorld.y);
      this.rotateStartAngle = Math.atan2(
        viewportPoint.y - screenPivot.y,
        viewportPoint.x - screenPivot.x,
      );
      this.lastTotalRotation = 0;
      return true;
    }

    const corners: Record<string, Point> = {
      nw: { x: bounds.x, y: bounds.y },
      n: { x: bounds.x + bounds.width / 2, y: bounds.y },
      ne: { x: bounds.x + bounds.width, y: bounds.y },
      e: { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 },
      se: { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
      s: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height },
      sw: { x: bounds.x, y: bounds.y + bounds.height },
      w: { x: bounds.x, y: bounds.y + bounds.height / 2 },
    };
    const opposites: Record<string, string> = {
      nw: "se",
      ne: "sw",
      se: "nw",
      sw: "ne",
      n: "s",
      s: "n",
      e: "w",
      w: "e",
    };

    const anchorScreen = corners[opposites[handle]];
    const worldAnchor = camera.screenToWorld(anchorScreen.x, anchorScreen.y);
    this.originalCornerScreen = corners[handle];
    this.transformAnchorScreen = anchorScreen;
    this.transformAnchorWorld = { x: worldAnchor.x, y: worldAnchor.y };
    this.lastTotalScaleX = 1;
    this.lastTotalScaleY = 1;
    return true;
  }

  update(viewportPoint: Point, camera: Camera): boolean {
    if (!this.activeHandle) return false;

    if (this.activeHandle === "rotate") {
      if (!this.rotatePivotWorld) return false;
      const screenCenter = camera.worldToScreen(
        this.rotatePivotWorld.x,
        this.rotatePivotWorld.y,
      );
      const currentAngle = Math.atan2(
        viewportPoint.y - screenCenter.y,
        viewportPoint.x - screenCenter.x,
      );
      const desiredRotation = currentAngle - this.rotateStartAngle;
      const incrementalRotation = desiredRotation - this.lastTotalRotation;
      if (Math.abs(incrementalRotation) <= 0.0001) return false;
      this.delegate.applyRotate(
        (incrementalRotation * 180) / Math.PI,
        this.rotatePivotWorld,
      );
      this.lastTotalRotation = desiredRotation;
      return true;
    }

    if (
      !this.transformAnchorScreen ||
      !this.transformAnchorWorld ||
      !this.originalCornerScreen
    ) {
      return false;
    }

    const anchor = this.transformAnchorScreen;
    const origCorner = this.originalCornerScreen;
    const isEdgeX = this.activeHandle === "e" || this.activeHandle === "w";
    const isEdgeY = this.activeHandle === "n" || this.activeHandle === "s";

    let desiredSX = this.lastTotalScaleX;
    let desiredSY = this.lastTotalScaleY;

    const dxOrig = origCorner.x - anchor.x;
    const dyOrig = origCorner.y - anchor.y;

    if (!isEdgeY && Math.abs(dxOrig) > 0.001) {
      desiredSX = (viewportPoint.x - anchor.x) / dxOrig;
    }
    if (!isEdgeX && Math.abs(dyOrig) > 0.001) {
      desiredSY = (viewportPoint.y - anchor.y) / dyOrig;
    }

    const minScale = 0.01;
    if (Math.abs(desiredSX) < minScale) {
      desiredSX = desiredSX < 0 ? -minScale : minScale;
    }
    if (Math.abs(desiredSY) < minScale) {
      desiredSY = desiredSY < 0 ? -minScale : minScale;
    }

    const incSX = desiredSX / this.lastTotalScaleX;
    const incSY = desiredSY / this.lastTotalScaleY;
    if (Math.abs(incSX - 1) <= 0.0001 && Math.abs(incSY - 1) <= 0.0001) {
      return false;
    }

    this.delegate.applyScale(incSX, incSY, this.transformAnchorWorld);
    this.lastTotalScaleX = desiredSX;
    this.lastTotalScaleY = desiredSY;
    return true;
  }

  getActiveHandle(): SelectionHandleId | null {
    return this.activeHandle;
  }

  isTransforming(): boolean {
    return this.activeHandle !== null;
  }

  getRotationOverlay(
    camera: Camera,
    cursor: Point | null,
  ): { cursor: Point; pivot: Point } | null {
    if (this.activeHandle !== "rotate" || !this.rotatePivotWorld || !cursor) return null;
    const pivot = camera.worldToScreen(this.rotatePivotWorld.x, this.rotatePivotWorld.y);
    return { cursor, pivot };
  }

  reset(): void {
    this.activeHandle = null;
    this.transformAnchorScreen = null;
    this.transformAnchorWorld = null;
    this.originalCornerScreen = null;
    this.lastTotalScaleX = 1;
    this.lastTotalScaleY = 1;
    this.rotateStartAngle = 0;
    this.lastTotalRotation = 0;
    this.rotatePivotWorld = null;
  }
}
