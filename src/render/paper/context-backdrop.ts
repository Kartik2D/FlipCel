/**
 * Edit-in-place backdrop: dimmed, locked renders of the parent timeline(s)
 * shown behind/above the symbol being edited, transformed into the symbol's
 * local space (inverse of the entered instance's world matrix). Like
 * OnionSkin, these layers are NOT in PaperRenderer.layerMap.
 */
import paper from "paper";
import { coveringKeyframeOf, EMPTY_CONTENT_ID, type Keyframe } from "../../document/keyframes";
import type { SymbolResolver } from "../../document/symbols";
import { hydrateInstance, isSymbolInstance, readInstance } from "./symbol-instances";

export interface BackdropTrack {
  id: string;
  visible: boolean;
  kind?: string;
  keyframes: Keyframe[];
}

/** One context level, outermost first in the array passed to `set`. */
export interface BackdropLevel {
  tracks: BackdropTrack[];
  /** Parent playhead when this level was entered. */
  frame: number;
  /** Instance entered through (null = isolated edit; nothing shown beyond it). */
  instanceIid: string | null;
  layerId: string | null;
  /** Instance local → parent matrix [a b c d tx ty]. */
  matrix: [number, number, number, number, number, number] | null;
}

/**
 * Parent-of-outermost-visible-level → innermost local matrix for a context
 * stack (outermost first). Null when the innermost level is isolated (no
 * backdrop). Stops at the first isolated level walking outward.
 */
export function composeContextToLocal(
  levels: ReadonlyArray<Pick<BackdropLevel, "instanceIid" | "matrix">>,
): paper.Matrix | null {
  const innermost = levels[levels.length - 1];
  if (!innermost || !innermost.instanceIid || !innermost.matrix) return null;
  const acc = new paper.Matrix();
  for (let i = levels.length - 1; i >= 0; i--) {
    const level = levels[i]!;
    if (!level.instanceIid || !level.matrix) break;
    const [a, b, c, d, tx, ty] = level.matrix;
    acc.append(new paper.Matrix(a, b, c, d, tx, ty).inverted());
  }
  return acc;
}

export class ContextBackdrop {
  private below: paper.Layer | null = null;
  private above: paper.Layer | null = null;

  getLayers(): paper.Layer[] {
    const out: paper.Layer[] = [];
    if (this.below) out.push(this.below);
    if (this.above) out.push(this.above);
    return out;
  }

  includes(layer: paper.Item): boolean {
    return layer === this.below || layer === this.above;
  }

  isActive(): boolean {
    return this.below !== null || this.above !== null;
  }

  clear(): void {
    if (!this.below && !this.above) return;
    this.below?.remove();
    this.above?.remove();
    this.below = null;
    this.above = null;
    paper.view.update();
  }

  /**
   * Rebuild from the context stack (outermost first). Creating layers
   * activates them; `restoreActive` is re-activated afterwards.
   */
  set(
    levels: BackdropLevel[],
    resolver: SymbolResolver,
    restoreActive: paper.Layer | null | undefined,
    opacity = 0.3,
  ): void {
    this.below?.remove();
    this.above?.remove();
    this.below = null;
    this.above = null;

    const innermost = levels[levels.length - 1];
    if (!innermost || !innermost.instanceIid || !innermost.matrix) {
      restoreActive?.activate();
      return;
    }

    const below = new paper.Layer();
    below.locked = true;
    const above = new paper.Layer();
    above.locked = true;

    // Accumulated parent → local transform; grows outward one level at a time.
    const acc = new paper.Matrix();
    for (let i = levels.length - 1; i >= 0; i--) {
      const level = levels[i]!;
      if (!level.instanceIid || !level.matrix) break;
      const [a, b, c, d, tx, ty] = level.matrix;
      acc.append(new paper.Matrix(a, b, c, d, tx, ty).inverted());
      this.appendLevel(level, resolver, acc, below, above);
    }

    const dim = (item: paper.Item) => {
      if (item instanceof paper.Path || item instanceof paper.CompoundPath) {
        item.opacity = opacity;
        if (item instanceof paper.CompoundPath) return;
      } else if (item instanceof paper.Raster) {
        item.opacity = opacity;
        return;
      }
      for (const child of item.children ?? []) dim(child);
    };
    for (const child of below.children) dim(child);
    for (const child of above.children) dim(child);

    this.below = below;
    this.above = above;
    this.reposition();
    restoreActive?.activate();
    paper.view.update();
  }

  private appendLevel(
    level: BackdropLevel,
    resolver: SymbolResolver,
    toLocal: paper.Matrix,
    below: paper.Layer,
    above: paper.Layer,
  ): void {
    const frame = Math.max(0, Math.round(level.frame));
    const entryIndex = level.tracks.findIndex((t) => t.id === level.layerId);
    let seenEntry = false;

    level.tracks.forEach((track, index) => {
      if (!track.visible) return;
      if (track.kind === "audio") return;
      const kf = coveringKeyframeOf(track, frame);
      if (!kf || kf.contentId === EMPTY_CONTENT_ID) return;
      const json = resolver.getContent(kf.contentId);
      if (!json) return;
      const elapsed = frame - kf.frameIndex;

      const scratch = new paper.Layer();
      scratch.importJSON(json);
      const children = [...scratch.children];
      scratch.remove();

      const isEntryLayer = index === entryIndex;
      for (const item of children) {
        if (isSymbolInstance(item)) {
          const data = readInstance(item);
          if (isEntryLayer && data?.iid === level.instanceIid) {
            seenEntry = true;
            item.remove();
            continue;
          }
          hydrateInstance(item, resolver, elapsed);
        }
        item.transform(toLocal);
        const goesAbove = entryIndex < 0 ? false : index > entryIndex || (isEntryLayer && seenEntry);
        (goesAbove ? above : below).addChild(item);
      }
    });
  }

  /** Below → bottom of the stack; above → top (caller re-raises overlays). */
  reposition(): void {
    this.below?.sendToBack();
    this.above?.bringToFront();
  }

  withHidden<T>(fn: () => T): T {
    const layers = this.getLayers();
    const prev = layers.map((l) => l.visible);
    for (const l of layers) l.visible = false;
    try {
      return fn();
    } finally {
      layers.forEach((l, i) => (l.visible = prev[i]!));
    }
  }
}
