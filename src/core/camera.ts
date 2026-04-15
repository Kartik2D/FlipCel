/**
 * Camera - Viewport Transformation Manager
 *
 * Manages the camera state for infinite canvas functionality:
 * - Position (pan offset in world coordinates)
 * - Zoom level (scale factor)
 * - Rotation (angle in radians)
 * - Coordinate transformations between screen and world space
 *
 * **Smoothing:** Target vs present poses; during **two-finger pinch** the present pose eases toward
 * target each frame. All other inputs (wheel, UI, single-pointer pan) keep present locked to target.
 *
 * Transformation (screen to world) uses the **present** pose so the drawn view matches picking.
 */

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
  rotation: number;
}

export interface Point2D {
  x: number;
  y: number;
}

function normalizeAngle(rad: number): number {
  return Math.atan2(Math.sin(rad), Math.cos(rad));
}

function lerpAngle(from: number, to: number, t: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return normalizeAngle(from + d * t);
}

export class Camera {
  /** Present — used for getTransformMatrix, screenToWorld, worldToScreen */
  private x = 0;
  private y = 0;
  private _zoom = 1;
  private _rotation = 0;

  /** Target — updated immediately by pan / zoom / rotate */
  private targetX = 0;
  private targetY = 0;
  private targetZoom = 1;
  private targetRotation = 0;

  private minZoom = 0.1;
  private maxZoom = 3;

  private viewportWidth = 0;
  private viewportHeight = 0;

  /** Higher = snappier follow (1/s time constant scale). Lower = gentler pinch easing. */
  private readonly lerpLambda = 50;

  /** When true (two-finger pinch), `stepLerp` eases present toward target; otherwise present matches target. */
  private pinchViewEasing = false;

  constructor(viewportWidth: number, viewportHeight: number) {
    this.viewportWidth = viewportWidth;
    this.viewportHeight = viewportHeight;
    const cx = viewportWidth / 2;
    const cy = viewportHeight / 2;
    this.x = cx;
    this.y = cy;
    this.targetX = cx;
    this.targetY = cy;
  }

  updateViewport(width: number, height: number): void {
    this.viewportWidth = width;
    this.viewportHeight = height;
  }

  /**
   * Enable view easing only during multitouch pinch; disabling snaps present to target immediately.
   */
  setPinchViewEasing(active: boolean): void {
    this.pinchViewEasing = active;
    if (!active) {
      this.syncPresentToTarget();
    }
  }

  get zoom(): number {
    return this._zoom;
  }

  set zoom(value: number) {
    const z = Math.max(this.minZoom, Math.min(this.maxZoom, value));
    this._zoom = z;
    this.targetZoom = z;
  }

  get rotation(): number {
    return this.targetRotation;
  }

  set rotation(value: number) {
    const r = normalizeAngle(value);
    this._rotation = r;
    this.targetRotation = r;
  }

  getRotationDegrees(): number {
    return (this.targetRotation * 180) / Math.PI;
  }

  setRotationDegrees(degrees: number): void {
    this.rotation = (degrees * Math.PI) / 180;
  }

  getPosition(): Point2D {
    return { x: this.x, y: this.y };
  }

  setPosition(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.targetX = x;
    this.targetY = y;
  }

  getState(): CameraState {
    return {
      x: this.targetX,
      y: this.targetY,
      zoom: this.targetZoom,
      rotation: this.targetRotation,
    };
  }

  setState(state: CameraState): void {
    const z = Math.max(this.minZoom, Math.min(this.maxZoom, state.zoom));
    const r = normalizeAngle(state.rotation);
    this.x = state.x;
    this.y = state.y;
    this._zoom = z;
    this._rotation = r;
    this.targetX = state.x;
    this.targetY = state.y;
    this.targetZoom = z;
    this.targetRotation = r;
  }

  /**
   * Copy present pose to match target (e.g. end of a precise animation).
   */
  syncPresentToTarget(): void {
    this.x = this.targetX;
    this.y = this.targetY;
    this._zoom = this.targetZoom;
    this._rotation = this.targetRotation;
  }

  /** Keep zoom lerping; snap pan + rotation to target (e.g. during rotation snap animation). */
  syncPresentPanRotationFromTarget(): void {
    this.x = this.targetX;
    this.y = this.targetY;
    this._rotation = this.targetRotation;
  }

  /**
   * Exponential smoothing toward target (call once per frame).
   */
  stepLerp(dtSeconds: number): void {
    if (dtSeconds <= 0 || !Number.isFinite(dtSeconds)) return;
    if (!this.pinchViewEasing) {
      this.syncPresentToTarget();
      return;
    }
    const k = 1 - Math.exp(-this.lerpLambda * Math.min(dtSeconds, 0.25));
    this.x += (this.targetX - this.x) * k;
    this.y += (this.targetY - this.y) * k;
    this._zoom += (this.targetZoom - this._zoom) * k;
    this._rotation = lerpAngle(this._rotation, this.targetRotation, k);
  }

  screenToWorld(screenX: number, screenY: number): Point2D {
    const offsetX = screenX - this.viewportWidth / 2;
    const offsetY = screenY - this.viewportHeight / 2;
    const scaledX = offsetX / this._zoom;
    const scaledY = offsetY / this._zoom;
    const cos = Math.cos(-this._rotation);
    const sin = Math.sin(-this._rotation);
    const rotatedX = scaledX * cos - scaledY * sin;
    const rotatedY = scaledX * sin + scaledY * cos;
    return {
      x: rotatedX + this.x,
      y: rotatedY + this.y,
    };
  }

  private screenToWorldWith(
    camX: number,
    camY: number,
    zoom: number,
    rot: number,
    screenX: number,
    screenY: number,
  ): Point2D {
    const offsetX = screenX - this.viewportWidth / 2;
    const offsetY = screenY - this.viewportHeight / 2;
    const scaledX = offsetX / zoom;
    const scaledY = offsetY / zoom;
    const cos = Math.cos(-rot);
    const sin = Math.sin(-rot);
    const rotatedX = scaledX * cos - scaledY * sin;
    const rotatedY = scaledX * sin + scaledY * cos;
    return {
      x: rotatedX + camX,
      y: rotatedY + camY,
    };
  }

  worldToScreen(worldX: number, worldY: number): Point2D {
    const offsetX = worldX - this.x;
    const offsetY = worldY - this.y;
    const cos = Math.cos(this._rotation);
    const sin = Math.sin(this._rotation);
    const rotatedX = offsetX * cos - offsetY * sin;
    const rotatedY = offsetX * sin + offsetY * cos;
    const scaledX = rotatedX * this._zoom;
    const scaledY = rotatedY * this._zoom;
    return {
      x: scaledX + this.viewportWidth / 2,
      y: scaledY + this.viewportHeight / 2,
    };
  }

  screenDeltaToWorld(deltaX: number, deltaY: number): Point2D {
    const scaledX = deltaX / this._zoom;
    const scaledY = deltaY / this._zoom;
    const cos = Math.cos(-this._rotation);
    const sin = Math.sin(-this._rotation);
    return {
      x: scaledX * cos - scaledY * sin,
      y: scaledX * sin + scaledY * cos,
    };
  }

  pan(screenDeltaX: number, screenDeltaY: number): void {
    const worldDelta = this.screenDeltaToWorld(screenDeltaX, screenDeltaY);
    this.targetX -= worldDelta.x;
    this.targetY -= worldDelta.y;
  }

  zoomAt(factor: number, screenX: number, screenY: number): void {
    const worldBefore = this.screenToWorldWith(
      this.targetX,
      this.targetY,
      this.targetZoom,
      this.targetRotation,
      screenX,
      screenY,
    );
    let newZoom = this.targetZoom * factor;
    newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, newZoom));
    const worldAfter = this.screenToWorldWith(
      this.targetX,
      this.targetY,
      newZoom,
      this.targetRotation,
      screenX,
      screenY,
    );
    this.targetX += worldBefore.x - worldAfter.x;
    this.targetY += worldBefore.y - worldAfter.y;
    this.targetZoom = newZoom;
  }

  zoomCenter(factor: number): void {
    this.zoomAt(factor, this.viewportWidth / 2, this.viewportHeight / 2);
  }

  rotateAt(deltaRadians: number, screenX: number, screenY: number): void {
    const worldBefore = this.screenToWorldWith(
      this.targetX,
      this.targetY,
      this.targetZoom,
      this.targetRotation,
      screenX,
      screenY,
    );
    const newRot = normalizeAngle(this.targetRotation + deltaRadians);
    const worldAfter = this.screenToWorldWith(
      this.targetX,
      this.targetY,
      this.targetZoom,
      newRot,
      screenX,
      screenY,
    );
    this.targetX += worldBefore.x - worldAfter.x;
    this.targetY += worldBefore.y - worldAfter.y;
    this.targetRotation = newRot;
  }

  rotateCenter(deltaRadians: number): void {
    this.rotateAt(deltaRadians, this.viewportWidth / 2, this.viewportHeight / 2);
  }

  rotateCenterDegrees(deltaDegrees: number): void {
    this.rotateCenter((deltaDegrees * Math.PI) / 180);
  }

  reset(): void {
    const cx = this.viewportWidth / 2;
    const cy = this.viewportHeight / 2;
    this.x = cx;
    this.y = cy;
    this._zoom = 1;
    this._rotation = 0;
    this.targetX = cx;
    this.targetY = cy;
    this.targetZoom = 1;
    this.targetRotation = 0;
  }

  resetRotation(): void {
    this._rotation = 0;
    this.targetRotation = 0;
  }

  fitToBounds(
    bounds: { x: number; y: number; width: number; height: number },
    padding = 0.1,
  ): void {
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    const paddedWidth = bounds.width * (1 + padding * 2);
    const paddedHeight = bounds.height * (1 + padding * 2);
    const zoomX = this.viewportWidth / paddedWidth;
    const zoomY = this.viewportHeight / paddedHeight;
    const z = Math.max(this.minZoom, Math.min(this.maxZoom, Math.min(zoomX, zoomY)));
    this.x = cx;
    this.y = cy;
    this._zoom = z;
    this._rotation = 0;
    this.targetX = cx;
    this.targetY = cy;
    this.targetZoom = z;
    this.targetRotation = 0;
  }

  getWorldBounds(): { x: number; y: number; width: number; height: number } {
    const corners = [
      this.screenToWorld(0, 0),
      this.screenToWorld(this.viewportWidth, 0),
      this.screenToWorld(this.viewportWidth, this.viewportHeight),
      this.screenToWorld(0, this.viewportHeight),
    ];
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const corner of corners) {
      minX = Math.min(minX, corner.x);
      minY = Math.min(minY, corner.y);
      maxX = Math.max(maxX, corner.x);
      maxY = Math.max(maxY, corner.y);
    }
    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  getTransformMatrix(): [number, number, number, number, number, number] {
    const cos = Math.cos(this._rotation);
    const sin = Math.sin(this._rotation);
    const z = this._zoom;
    const a = z * cos;
    const b = z * sin;
    const c = -z * sin;
    const d = z * cos;
    const tx = -this.x * a - this.y * c + this.viewportWidth / 2;
    const ty = -this.x * b - this.y * d + this.viewportHeight / 2;
    return [a, b, c, d, tx, ty];
  }

  getInverseTransformMatrix(): [number, number, number, number, number, number] {
    const cos = Math.cos(-this._rotation);
    const sin = Math.sin(-this._rotation);
    const invZ = 1 / this._zoom;
    const a = invZ * cos;
    const b = invZ * sin;
    const c = -invZ * sin;
    const d = invZ * cos;
    const centerX = this.viewportWidth / 2;
    const centerY = this.viewportHeight / 2;
    const tx = -centerX * a - centerY * c + this.x;
    const ty = -centerX * b - centerY * d + this.y;
    return [a, b, c, d, tx, ty];
  }

  getZoomPercent(): number {
    return Math.round(this.targetZoom * 100);
  }
}
