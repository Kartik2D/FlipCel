/**
 * Magnet Controller
 *
 * Soft-drag brush over the active layer's kernel map. On pointer down, every
 * vertex and every curved edge's control point whose screen position falls
 * within the brush radius is captured with a raised-cosine falloff weight
 * (1 at center, 0 at the edge). Each pointer move translates those points by
 * the pointer's world delta scaled by their weights, through the kernel's
 * `moveVertex` / `curveEdge` so the planar map stays valid.
 *
 * There is no on-screen vertex display; the only visible feedback is the
 * brush ring owned by FeedbackLayer.
 */
import type { Point, CanvasConfig } from "../geometry/types";
import type { StageRenderer } from "../render/stage-renderer";
import type { Camera } from "../render/camera";
import { configStore, modifiersStore, toolSettingsStore } from "../state/index";
import { pixelToViewport } from "../geometry/coords";
import { isConstrainMoveModifierHeld } from "../input/shortcuts";
import { constrainAxisScreenDelta } from "./transform-gizmo";
import type { KernelEdge, Px, VectorLayer } from "../vector/kernel";

interface CapturedVertex {
  /** Current position (as last handed to the kernel). */
  at: Px;
  weight: number;
}

interface CapturedCtrl {
  /** Edge endpoints: kept in sync with vertex moves. */
  a: Px;
  b: Px;
  ctrl: Px;
  weight: number;
}

const EPS = 1e-6;

function samePoint(p: Px, q: Px): boolean {
  return Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) < EPS;
}

export class MagnetController {
  private config: CanvasConfig;
  private renderer: StageRenderer;
  private camera: Camera;
  private onSnapshot?: () => void;
  private onLiveEditStart?: () => void;

  /** Brush diameter in viewport/screen pixels. */
  private size = 120;

  private art: VectorLayer | null = null;
  private layerId: string | null = null;
  private vertices: CapturedVertex[] = [];
  private ctrls: CapturedCtrl[] = [];
  private lastWorldPoint: Point | null = null;
  private didMove = false;
  private isActive = false;

  constructor(renderer: StageRenderer, camera: Camera) {
    this.renderer = renderer;
    this.camera = camera;
    this.config = configStore.get();
    configStore.subscribe((config) => {
      this.config = config;
    });

    const applyMagnetSettings = (settings: Record<string, unknown>) => {
      const magnet = settings["magnet"] as { size?: number } | undefined;
      if (magnet && typeof magnet.size === "number") {
        this.size = magnet.size;
      }
    };
    applyMagnetSettings(toolSettingsStore.get() as unknown as Record<string, unknown>);
    toolSettingsStore.subscribe((settings) => {
      applyMagnetSettings(settings as unknown as Record<string, unknown>);
    });
  }

  setSnapshotCallback(callback: () => void): void {
    this.onSnapshot = callback;
  }

  setLiveEditStartCallback(callback: () => void): void {
    this.onLiveEditStart = callback;
  }

  /** Current brush diameter in viewport/screen pixels. */
  getSizeScreen(): number {
    return this.size;
  }

  hasActiveStroke(): boolean {
    return this.isActive;
  }

  // ============================================================
  // Pointer events
  // ============================================================

  handleStart(point: Point): void {
    const viewportPoint = pixelToViewport(point, this.config);
    const worldPoint = this.camera.screenToWorld(viewportPoint.x, viewportPoint.y);

    const radius = this.size / 2;
    const r2 = radius * radius;

    this.vertices = [];
    this.ctrls = [];
    this.layerId = this.renderer.getActiveLayerId();
    this.art = this.renderer.activeArt();

    const weightAt = (p: Px): number | null => {
      const screen = this.camera.worldToScreen(p.x, p.y);
      const dx = screen.x - viewportPoint.x;
      const dy = screen.y - viewportPoint.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) return null;
      const t = Math.sqrt(d2) / radius;
      // Raised cosine falloff: smooth, 1 at center, 0 at edge.
      return 0.5 * (1 + Math.cos(Math.PI * t));
    };

    if (this.art) {
      for (const v of this.art.vertices()) {
        const w = weightAt(v);
        if (w !== null && w > 0) this.vertices.push({ at: { ...v }, weight: w });
      }
      for (const e of this.art.edges()) {
        if (!e.ctrl) continue;
        const w = weightAt(e.ctrl);
        if (w !== null && w > 0) {
          this.ctrls.push({ a: { ...e.a }, b: { ...e.b }, ctrl: { ...e.ctrl }, weight: w });
        }
      }
    }

    this.lastWorldPoint = { x: worldPoint.x, y: worldPoint.y };
    this.didMove = false;
    this.isActive = true;
  }

  handleMove(point: Point): void {
    if (
      !this.isActive ||
      !this.art ||
      (this.vertices.length === 0 && this.ctrls.length === 0) ||
      !this.lastWorldPoint
    ) {
      return;
    }
    const viewportPoint = pixelToViewport(point, this.config);
    const worldPoint = this.camera.screenToWorld(viewportPoint.x, viewportPoint.y);

    const screenLast = this.camera.worldToScreen(this.lastWorldPoint.x, this.lastWorldPoint.y);
    const screenCur = this.camera.worldToScreen(worldPoint.x, worldPoint.y);
    const constrained = constrainAxisScreenDelta(
      screenCur.x - screenLast.x,
      screenCur.y - screenLast.y,
      isConstrainMoveModifierHeld(modifiersStore.get()),
    );
    if (constrained.x === 0 && constrained.y === 0) return;

    const constrainedWorld = this.camera.screenToWorld(
      screenLast.x + constrained.x,
      screenLast.y + constrained.y,
    );
    const dx = constrainedWorld.x - this.lastWorldPoint.x;
    const dy = constrainedWorld.y - this.lastWorldPoint.y;
    if (dx === 0 && dy === 0) return;

    const art = this.art;
    let changed = false;

    for (const v of this.vertices) {
      const to = { x: v.at.x + dx * v.weight, y: v.at.y + dy * v.weight };
      if (art.moveVertex(v.at, to)) {
        // Keep captured edge endpoints in sync so curveEdge can still find them.
        for (const c of this.ctrls) {
          if (samePoint(c.a, v.at)) c.a = { ...to };
          if (samePoint(c.b, v.at)) c.b = { ...to };
        }
        v.at = to;
        changed = true;
      }
    }

    for (const c of this.ctrls) {
      const to = { x: c.ctrl.x + dx * c.weight, y: c.ctrl.y + dy * c.weight };
      const edge: KernelEdge = { a: c.a, b: c.b, ctrl: c.ctrl };
      if (art.curveEdge(edge, to)) {
        c.ctrl = to;
        changed = true;
      }
    }

    if (changed && this.layerId) {
      this.renderer.markLayerDirty(this.layerId);
      this.renderer.requestRender();
    }

    this.lastWorldPoint = { x: constrainedWorld.x, y: constrainedWorld.y };
    if (changed && !this.didMove) {
      this.didMove = true;
      this.onLiveEditStart?.();
    }
  }

  handleEnd(): void {
    if (!this.isActive) return;
    if (this.didMove) this.onSnapshot?.();
    this.resetStroke();
  }

  handleCancel(): void {
    this.resetStroke();
  }

  private resetStroke(): void {
    this.vertices = [];
    this.ctrls = [];
    this.art = null;
    this.layerId = null;
    this.lastWorldPoint = null;
    this.didMove = false;
    this.isActive = false;
  }
}
