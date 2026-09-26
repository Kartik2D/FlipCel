import paper from "paper";
import { getContainmentPoint, intersectOf, subtractOf, uniteOf } from "./path-geometry";
import { flattenGroups } from "./svg-io";
import type { MergePassResult } from "./types";

/**
 * The layer is a planar partition: non-overlapping single-color fills, no
 * meaningful stacking order. Every drawing op is one of the three functions
 * below; both the main thread and the merge worker run this code.
 */
export type MergeAdopt = {
  /** May these two items interact (EMF keyframe bucket)? */
  compatible(a: paper.PathItem, b: paper.PathItem): boolean;
  /** Copy style from `from` onto the boolean result `to`. */
  paint(from: paper.PathItem, to: paper.PathItem): void;
  /** Carry bookkeeping (selection markers, EMF tag) from `froms` onto `to`. */
  stamp?(froms: paper.PathItem[], to: paper.PathItem): void;
  /** `item` is leaving the layer; forget it. */
  removed?(item: paper.PathItem): void;
};

function pathsOnLayer(layer: paper.Layer): paper.PathItem[] {
  return layer.children.filter(
    (c): c is paper.PathItem =>
      c instanceof paper.Path || c instanceof paper.CompoundPath,
  );
}

function emfFrame(item: paper.Item): number | null {
  const frame = (item.data as { emfKeyframeFrame?: unknown } | null)?.emfKeyframeFrame;
  return typeof frame === "number" && Number.isFinite(frame) ? frame : null;
}

function copyEmf(source: paper.Item, target: paper.Item): void {
  const frame = emfFrame(source);
  if (frame === null) return;
  const data = (target.data as Record<string, unknown> | null) ?? {};
  data.emfKeyframeFrame = frame;
  target.data = data;
}

function copyFill(source: paper.PathItem, target: paper.PathItem): void {
  target.fillColor = source.fillColor ? source.fillColor.clone() : null;
  target.strokeColor = null;
  target.strokeWidth = 0;
}

function fillKey(item: paper.PathItem): string {
  return item.fillColor?.toCSS(true) ?? "none";
}

function sameEmf(a: paper.PathItem, b: paper.PathItem): boolean {
  return emfFrame(a) === emfFrame(b);
}

/** Adopt used off the main thread. Stale EMF tags are ignored when EMF is off. */
export function plainAdopt(emfActive: boolean): MergeAdopt {
  return {
    compatible: emfActive ? sameEmf : () => true,
    paint: copyFill,
    stamp: (froms, to) => copyEmf(froms[0]!, to),
  };
}

/** Live AABB neighbors of `seed` on `layer`, excluding `skip`. */
function neighbors(
  layer: paper.Layer,
  seed: paper.PathItem,
  skip: Set<number> = new Set(),
): paper.PathItem[] {
  const expanded = seed.bounds.expand(4);
  return pathsOnLayer(layer).filter(
    (item) =>
      item.parent &&
      item !== seed &&
      !skip.has(item.id) &&
      expanded.intersects(item.bounds),
  );
}

function forget(item: paper.PathItem, adopt: MergeAdopt): void {
  adopt.removed?.(item);
  item.remove();
}

/** `neighbor := neighbor − cutter`; "gone" removes it. */
function cutNeighbor(
  neighbor: paper.PathItem,
  cutter: paper.PathItem,
  adopt: MergeAdopt,
  changed: paper.PathItem[],
): void {
  const cut = subtractOf(neighbor, cutter);
  if (cut === "gone") {
    forget(neighbor, adopt);
    return;
  }
  if (!cut || cut === "unchanged") return;
  adopt.paint(neighbor, cut);
  adopt.stamp?.([neighbor], cut);
  adopt.removed?.(neighbor);
  neighbor.replaceWith(cut);
  changed.push(cut);
}

/** Add fills: cut every other-color fill they touch, unite same-color ones. */
export function addToLayer(
  layer: paper.Layer,
  additions: paper.PathItem[],
  adopt: MergeAdopt,
  /** `null` = cut all other-color neighbors. A set limits the cut loop to those ids. */
  cutTargets: Set<number> | null = null,
): MergePassResult {
  const changed: paper.PathItem[] = [];
  const survivors: paper.PathItem[] = [];

  for (const addition of additions) {
    if (!addition.parent) continue;
    const color = fillKey(addition);

    for (const n of neighbors(layer, addition)) {
      if (!n.parent || fillKey(n) === color || !adopt.compatible(addition, n)) continue;
      if (cutTargets && !cutTargets.has(n.id)) continue;
      cutNeighbor(n, addition, adopt, changed);
    }

    let current = addition;
    const tried = new Set<number>();
    for (let grew = true; grew; ) {
      grew = false;
      for (const n of neighbors(layer, current)) {
        if (!n.parent || tried.has(n.id)) continue;
        tried.add(n.id);
        if (fillKey(n) !== color || !adopt.compatible(current, n)) continue;
        const united = uniteOf(current, n);
        if (!united) continue;
        adopt.paint(current, united);
        adopt.stamp?.([current, n], united);
        forget(current, adopt);
        forget(n, adopt);
        layer.addChild(united);
        changed.push(united);
        current = united;
        grew = true;
      }
    }
    if (current.parent) survivors.push(current);
  }

  return splitResult({ survivors, changedItems: changed }, adopt);
}

/**
 * Stacked / painter's SVGs: add back → front so each fill only cuts what is
 * already committed. Avoids a full-image back fill deleting everything else.
 */
export function addToLayerSequential(
  layer: paper.Layer,
  additions: paper.PathItem[],
  adopt: MergeAdopt,
): void {
  const pending = [...additions];
  for (const item of pending) item.remove();
  let committed = new Set<number>();
  for (const item of pending) {
    layer.addChild(item);
    addToLayer(layer, [item], adopt, committed);
    committed = new Set(pathsOnLayer(layer).map((child) => child.id));
  }
}

/** Erase: cut every fill the cutters touch, then drop the cutters. */
export function subtractFromLayer(
  layer: paper.Layer,
  cutters: paper.PathItem[],
  adopt: MergeAdopt,
): MergePassResult {
  const changed: paper.PathItem[] = [];
  const skip = new Set(cutters.map((c) => c.id));
  for (const cutter of cutters) {
    if (!cutter.parent) continue;
    for (const n of neighbors(layer, cutter, skip)) {
      if (!n.parent || !adopt.compatible(cutter, n)) continue;
      cutNeighbor(n, cutter, adopt, changed);
    }
    forget(cutter, adopt);
  }
  return splitResult({ survivors: [], changedItems: changed }, adopt);
}

/**
 * Inside mode. With `clip`: paint only within that fill. Without: paint
 * only where nothing is filled yet (behind). Then a normal add.
 */
export function paintInsideLayer(
  layer: paper.Layer,
  incoming: paper.PathItem[],
  clip: paper.PathItem | null,
  adopt: MergeAdopt,
): MergePassResult {
  const skip = new Set(incoming.map((p) => p.id));
  const pieces: paper.PathItem[] = [];

  for (const p of incoming) {
    if (!p.parent) continue;
    let cur: paper.PathItem | null = p;
    if (clip) {
      cur = intersectOf(p, clip);
    } else {
      for (const ex of neighbors(layer, p, skip)) {
        if (!cur) break;
        if (!ex.parent || !adopt.compatible(p, ex)) continue;
        const cut = subtractOf(cur, ex);
        if (cut === "gone") {
          if (cur !== p) cur.remove();
          cur = null;
        } else if (cut && cut !== "unchanged") {
          if (cur !== p) cur.remove();
          cur = cut;
        }
      }
    }
    if (cur && cur !== p) {
      adopt.paint(p, cur);
      adopt.stamp?.([p], cur);
      layer.addChild(cur);
    }
    if (cur !== p) forget(p, adopt);
    if (cur) pieces.push(cur);
  }

  // Paint-behind pieces already subtracted every neighbor; clip pieces can
  // only overlap `clip`. Re-cutting coincident edges drops stroke chains.
  return addToLayer(layer, pieces, adopt, clip ? new Set([clip.id]) : new Set());
}

/** Replace compounds in the result with their disconnected pieces. */
function splitResult(result: MergePassResult, adopt: MergeAdopt): MergePassResult {
  const memo = new Map<number, paper.PathItem[]>();
  const changedItems = splitCompounds(result.changedItems, adopt, memo);
  const survivors = splitCompounds(result.survivors, adopt, memo);
  return { survivors, changedItems };
}

/** `items` with every disconnected compound replaced by its pieces. */
export function splitCompounds(
  items: paper.PathItem[],
  adopt: MergeAdopt,
  memo = new Map<number, paper.PathItem[]>(),
): paper.PathItem[] {
  return items.flatMap((item) => {
    const hit = memo.get(item.id);
    if (hit) return hit;
    if (!item.parent) return [];
    const out =
      item instanceof paper.CompoundPath ? splitCompound(item, adopt) : [item];
    memo.set(item.id, out);
    return out;
  });
}

/** One evenodd compound → one item per filled region (with its holes). */
function splitCompound(item: paper.CompoundPath, adopt: MergeAdopt): paper.PathItem[] {
  const layer = item.layer;
  if (!layer || !item.parent || item.children.length <= 1) return [item];

  const subs = item.children as paper.Path[];
  const n = subs.length;
  const subData = subs.map((s) => s.pathData);
  const parents: Array<number | null> = new Array(n).fill(null);
  const absArea = subs.map((p) => {
    try {
      return Math.abs(p.area);
    } catch {
      return Math.abs(p.bounds.area);
    }
  });
  const interiorPoints = subs.map((p) => getContainmentPoint(p));

  for (let i = 0; i < n; i++) {
    let bestParent: number | null = null;
    let bestArea = Infinity;
    const pt = interiorPoints[i];
    if (!pt) continue;
    for (let j = 0; j < n; j++) {
      if (i === j || !subs[j].bounds.contains(subs[i].bounds)) continue;
      let nested = false;
      try {
        nested = subs[j].contains(pt);
      } catch {}
      if (!nested) continue;
      if (absArea[j] < bestArea) {
        bestArea = absArea[j];
        bestParent = j;
      }
    }
    parents[i] = bestParent;
  }

  const depth = new Array(n).fill(0);
  const computeDepth = (i: number): number => {
    const p = parents[i];
    if (p == null) return 0;
    const d = computeDepth(p) + 1;
    depth[i] = d;
    return d;
  };
  for (let i = 0; i < n; i++) computeDepth(i);

  const nearestEven = (i: number): number => {
    if (depth[i] % 2 === 0) return i;
    const p = parents[i];
    return p == null ? i : nearestEven(p);
  };

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = nearestEven(i);
    if (!groups.has(root)) groups.set(root, []);
    if (i === root || depth[i] % 2 === 1) groups.get(root)!.push(i);
  }

  const filledRoots = [...groups.keys()].filter((k) => depth[k] % 2 === 0);
  if (filledRoots.length <= 1) return [item];

  let insertAt = layer.children.indexOf(item);
  const out: paper.PathItem[] = [];
  for (const root of filledRoots) {
    const indices = groups.get(root) ?? [root];
    let piece: paper.PathItem;
    if (indices.length === 1) {
      const path = new paper.Path(subData[root]);
      path.closed = subs[root].closed;
      piece = path;
    } else {
      const compound = new paper.CompoundPath([]);
      compound.fillRule = "evenodd";
      for (const ci of indices) {
        const child = new paper.Path(subData[ci]);
        child.closed = subs[ci].closed;
        compound.addChild(child);
      }
      piece = compound;
    }
    adopt.paint(item, piece);
    adopt.stamp?.([item], piece);
    layer.insertChild(insertAt++, piece);
    out.push(piece);
  }
  forget(item, adopt);
  return out;
}

function appendLayerJson(target: paper.Layer, json: string): void {
  if (!json) return;
  const temp = new paper.Layer();
  temp.importJSON(json);
  for (const child of [...temp.children]) target.addChild(child);
  temp.remove();
}

/** Import base + additions JSON, add-merge, export. Activates a scratch layer. */
export function mergeJsons(
  baseJson: string,
  additionsJson: string,
  emfActive = false,
): string {
  if (!additionsJson) return baseJson;
  if (!baseJson) return additionsJson;

  const previousActive = paper.project.activeLayer;
  const scratch = new paper.Layer();
  appendLayerJson(scratch, baseJson);
  scratch.activate();
  flattenGroups();
  const belowIds = new Set(pathsOnLayer(scratch).map((p) => p.id));
  appendLayerJson(scratch, additionsJson);
  flattenGroups();
  const additions = pathsOnLayer(scratch).filter((p) => !belowIds.has(p.id));
  if (additions.length > 0) addToLayer(scratch, additions, plainAdopt(emfActive));
  flattenGroups();
  const out =
    scratch.children.length === 0 ? "" : ((scratch.exportJSON() as string) ?? "");
  scratch.remove();
  previousActive?.activate();
  return out;
}

export function exportItemsJson(items: paper.PathItem[]): string {
  if (items.length === 0) return "";
  const previousActive = paper.project.activeLayer;
  const scratch = new paper.Layer();
  for (const item of items) {
    scratch.addChild(item.clone({ insert: false }) as paper.PathItem);
  }
  const json = (scratch.exportJSON() as string) ?? "";
  scratch.remove();
  previousActive?.activate();
  return json;
}
