/**
 * Magnet Controller
 *
 * Soft-drag brush. On pointer down, every segment anchor and bezier handle tip
 * on the active layer whose screen-space position falls within the brush radius
 * is captured with a distance-based falloff weight (smooth raised cosine: 1 at
 * center, 0 at the edge). Each pointer move translates those points by the
 * pointer's world delta scaled by their individual weights.
 *
 * Anchors and handle tips are weighted independently from their own screen
 * positions, so curves deform with the field instead of leaving stale handle
 * directions behind (a common “weird curve” failure mode).
 *
 * Unlike direct-select there is no on-screen vertex display; the only visible
 * feedback is the brush ring owned by FeedbackLayer.
 */
import type { Point, CanvasConfig } from "../geometry/types";
import type { PaperRenderer } from "../render/paper-renderer";
import type { Camera } from "../render/camera";
import { configStore, toolSettingsStore } from "../state/index";
import paper from "paper";
import { pixelToViewport } from "../geometry/coords";

interface CapturedAnchor {
  item: paper.PathItem;
  path: paper.Path;
  segment: paper.Segment;
  /** Smooth falloff weight in [0, 1]; 1 at pointer center, 0 at radius. */
  weight: number;
}

interface CapturedHandle {
  item: paper.PathItem;
  path: paper.Path;
  segment: paper.Segment;
  side: "in" | "out";
  /** Falloff from the handle tip’s screen position. */
  weight: number;
}

export class MagnetController {
  private config: CanvasConfig;
  private paperRenderer: PaperRenderer;
  private camera: Camera;
  private onSnapshot?: () => void;
  private onLiveEditStart?: () => void;
  private onReconcile?: (items: paper.PathItem[]) => void;

  /** Brush diameter in viewport/screen pixels. */
  private size = 120;

  private capturedAnchors: CapturedAnchor[] = [];
  private capturedHandles: CapturedHandle[] = [];
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

  setLiveEditStartCallback(callback: () => void): void {
    this.onLiveEditStart = callback;
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

    this.capturedAnchors = [];
    this.capturedHandles = [];
    this.affectedItems = new Set();

    const weightAt = (worldX: number, worldY: number): number | null => {
      const screen = this.camera.worldToScreen(worldX, worldY);
      const dx = screen.x - viewportPoint.x;
      const dy = screen.y - viewportPoint.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) return null;
      const t = Math.sqrt(d2) / radius;
      // Raised cosine falloff: smooth, 1 at center, 0 at edge.
      return 0.5 * (1 + Math.cos(Math.PI * t));
    };

    for (const item of this.paperRenderer.getAllPaths()) {
      const paths = this.paperRenderer.getChildPaths(item);
      for (const path of paths) {
        for (const seg of path.segments) {
          const anchorWeight = weightAt(seg.point.x, seg.point.y);
          if (anchorWeight !== null) {
            this.capturedAnchors.push({
              item,
              path,
              segment: seg,
              weight: anchorWeight,
            });
            this.affectedItems.add(item);
          }

          if (!seg.handleIn.isZero()) {
            const tip = seg.point.add(seg.handleIn);
            const handleWeight = weightAt(tip.x, tip.y);
            if (handleWeight !== null) {
              this.capturedHandles.push({
                item,
                path,
                segment: seg,
                side: "in",
                weight: handleWeight,
              });
              this.affectedItems.add(item);
            }
          }

          if (!seg.handleOut.isZero()) {
            const tip = seg.point.add(seg.handleOut);
            const handleWeight = weightAt(tip.x, tip.y);
            if (handleWeight !== null) {
              this.capturedHandles.push({
                item,
                path,
                segment: seg,
                side: "out",
                weight: handleWeight,
              });
              this.affectedItems.add(item);
            }
          }
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
      (this.capturedAnchors.length === 0 && this.capturedHandles.length === 0) ||
      !this.lastWorldPoint
    ) {
      return;
    }
    const viewportPoint = pixelToViewport(point, this.config);
    const worldPoint = this.camera.screenToWorld(viewportPoint.x, viewportPoint.y);

    const dx = worldPoint.x - this.lastWorldPoint.x;
    const dy = worldPoint.y - this.lastWorldPoint.y;
    if (dx === 0 && dy === 0) return;

    // Anchor weights for the same segment — used so handle tips move by their
    // own weight in absolute space after the anchor has already moved.
    const anchorWeightBySegment = new Map<paper.Segment, number>();
    for (const c of this.capturedAnchors) {
      if (c.weight <= 0) continue;
      anchorWeightBySegment.set(c.segment, c.weight);
      c.segment.point = new paper.Point(
        c.segment.point.x + dx * c.weight,
        c.segment.point.y + dy * c.weight,
      );
    }

    for (const c of this.capturedHandles) {
      if (c.weight <= 0) continue;
      const anchorWeight = anchorWeightBySegment.get(c.segment) ?? 0;
      // Absolute tip should move by handleWeight * delta. Moving the anchor
      // already carried the tip by anchorWeight * delta, so adjust relative
      // handles by the difference.
      const extra = c.weight - anchorWeight;
      if (extra === 0) continue;
      const hx = dx * extra;
      const hy = dy * extra;
      if (c.side === "in") {
        c.segment.handleIn = new paper.Point(
          c.segment.handleIn.x + hx,
          c.segment.handleIn.y + hy,
        );
      } else {
        c.segment.handleOut = new paper.Point(
          c.segment.handleOut.x + hx,
          c.segment.handleOut.y + hy,
        );
      }
    }

    paper.view.update();

    this.lastWorldPoint = { x: worldPoint.x, y: worldPoint.y };
    if (!this.didMove) {
      this.didMove = true;
      this.onLiveEditStart?.();
    }
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
    this.capturedAnchors = [];
    this.capturedHandles = [];
    this.affectedItems = new Set();
    this.lastWorldPoint = null;
    this.didMove = false;
    this.isActive = false;
  }
}
