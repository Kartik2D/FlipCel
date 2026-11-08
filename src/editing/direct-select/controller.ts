/**
 * Direct Select Controller (kernel edition)
 *
 * Edits the active layer's planar map vertex by vertex:
 *
 *   - Click a vertex → pick it (add-modifier extends). Dragging previews the
 *     move in the chrome layer; on release every picked vertex goes through
 *     the kernel's `moveVertex` once, so merge semantics (welding, splitting)
 *     apply only to the final position.
 *   - Click an edge → drag bends it: on release the edge becomes a quadratic
 *     whose curve passes through the pointer (`curveEdge`).
 *   - Drag a control handle (shown for curves at picked vertices) to place
 *     the control directly. Moving a vertex carries its controls along.
 *   - Marquee (rect / lasso) picks vertices inside.
 *   - Click a shape to show its vertices. Click another shape to switch.
 *     Click empty space to hide them.
 *
 * Vertex / corner operations on the picked set:
 *   - delete     : collapse each picked vertex onto a neighbour (removes it).
 *   - simplify   : refit each picked run with as few cubics as fit within a
 *                  world-pixel tolerance (drops redundant vertices); drag
 *                  further for a looser fit and fewer vertices.
 *   - smooth     : refit each picked run as a Catmull-Rom cubic spline
 *                  (vertices stay, every edge becomes a curve).
 *
 * Identity is positional: a picked vertex is its current world position.
 */
import type { Point, CanvasConfig } from "../../geometry/types";
import type { StageRenderer } from "../../render/stage-renderer";
import type { Camera } from "../../render/camera";
import type { ChromeLayer } from "../../render/chrome-layer";
import { scheduler, Surface } from "../../render/frame-scheduler";
import {
  configStore,
  toolSettingsStore,
  selectionStore,
  EMPTY_SELECTION,
  quickShapeEnabledStore,
  quickShapeCurveStyleStore,
  quickShapeShapesEnabledStore,
  quickShapeHoldMsStore,
  modifiersStore,
} from "../../state/index";
import { pixelToViewport } from "../../geometry/coords";
import { LassoQuickShapeSession } from "../../geometry/quick-shape";
import { MarqueeTracker } from "../marquee";
import {
  isAddToSelectionModifierHeld,
  isConstrainMoveModifierHeld,
  isConstrainScaleModifierHeld,
} from "../../input/shortcuts";
import { constrainAxisScreenDelta } from "../transform-gizmo";
import {
  snapLockFromConstrain,
  snapWorldTranslation,
  setSnapGuides,
  type SnapGuide,
} from "../snap";
import { pointInPolygon } from "./geometry";
import { rekeyPicks, simplifyChains, smoothChains, vertexKey as key } from "./refit";
import { ringsToPath2D, type KernelEdge, type Px, type Region, type Ring, type Seg, type VectorLayer } from "../../vector/kernel";

type PathEditKind = "simplify";

const ANCHOR_HIT_PX = 10;
const EDGE_HIT_PX = 8;
const ANCHOR_SIZE = 8;
const DOUBLE_CLICK_MS = 350;
const DOUBLE_CLICK_PX = 6;
/**
 * Kernel positions sit on a 0.05px twip grid, but `vertices()`/`edges()`
 * come back as f32 while `nearestVertex()` is f64, so the same vertex can
 * differ by ~1e-5. Compare well above that and well below half a twip.
 */
const EPS = 1e-3;

/** Simplify fits to within this many world pixels (1.5px = 30 twips). */
const SIMPLIFY_TOL_PX = 1.5;
const SIMPLIFY_TOL_MIN = 0.25;
const SIMPLIFY_TOL_MAX = 25;
/** Smooth handle length as a fraction of the edge chord. */
const SMOOTH_DEFAULT = 1 / 3;

const same = (a: Px, b: Px): boolean => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
const sameEdgeEnds = (e: KernelEdge, f: KernelEdge): boolean =>
  (same(e.a, f.a) && same(e.b, f.b)) || (same(e.a, f.b) && same(e.b, f.a));

interface EdgeDrag {
  edge: KernelEdge;
  /** Pending control point; applied on release. */
  ctrl: Px | null;
  /** True when the control handle itself is being dragged (pointer = control). */
  handle: boolean;
}

/** Edge/vertex readback of one kernel state (see `geometry()`). */
interface LayerGeometry {
  art: VectorLayer;
  digest: bigint;
  edges: KernelEdge[];
  vertices: Px[];
  /** `vertexKey` of each vertex, parallel to `vertices`. */
  keys: string[];
  /** Whether each vertex is picked, parallel to `vertices`. */
  pickedMask: boolean[];
  /** Filled faces of this map. */
  regions: Region[];
}

/** A vertex drag in flight: the kernel is untouched until release. */
interface VertexDrag {
  /** Picked positions when the drag began. */
  starts: Px[];
  /** Edges touching any picked vertex, as they were at drag start. */
  edges: KernelEdge[];
  /** Current (snapped) world offset. */
  offset: Px;
}

export class DirectSelectController {
  private readonly dragMoveThresholdSq = 5 * 5;
  private dragPointerOrigin: Point | null = null;
  private dragPastThreshold = false;

  private config: CanvasConfig;
  private renderer: StageRenderer;
  private camera: Camera;
  private chromeLayer: ChromeLayer;
  private chromeCtx: CanvasRenderingContext2D;
  private onSnapshot?: () => void;
  private onLiveEditStart?: () => void;
  private onActivateLayer?: (layerId: string) => void;

  private selectionShape: "rect" | "lasso" = "rect";
  private lassoQuickShape = new LassoQuickShapeSession();
  private marquee = new MarqueeTracker();

  /** Picked vertices, keyed by position. */
  private picked = new Map<string, Px>();
  /** Vertices of the shapes whose anchors are shown. */
  private shown = new Set<string>();
  private shownVersion = 0;
  private layerId: string | null = null;

  private isDragging = false;
  private dragStartWorld: Point | null = null;
  private didMove = false;
  private snapGuides: SnapGuide[] = [];
  private edgeDrag: EdgeDrag | null = null;
  private vertexDrag: VertexDrag | null = null;
  private lastSelectionViewport: Point | null = null;
  /** Previous edge click, for double-click-to-add-vertex. */
  private lastEdgeClick: { at: Point; timeMs: number; edge: KernelEdge } | null = null;

  private pathEditDragSession: {
    kind: PathEditKind;
    picks: Px[];
    bytes: Uint8Array;
  } | null = null;

  /** Paint caches (see `geometry()` / `outlinePath()`). */
  private geoCache: LayerGeometry | null = null;
  private outlineCache: { art: VectorLayer; digest: bigint; key: string; path: Path2D } | null = null;

  constructor(renderer: StageRenderer, camera: Camera, chromeLayer: ChromeLayer) {
    this.renderer = renderer;
    this.camera = camera;
    this.chromeLayer = chromeLayer;
    this.chromeCtx = chromeLayer.getContext();
    this.config = configStore.get();
    configStore.subscribe((config) => {
      this.config = config;
    });
    const applySettings = () => {
      const s = toolSettingsStore.get()["direct-select"] as { shape?: unknown } | undefined;
      this.selectionShape = s?.shape === "lasso" ? "lasso" : "rect";
      this.syncLassoQuickShapePrefs();
    };
    applySettings();
    toolSettingsStore.subscribe(applySettings);
    quickShapeEnabledStore.subscribe(() => this.syncLassoQuickShapePrefs());
    quickShapeCurveStyleStore.subscribe(() => this.syncLassoQuickShapePrefs());
    quickShapeShapesEnabledStore.subscribe(() => this.syncLassoQuickShapePrefs());
    quickShapeHoldMsStore.subscribe(() => this.syncLassoQuickShapePrefs());
  }

  private syncLassoQuickShapePrefs(): void {
    this.lassoQuickShape.setEnabled(quickShapeEnabledStore.get() && this.selectionShape === "lasso");
    this.lassoQuickShape.setCurveStyle(quickShapeCurveStyleStore.get());
    this.lassoQuickShape.setAllowShapes(quickShapeShapesEnabledStore.get());
    this.lassoQuickShape.setHoldMs(quickShapeHoldMsStore.get());
  }

  setSnapshotCallback(callback: () => void): void {
    this.onSnapshot = callback;
  }

  setLiveEditStartCallback(callback: () => void): void {
    this.onLiveEditStart = callback;
  }

  setActivateLayerCallback(callback: (layerId: string) => void): void {
    this.onActivateLayer = callback;
  }

  // ------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------

  hasSelection(): boolean {
    return this.picked.size > 0;
  }

  getPickedAnchorCount(): number {
    return this.picked.size;
  }

  getLastSelectionViewport(): Point | null {
    return this.lastSelectionViewport;
  }

  getSelectionScreenBounds(): { x: number; y: number; width: number; height: number } | null {
    if (this.picked.size < 2) return null;
    return this.pickedScreenBounds();
  }

  getSinglePickedAnchorViewport(): Point | null {
    if (this.picked.size !== 1) return null;
    const p = this.picked.values().next().value as Px;
    return this.camera.worldToScreen(p.x, p.y);
  }

  getSinglePickedAnchorScreenBounds(): { x: number; y: number; width: number; height: number } | null {
    const p = this.getSinglePickedAnchorViewport();
    if (!p) return null;
    return { x: p.x - ANCHOR_SIZE, y: p.y - ANCHOR_SIZE, width: ANCHOR_SIZE * 2, height: ANCHOR_SIZE * 2 };
  }

  private pickedScreenBounds(): { x: number; y: number; width: number; height: number } | null {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of this.picked.values()) {
      const s = this.camera.worldToScreen(p.x, p.y);
      minX = Math.min(minX, s.x); minY = Math.min(minY, s.y);
      maxX = Math.max(maxX, s.x); maxY = Math.max(maxY, s.y);
    }
    if (!Number.isFinite(minX)) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  private art(): VectorLayer | null {
    return this.renderer.activeArt();
  }

  // ------------------------------------------------------------
  // Selection lifecycle
  // ------------------------------------------------------------

  clearSelection(): void {
    this.picked.clear();
    this.hideShapes();
    this.layerId = null;
    this.edgeDrag = null;
    this.vertexDrag = null;
    this.pathEditDragSession = null;
    this.resetGesture();
    selectionStore.set(EMPTY_SELECTION);
    this.drawUI();
  }

  confirmAndClearSelection(): void {
    this.clearSelection();
  }

  private resetGesture(): void {
    this.isDragging = false;
    this.dragStartWorld = null;
    this.dragPointerOrigin = null;
    this.dragPastThreshold = false;
    this.snapGuides = [];
    this.lassoQuickShape.reset();
    this.marquee.reset();
    setSnapGuides([]);
  }

  private publish(): void {
    const n = this.picked.size;
    selectionStore.set(
      n > 0
        ? { count: 1, hasShapes: true, instances: [], layerIds: this.layerId ? [this.layerId] : [] }
        : EMPTY_SELECTION,
    );
  }

  /** Drop picks that no longer exist in the map (after kernel edits). */
  private prunePicks(): void {
    const art = this.art();
    if (!art) {
      this.picked.clear();
      return;
    }
    const live = new Set(art.vertices().map(key));
    for (const k of [...this.picked.keys()]) if (!live.has(k)) this.picked.delete(k);
  }

  // ------------------------------------------------------------
  // Pointer events
  // ------------------------------------------------------------

  private hideShapes(): void {
    if (this.shown.size === 0) return;
    this.shown.clear();
    this.shownVersion++;
  }

  /** Show these faces' vertices. A plain click replaces the shown set. */
  private showRegions(regions: readonly Region[], add: boolean): void {
    if (regions.length === 0) {
      if (!add) this.hideShapes();
      return;
    }
    if (!add) this.shown.clear();
    for (const region of regions) {
      for (const ring of region.rings) for (const p of ringPoints(ring)) this.shown.add(key(p));
    }
    this.shownVersion++;
  }

  /** The filled face under `world`, preferring the smallest one. */
  private regionAt(art: VectorLayer, world: Px): Region | null {
    let best: Region | null = null;
    let bestArea = Infinity;
    for (const region of this.geometry(art).regions) {
      if (!faceContains(world, region.rings)) continue;
      const area = Math.abs(ringArea(region.rings[0]));
      if (area < bestArea) {
        best = region;
        bestArea = area;
      }
    }
    return best;
  }

  private regionsTouching(art: VectorLayer, hit: (pts: Px[]) => boolean): Region[] {
    const out: Region[] = [];
    for (const region of this.geometry(art).regions) {
      const pts = region.rings.flatMap(ringPoints);
      if (hit(pts)) out.push(region);
    }
    return out;
  }

  handleStart(point: Point): void {
    const vp = pixelToViewport(point, this.config);
    const world = this.camera.screenToWorld(vp.x, vp.y);
    const art = this.art();
    const add = isAddToSelectionModifierHeld(modifiersStore.get());
    this.lastSelectionViewport = vp;

    if (art) {
      const tol = ANCHOR_HIT_PX / this.camera.zoom;
      // Control handles are shown for edges touching picked vertices; grab those first.
      const handleEdge = this.picked.size > 0 ? this.controlHandleAt(art, world, tol) : null;
      if (handleEdge) {
        this.layerId = this.renderer.getActiveLayerId();
        this.edgeDrag = { edge: handleEdge, ctrl: handleEdge.ctrl, handle: true };
        this.beginDrag(vp, world);
        this.drawUI();
        return;
      }
      const v = art.nearestVertex(world, tol);
      // Only anchors of an already revealed shape are grabbable. A click on
      // another shape falls through and reveals that face instead.
      if (v && this.shown.has(key(v))) {
        const k = key(v);
        if (!this.picked.has(k)) {
          if (!add) this.picked.clear();
          this.picked.set(k, v);
        } else if (add) {
          this.picked.delete(k);
          this.publish();
          this.drawUI();
          return;
        }
        this.layerId = this.renderer.getActiveLayerId();
        this.beginDrag(vp, world);
        const starts = [...this.picked.values()];
        this.vertexDrag = {
          starts,
          edges: art.edges().filter((e) => starts.some((p) => same(e.a, p) || same(e.b, p))),
          offset: { x: 0, y: 0 },
        };
        this.publish();
        this.drawUI();
        return;
      }

      const e = art.nearestEdge(world, EDGE_HIT_PX / this.camera.zoom);
      if (e && this.shown.has(key(e.a)) && this.shown.has(key(e.b))) {
        const now = performance.now();
        const last = this.lastEdgeClick;
        const isDouble =
          !!last &&
          now - last.timeMs <= DOUBLE_CLICK_MS &&
          sameEdgeEnds(last.edge, e) &&
          Math.hypot(vp.x - last.at.x, vp.y - last.at.y) <= DOUBLE_CLICK_PX;
        this.lastEdgeClick = isDouble ? null : { at: vp, timeMs: now, edge: e };
        if (isDouble) {
          this.layerId = this.renderer.getActiveLayerId();
          this.addVertexOnEdge(art, e, world);
          return;
        }
        if (!add) this.picked.clear();
        this.layerId = this.renderer.getActiveLayerId();
        this.edgeDrag = { edge: e, ctrl: e.ctrl, handle: false };
        this.beginDrag(vp, world);
        this.publish();
        this.drawUI();
        return;
      }
    }

    // Empty space or an unrevealed shape: marquee (a tap resolves in handleEnd).
    this.marquee.start(vp);
    if (this.selectionShape === "lasso") {
      this.syncLassoQuickShapePrefs();
      this.lassoQuickShape.begin(
        vp,
        () => this.marquee.getLassoPoints(),
        (path) => {
          this.marquee.setLassoPoints(path);
          this.drawUI();
        },
      );
    }
    this.drawUI();
  }

  /** Edges whose control handles are visible (curved, touching a picked vertex). */
  private handleEdges(art: VectorLayer): KernelEdge[] {
    return this.geometry(art).edges.filter(
      (e) => e.ctrl && (this.picked.has(key(e.a)) || this.picked.has(key(e.b))),
    );
  }

  private controlHandleAt(art: VectorLayer, world: Px, tol: number): KernelEdge | null {
    let best: KernelEdge | null = null;
    let bestD = tol;
    for (const e of this.handleEdges(art)) {
      const d = Math.hypot(e.ctrl!.x - world.x, e.ctrl!.y - world.y);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  /** Split `e` at the point nearest `world`, keeping its shape, and pick the new vertex. */
  private addVertexOnEdge(art: VectorLayer, e: KernelEdge, world: Px): void {
    const t = nearestT(e, world);
    if (t <= 0.02 || t >= 0.98) return;
    const lerp = (p: Px, q: Px): Px => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    let mid: Px;
    let segs: Seg[];
    if (e.ctrl) {
      // de Casteljau: both halves stay on the original curve.
      const c1 = lerp(e.a, e.ctrl);
      const c2 = lerp(e.ctrl, e.b);
      mid = lerp(c1, c2);
      segs = [{ kind: "Q", c: c1, to: mid }, { kind: "Q", c: c2, to: e.b }];
    } else {
      mid = lerp(e.a, e.b);
      segs = [{ kind: "L", to: mid }, { kind: "L", to: e.b }];
    }
    if (!art.replaceChain([e.a, e.b], segs)) return;
    this.shown.add(key(mid));
    this.shownVersion++;
    this.picked = rekeyPicks(art, [mid]);
    this.commitEdit();
    this.publish();
    this.drawUI();
  }

  private beginDrag(vp: Point, world: Point): void {
    this.isDragging = true;
    this.dragStartWorld = world;
    this.dragPointerOrigin = vp;
    this.dragPastThreshold = false;
    this.didMove = false;
  }

  handleMove(point: Point): void {
    const vp = pixelToViewport(point, this.config);

    if (this.marquee.isTracking()) {
      if (this.selectionShape === "lasso") {
        const mode = this.lassoQuickShape.noteMove(vp);
        if (mode === "adjust") {
          const path = this.lassoQuickShape.getPath();
          if (path) this.marquee.setLassoPoints(path);
          this.drawUI();
          return;
        }
      }
      this.marquee.update(vp, this.selectionShape, isConstrainScaleModifierHeld(modifiersStore.get()));
      this.drawUI();
      return;
    }

    if (!this.isDragging || !this.dragStartWorld || !this.dragPointerOrigin) return;
    if (!this.dragPastThreshold) {
      const dx = vp.x - this.dragPointerOrigin.x;
      const dy = vp.y - this.dragPointerOrigin.y;
      if (dx * dx + dy * dy < this.dragMoveThresholdSq) return;
      this.dragPastThreshold = true;
    }

    const art = this.art();
    if (!art) return;
    const world = this.camera.screenToWorld(vp.x, vp.y);

    if (this.edgeDrag) {
      // Preview only; the kernel edge is bent on release. Dragging the handle
      // places the control at the pointer; dragging the edge body puts the
      // curve through the pointer at t = 0.5: ctrl = 2P - (A + B) / 2.
      const { a, b } = this.edgeDrag.edge;
      this.edgeDrag.ctrl = this.edgeDrag.handle
        ? world
        : { x: 2 * world.x - (a.x + b.x) / 2, y: 2 * world.y - (a.y + b.y) / 2 };
      this.noteEdit();
      this.drawUI();
      return;
    }

    const drag = this.vertexDrag;
    if (!drag || drag.starts.length === 0) return;
    const total = {
      x: vp.x - this.dragPointerOrigin.x,
      y: vp.y - this.dragPointerOrigin.y,
    };
    const constrain = isConstrainMoveModifierHeld(modifiersStore.get());
    const constrained = constrainAxisScreenDelta(total.x, total.y, constrain);
    const desired = this.camera.screenDeltaToWorld(constrained.x, constrained.y);
    const snapped = snapWorldTranslation(
      { xs: [], ys: [], points: drag.starts },
      desired,
      this.camera,
      this.renderer,
      snapLockFromConstrain(constrained, constrain),
      drag.starts,
      false,
    );
    this.snapGuides = snapped.guides;
    setSnapGuides(this.snapGuides);
    if (snapped.dx !== drag.offset.x || snapped.dy !== drag.offset.y) {
      drag.offset = { x: snapped.dx, y: snapped.dy };
      this.noteEdit();
      this.drawUI();
    }
  }

  /** Commit the in-flight drag to the kernel (once, on release). */
  private applyDrag(art: VectorLayer): boolean {
    if (this.edgeDrag) {
      const { edge, ctrl } = this.edgeDrag;
      if (!ctrl || (edge.ctrl && same(edge.ctrl, ctrl))) return false;
      return art.curveEdge(edge, ctrl);
    }
    const drag = this.vertexDrag;
    if (!drag || (drag.offset.x === 0 && drag.offset.y === 0)) return false;
    const moves = drag.starts.map((p) => ({ from: p, to: { x: p.x + drag.offset.x, y: p.y + drag.offset.y } }));
    if (!art.moveVertices(moves)) return false;
    for (const m of moves) {
      if (this.shown.delete(key(m.from))) this.shown.add(key(m.to));
    }
    this.shownVersion++;
    this.picked = new Map(moves.map((m) => [key(m.to), m.to]));
    return true;
  }

  handleEnd(): void {
    if (this.marquee.isTracking()) {
      const start = this.marquee.getStartPoint();
      const cur = this.marquee.getCurrentPoint();
      const lasso = this.marquee.getLassoPoints();
      const add = isAddToSelectionModifierHeld(modifiersStore.get());
      const active = this.marquee.hasActiveMarquee(this.selectionShape);
      this.lassoQuickShape.reset();
      this.marquee.reset();
      if (!start || !cur) {
        this.drawUI();
        return;
      }
      if (!add) {
        this.picked.clear();
        this.hideShapes();
      }
      const art = this.art();
      if (!active) {
        if (art) {
          const world = this.camera.screenToWorld(cur.x, cur.y);
          const region = this.regionAt(art, world);
          this.showRegions(region ? [region] : [], add);
        }
      } else if (art) {
        const toWorld = (p: Point) => this.camera.screenToWorld(p.x, p.y);
        const poly =
          this.selectionShape === "lasso"
            ? lasso.map(toWorld)
            : [toWorld(start), toWorld({ x: cur.x, y: start.y }), toWorld(cur), toWorld({ x: start.x, y: cur.y })];
        if (poly.length >= 3) {
          for (const v of art.vertices()) {
            if (pointInPolygon(v, poly)) this.picked.set(key(v), v);
          }
        }
        if (this.picked.size > 0) {
          this.layerId = this.renderer.getActiveLayerId();
          if (this.layerId) this.onActivateLayer?.(this.layerId);
          const regions: Region[] = [];
          for (const v of this.picked.values()) {
            regions.push(...this.regionsTouching(art, (pts) => pts.some((q) => same(q, v))));
          }
          this.showRegions(regions, true);
        }
      }
      this.publish();
      this.drawUI();
      return;
    }

    if (this.isDragging) {
      const art = this.art();
      if (this.didMove && art && this.applyDrag(art)) {
        this.prunePicks();
        if (this.layerId) this.renderer.markLayerDirty(this.layerId);
        this.renderer.requestRender();
        this.publish();
        this.onSnapshot?.();
      }
      this.edgeDrag = null;
      this.vertexDrag = null;
      this.resetGesture();
    this.drawUI();
    }
  }

  handleCancel(): void {
    this.edgeDrag = null;
    this.vertexDrag = null;
    this.resetGesture();
    this.drawUI();
  }

  private noteEdit(): void {
    if (!this.didMove) {
      this.didMove = true;
      this.onLiveEditStart?.();
    }
  }

  // ------------------------------------------------------------
  // Vertex operations
  // ------------------------------------------------------------

  /** Edges touching `v` in the current map. */
  private incident(art: VectorLayer, v: Px): KernelEdge[] {
    return art.edges().filter((e) => same(e.a, v) || same(e.b, v));
  }

  /** Collapse each picked vertex onto a neighbour, removing it. */
  deletePickedVertices(): void {
    const art = this.art();
    if (!art || this.picked.size === 0) return;
    let changed = false;
    for (const v of this.picked.values()) {
      const inc = this.incident(art, v);
      if (inc.length === 0) continue;
      const e = inc[0];
      const target = same(e.a, v) ? e.b : e.a;
      if (art.moveVertex(v, target)) changed = true;
    }
    this.picked.clear();
    if (changed) this.commitEdit();
    this.publish();
    this.drawUI();
  }

  /**
   * Replace every picked run with a least-squares cubic fit, dropping
   * redundant vertices. `tol` is the max deviation in world pixels.
   */
  simplifyPickedVertices(tol = SIMPLIFY_TOL_PX): void {
    const art = this.art();
    if (!art || this.picked.size === 0) return;
    const { changed, picks } = simplifyChains(art, this.picked, tol);
    this.picked = rekeyPicks(art, picks);
    if (changed) this.commitEdit();
    this.publish();
    this.drawUI();
  }

  /**
   * Make every picked run a cubic spline through its vertices. `amount` is
   * the handle length as a fraction of each edge's chord (1/3 ≈ Catmull-Rom).
   */
  smoothPickedVertices(amount = SMOOTH_DEFAULT): void {
    const art = this.art();
    if (!art || this.picked.size === 0) return;
    const { changed, picks } = smoothChains(art, this.picked, amount);
    this.picked = rekeyPicks(art, picks);
    if (changed) this.commitEdit();
    this.drawUI();
  }

  private commitEdit(): void {
    if (this.layerId) this.renderer.markLayerDirty(this.layerId);
    this.renderer.requestRender();
    this.onLiveEditStart?.();
    this.onSnapshot?.();
  }

  // ------------------------------------------------------------
  // Draggable "simplify"
  // ------------------------------------------------------------

  beginPathEditDrag(kind: PathEditKind): boolean {
    const art = this.art();
    if (!art || this.picked.size === 0 || this.pathEditDragSession) return false;
    this.pathEditDragSession = { kind, picks: [...this.picked.values()], bytes: art.toBytes() };
    return true;
  }

  updatePathEditDrag(amount: number): void {
    const session = this.pathEditDragSession;
    const art = this.art();
    if (!session || !art) return;
    // Rebuild from the pristine map, then apply the current amount.
    art.restoreBytes(session.bytes);
    this.picked = new Map(session.picks.map((p) => [key(p), p]));
    // amount is a world drag distance: a fit tolerance (further = fewer vertices).
    const tol = Math.min(SIMPLIFY_TOL_MAX, Math.max(SIMPLIFY_TOL_MIN, amount / 10));
    this.picked = rekeyPicks(art, simplifyChains(art, this.picked, tol).picks);
    if (this.layerId) this.renderer.markLayerDirty(this.layerId);
    this.renderer.requestRender();
    this.drawUI();
  }

  endPathEditDrag(): void {
    if (!this.pathEditDragSession) return;
    this.pathEditDragSession = null;
    this.onLiveEditStart?.();
    this.onSnapshot?.();
    this.drawUI();
  }

  isPathEditDragActive(): boolean {
    return this.pathEditDragSession !== null;
  }

  // ------------------------------------------------------------
  // Chrome
  // ------------------------------------------------------------

  /** Mark the chrome surface dirty; `paintUI` runs once on the next frame. */
  drawUI(): void {
    scheduler.invalidate(Surface.CHROME);
  }

  /**
   * Paint outline, handles and vertices onto the (already cleared) chrome
   * canvas. Called by the frame scheduler's CHROME painter, never directly.
   */
  paintUI(): void {
    const ctx = this.chromeCtx;

    if (this.marquee.isTracking()) {
      const start = this.marquee.getStartPoint();
      const cur = this.marquee.getCurrentPoint();
      if (start && cur) {
        if (this.selectionShape === "lasso") this.chromeLayer.drawLassoPreview(this.marquee.getLassoPoints());
        else this.chromeLayer.drawMarqueeRect(start, cur);
      }
      return;
    }

    const art = this.art();
    if (art && !art.isEmpty()) {
      const geo = this.geometry(art);
      if (this.shown.size === 0) return;
      this.drawOutline(ctx, geo);
      const drag = this.vertexDrag;
      const shift = (p: Px): Px =>
        drag && drag.starts.some((s) => same(s, p)) ? { x: p.x + drag.offset.x, y: p.y + drag.offset.y } : p;
      // Same palette as the main select chrome (selection-chrome.ts).
      const controlFill = "#000000";
      const controlStroke = "#ffffff";
      ctx.save();
      ctx.setLineDash([]);
      // Control handles of curved edges touching picked vertices (at their
      // pending positions while a drag is in flight), under the vertices.
      const handles = this.handleEdges(art).map((e) => this.pendingEdge(e));
      if (this.edgeDrag?.ctrl && !handles.some((h) => sameEdgeEnds(h, this.edgeDrag!.edge))) {
        handles.push({ ...this.edgeDrag.edge, ctrl: this.edgeDrag.ctrl });
      }
      for (const e of handles) {
        if (!e.ctrl) continue;
        const c = this.camera.worldToScreen(e.ctrl.x, e.ctrl.y);
        const a = this.camera.worldToScreen(e.a.x, e.a.y);
        const b = this.camera.worldToScreen(e.b.x, e.b.y);
        for (const pass of [{ style: controlStroke, width: 3 }, { style: controlFill, width: 1.5 }]) {
          ctx.strokeStyle = pass.style;
          ctx.lineWidth = pass.width;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(c.x, c.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(c.x, c.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = controlFill;
        ctx.strokeStyle = controlStroke;
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
      }
      // Vertices: black squares for picked, white for free, like select handles.
      // One fill pass per colour so a tiger-sized layer costs two fills and two
      // strokes, not four canvas calls per vertex.
      ctx.lineWidth = 2;
      const pickedPath = new Path2D();
      const freePath = new Path2D();
      for (let i = 0; i < geo.vertices.length; i++) {
        if (!this.shown.has(geo.keys[i])) continue;
        const v = shift(geo.vertices[i]);
        const s = this.camera.worldToScreen(v.x, v.y);
        const into = geo.pickedMask[i] ? pickedPath : freePath;
        into.rect(s.x - ANCHOR_SIZE / 2, s.y - ANCHOR_SIZE / 2, ANCHOR_SIZE, ANCHOR_SIZE);
      }
      ctx.fillStyle = controlStroke;
      ctx.strokeStyle = controlFill;
      ctx.fill(freePath);
      ctx.stroke(freePath);
      ctx.fillStyle = controlFill;
      ctx.strokeStyle = controlStroke;
      ctx.fill(pickedPath);
      ctx.stroke(pickedPath);
      ctx.restore();
    }
  }

  /**
   * Edge/vertex readback for `art`, cached by kernel digest so idle repaints
   * (camera moves, hover) do not cross into wasm or rebuild vertex keys. The
   * picked mask is a Set lookup per vertex, recomputed on every paint since
   * the pick set changes in many places.
   */
  private geometry(art: VectorLayer): LayerGeometry {
    const digest = art.digest();
    let g = this.geoCache;
    if (!g || g.art !== art || g.digest !== digest) {
      const vertices = art.vertices();
      g = {
        art,
        digest,
        edges: art.edges(),
        vertices,
        keys: vertices.map(key),
        pickedMask: [],
        regions: art.regions(),
      };
      this.geoCache = g;
    }
    g.pickedMask = g.keys.map((k) => this.picked.has(k));
    return g;
  }

  /**
   * `e` as it will be after the in-flight drag: endpoints shifted, the
   * control carried by the full offset when both ends move, half when one
   * does (matching the kernel's `moveVertices`), or replaced by the pending
   * control of an edge/handle drag.
   */
  private pendingEdge(e: KernelEdge): KernelEdge {
    if (this.edgeDrag && sameEdgeEnds(e, this.edgeDrag.edge)) return { ...e, ctrl: this.edgeDrag.ctrl };
    const d = this.vertexDrag;
    if (!d) return e;
    const moved = (p: Px) => d.starts.some((s) => same(s, p));
    const shift = (p: Px): Px => (moved(p) ? { x: p.x + d.offset.x, y: p.y + d.offset.y } : p);
    const ends = Number(moved(e.a)) + Number(moved(e.b));
    const ctrl = e.ctrl && ends ? { x: e.ctrl.x + (d.offset.x * ends) / 2, y: e.ctrl.y + (d.offset.y * ends) / 2 } : e.ctrl;
    return { a: shift(e.a), b: shift(e.b), ctrl };
  }

  /**
   * Dashed outline of every edge on the active layer, at its pending
   * position while a drag is in flight (so the preview is the outline).
   */
  private drawOutline(ctx: CanvasRenderingContext2D, geo: LayerGeometry): void {
    const path = this.outlinePath(geo);
    ctx.save();
    // Same passes as the main select outline (StageRenderer.strokePartsOutline).
    ctx.lineJoin = "round";
    ctx.setLineDash([6, 5]);
    for (const pass of [
      { style: "rgba(0, 0, 0, 0.45)", width: 5 },
      { style: "#ffffff", width: 3.5 },
      { style: "#000000", width: 1.5 },
    ]) {
      ctx.strokeStyle = pass.style;
      ctx.lineWidth = pass.width;
      ctx.stroke(path);
    }
    ctx.restore();
  }

  /**
   * Screen-space outline of the shown shape's edges, at pending positions while a drag is
   * in flight. Rebuilt only when the geometry, camera or drag state changes;
   * otherwise the three dashed passes stroke the same prebuilt `Path2D`.
   */
  private outlinePath(geo: LayerGeometry): Path2D {
    const d = this.vertexDrag;
    const e = this.edgeDrag;
    const cacheKey = [
      this.camera.getTransformMatrix().join(","),
      d ? `${d.offset.x},${d.offset.y},${d.starts.length}` : "",
      e?.ctrl ? `${e.ctrl.x},${e.ctrl.y}` : "",
      this.shownVersion,
    ].join("|");
    const c = this.outlineCache;
    if (c && c.digest === geo.digest && c.art === geo.art && c.key === cacheKey) return c.path;

    const path = new Path2D();
    for (const e0 of geo.edges) {
      if (!this.shown.has(key(e0.a)) || !this.shown.has(key(e0.b))) continue;
      const edge = this.pendingEdge(e0);
      const a = this.camera.worldToScreen(edge.a.x, edge.a.y);
      const b = this.camera.worldToScreen(edge.b.x, edge.b.y);
      path.moveTo(a.x, a.y);
      if (edge.ctrl) {
        const cp = this.camera.worldToScreen(edge.ctrl.x, edge.ctrl.y);
        path.quadraticCurveTo(cp.x, cp.y, b.x, b.y);
      } else {
        path.lineTo(b.x, b.y);
      }
    }
    this.outlineCache = { art: geo.art, digest: geo.digest, key: cacheKey, path };
    return path;
  }
}

function ringPoints(ring: Ring): Px[] {
  const pts = [ring.start];
  for (const seg of ring.segs) pts.push(seg.to);
  if (pts.length > 1 && same(pts[0], pts[pts.length - 1])) pts.pop();
  return pts;
}

function ringArea(ring: Ring | undefined): number {
  const pts = ring ? ringPoints(ring) : [];
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    area += p.x * q.y - q.x * p.y;
  }
  return area * 0.5;
}

let shapeHit: CanvasRenderingContext2D | null | undefined;

/** Nonzero fill of the face's rings, in world pixels. */
function faceContains(p: Px, rings: readonly Ring[]): boolean {
  if (rings.length === 0) return false;
  if (shapeHit === undefined) shapeHit = document.createElement("canvas").getContext("2d");
  return !!shapeHit && shapeHit.isPointInPath(ringsToPath2D(rings), p.x, p.y, "nonzero");
}

/** Parameter on `e` (line or quadratic) closest to `p`. */
function nearestT(e: KernelEdge, p: Px): number {
  const at = (t: number): Px => {
    if (!e.ctrl) return { x: e.a.x + (e.b.x - e.a.x) * t, y: e.a.y + (e.b.y - e.a.y) * t };
    const mt = 1 - t;
    return {
      x: mt * mt * e.a.x + 2 * mt * t * e.ctrl.x + t * t * e.b.x,
      y: mt * mt * e.a.y + 2 * mt * t * e.ctrl.y + t * t * e.b.y,
    };
  };
  const d2 = (t: number) => {
    const q = at(t);
    return (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
  };
  // Coarse sample, then refine by shrinking the bracket.
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i <= 32; i++) {
    const t = i / 32;
    const d = d2(t);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  let step = 1 / 32;
  for (let i = 0; i < 20; i++) {
    step /= 2;
    for (const t of [best - step, best + step]) {
      if (t < 0 || t > 1) continue;
      const d = d2(t);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
  }
  return best;
}
