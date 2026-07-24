import paper from "paper";

export type OnionGhost = {
  jsons: string[];
  opacity: number;
  color: string;
};

/**
 * Owns onion-skin ghost layers: locked, dimmed renders of nearby animation
 * frames. Deliberately NOT in PaperRenderer.layerMap, so layer
 * restore/reorder/flatten logic never treats them as document content.
 */
export class OnionSkin {
  private layers: paper.Layer[] = [];
  /** When true, ghosts are stroked outlines above artwork; when false, filled under the active layer. */
  private outline = true;
  /** Minimum world-space stroke width for outline-mode onion-skin ghosts. */
  private readonly outlineWidth = 6;

  /** Read-only view of ghost layers (z-order / export / flatten skips). */
  getLayers(): readonly paper.Layer[] {
    return this.layers;
  }

  includes(layer: paper.Layer): boolean {
    return this.layers.includes(layer);
  }

  /** Remove all onion-skin ghost layers. */
  clear(): void {
    if (this.layers.length === 0) return;
    for (const layer of this.layers) layer.remove();
    this.layers = [];
    paper.view.update();
  }

  /**
   * Replace the onion-skin ghosts. Each ghost is one neighbor frame: its
   * visible layers' content JSONs (bottom→top), tinted with per-path opacity.
   * Outline mode sits above all artwork; filled mode sits under `restoreActive`
   * so current-layer paint covers the ghosts.
   *
   * Creating `paper.Layer` activates it; pass `restoreActive` so the real
   * document active layer is restored afterward.
   */
  set(
    ghosts: OnionGhost[],
    outline: boolean,
    restoreActive: paper.Layer | null | undefined,
  ): void {
    for (const layer of this.layers) layer.remove();
    this.layers = [];
    this.outline = outline;

    for (const ghost of ghosts) {
      const ghostLayer = new paper.Layer();
      ghostLayer.locked = true;

      for (const json of ghost.jsons) {
        if (!json) continue;
        // importJSON of a Layer payload fills the receiving layer; use a
        // scratch layer so multiple document layers combine into one ghost.
        const scratch = new paper.Layer();
        scratch.importJSON(json);
        ghostLayer.addChildren([...scratch.children]);
        scratch.remove();
      }

      // Outline-only ghosts: every shape becomes an unfilled tinted contour,
      // so ghosts never obscure the current frame's artwork.
      // Fade via path.opacity (not layer.opacity) — Paper can composite a
      // single fill-or-stroke path with ctx.globalAlpha; layer opacity forces
      // a full view-bounds offscreen canvas every redraw.
      const tint = new paper.Color(ghost.color);
      const outlineWidth = this.outlineWidth;
      const ghostOpacity = ghost.opacity;
      const styleGhost = (item: paper.Item) => {
        if (item instanceof paper.Path || item instanceof paper.CompoundPath) {
          // Path can use ctx.globalAlpha directly; CompoundPath still
          // offscreens, but only for that item's bounds — never the layer.
          item.opacity = ghostOpacity;
          if (outline) {
            const hadStroke = !!item.strokeColor;
            item.fillColor = null;
            item.strokeColor = tint.clone();
            item.strokeWidth = hadStroke
              ? Math.max(item.strokeWidth, outlineWidth)
              : outlineWidth;
          } else {
            item.fillColor = tint.clone();
            item.strokeColor = null;
            item.strokeWidth = 0;
          }
          // CompoundPath children are geometry only; don't restyle / re-fade.
          if (item instanceof paper.CompoundPath) return;
        }
        for (const child of item.children ?? []) styleGhost(child);
      };
      for (const child of [...ghostLayer.children]) styleGhost(child);
      this.layers.push(ghostLayer);
    }

    this.reposition(restoreActive);

    restoreActive?.activate();
    paper.view.update();
  }

  /**
   * Re-apply ghost z-order after document layers are reordered.
   * Outline → above all artwork; filled → immediately under `belowLayer`.
   */
  reposition(belowLayer?: paper.Layer | null): void {
    if (this.layers.length === 0) return;
    if (this.outline || !belowLayer) {
      for (const layer of this.layers) layer.bringToFront();
      return;
    }
    // Insert in order so later ghosts (e.g. next-keyframe) sit above earlier
    // ones while remaining under the active layer.
    for (const layer of this.layers) {
      layer.insertBelow(belowLayer);
    }
  }

  /** Temporarily hide ghosts while running `fn` (e.g. SVG export). */
  withHidden<T>(fn: () => T): T {
    const prevVisibility = this.layers.map((l) => l.visible);
    for (const layer of this.layers) layer.visible = false;
    try {
      return fn();
    } finally {
      this.layers.forEach((l, i) => (l.visible = prevVisibility[i]));
    }
  }
}
