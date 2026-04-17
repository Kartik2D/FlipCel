/**
 * Direct Select Controller
 *
 * Simple model:
 *
 *   While the direct-select tool is active, EVERY anchor on the active layer
 *   is exposed. There is no "which shapes show anchors" derivation — it's
 *   always all of them.
 *
 *   The only state the tool holds is:
 *     pickedAnchors : Set<AnchorKey>   — anchors the user selected (click /
 *                                        marquee / lasso). Drag moves these.
 *     anchorHandles : AnchorHandle[]   — cached per-frame, one handle per
 *                                        anchor of every active-layer item.
 *
 *   What gets published to the shared selectionStore:
 *     items owning any picked anchor. Empty when nothing is picked.
 *     That's what the color picker and functions panel operate on.
 */
import type { Point, CanvasConfig } from "./types";
import type { PaperRenderer } from "./paper-renderer";
import type { Camera } from "./camera";
import type { ChromeOverlay } from "./chrome-overlay";
import { configStore, toolSettingsStore, selectionStore } from "./stores";
import paper from "paper";

type AnchorKey = string;

export interface AnchorHandle {
  item: paper.PathItem;
  childIndex: number;
  segmentIndex: number;
  key: AnchorKey;
  x: number;
  y: number;
}

const anchorKey = (itemId: number, childIndex: number, segmentIndex: number): AnchorKey =>
  `${itemId}:${childIndex}:${segmentIndex}`;

const parseAnchorKey = (key: AnchorKey) => {
  const [i, c, s] = key.split(":").map(Number);
  return { itemId: i, childIndex: c, segmentIndex: s };
};

export class DirectSelectController {
  private config: CanvasConfig;
  private paperRenderer: PaperRenderer;
  private camera: Camera;
  private chromeOverlay: ChromeOverlay;
  private chromeCtx: CanvasRenderingContext2D;
  private onSnapshot?: () => void;
  private onReconcile?: (item: paper.PathItem) => paper.PathItem | null;

  private selectionShape: "rect" | "lasso" = "rect";

  private pickedAnchors: Set<AnchorKey> = new Set();
  private anchorHandles: AnchorHandle[] = [];

  private isDraggingAnchor = false;
  private dragStartPoint: Point | null = null;
  private didMoveAnchor = false;

  private marqueeStartPoint: Point | null = null;
  private marqueeCurrentPoint: Point | null = null;
  private lassoPoints: Point[] = [];
  private readonly marqueeDragThresholdPx = 6;

  private lastSelectionViewport: Point | null = null;
  private selectionChangeCallback?: (hasSelection: boolean) => void;

  constructor(
    paperRenderer: PaperRenderer,
    camera: Camera,
    chromeOverlay: ChromeOverlay,
  ) {
    this.paperRenderer = paperRenderer;
    this.camera = camera;
    this.chromeOverlay = chromeOverlay;
    this.chromeCtx = chromeOverlay.getContext();
    this.config = configStore.get();
    configStore.subscribe((config) => {
      this.config = config;
    });
    toolSettingsStore.subscribe((settings) => {
      const directSelectSettings = settings["direct-select"] as { shape?: unknown };
      this.selectionShape = directSelectSettings.shape === "lasso" ? "lasso" : "rect";
    });
  }

  setSnapshotCallback(callback: () => void): void {
    this.onSnapshot = callback;
  }

  setReconcileCallback(callback: (item: paper.PathItem) => paper.PathItem | null): void {
    this.onReconcile = callback;
  }

  onSelectionChange(callback: (hasSelection: boolean) => void): void {
    this.selectionChangeCallback = callback;
  }

  // ============================================================
  // Public API
  // ============================================================

  /** True when the user has picked at least one anchor. */
  hasSelection(): boolean {
    return this.pickedAnchors.size > 0;
  }

  /**
   * True when the tool has any transient UI to draw beyond the baseline
   * "all anchors on the layer" state — i.e. a pick, a drag, or an in-progress
   * marquee. The baseline itself is drawn whenever the tool is active.
   */
  hasTransientUI(): boolean {
    return (
      this.hasSelection() ||
      this.marqueeStartPoint !== null ||
      this.isDraggingAnchor
    );
  }

  getLastSelectionViewport(): Point | null {
    return this.lastSelectionViewport;
  }

  clearSelection(): void {
    this.pickedAnchors.clear();
    this.resetDragState();
    this.resetMarqueeState();
    this.lastSelectionViewport = null;
    selectionStore.set({ items: [] });
    this.drawUI();
  }

  // ============================================================
  // Pointer events
  // ============================================================

  handleStart(point: Point): void {
    const viewportPoint = this.pixelToViewport(point);
    this.rebuildAnchorHandles();

    const hitIdx = this.hitTestAnchor(viewportPoint);
    if (hitIdx !== null) {
      const hit = this.anchorHandles[hitIdx];
      if (!this.pickedAnchors.has(hit.key)) {
        this.pickedAnchors = new Set([hit.key]);
      }
      this.isDraggingAnchor = true;
      this.dragStartPoint = viewportPoint;
      this.didMoveAnchor = false;
      this.publishPickedItems();
      this.drawUI();
      return;
    }

    this.marqueeStartPoint = viewportPoint;
    this.marqueeCurrentPoint = viewportPoint;
    this.lassoPoints = [viewportPoint];
    this.drawUI();
  }

  handleMove(point: Point): void {
    const viewportPoint = this.pixelToViewport(point);

    if (this.marqueeStartPoint) {
      this.marqueeCurrentPoint = viewportPoint;
      if (this.selectionShape === "lasso") {
        this.lassoPoints.push(viewportPoint);
      }
      this.drawUI();
      return;
    }

    if (!this.isDraggingAnchor || !this.dragStartPoint) return;

    const worldPoint = this.camera.screenToWorld(viewportPoint.x, viewportPoint.y);
    const worldStart = this.camera.screenToWorld(this.dragStartPoint.x, this.dragStartPoint.y);
    const dx = worldPoint.x - worldStart.x;
    const dy = worldPoint.y - worldStart.y;

    if (dx !== 0 || dy !== 0) {
      this.didMoveAnchor = true;
      this.moveSelectedAnchors(dx, dy);
      this.dragStartPoint = viewportPoint;
      this.drawUI();
    }
  }

  handleEnd(): void {
    if (this.marqueeStartPoint && this.marqueeCurrentPoint) {
      this.finalizeMarquee();
      this.resetMarqueeState();
      this.drawUI();
      return;
    }

    if (this.isDraggingAnchor && this.didMoveAnchor) {
      this.finalizeAnchorMove();
    }

    this.resetDragState();
    this.drawUI();
  }

  handleCancel(): void {
    this.resetDragState();
    this.resetMarqueeState();
    this.drawUI();
  }

  // ============================================================
  // Drawing
  // ============================================================

  drawUI(): void {
    this.chromeOverlay.clear();
    this.rebuildAnchorHandles();

    const ctx = this.chromeCtx;
    ctx.save();

    // Outline every item that owns at least one picked anchor.
    for (const item of this.getPickedItems()) {
      this.paperRenderer.strokeSelectionShapeOutline(ctx, item);
    }

    // Anchor nodes: black fill, white outline (picked = larger).
    const unpickedR = 3;
    const pickedR = 5;
    for (const h of this.anchorHandles) {
      const isPicked = this.pickedAnchors.has(h.key);
      const r = isPicked ? pickedR : unpickedR;
      ctx.fillStyle = "#000000";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = isPicked ? 2 : 1.5;
      ctx.beginPath();
      ctx.rect(h.x - r, h.y - r, r * 2, r * 2);
      ctx.fill();
      ctx.stroke();
    }

    if (this.marqueeStartPoint && this.marqueeCurrentPoint) {
      if (this.selectionShape === "lasso") {
        this.drawLassoPreview(this.lassoPoints);
      } else {
        this.drawMarqueeRect(this.marqueeStartPoint, this.marqueeCurrentPoint);
      }
    }

    ctx.restore();
  }

  // ============================================================
  // Derived state
  // ============================================================

  /** Items on the active layer that own at least one picked anchor. */
  private getPickedItems(): paper.PathItem[] {
    if (this.pickedAnchors.size === 0) return [];
    const pathById = this.buildPathIndex();
    const items: paper.PathItem[] = [];
    const seen = new Set<number>();
    for (const key of this.pickedAnchors) {
      const { itemId } = parseAnchorKey(key);
      const item = pathById.get(itemId);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    return items;
  }

  private rebuildAnchorHandles(): void {
    const handles: AnchorHandle[] = [];
    const liveKeys = new Set<AnchorKey>();

    for (const item of this.paperRenderer.getAllPaths()) {
      this.forEachSegment(item, (ci, si, seg) => {
        const screen = this.camera.worldToScreen(seg.point.x, seg.point.y);
        const key = anchorKey(item.id, ci, si);
        liveKeys.add(key);
        handles.push({
          item,
          childIndex: ci,
          segmentIndex: si,
          key,
          x: screen.x,
          y: screen.y,
        });
      });
    }
    this.anchorHandles = handles;

    // Drop picks that reference anchors that no longer exist.
    if (this.pickedAnchors.size > 0) {
      const pruned = new Set<AnchorKey>();
      for (const k of this.pickedAnchors) {
        if (liveKeys.has(k)) pruned.add(k);
      }
      if (pruned.size !== this.pickedAnchors.size) {
        this.pickedAnchors = pruned;
      }
    }
  }

  // ============================================================
  // Mutation & finalization
  // ============================================================

  private moveSelectedAnchors(dx: number, dy: number): void {
    const delta = new paper.Point(dx, dy);
    const pathById = this.buildPathIndex();
    for (const key of this.pickedAnchors) {
      const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
      const item = pathById.get(itemId);
      if (!item) continue;
      const seg = this.getChildPaths(item)[childIndex]?.segments[segmentIndex];
      if (!seg) continue;
      seg.point = seg.point.add(delta);
    }
    paper.view.update();
  }

  private finalizeMarquee(): void {
    const matched = this.collectMarqueeMatches();
    const matchedKeys = new Set(matched.map((h) => h.key));

    if (this.hasActiveMarquee()) {
      this.pickedAnchors = matchedKeys;
    } else {
      // Empty click below the drag threshold: clear picks.
      this.pickedAnchors.clear();
    }

    this.publishPickedItems();
  }

  /**
   * Reconcile every item that carried a picked anchor, then remap picks by
   * matching pre-move world positions against segments on whatever is on the
   * layer now. We don't need to track survivors or new items — since every
   * active-layer anchor is exposed automatically, the user always sees the
   * boolean result. Remap is purely about keeping the "picked" set meaningful
   * across the reconcile.
   */
  private finalizeAnchorMove(): void {
    const targets: paper.Point[] = [];
    const pathById = this.buildPathIndex();
    for (const key of this.pickedAnchors) {
      const { itemId, childIndex, segmentIndex } = parseAnchorKey(key);
      const item = pathById.get(itemId);
      if (!item) continue;
      const seg = this.getChildPaths(item)[childIndex]?.segments[segmentIndex];
      if (!seg) continue;
      targets.push(seg.point.clone());
    }

    if (!this.onReconcile) {
      this.onSnapshot?.();
      this.publishPickedItems();
      return;
    }

    const affectedIds = new Set<number>();
    for (const key of this.pickedAnchors) {
      affectedIds.add(parseAnchorKey(key).itemId);
    }
    for (const id of affectedIds) {
      const item = pathById.get(id);
      if (!item || !item.parent) continue;
      this.onReconcile(item);
    }

    const epsilon = 1e-3;
    const newKeys = new Set<AnchorKey>();
    const layerItems = this.paperRenderer.getAllPaths();
    for (const pos of targets) {
      for (const candidate of layerItems) {
        const match = this.findSegmentNear(candidate, pos, epsilon);
        if (match) {
          newKeys.add(anchorKey(candidate.id, match.childIndex, match.segmentIndex));
          break;
        }
      }
    }
    this.pickedAnchors = newKeys;

    this.onSnapshot?.();
    this.publishPickedItems();
  }

  // ============================================================
  // Sync / state helpers
  // ============================================================

  private publishPickedItems(): void {
    const items = this.getPickedItems();
    this.lastSelectionViewport = this.getSelectionAnchorViewport(items);
    selectionStore.set({ items });
    this.selectionChangeCallback?.(items.length > 0);
  }

  private resetDragState(): void {
    this.isDraggingAnchor = false;
    this.dragStartPoint = null;
    this.didMoveAnchor = false;
  }

  private resetMarqueeState(): void {
    this.marqueeStartPoint = null;
    this.marqueeCurrentPoint = null;
    this.lassoPoints = [];
  }

  // ============================================================
  // Hit testing & marquee
  // ============================================================

  private hitTestAnchor(viewportPoint: Point): number | null {
    const hitRadiusSq = 10 * 10;
    for (let i = 0; i < this.anchorHandles.length; i++) {
      const h = this.anchorHandles[i];
      const dx = viewportPoint.x - h.x;
      const dy = viewportPoint.y - h.y;
      if (dx * dx + dy * dy <= hitRadiusSq) return i;
    }
    return null;
  }

  private collectMarqueeMatches(): AnchorHandle[] {
    const handles = this.anchorHandles;

    if (this.selectionShape === "lasso") {
      return handles.filter((h) => this.pointInPolygon({ x: h.x, y: h.y }, this.lassoPoints));
    }
    if (!this.marqueeStartPoint || !this.marqueeCurrentPoint) return [];
    const minX = Math.min(this.marqueeStartPoint.x, this.marqueeCurrentPoint.x);
    const minY = Math.min(this.marqueeStartPoint.y, this.marqueeCurrentPoint.y);
    const maxX = Math.max(this.marqueeStartPoint.x, this.marqueeCurrentPoint.x);
    const maxY = Math.max(this.marqueeStartPoint.y, this.marqueeCurrentPoint.y);
    return handles.filter(
      (h) => h.x >= minX && h.x <= maxX && h.y >= minY && h.y <= maxY,
    );
  }

  private hasActiveMarquee(): boolean {
    if (this.selectionShape === "lasso") {
      if (this.lassoPoints.length < 2) return false;
      const first = this.lassoPoints[0];
      const last = this.lassoPoints[this.lassoPoints.length - 1];
      const dx = last.x - first.x;
      const dy = last.y - first.y;
      return dx * dx + dy * dy >= this.marqueeDragThresholdPx ** 2;
    }
    if (!this.marqueeStartPoint || !this.marqueeCurrentPoint) return false;
    const dx = this.marqueeCurrentPoint.x - this.marqueeStartPoint.x;
    const dy = this.marqueeCurrentPoint.y - this.marqueeStartPoint.y;
    return dx * dx + dy * dy >= this.marqueeDragThresholdPx ** 2;
  }

  private pointInPolygon(point: Point, polygon: Point[]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x,
        yi = polygon[i].y;
      const xj = polygon[j].x,
        yj = polygon[j].y;
      const intersects =
        yi > point.y !== yj > point.y &&
        point.x < ((xj - xi) * (point.y - yi)) / (yj - yi || 1e-6) + xi;
      if (intersects) inside = !inside;
    }
    return inside;
  }

  // ============================================================
  // Path helpers
  // ============================================================

  private buildPathIndex(): Map<number, paper.PathItem> {
    const map = new Map<number, paper.PathItem>();
    for (const p of this.paperRenderer.getAllPaths()) {
      map.set(p.id, p);
    }
    return map;
  }

  private getChildPaths(item: paper.PathItem): paper.Path[] {
    if (item instanceof paper.Path) return [item];
    if (item instanceof paper.CompoundPath) {
      return item.children.filter((c): c is paper.Path => c instanceof paper.Path);
    }
    return [];
  }

  private forEachSegment(
    item: paper.PathItem,
    fn: (childIndex: number, segmentIndex: number, seg: paper.Segment) => void,
  ): void {
    const childPaths = this.getChildPaths(item);
    for (let ci = 0; ci < childPaths.length; ci++) {
      const segs = childPaths[ci].segments;
      for (let si = 0; si < segs.length; si++) {
        fn(ci, si, segs[si]);
      }
    }
  }

  private findSegmentNear(
    item: paper.PathItem,
    worldPoint: paper.Point,
    epsilon: number,
  ): { childIndex: number; segmentIndex: number } | null {
    const eps2 = epsilon * epsilon;
    let bestChild = -1;
    let bestSeg = -1;
    let bestDist2 = Infinity;
    this.forEachSegment(item, (ci, si, seg) => {
      const dx = seg.point.x - worldPoint.x;
      const dy = seg.point.y - worldPoint.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= eps2 && d2 < bestDist2) {
        bestChild = ci;
        bestSeg = si;
        bestDist2 = d2;
      }
    });
    return bestChild >= 0 ? { childIndex: bestChild, segmentIndex: bestSeg } : null;
  }

  // ============================================================
  // Drawing helpers
  // ============================================================

  private drawMarqueeRect(start: Point, end: Point): void {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);

    const ctx = this.chromeCtx;
    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.1)";
    ctx.fillRect(x, y, width, height);
    const dash = [6, 4];
    ctx.setLineDash(dash);
    ctx.lineJoin = "miter";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, width, height);
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, width, height);
    ctx.setLineDash([]);
    ctx.restore();
  }

  private drawLassoPreview(points: Point[]): void {
    if (points.length < 2) return;
    const ctx = this.chromeCtx;
    ctx.save();
    const dash = [6, 4];
    ctx.setLineDash(dash);
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(0, 0, 0, 0.1)";
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  private getSelectionAnchorViewport(items: paper.PathItem[]): Point | null {
    if (items.length === 0) return null;
    const bounds = this.paperRenderer.getCombinedBounds(items);
    if (!bounds) return null;
    return this.camera.worldToScreen(bounds.x + bounds.width, bounds.y);
  }

  private pixelToViewport(point: Point): Point {
    return {
      x: (point.x / this.config.pixelWidth) * this.config.viewportWidth,
      y: (point.y / this.config.pixelHeight) * this.config.viewportHeight,
    };
  }
}
