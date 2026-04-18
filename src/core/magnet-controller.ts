/**
 * Magnet Controller
 *
 * Soft-drag brush. On pointer down, every segment on the active layer whose
 * screen-space anchor falls within the brush radius is captured with a
 * distance-based falloff weight (smooth raised cosine: 1 at center, 0 at the
 * edge). Each pointer move translates those anchors by the pointer's world
 * delta scaled by their individual weights, producing a soft "magnetic"
 * deformation similar to Moho's magnet tool.
 *
 * Unlike direct-select there is no on-screen vertex display; the only visible
 * feedback is the brush ring owned by UIOverlay.
 */
import type { Point, CanvasConfig } from "./types";
import type { PaperRenderer } from "./paper-renderer";
import type { Camera } from "./camera";
import { configStore, toolSettingsStore } from "./stores";
import paper from "paper";
import { pixelToViewport } from "./coords";

interface CapturedAnchor {
  item: paper.PathItem;
  path: paper.Path;
  segment: paper.Segment;
  /** Smooth falloff weight in [0, 1]; 1 at pointer center, 0 at radius. */
  weight: number;
}

export class MagnetController {
  private config: CanvasConfig;
  private paperRenderer: PaperRenderer;
  private camera: Camera;
  private onSnapshot?: () => void;
  private onReconcile?: (items: paper.PathItem[]) => void;

  /** Brush diameter in viewport/screen pixels. */
  private size = 120;

  private captured: CapturedAnchor[] = [];
  private affectedItems: Set<paper.PathItem> = new Set();
  private lastWorldPoint: Point | null = null;
  private didMove = false;
  private isActive = false;

  constructor(paperRenderer: PaperRenderer, camera: Camera) {
    this.paperRenderer = paperRenderer;
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
    applyMagnetSettings(
      toolSettingsStore.get() as unknown as Record<string, unknown>,
    );
    toolSettingsStore.subscribe((settings) => {
      applyMagnetSettings(settings as unknown as Record<string, unknown>);
    });
  }

  setSnapshotCallback(callback: () => void): void {
    this.onSnapshot = callback;
  }

  setReconcileCallback(
    callback: (items: paper.PathItem[]) => void,
  ): void {
    this.onReconcile = callback;
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

    this.captured = [];
    this.affectedItems = new Set();

    for (const item of this.paperRenderer.getAllPaths()) {
      const paths = this.paperRenderer.getChildPaths(item);
      for (const path of paths) {
        for (const seg of path.segments) {
          const screen = this.camera.worldToScreen(seg.point.x, seg.point.y);
          const dx = screen.x - viewportPoint.x;
          const dy = screen.y - viewportPoint.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          const t = Math.sqrt(d2) / radius;
          // Raised cosine falloff: smooth, 1 at center, 0 at edge.
          const weight = 0.5 * (1 + Math.cos(Math.PI * t));
          this.captured.push({ item, path, segment: seg, weight });
          this.affectedItems.add(item);
        }
      }
    }

    this.lastWorldPoint = { x: worldPoint.x, y: worldPoint.y };
    this.didMove = false;
    this.isActive = true;
  }

  handleMove(point: Point): void {
    if (!this.isActive || this.captured.length === 0 || !this.lastWorldPoint) {
      return;
    }
    const viewportPoint = pixelToViewport(point, this.config);
    const worldPoint = this.camera.screenToWorld(viewportPoint.x, viewportPoint.y);

    const dx = worldPoint.x - this.lastWorldPoint.x;
    const dy = worldPoint.y - this.lastWorldPoint.y;
    if (dx === 0 && dy === 0) return;

    for (const c of this.captured) {
      if (c.weight <= 0) continue;
      const wx = dx * c.weight;
      const wy = dy * c.weight;
      c.segment.point = new paper.Point(
        c.segment.point.x + wx,
        c.segment.point.y + wy,
      );
    }
    paper.view.update();

    this.lastWorldPoint = { x: worldPoint.x, y: worldPoint.y };
    this.didMove = true;
  }

  handleEnd(): void {
    if (!this.isActive) return;

    if (this.didMove && this.onReconcile) {
      const affected = [...this.affectedItems].filter((item) => item.parent);
      if (affected.length > 0) this.onReconcile(affected);
    }
    if (this.didMove) {
      this.onSnapshot?.();
    }

    this.resetStroke();
  }

  handleCancel(): void {
    this.resetStroke();
  }

  private resetStroke(): void {
    this.captured = [];
    this.affectedItems = new Set();
    this.lastWorldPoint = null;
    this.didMove = false;
    this.isActive = false;
  }

  // ============================================================
  // Helpers
  // ============================================================

}
