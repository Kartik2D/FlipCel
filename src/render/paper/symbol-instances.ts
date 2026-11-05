/**
 * Symbol instances on Paper layers.
 *
 * An instance is a `paper.Group` with `applyMatrix = false`, a local pivot,
 * and `data` = `SymbolInstanceData`. It carries no persisted children: the
 * referenced symbol frame is *hydrated* into it for display and *stripped*
 * before any export so stored layer JSON stays small and stable.
 *
 * Instances are not PathItems, so the planar merge kernel, fill, magnet and
 * direct-select ignore them by construction. They always sit above the
 * shapes on their layer (`normalizeInstanceOrder`).
 *
 * All helpers take an explicit PaperScope so offscreen exports and the merge
 * worker can use them.
 */
import paper from "paper";
import {
  childFrameFor,
  instanceAnimates,
  newInstanceId,
  normalizeInstanceData,
  resolveSymbolFrame,
  type SymbolInstanceData,
  type SymbolResolver,
} from "../../document/symbols";

export const MAX_SYMBOL_DEPTH = 8;

type Scope = typeof paper;

/** A hydratable instance group (brand keeps `!isSymbolInstance(group)` useful). */
export type SymbolInstanceGroup = paper.Group & { data: SymbolInstanceData };

export function isSymbolInstance(
  item: paper.Item | null | undefined,
): item is SymbolInstanceGroup {
  if (!item || !(item instanceof paper.Group)) return false;
  const data = item.data as { symbol?: unknown } | null;
  return !!data && typeof data.symbol === "string" && data.symbol.length > 0;
}

export function readInstance(group: paper.Item): SymbolInstanceData | null {
  return normalizeInstanceData(group.data);
}

export function writeInstance(group: paper.Item, data: SymbolInstanceData): void {
  group.data = { ...data };
}

/** Root instance groups on a layer (document order). */
export function instancesOnLayer(layer: paper.Item): paper.Group[] {
  return layer.children.filter((c): c is paper.Group => isSymbolInstance(c));
}

/** Walk up to the layer's direct child; the instance if that is one. */
export function instanceRootOf(item: paper.Item | null): paper.Group | null {
  let cur: paper.Item | null = item;
  while (cur && cur.parent && !(cur.parent instanceof paper.Layer)) cur = cur.parent;
  return cur && isSymbolInstance(cur) ? cur : null;
}

/** New empty instance at `worldPoint` (pivot = symbol origin). Not inserted. */
export function createInstance(
  data: SymbolInstanceData,
  worldPoint: { x: number; y: number },
  scope: Scope = paper,
): paper.Group {
  const group = new scope.Group({ insert: false });
  group.applyMatrix = false;
  group.pivot = new scope.Point(0, 0);
  writeInstance(group, data);
  group.matrix = new scope.Matrix(1, 0, 0, 1, worldPoint.x, worldPoint.y);
  return group;
}

export function duplicateInstance(group: paper.Group): paper.Group {
  const copy = group.clone({ insert: true }) as paper.Group;
  const data = readInstance(copy);
  if (data) writeInstance(copy, { ...data, iid: newInstanceId() });
  return copy;
}

// ------------------------------------------------------------
// Template cache (parsed content → cloned per hydration)
// ------------------------------------------------------------

class TemplateCache {
  private templates = new Map<string, paper.Group>();
  private readonly max = 256;

  children(json: string, scope: Scope): paper.Item[] {
    let tpl = this.templates.get(json);
    if (!tpl) {
      const prevActive = scope.project.activeLayer;
      const scratch = new scope.Layer();
      scratch.importJSON(json);
      tpl = new scope.Group({ insert: false });
      tpl.addChildren([...scratch.children]);
      scratch.remove();
      prevActive?.activate();
      if (this.templates.size >= this.max) {
        const oldest = this.templates.keys().next().value;
        if (oldest !== undefined) {
          this.templates.get(oldest)?.remove();
          this.templates.delete(oldest);
        }
      }
      this.templates.set(json, tpl);
    }
    return tpl.children.map((c) => c.clone({ insert: false }));
  }

  clear(): void {
    for (const tpl of this.templates.values()) tpl.remove();
    this.templates.clear();
  }
}

const cacheByScope = new WeakMap<object, TemplateCache>();
function cacheFor(scope: Scope): TemplateCache {
  let c = cacheByScope.get(scope);
  if (!c) {
    c = new TemplateCache();
    cacheByScope.set(scope, c);
  }
  return c;
}

export function clearSymbolTemplateCache(scope: Scope = paper): void {
  cacheByScope.get(scope)?.clear();
}

// ------------------------------------------------------------
// Hydrate / strip
// ------------------------------------------------------------

/**
 * Fill an instance group with the symbol frame it shows at `elapsed` frames
 * into its covering keyframe. Nested instances recurse with their own
 * elapsed. Returns true when the instance animates (needs per-frame work).
 */
export function hydrateInstance(
  group: paper.Group,
  resolver: SymbolResolver,
  elapsed: number,
  scope: Scope = paper,
  depth = 0,
  visiting: ReadonlySet<string> = new Set(),
): boolean {
  group.removeChildren();
  const data = readInstance(group);
  if (!data) return false;
  if (depth > MAX_SYMBOL_DEPTH || visiting.has(data.symbol)) return false;
  const symbol = resolver.getSymbol(data.symbol);
  if (!symbol) return false;

  const childFrame = childFrameFor(data, elapsed, symbol.duration);
  const layers = resolveSymbolFrame(symbol, childFrame, resolver);
  if (layers.length === 0) return instanceAnimates(data, symbol.duration);

  const nextVisiting = new Set(visiting);
  nextVisiting.add(symbol.id);
  const cache = cacheFor(scope);
  let animates = instanceAnimates(data, symbol.duration);
  for (const layer of layers) {
    for (const child of cache.children(layer.json, scope)) {
      if (isSymbolInstance(child)) {
        if (
          hydrateInstance(
            child,
            resolver,
            childFrame - layer.keyframeFrame,
            scope,
            depth + 1,
            nextVisiting,
          )
        ) {
          animates = true;
        }
      }
      group.addChild(child);
    }
  }
  return animates;
}

/** Hydrate every root instance on a layer. Returns true when any animates. */
export function hydrateLayer(
  layer: paper.Layer,
  resolver: SymbolResolver,
  elapsed: number,
  scope: Scope = paper,
): boolean {
  let animates = false;
  for (const inst of instancesOnLayer(layer)) {
    if (hydrateInstance(inst, resolver, elapsed, scope)) animates = true;
  }
  return animates;
}

/** Run `fn` with every root instance on `layer` emptied, then restore. */
export function withInstancesStripped<T>(layer: paper.Layer, fn: () => T): T {
  const stash: Array<[paper.Group, paper.Item[]]> = [];
  for (const inst of instancesOnLayer(layer)) {
    if (inst.children.length === 0) continue;
    stash.push([inst, inst.removeChildren()]);
  }
  try {
    return fn();
  } finally {
    for (const [inst, kids] of stash) inst.addChildren(kids);
  }
}

/** Run `fn` with instances hidden (e.g. fill-tool rasterization). */
export function withInstancesHidden<T>(layers: Iterable<paper.Layer>, fn: () => T): T {
  const hidden: paper.Group[] = [];
  for (const layer of layers) {
    for (const inst of instancesOnLayer(layer)) {
      if (!inst.visible) continue;
      inst.visible = false;
      hidden.push(inst);
    }
  }
  try {
    return fn();
  } finally {
    for (const inst of hidden) inst.visible = true;
  }
}

/** Keep instances above shapes (relative instance order preserved). */
export function normalizeInstanceOrder(layer: paper.Layer): boolean {
  const kids = layer.children;
  let firstInstance = -1;
  let needs = false;
  for (let i = 0; i < kids.length; i++) {
    if (isSymbolInstance(kids[i])) {
      if (firstInstance === -1) firstInstance = i;
    } else if (firstInstance !== -1) {
      needs = true;
      break;
    }
  }
  if (!needs) return false;
  for (const inst of instancesOnLayer(layer)) layer.addChild(inst);
  return true;
}

/**
 * Re-import `json` into `layer` while keeping existing instance *objects*
 * (matched by iid) so selections survive merge-worker rebuilds. The
 * imported stub's matrix/pivot/data win; children are re-hydrated by caller.
 */
export function replaceLayerContentKeepingInstances(
  layer: paper.Layer,
  json: string,
): void {
  const keep = new Map<string, paper.Group>();
  for (const inst of instancesOnLayer(layer)) {
    const data = readInstance(inst);
    if (data) keep.set(data.iid, inst);
  }
  for (const inst of keep.values()) inst.remove();
  layer.removeChildren();
  if (json) layer.importJSON(json);
  if (keep.size === 0) return;
  for (const stub of instancesOnLayer(layer)) {
    const data = readInstance(stub);
    const original = data ? keep.get(data.iid) : undefined;
    if (!original) continue;
    original.removeChildren();
    original.matrix = stub.matrix.clone();
    original.pivot = stub.pivot ? stub.pivot.clone() : new paper.Point(0, 0);
    original.data = { ...(stub.data as object) };
    stub.replaceWith(original);
  }
}
