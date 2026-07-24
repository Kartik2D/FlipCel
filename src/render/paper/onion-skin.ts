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
  /** Minimum world-space stroke width for outline-mode onion-skin ghosts. */
  private readonly outlineWidth = 3;

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
   * visible layers' content JSONs (bottom→top), rendered as tinted outlines
   * (no fill) at the given opacity. Ghost layers are locked and sit above
   * all artwork.
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
      const tint = new paper.Color(ghost.color);
      const outlineWidth = this.outlineWidth;
      const styleGhost = (item: paper.Item) => {
        if (item instanceof paper.Path || item instanceof paper.CompoundPath) {
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
        }
        for (const child of item.children ?? []) styleGhost(child);
      };
      for (const child of [...ghostLayer.children]) styleGhost(child);
      ghostLayer.opacity = ghost.opacity;
      this.layers.push(ghostLayer);
    }

    // Ghosts render above all artwork so they stay readable; being unfilled
    // outlines, they don't obscure the frame underneath. Walk in order so
    // later ghosts (next-keyframe) end up topmost.
    this.bringToFront();

    restoreActive?.activate();
    paper.view.update();
  }

  /** Keep ghosts above all artwork after document layers are reordered. */
  bringToFront(): void {
    for (const layer of this.layers) {
      layer.bringToFront();
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
