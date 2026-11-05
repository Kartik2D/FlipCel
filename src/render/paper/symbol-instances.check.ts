// Symbol fixture. Run: npm run check:symbols
import paper from "paper";
import {
  childFrameFor,
  resolveSymbolFrame,
  scanInstanceSymbolIds,
  type SymbolDefinition,
  type SymbolResolver,
} from "../../document/symbols";
import { EMPTY_CONTENT_ID } from "../../document/keyframes";
import { mergeJsons } from "./merge-layer";
import { flattenGroups } from "./svg-io";
import { collectTargets, type SnapSettings } from "../../editing/snap";
import type { PaperRenderer } from "../paper-renderer";
import {
  createInstance,
  hydrateInstance,
  hydrateLayer,
  instancesOnLayer,
  isSymbolInstance,
  normalizeInstanceOrder,
  readInstance,
  replaceLayerContentKeepingInstances,
  withInstancesStripped,
} from "./symbol-instances";

paper.setup(new paper.Size(1, 1));
const RED = "#ff0000";
const BLUE = "#0000ff";

function eq(name: string, got: unknown, want: unknown): void {
  if (got !== want) throw new Error(`${name}: got ${String(got)}, want ${String(want)}`);
}
function near(name: string, got: number, want: number, tol = 1e-6): void {
  if (Math.abs(got - want) > tol) throw new Error(`${name}: got ${got}, want ${want}`);
}
function fresh(): paper.Layer {
  paper.project.clear();
  const layer = new paper.Layer();
  layer.activate();
  return layer;
}
function rect(x1: number, y1: number, x2: number, y2: number, color: string): paper.Path {
  return new paper.Path.Rectangle({ from: [x1, y1], to: [x2, y2], fillColor: color });
}
function layerJson(build: (layer: paper.Layer) => void): string {
  const prev = paper.project.activeLayer;
  const scratch = new paper.Layer();
  build(scratch);
  const json = scratch.exportJSON() as string;
  scratch.remove();
  prev?.activate();
  return json;
}

// --- Frame math -------------------------------------------------------------
eq("loop wraps", childFrameFor({ mode: "loop", firstFrame: 0 }, 5, 4), 1);
eq("loop firstFrame", childFrameFor({ mode: "loop", firstFrame: 2 }, 3, 4), 1);
eq("once clamps", childFrameFor({ mode: "once", firstFrame: 1 }, 10, 4), 3);
eq("single fixed", childFrameFor({ mode: "single", firstFrame: 2 }, 10, 4), 2);
eq("single clamp", childFrameFor({ mode: "single", firstFrame: 9 }, 0, 4), 3);
eq("duration 1", childFrameFor({ mode: "loop", firstFrame: 0 }, 7, 1), 0);

// --- Symbol content (origin-centered red square, two frames) ---------------
const frameA = layerJson((l) => l.addChild(rect(-10, -10, 10, 10, RED)));
const frameB = layerJson((l) => l.addChild(rect(-20, -20, 20, 20, BLUE)));
const content = new Map<string, string>([
  ["a", frameA],
  ["b", frameB],
  [EMPTY_CONTENT_ID, ""],
]);
const square: SymbolDefinition = {
  id: "sym1",
  name: "Square",
  duration: 4,
  tags: [],
  tracks: [
    {
      id: "t1",
      name: "Layer 1",
      visible: true,
      locked: false,
      kind: "vector",
      keyframes: [
        { frameIndex: 0, contentId: "a", holdUntil: 1 },
        { frameIndex: 2, contentId: "b", holdUntil: 3 },
      ],
    },
  ],
};
const symbols = new Map<string, SymbolDefinition>([[square.id, square]]);
const resolver: SymbolResolver = {
  getSymbol: (id) => symbols.get(id) ?? null,
  getContent: (id) => content.get(id) ?? "",
};

eq("resolve f0", resolveSymbolFrame(square, 0, resolver)[0]?.contentId, "a");
eq("resolve f1 hold", resolveSymbolFrame(square, 1, resolver)[0]?.keyframeFrame, 0);
eq("resolve f3", resolveSymbolFrame(square, 3, resolver)[0]?.contentId, "b");

// --- Instance JSON round trip ----------------------------------------------
{
  const layer = fresh();
  const inst = createInstance(
    { symbol: "sym1", iid: "i1", mode: "loop", firstFrame: 0 },
    { x: 100, y: 50 },
  );
  layer.addChild(inst);
  inst.rotate(90);
  inst.scale(2);
  const stripped = layer.exportJSON() as string;
  eq("stripped has no paths", stripped.includes('"Path"'), false);
  eq("stripped has symbol", scanInstanceSymbolIds(stripped)[0], "sym1");

  const animates = hydrateLayer(layer, resolver, 0);
  eq("hydrated children", inst.children.length, 1);
  eq("loop animates", animates, true);
  near("hydrated bounds w", inst.bounds.width, 40);
  near("position x (pivot)", inst.position.x, 100);
  near("position y (pivot)", inst.position.y, 50);

  const exported = withInstancesStripped(layer, () => layer.exportJSON() as string);
  eq("strip round-trip", exported, stripped);
  eq("children restored", inst.children.length, 1);

  // Re-import: applyMatrix/pivot/matrix preserved.
  const layer2 = new paper.Layer();
  layer2.importJSON(exported);
  const inst2 = instancesOnLayer(layer2)[0]!;
  eq("reimport is instance", isSymbolInstance(inst2), true);
  eq("reimport applyMatrix", inst2.applyMatrix, false);
  near("reimport position", inst2.position.x, 100);
  near("reimport scale", inst2.matrix.scaling.x, 2);
  eq("reimport iid", readInstance(inst2)?.iid, "i1");
  hydrateInstance(inst2, resolver, 2);
  near("elapsed 2 -> frame b", inst2.bounds.width, 80);
}

// --- flattenGroups keeps instances, dissolves plain groups -----------------
{
  const layer = fresh();
  const plain = new paper.Group([rect(0, 0, 5, 5, RED)]);
  layer.addChild(plain);
  const inst = createInstance(
    { symbol: "sym1", iid: "i2", mode: "single", firstFrame: 0 },
    { x: 0, y: 0 },
  );
  layer.addChild(inst);
  hydrateLayer(layer, resolver, 0);
  flattenGroups();
  eq("plain group dissolved", layer.children.filter((c) => c instanceof paper.Group).length, 1);
  eq("instance intact", inst.parent === layer && inst.children.length === 1, true);
}

// --- normalizeInstanceOrder -------------------------------------------------
{
  const layer = fresh();
  const i1 = createInstance({ symbol: "sym1", iid: "i3", mode: "loop", firstFrame: 0 }, { x: 0, y: 0 });
  const i2 = createInstance({ symbol: "sym1", iid: "i4", mode: "loop", firstFrame: 0 }, { x: 0, y: 0 });
  layer.addChild(i1);
  layer.addChild(rect(0, 0, 1, 1, RED));
  layer.addChild(i2);
  layer.addChild(rect(0, 0, 1, 1, BLUE));
  eq("needed", normalizeInstanceOrder(layer), true);
  eq("shapes first", isSymbolInstance(layer.children[0]) || isSymbolInstance(layer.children[1]), false);
  eq("i1 before i2", layer.children[2] === i1 && layer.children[3] === i2, true);
  eq("idempotent", normalizeInstanceOrder(layer), false);
}

// --- mergeJsons keeps instances above shapes ------------------------------
{
  const base = layerJson((l) => {
    l.addChild(rect(0, 0, 10, 10, RED));
    l.addChild(
      createInstance({ symbol: "sym1", iid: "i5", mode: "loop", firstFrame: 0 }, { x: 5, y: 5 }),
    );
  });
  const add = layerJson((l) => l.addChild(rect(5, 5, 15, 15, BLUE)));
  const merged = mergeJsons(base, add);
  const layer = fresh();
  layer.importJSON(merged);
  const kids = layer.children;
  eq("merged count", kids.length, 3);
  eq("instance last", isSymbolInstance(kids[kids.length - 1]), true);
  eq("instance iid kept", readInstance(kids[kids.length - 1]!)?.iid, "i5");
  eq("blue cut red", kids.filter((k) => !isSymbolInstance(k)).length, 2);
}

// --- replaceLayerContentKeepingInstances preserves identity ---------------
{
  const layer = fresh();
  const inst = createInstance({ symbol: "sym1", iid: "i6", mode: "loop", firstFrame: 0 }, { x: 0, y: 0 });
  layer.addChild(inst);
  hydrateLayer(layer, resolver, 0);
  const moved = layerJson((l) => {
    l.addChild(rect(0, 0, 3, 3, RED));
    l.addChild(
      createInstance({ symbol: "sym1", iid: "i6", mode: "loop", firstFrame: 0 }, { x: 40, y: 0 }),
    );
  });
  replaceLayerContentKeepingInstances(layer, moved);
  eq("same object", instancesOnLayer(layer)[0] === inst, true);
  near("matrix updated", inst.position.x, 40);
  eq("children cleared for rehydrate", inst.children.length, 0);
  eq("layer has shape + instance", layer.children.length, 2);
}

// --- Cycle guard ------------------------------------------------------------
{
  const selfRef = layerJson((l) =>
    l.addChild(
      createInstance({ symbol: "sym2", iid: "i7", mode: "loop", firstFrame: 0 }, { x: 0, y: 0 }),
    ),
  );
  content.set("c", selfRef);
  symbols.set("sym2", {
    id: "sym2",
    name: "Cycle",
    duration: 1,
    tags: [],
    tracks: [
      {
        id: "t",
        name: "L",
        visible: true,
        locked: false,
        kind: "vector",
        keyframes: [{ frameIndex: 0, contentId: "c", holdUntil: 0 }],
      },
    ],
  });
  const layer = fresh();
  const inst = createInstance({ symbol: "sym2", iid: "i8", mode: "loop", firstFrame: 0 }, { x: 0, y: 0 });
  layer.addChild(inst);
  hydrateLayer(layer, resolver, 0); // must terminate
  eq("cycle: one nested stub", inst.children.length, 1);
  eq("cycle: nested empty", (inst.children[0] as paper.Group).children.length, 0);
}

// --- Snap targets include instance bounds and world-space nodes ------------
{
  const layer = fresh();
  const inst = createInstance(
    { symbol: "sym1", iid: "i9", mode: "single", firstFrame: 0 },
    { x: 100, y: 50 },
  );
  layer.addChild(inst);
  inst.scale(2);
  hydrateInstance(inst, resolver, 0);
  const shape = rect(200, 0, 210, 10, RED);
  layer.addChild(shape);

  const settings: SnapSettings = {
    enabled: true,
    tolerancePx: 8,
    grid: false,
    stage: false,
    stageMidpoints: false,
    bounds: true,
    boundsMidpoints: false,
    geometry: true,
    selfGeometry: false,
  };
  const extras = { gridSpacing: 0, stageWidth: 1000, stageHeight: 1000 };
  const renderer = {
    getSelectableItems: () => [inst, shape],
  } as unknown as PaperRenderer;

  const targets = collectTargets(renderer, new Set(), settings, extras);
  const xs = targets.xs.map((t) => t.value);
  eq("symbol left edge", xs.includes(80), true);
  eq("symbol right edge", xs.includes(120), true);
  eq("shape still snaps", xs.includes(200) && xs.includes(210), true);
  eq(
    "symbol node in world space",
    targets.points.some((p) => Math.abs(p.x - 80) < 1e-6 && Math.abs(p.y - 30) < 1e-6),
    true,
  );
  eq(
    "symbol node not left in local space",
    targets.points.some((p) => Math.abs(p.x + 10) < 1e-6),
    false,
  );
  const onEdge = targets.nearestOnPaths?.({ x: 81, y: 40 });
  near("nearest on symbol edge x", onEdge?.x ?? NaN, 80);
  near("nearest on symbol edge y", onEdge?.y ?? NaN, 40);

  const hidden = collectTargets(renderer, new Set([inst.id, shape.id]), settings, extras);
  eq("selection excluded", hidden.xs.length, 0);
  eq("selection excluded points", hidden.points.length, 0);
}

console.log("symbol-instances.check: ok");
