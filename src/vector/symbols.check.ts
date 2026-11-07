/**
 * Node check for the v4 content / symbol pipeline: instance placement,
 * content merge/translate, symbol frame resolution and recursive SVG output.
 * Run with `npm run check:symbols`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VectorLayer, initKernelSync, rectRing } from "./kernel";
import {
  contentCache,
  contentFills,
  decodeContent,
  encodeLayerContent,
  instanceContent,
  mergeContents,
  remapContentFills,
  scanContentSymbolIds,
  translateContent,
  withFreshInstanceIds,
} from "./content";
import { Palette } from "./palette";
import { contentToSvgPaths, layerToSvgPaths } from "./svg";
import {
  childFrameFor,
  resolveSymbolFrame,
  type SymbolDefinition,
  type SymbolResolver,
} from "../document/symbols";

// Path2D stub so `faces()` can run outside a browser.
class FakePath2D {
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  bezierCurveTo() {}
  closePath() {}
}
(globalThis as { Path2D?: unknown }).Path2D = FakePath2D;

const wasmPath = fileURLToPath(new URL("./pkg/kernel_bg.wasm", import.meta.url));
initKernelSync(readFileSync(wasmPath));

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const palette = new Palette();
const red = palette.fillFor("#ff0000");
const blue = palette.fillFor("#0000ff");

// Symbol "sq": one track, two keyframes (red square at 0, blue square at 2), duration 4.
const squareJson = (fill: number) => {
  const l = new VectorLayer();
  l.paint([rectRing(-10, -10, 20, 20)], fill);
  const json = encodeLayerContent(l, []);
  l.free();
  return json;
};
const contents = new Map<string, string>([
  ["c-red", squareJson(red)],
  ["c-blue", squareJson(blue)],
]);
const symbol: SymbolDefinition = {
  id: "sq",
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
        { frameIndex: 0, contentId: "c-red", holdUntil: 1 },
        { frameIndex: 2, contentId: "c-blue", holdUntil: 3 },
      ],
    },
  ],
};
const resolver: SymbolResolver = {
  getSymbol: (id) => (id === "sq" ? symbol : null),
  getContent: (id) => contents.get(id) ?? "",
};

// 1. Instance content round trip.
{
  const json = instanceContent({ symbol: "sq", iid: "i1", mode: "loop", firstFrame: 0 }, { x: 100, y: 50 });
  const c = decodeContent(json);
  check("instance content has no map", c.map.length === 0);
  check("instance placed at origin", c.instances.length === 1 && c.instances[0].matrix[4] === 100 && c.instances[0].matrix[5] === 50);
  check("scan symbol ids", scanContentSymbolIds(json).join() === "sq");
  const fresh = withFreshInstanceIds(json, () => "fresh");
  check("fresh instance ids", decodeContent(fresh).instances[0].iid === "fresh");
  const moved = translateContent(json, 5, -5);
  const m = decodeContent(moved).instances[0].matrix;
  check("translate moves instance", m[4] === 105 && m[5] === 45, JSON.stringify(m));
}

// 2. Merge shapes + instances; translate moves the map too.
{
  const below = squareJson(red);
  const above = instanceContent({ symbol: "sq", iid: "i2", mode: "single", firstFrame: 2 }, { x: 0, y: 0 });
  const merged = mergeContents(below, above);
  const c = decodeContent(merged);
  check("merge keeps map", c.map.length > 0);
  check("merge keeps instance", c.instances.length === 1);
  const moved = translateContent(merged, 100, 0);
  const layer = VectorLayer.fromBytes(decodeContent(moved).map);
  check("translate moves map", layer.faceAt({ x: 100, y: 0 }) === red && layer.faceAt({ x: 0, y: 0 }) === 0);
  layer.free();
  check("content fills", contentFills(merged).join() === String(red));
  const remapped = remapContentFills(merged, [[red, blue]]);
  check("remap fills", !!remapped && contentFills(remapped).join() === String(blue));
}

// 3. Frame resolution and playback modes.
{
  check("loop wraps", childFrameFor({ mode: "loop", firstFrame: 3 }, 1, 4) === 0);
  check("once clamps", childFrameFor({ mode: "once", firstFrame: 1 }, 10, 4) === 3);
  check("single holds", childFrameFor({ mode: "single", firstFrame: 2 }, 7, 4) === 2);
  const at0 = resolveSymbolFrame(symbol, 0, resolver);
  const at3 = resolveSymbolFrame(symbol, 3, resolver);
  check("resolve frame 0 → red", at0.length === 1 && at0[0].contentId === "c-red");
  check("resolve frame 3 → blue (held)", at3.length === 1 && at3[0].contentId === "c-blue" && at3[0].keyframeFrame === 2);
}

// 4. Recursive SVG: a layer holding an instance renders the symbol's art at the instance origin.
{
  const host = instanceContent({ symbol: "sq", iid: "i3", mode: "single", firstFrame: 2 }, { x: 200, y: 300 });
  const svg = contentToSvgPaths(host, palette, resolver);
  check("svg recurses into symbol", svg.includes('fill="#0000ff"'), svg.slice(0, 120));
  check("svg applies instance matrix", svg.includes("190 290") && svg.includes("210 310"), svg);
  const direct = layerToSvgPaths(VectorLayer.fromBytes(decodeContent(squareJson(red)).map), palette);
  check("svg direct layer", direct.includes('fill="#ff0000"') && direct.includes("Z"));
}

// 5. Nested instance inside a symbol (depth 2) + cache reuse.
{
  const inner = instanceContent({ symbol: "sq", iid: "i4", mode: "single", firstFrame: 0 }, { x: 0, y: 0 });
  contents.set("c-nested", mergeContents(squareJson(blue), inner));
  const outer: SymbolDefinition = {
    ...symbol,
    id: "outer",
    tracks: [{ ...symbol.tracks[0], keyframes: [{ frameIndex: 0, contentId: "c-nested", holdUntil: 0 }] }],
    duration: 1,
  };
  const res2: SymbolResolver = {
    getSymbol: (id) => (id === "outer" ? outer : id === "sq" ? symbol : null),
    getContent: (id) => contents.get(id) ?? "",
  };
  const host = instanceContent({ symbol: "outer", iid: "i5", mode: "single", firstFrame: 0 }, { x: 0, y: 0 });
  const svg = contentToSvgPaths(host, palette, res2);
  check("nested svg has both fills", svg.includes("#0000ff") && svg.includes("#ff0000"));
  const a = contentCache.get(contents.get("c-nested")!);
  const b = contentCache.get(contents.get("c-nested")!);
  check("content cache reuses decoded layer", a.layer === b.layer && a.layer !== null);
  contentCache.clear();
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all passed");
