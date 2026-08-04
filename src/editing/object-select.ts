/**
 * Selection Controller
 *
 * Manages the selection tool state and interactions.
 * Hold or double-click / double-tap a shape to select it (mouse and touch).
 * Drag always marquees (rect/lasso) unless something is already selected —
 * then click-drag moves / transforms it. Touch drag before hold pans.
 */
import type { Point, CanvasConfig } from "../geometry/types";
import type {
  PaperRenderer,
  SelectLayerScope,
  SelectionHandleId,
  SelectionHandle,
} from "../render/paper-renderer";
import type { Camera } from "../render/camera";
import type { ChromeLayer } from "../render/chrome-layer";
import {
  configStore,
  toolSettingsStore,
  selectionStore,
  quickShapeEnabledStore,
  quickShapeCurveStyleStore,
  quickShapeHoldMsStore,
  modifiersStore,
} from "../state/index";
import { pixelToViewport } from "../geometry/coords";
import { LassoQuickShapeSession } from "../geometry/quick-shape";
import { MarqueeTracker } from "./marquee";
import {
  isAddToSelectionModifierHeld,
  isConstrainMoveModifierHeld,
} from "../input/shortcuts";
import {
  TransformGizmoController,
  constrainAxisScreenDelta,
} from "./transform-gizmo";

export class SelectionController {
  /** Ignore sub-pixel jitter: only count drags after this many viewport px from pointer-down. */
  private readonly dragMoveThresholdSq = 5 * 5;
  private dragPointerOrigin: Point | null = null;
  private dragPastThreshold = false;

  /**
   * Last click on an unselected shape. A second press within
   * `doubleClickWindowMs` / `doubleClickDistanceSq` selects that shape.
   * Single click / drag on unselected content always starts a marquee.
   */
  private lastShapeClick: {
    timestampMs: number;
    point: Point;
    itemId: number;
  } | null = null;
  private readonly doubleClickWindowMs = 350;
  private readonly doubleClickDistanceSq = 6 * 6;

  private selectionShape: "rect" | "lasso" = "rect";
  private layerScope: SelectLayerScope = "all";
  private lassoQuickShape = new LassoQuickShapeSession();
  private selectedItems: paper.PathItem[] = [];
  private pendingExtractionSnapshot: Map<string, paper.PathItem[]> | null = null;
  private isDragging = false;
  private dragStartPoint: Point | null = null;
  /** Screen-space total already applied this translate gesture (from drag origin). */
  private lastAppliedScreenTotal: Point = { x: 0, y: 0 };
  private didMove = false;
  private selectionNeedsPlacement = false;
  private config: CanvasConfig;
  private onSnapshot?: () => void;
  private onLiveEditStart?: () => void;
  private onActivateLayer?: (layerId: string) => void;

  private paperRenderer: PaperRenderer;
  private camera: Camera;
  private chromeLayer: ChromeLayer;
  private chromeCtx: CanvasRenderingContext2D;

  // Transform handle state
  private handles: SelectionHandle[] = [];
  private marquee = new MarqueeTracker();
  private transformGizmo: TransformGizmoController;

  // Current cursor in viewport space (for rotation visual feedback)
  private lastViewportPoint: Point | null = null;

  constructor(
    paperRenderer: PaperRenderer,
    camera: Camera,
    chromeLayer: ChromeLayer,
  ) {
    this.paperRenderer = paperRenderer;
    this.camera = camera;
    this.chromeLayer = chromeLayer;
    this.chromeCtx = chromeLayer.getContext();
    this.transformGizmo = new TransformGizmoController({
      getScreenBounds: () =>
        this.paperRenderer.getSelectionFrameScreenBounds(this.selectedItems),
      getRotatePivotWorld: () => {
        if (!this.hasSelection()) return null;
        if (this.selectedItems.length === 1) {
          const pos = this.selectedItems[0].position;
          return { x: pos.x, y: pos.y };
        }
        const bounds = this.paperRenderer.getCombinedBounds(this.selectedItems);
        if (!bounds) return null;
        return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      },
      applyScale: (incSX, incSY, worldAnchor) => {
        for (const item of this.selectedItems) {
          this.paperRenderer.scalePathInViewSpace(item, incSX, incSY, worldAnchor);
        }
      },
      applyRotate: (degrees, worldPivot) => {
        for (const item of this.selectedItems) {
          this.paperRenderer.rotatePath(item, degrees, worldPivot);
        }
      },
    });
    this.config = configStore.get();
    configStore.subscribe((config) => {
      this.config = config;
    });
    const applySelectSettings = () => {
      const selectSettings = toolSettingsStore.get().select as {
        shape?: unknown;
        scope?: unknown;
      };
      this.selectionShape = selectSettings.shape === "lasso" ? "lasso" : "rect";
      this.layerScope = selectSettings.scope === "active" ? "active" : "all";
      this.syncLassoQuickShapePrefs();
    };
    applySelectSettings();
    toolSettingsStore.subscribe(() => applySelectSettings());
    quickShapeEnabledStore.subscribe(() => this.syncLassoQuickShapePrefs());
    quickShapeCurveStyleStore.subscribe(() => this.syncLassoQuickShapePrefs());
    quickShapeHoldMsStore.subscribe(() => this.syncLassoQuickShapePrefs());
  }

  private syncLassoQuickShapePrefs(): void {
    this.lassoQuickShape.setEnabled(
      quickShapeEnabledStore.get() && this.selectionShape === "lasso",
    );
    this.lassoQuickShape.setCurveStyle(quickShapeCurveStyleStore.get());
    this.lassoQuickShape.setHoldMs(quickShapeHoldMsStore.get());
  }

  setSnapshotCallback(callback: () => void): void {
    this.onSnapshot = callback;
  }

  /** Fired once when a selection first diverges from committed content (move/transform). */
  setLiveEditStartCallback(callback: () => void): void {
    this.onLiveEditStart = callback;
  }

  setActivateLayerCallback(callback: (layerId: string) => void): void {
    this.onActivateLayer = callback;
  }

  getSelectedItem(): paper.Item | null {
    return this.selectedItems[0] ?? null;
  }

  getSelectedItems(): paper.PathItem[] {
    return [...this.selectedItems];
  }

  setSelectedItems(
    items: paper.PathItem[],
    options?: { needsPlacement?: boolean; didMove?: boolean },
  ): void {
    this.selectedItems = [...items];
    this.selectionNeedsPlacement = options?.needsPlacement ?? false;
    this.didMove = false;
    if (options?.didMove) this.noteLiveEditStarted();
    this.handles = [];
    selectionStore.set({ items: [...this.selectedItems] });
    this.drawUI();
  }

  hasSelection(): boolean {
    return this.selectedItems.length > 0;
  }

  hasTransientUI(): boolean {
    return this.hasSelection() || this.marquee.isTracking();
  }

  placeSelection(): void {
    if (this.selectedItems.length > 0 && (this.selectionNeedsPlacement || this.didMove)) {
      for (const item of this.selectedItems) {
        if (!item.parent) continue;
        this.paperRenderer.placeSelection(item);
      }
      if (this.didMove) {
        this.onSnapshot?.();
      }
    }
    this.pendingExtractionSnapshot = null;
    this.selectedItems = [];
    this.selectionNeedsPlacement = false;
    this.didMove = false;
    this.handles = [];
    selectionStore.set({ items: [] });
  }

  /**
   * Always place a pending extraction / moved selection (never revert), then
   * clear drag/gizmo chrome. Used when leaving the frame so edits stick.
   */
  confirmAndClearSelection(): void {
    this.placeSelection();
    this.isDragging = false;
    this.dragStartPoint = null;
    this.resetDragThreshold();
    this.lassoQuickShape.reset();
    this.marquee.reset();
    this.clearTransformState();
    this.drawUI();
  }

  clearSelection(): void {
    if (this.selectionNeedsPlacement && !this.didMove) {
      this.revertPendingSelection();
    } else {
      this.placeSelection();
    }
    this.isDragging = false;
    this.dragStartPoint = null;
    this.resetDragThreshold();
    this.lassoQuickShape.reset();
    this.marquee.reset();
    this.clearTransformState();
    this.drawUI();
  }

  discardSelection(): void {
    this.pendingExtractionSnapshot = null;
    this.selectedItems = [];
    this.selectionNeedsPlacement = false;
    this.didMove = false;
    this.handles = [];
    this.isDragging = false;
    this.dragStartPoint = null;
    this.resetDragThreshold();
    this.lassoQuickShape.reset();
    this.marquee.reset();
    this.lastShapeClick = null;
    this.clearTransformState();
    selectionStore.set({ items: [] });
    this.drawUI();
  }

  markSelectionAsModified(): void {
    if (!this.hasSelection()) return;
    this.noteLiveEditStarted();
    selectionStore.set({ items: [...this.selectedItems] });
    this.drawUI();
  }

  handleStart(point: Point, options?: { fromTouchHold?: boolean }): void {
    const viewportPoint = pixelToViewport(point, this.config);
    const fromTouchHold = options?.fromTouchHold === true;

    // Check transform handles on existing selection first
    if (this.hasSelection() && this.handles.length > 0) {
      const hitHandle = this.hitTestHandle(viewportPoint);
      if (hitHandle && this.transformGizmo.begin(hitHandle, viewportPoint, this.camera)) {
        this.lastShapeClick = null;
        this.isDragging = true;
        this.dragStartPoint = viewportPoint;
        this.beginDragThreshold(viewportPoint);
        this.didMove = false;
        return;
      }
    }

    const initialHitItem = this.paperRenderer.resolveSelectableItem(
      this.paperRenderer.hitTestSelectable(viewportPoint, this.layerScope),
    );

    // Already-selected shape: click-drag moves the selection.
    if (initialHitItem && this.isSelectedItem(initialHitItem)) {
      this.lastShapeClick = null;
      this.activateLayerForItem(initialHitItem);
      this.isDragging = true;
      this.dragStartPoint = viewportPoint;
      this.beginDragThreshold(viewportPoint);
      this.didMove = false;
      this.bringSelectionToFront();
      this.drawUI();
      return;
    }

    const hitItem = initialHitItem;

    // Hold or double-click / double-tap on an unselected shape selects it.
    if (hitItem) {
      const now = performance.now();
      const shouldSelectShape =
        fromTouchHold || this.isDoubleClickOnShape(viewportPoint, hitItem.id, now);
      if (shouldSelectShape) {
        this.lastShapeClick = null;
        const selectItem =
          this.paperRenderer.resolveSelectableItem(
            this.paperRenderer.hitTestSelectable(viewportPoint, this.layerScope),
          ) ?? hitItem;
        this.activateLayerForItem(selectItem);
        if (isAddToSelectionModifierHeld(modifiersStore.get())) {
          this.addItemToSelection(selectItem);
        } else {
          this.resolvePendingSelectionForNewGesture();
          this.setSelectedItems([selectItem]);
        }
        this.isDragging = true;
        this.dragStartPoint = viewportPoint;
        this.beginDragThreshold(viewportPoint);
        this.didMove = false;
        this.bringSelectionToFront();
        this.drawUI();
        return;
      }
      this.lastShapeClick = {
        timestampMs: now,
        point: { ...viewportPoint },
        itemId: hitItem.id,
      };
    } else {
      this.lastShapeClick = null;
    }

    // Single click / drag on empty space or an unselected shape: marquee only.
    // Defer placing/clearing the current selection until pointer-up so a tap
    // outside can deselect without a tiny jitter re-extracting the same shapes.
    this.startMarquee(viewportPoint);
    this.drawUI();
  }

  handleMove(point: Point): void {
    const viewportPoint = pixelToViewport(point, this.config);
    this.lastViewportPoint = viewportPoint;

    if (this.marquee.isTracking()) {
      if (this.selectionShape === "lasso") {
        const mode = this.lassoQuickShape.noteMove(viewportPoint);
        if (mode === "adjust") {
          const path = this.lassoQuickShape.getPath();
          if (path) this.marquee.setLassoPoints(path);
          this.drawUI();
          return;
        }
      }
      this.marquee.update(viewportPoint, this.selectionShape);
      this.drawUI();
      return;
    }

    if (!this.isDragging || !this.hasSelection() || !this.dragStartPoint) return;

    if (!this.pastDragThreshold(viewportPoint)) {
      this.drawUI();
      return;
    }

    if (this.transformGizmo.isTransforming()) {
      if (this.transformGizmo.update(viewportPoint, this.camera)) {
        this.noteLiveEditStarted();
      }
    } else {
      this.handleTranslateMove(viewportPoint);
    }

    this.drawUI();
  }

  handleEnd(): void {
    if (this.marquee.isTracking()) {
      const marqueeStartPoint = this.marquee.getStartPoint();
      const marqueeCurrentPoint = this.marquee.getCurrentPoint();
      const lassoPoints = this.marquee.getLassoPoints();
      if (!marqueeStartPoint || !marqueeCurrentPoint) {
        this.lassoQuickShape.reset();
        this.marquee.reset();
        this.drawUI();
        return;
      }
      if (this.hasActiveMarquee()) {
        const add = isAddToSelectionModifierHeld(modifiersStore.get());
        let kept: paper.PathItem[] = [];
        if (add && this.selectedItems.length > 0) {
          // Commit prior selection but keep survivors so the new extract unions in.
          if (this.selectionNeedsPlacement || this.didMove) {
            kept = this.paperRenderer.placeItemsAsSelection(this.selectedItems);
            this.pendingExtractionSnapshot = null;
            this.selectionNeedsPlacement = false;
            this.didMove = false;
          } else {
            kept = this.selectedItems.filter((item) => !!item.parent);
          }
          this.selectedItems = [];
          this.handles = [];
        } else {
          // Commit/clear whatever was selected before extracting a new range.
          this.resolvePendingSelectionForNewGesture();
        }
        this.pendingExtractionSnapshot =
          this.paperRenderer.captureSelectableLayersSnapshot(this.layerScope);
        const keptIds = new Set(kept.map((item) => item.id));
        const itemFilter =
          keptIds.size > 0
            ? (item: paper.PathItem) => !keptIds.has(item.id)
            : undefined;
        const extracted =
          this.selectionShape === "lasso"
            ? this.paperRenderer.extractSelectionFromScreenLasso(
                lassoPoints,
                this.layerScope,
                itemFilter,
              )
            : this.paperRenderer.extractSelectionFromScreenRect(
                marqueeStartPoint,
                marqueeCurrentPoint,
                this.layerScope,
                itemFilter,
              );
        const byId = new Map<number, paper.PathItem>();
        for (const item of kept) byId.set(item.id, item);
        for (const item of extracted) byId.set(item.id, item);
        this.selectedItems = [...byId.values()];
        this.selectionNeedsPlacement = extracted.length > 0;
        if (!this.selectionNeedsPlacement) {
          this.pendingExtractionSnapshot = null;
        } else if (this.layerScope === "all") {
          this.activateTopmostSelectedLayer();
        }
        selectionStore.set({ items: [...this.selectedItems] });
      } else {
        // Tap outside / on an unselected shape: deselect only.
        // With add-to-selection held, keep the current selection.
        this.lassoQuickShape.reset();
        this.marquee.reset();
        this.isDragging = false;
        this.dragStartPoint = null;
        this.resetDragThreshold();
        this.clearTransformState();
        if (!isAddToSelectionModifierHeld(modifiersStore.get())) {
          this.clearSelection();
        } else {
          this.drawUI();
        }
        return;
      }
      this.lassoQuickShape.reset();
      this.marquee.reset();
      this.isDragging = false;
      this.dragStartPoint = null;
      this.resetDragThreshold();
      this.clearTransformState();
      this.drawUI();
      return;
    }

    this.isDragging = false;
    this.dragStartPoint = null;
    this.resetDragThreshold();
    this.clearTransformState();
    this.drawUI();
  }

  handleCancel(): void {
    if (this.selectionNeedsPlacement) {
      this.revertPendingSelection();
    }
    this.isDragging = false;
    this.dragStartPoint = null;
    this.resetDragThreshold();
    this.lassoQuickShape.reset();
    this.marquee.reset();
    this.clearTransformState();
    this.drawUI();
  }

  drawUI(): void {
    this.chromeLayer.clear();

    // While marqueeing, hide the prior selection chrome so a tap-outside
    // deselect doesn't flash the old frame beside the new marquee.
    if (this.hasSelection() && !this.marquee.isTracking()) {
      const rotating = this.transformGizmo.getRotationOverlay(
        this.camera,
        this.lastViewportPoint,
      );
      this.handles = this.paperRenderer.drawSelection(
        this.selectedItems,
        this.chromeCtx,
        rotating,
      );
    } else {
      this.handles = [];
    }

    if (this.marquee.isTracking()) {
      const start = this.marquee.getStartPoint();
      const current = this.marquee.getCurrentPoint();
      if (!start || !current) return;
      if (this.selectionShape === "lasso") {
        this.chromeLayer.drawLassoPreview(this.marquee.getLassoPoints());
      } else {
        this.chromeLayer.drawMarqueeRect(start, current);
      }
    }
  }

  // ============================================================
  // Private: Handle hit testing
  // ============================================================

  private hitTestHandle(viewportPoint: Point): SelectionHandleId | null {
    const hitRadiusSq = 12 * 12;

    for (const handle of this.handles) {
      const dx = viewportPoint.x - handle.x;
      const dy = viewportPoint.y - handle.y;
      if (dx * dx + dy * dy <= hitRadiusSq) {
        return handle.id;
      }
    }
    return null;
  }

  // ============================================================
  // Private: Transform initialization
  // ============================================================

  private handleTranslateMove(viewportPoint: Point): void {
    const origin = this.dragPointerOrigin ?? this.dragStartPoint;
    if (!origin) return;

    const total = {
      x: viewportPoint.x - origin.x,
      y: viewportPoint.y - origin.y,
    };
    const constrained = constrainAxisScreenDelta(
      total.x,
      total.y,
      isConstrainMoveModifierHeld(modifiersStore.get()),
    );
    const screenDelta = {
      x: constrained.x - this.lastAppliedScreenTotal.x,
      y: constrained.y - this.lastAppliedScreenTotal.y,
    };

    const worldDelta = this.camera.screenDeltaToWorld(
      screenDelta.x,
      screenDelta.y,
    );

    if (worldDelta.x !== 0 || worldDelta.y !== 0) {
      for (const item of this.selectedItems) {
        this.paperRenderer.movePath(item, worldDelta);
      }
      this.lastAppliedScreenTotal = constrained;
      this.dragStartPoint = viewportPoint;
      this.noteLiveEditStarted();
    }
  }

  /** Mark the selection as dirty and refresh onion once on the first edit. */
  private noteLiveEditStarted(): void {
    if (this.didMove) return;
    this.didMove = true;
    this.onLiveEditStart?.();
  }

  // ============================================================
  // Private: Utilities
  // ============================================================

  private clearTransformState(): void {
    this.transformGizmo.reset();
    this.lastViewportPoint = null;
  }

  private beginDragThreshold(viewportPoint: Point): void {
    this.dragPointerOrigin = viewportPoint;
    this.dragPastThreshold = false;
  }

  private resetDragThreshold(): void {
    this.dragPointerOrigin = null;
    this.dragPastThreshold = false;
    this.lastAppliedScreenTotal = { x: 0, y: 0 };
  }

  /** Returns true once pointer has moved at least dragMoveThresholdSq from origin. */
  private pastDragThreshold(viewportPoint: Point): boolean {
    if (this.dragPastThreshold) return true;
    if (!this.dragPointerOrigin) return true;
    const dx = viewportPoint.x - this.dragPointerOrigin.x;
    const dy = viewportPoint.y - this.dragPointerOrigin.y;
    if (dx * dx + dy * dy >= this.dragMoveThresholdSq) {
      this.dragPastThreshold = true;
      return true;
    }
    return false;
  }

  private startMarquee(viewportPoint: Point): void {
    this.isDragging = false;
    this.dragStartPoint = null;
    this.marquee.start(viewportPoint);
    this.clearTransformState();
    if (this.selectionShape === "lasso") {
      this.syncLassoQuickShapePrefs();
      this.lassoQuickShape.begin(
        viewportPoint,
        () => this.marquee.getLassoPoints(),
        (path) => {
          this.marquee.setLassoPoints(path);
          this.drawUI();
        },
      );
    } else {
      this.lassoQuickShape.reset();
    }
  }

  private isDoubleClickOnShape(
    viewportPoint: Point,
    itemId: number,
    nowMs: number,
  ): boolean {
    const last = this.lastShapeClick;
    if (!last) return false;
    if (last.itemId !== itemId) return false;
    if (nowMs - last.timestampMs > this.doubleClickWindowMs) return false;
    const dx = viewportPoint.x - last.point.x;
    const dy = viewportPoint.y - last.point.y;
    return dx * dx + dy * dy <= this.doubleClickDistanceSq;
  }

  private resolvePendingSelectionForNewGesture(): void {
    if (this.selectionNeedsPlacement && !this.didMove) {
      this.revertPendingSelection();
    } else {
      this.placeSelection();
    }
  }

  /** Union `item` into the current selection, committing any pending extract first. */
  private addItemToSelection(item: paper.PathItem): void {
    let kept: paper.PathItem[] = [];
    if (this.selectedItems.length > 0) {
      if (this.selectionNeedsPlacement || this.didMove) {
        kept = this.paperRenderer.placeItemsAsSelection(this.selectedItems);
        this.pendingExtractionSnapshot = null;
        this.selectionNeedsPlacement = false;
        this.didMove = false;
      } else {
        kept = this.selectedItems.filter((existing) => !!existing.parent);
      }
    }
    if (!kept.some((existing) => existing.id === item.id)) {
      kept = [...kept, item];
    }
    this.setSelectedItems(kept);
  }

  private revertPendingSelection(): void {
    if (this.pendingExtractionSnapshot) {
      this.paperRenderer.restoreSelectableLayersSnapshot(
        this.pendingExtractionSnapshot,
      );
    }
    this.pendingExtractionSnapshot = null;
    this.selectedItems = [];
    this.selectionNeedsPlacement = false;
    this.didMove = false;
    this.handles = [];
    selectionStore.set({ items: [] });
  }

  private activateLayerForItem(item: paper.PathItem): void {
    const layerId = this.paperRenderer.getLayerIdForPathItem(item);
    if (layerId) this.onActivateLayer?.(layerId);
  }

  private activateTopmostSelectedLayer(): void {
    const layerId = this.paperRenderer.getTopmostSelectedLayerId(this.selectedItems);
    if (layerId) this.onActivateLayer?.(layerId);
  }

  private isSelectedItem(item: paper.Item): boolean {
    return this.selectedItems.some((selected) => selected.id === item.id);
  }

  private bringSelectionToFront(): void {
    for (const item of this.selectedItems) {
      this.paperRenderer.bringToFront(item);
    }
  }

  private hasActiveMarquee(): boolean {
    return this.marquee.hasActiveMarquee(this.selectionShape);
  }
}
