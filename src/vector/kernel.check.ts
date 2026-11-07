/**
 * Node check for the kernel wrapper: packing, painting, booleans, SVG path
 * parsing, content round trips. Run with `npm run check:kernel`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BoolOp,
  PaintMode,
  VectorLayer,
  initKernelSync,
  rectRing,
  regionOpRings,
  rotateAbout,
  translation,
} from "./kernel";
import { ellipseRing, expandSymmetry, parsePathData, parseSvgShapes, strokeRings } from "./rings";
import { decodeContent, encodeLayerContent } from "./content";
import { Palette } from "./palette";

// Path2D stub so `faces()` can run outside a browser.
class FakePath2D {
  ops = 0;
  moveTo() { this.ops++; }
  lineTo() { this.ops++; }
  quadraticCurveTo() { this.ops++; }
  bezierCurveTo() { this.ops++; }
  closePath() { this.ops++; }
}
(globalThis as { Path2D?: unknown }).Path2D = FakePath2D;

const wasmPath = fileURLToPath(new URL("./pkg/kernel_bg.wasm", import.meta.url));
initKernelSync(readFileSync(wasmPath));

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// 1. Paint a square, fill lookups in px.
{
  const layer = new VectorLayer();
  layer.paint([rectRing(10, 10, 100, 100)], 1);
  check("square fill at centre", layer.faceAt({ x: 60, y: 60 }) === 1);
  check("square empty outside", layer.faceAt({ x: 5, y: 5 }) === 0);
  const b = layer.bounds();
  check("square bounds", !!b && b.x === 10 && b.y === 10 && b.width === 100 && b.height === 100, JSON.stringify(b));
  check("faces readback", layer.faces().length === 1);

  // Erase a hole.
  layer.erase([rectRing(40, 40, 20, 20)]);
  check("hole is empty", layer.faceAt({ x: 50, y: 50 }) === 0);
  check("ring still filled", layer.faceAt({ x: 20, y: 20 }) === 1);

  // Paint inside clips to the target face.
  const target = layer.faceAt({ x: 20, y: 20 });
  layer.paint([rectRing(0, 0, 200, 30)], 2, PaintMode.Inside, target);
  check("inside clipped (outside stays empty)", layer.faceAt({ x: 150, y: 15 }) === 0);
  check("inside painted", layer.faceAt({ x: 20, y: 15 }) === 2);

  // Behind only paints empty space.
  layer.paint([rectRing(0, 0, 200, 200)], 3, PaintMode.Behind);
  check("behind keeps top", layer.faceAt({ x: 20, y: 15 }) === 2);
  check("behind fills background", layer.faceAt({ x: 150, y: 150 }) === 3);
  check("behind fills the hole", layer.faceAt({ x: 50, y: 50 }) === 3);

  // Bytes round trip + digest.
  const bytes = layer.toBytes();
  const copy = VectorLayer.fromBytes(bytes);
  check("bytes round trip digest", copy.digest() === layer.digest());
  copy.free();
  layer.free();
}

// 2. Lift + stamp with transform.
{
  const layer = new VectorLayer();
  layer.paint([rectRing(0, 0, 50, 50)], 1);
  layer.paint([rectRing(100, 0, 50, 50)], 2);
  const lifted = layer.splitOffFace({ x: 25, y: 25 });
  check("lift removed face", layer.faceAt({ x: 25, y: 25 }) === 0);
  check("lift kept other", layer.faceAt({ x: 125, y: 25 }) === 2);
  check("lifted has face", lifted.faceAt({ x: 25, y: 25 }) === 1);
  layer.stamp(lifted, translation(0, 100));
  check("stamp translated", layer.faceAt({ x: 25, y: 125 }) === 1);
  layer.stamp(lifted, rotateAbout(90, { x: 0, y: 0 }));
  check("stamp rotated", layer.faceAt({ x: -25, y: 25 }) === 1);
  lifted.free();

  const rect = layer.splitOff([rectRing(90, -10, 100, 100)]);
  check("marquee lift", rect.faceAt({ x: 125, y: 25 }) === 2 && layer.faceAt({ x: 125, y: 25 }) === 0);
  rect.free();
  layer.free();
}

// 3. Booleans on rings.
{
  const a = [rectRing(0, 0, 10, 10)];
  const b = [rectRing(5, 0, 10, 10)];
  const probe = (rings: ReturnType<typeof regionOpRings>, p: { x: number; y: number }) => {
    const l = new VectorLayer();
    l.paint(rings, 1);
    const r = l.faceAt(p);
    l.free();
    return r;
  };
  const u = regionOpRings(a, b, BoolOp.Union);
  check("union covers both", probe(u, { x: 2, y: 5 }) === 1 && probe(u, { x: 13, y: 5 }) === 1);
  const i = regionOpRings(a, b, BoolOp.Intersect);
  check("intersect middle only", probe(i, { x: 7, y: 5 }) === 1 && probe(i, { x: 2, y: 5 }) === 0);
  const s = regionOpRings(a, b, BoolOp.Subtract);
  check("subtract left only", probe(s, { x: 2, y: 5 }) === 1 && probe(s, { x: 7, y: 5 }) === 0);
}

// 4. SVG path data (potrace-style) and shapes.
{
  const rings = parsePathData("M 0 0 L 100 0 L 100 100 L 0 100 Z M 25 25 L 25 75 L 75 75 L 75 25 Z");
  check("two rings parsed", rings.length === 2);
  const layer = new VectorLayer();
  layer.paint(rings, 1);
  check("opposite inner ring is a hole", layer.faceAt({ x: 50, y: 50 }) === 0 && layer.faceAt({ x: 10, y: 10 }) === 1);
  layer.free();

  const eight = parsePathData("M0 0 L 100 100 L 0 100 L 100 0 Z");
  const l8 = new VectorLayer();
  l8.paint(eight, 1);
  check("figure-eight fills both lobes", l8.faceAt({ x: 50, y: 20 }) === 1 && l8.faceAt({ x: 50, y: 80 }) === 1);
  l8.free();

  const curved = parsePathData("M0 0 C 0 55 100 55 100 0 Z");
  check("cubic parsed", curved.length === 1 && curved[0].segs[0].kind === "C");
  const l2 = new VectorLayer();
  l2.paint(curved, 1);
  check("cubic region filled", l2.faceAt({ x: 50, y: 20 }) === 1 && l2.faceAt({ x: 50, y: 60 }) === 0);
  l2.free();

  const svg = `<svg width="200" height="100"><g transform="translate(10 20)"><path d="M0 0h50v50h-50z" fill="#ff0000"/></g><rect x="100" y="0" width="20" height="20" fill="rgb(0, 0, 255)"/></svg>`;
  const shapes = parseSvgShapes(svg);
  check("svg shapes", shapes.length === 2 && shapes[0].fill === "#ff0000");
  const l3 = new VectorLayer();
  l3.paint(shapes[0].rings, 1);
  check("svg translate applied", l3.faceAt({ x: 35, y: 45 }) === 1 && l3.faceAt({ x: 5, y: 5 }) === 0);
  l3.free();

  const arc = parsePathData("M 0 0 A 50 50 0 0 1 100 0 Z");
  const l4 = new VectorLayer();
  l4.paint(arc, 1);
  check("arc approximated", l4.faceAt({ x: 50, y: -20 }) === 1 || l4.faceAt({ x: 50, y: 20 }) === 1);
  l4.free();
}

// 5. Strokes / ellipse / symmetry.
{
  const l = new VectorLayer();
  l.paint(strokeRings([{ x: 0, y: 0 }, { x: 100, y: 0 }], 10), 1);
  check("stroke capsule", l.faceAt({ x: 50, y: 0 }) === 1 && l.faceAt({ x: 50, y: 8 }) === 0 && l.faceAt({ x: -3, y: 0 }) === 1);
  l.free();

  const e = new VectorLayer();
  e.paint([ellipseRing(50, 50, 40, 20)], 1);
  check("ellipse", e.faceAt({ x: 50, y: 50 }) === 1 && e.faceAt({ x: 85, y: 65 }) === 0);
  e.free();

  const sym = expandSymmetry([rectRing(10, -5, 20, 10)], { enabled: true, mode: "vertical", originX: 0, originY: 0, radialCount: 2 }, 1);
  const s = new VectorLayer();
  s.paint(sym, 1);
  check("vertical symmetry mirrored", s.faceAt({ x: 20, y: 0 }) === 1 && s.faceAt({ x: -20, y: 0 }) === 1);
  s.free();
}

// 6. Content encoding + palette.
{
  const pal = new Palette();
  const red = pal.fillFor("#f00");
  const blue = pal.fillFor("#0000ff");
  check("palette ids", red === 1 && blue === 2 && pal.fillFor("#FF0000") === 1 && pal.colorOf(2) === "#0000ff");

  const l = new VectorLayer();
  l.paint([rectRing(0, 0, 10, 10)], red);
  const json = encodeLayerContent(l, [
    { symbol: "s1", iid: "i1", mode: "loop", firstFrame: 0, matrix: [1, 0, 0, 1, 5, 6], pivot: { x: 0, y: 0 } },
  ]);
  const back = decodeContent(json);
  const l2 = VectorLayer.fromBytes(back.map);
  check("content round trip", l2.digest() === l.digest() && back.instances.length === 1 && back.instances[0].matrix[4] === 5);
  check("empty content is empty string", encodeLayerContent(new VectorLayer(), []) === "");
  l.free();
  l2.free();
}

// 7. Direct edits.
{
  const l = new VectorLayer();
  l.paint([rectRing(0, 0, 100, 100)], 1);
  const v = l.nearestVertex({ x: 2, y: 1 }, 5);
  check("nearest vertex", !!v && v.x === 0 && v.y === 0);
  check("move vertex", l.moveVertex({ x: 0, y: 0 }, { x: -20, y: -20 }) && l.faceAt({ x: -10, y: -10 }) === 1);
  const e = l.nearestEdge({ x: 50, y: -8 }, 20);
  check("nearest edge", !!e && e.ctrl === null);
  if (e) {
    check("curve edge", l.curveEdge(e, { x: 50, y: -40 }) && l.faceAt({ x: 50, y: -10 }) === 1);
  }
  l.free();
}

// 8. Vertex collapse (direct-select delete): moving a vertex onto its
//    neighbour removes it and straightens the boundary.
{
  const l = new VectorLayer();
  // Pentagon-ish: square with a notch vertex on the top edge.
  l.paint(
    [
      {
        start: { x: 0, y: 0 },
        segs: [
          { kind: "L", to: { x: 50, y: -20 } },
          { kind: "L", to: { x: 100, y: 0 } },
          { kind: "L", to: { x: 100, y: 100 } },
          { kind: "L", to: { x: 0, y: 100 } },
        ],
      },
    ],
    1,
  );
  check("notch is filled before collapse", l.faceAt({ x: 50, y: -10 }) === 1);
  check("collapse vertex onto neighbour", l.moveVertex({ x: 50, y: -20 }, { x: 0, y: 0 }));
  check("vertex removed", l.vertices().length === 4, String(l.vertices().length));
  check("notch gone", l.faceAt({ x: 50, y: -10 }) === 0 && l.faceAt({ x: 50, y: 50 }) === 1);
  // restoreBytes round trip (the simplify drag uses it).
  const bytes = l.toBytes();
  l.erase([rectRing(0, 0, 100, 100)]);
  check("erased everything", l.isEmpty());
  l.restoreBytes(bytes);
  check("restoreBytes brings art back", l.faceAt({ x: 50, y: 50 }) === 1);
  l.free();
}

// 9. SVG import: strokes become filled outlines, default fill is black, `none` skipped.
{
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<rect x="10" y="10" width="30" height="30"/>' +
    '<line x1="0" y1="80" x2="100" y2="80" stroke="#00ff00" stroke-width="4"/>' +
    '<circle cx="70" cy="30" r="10" fill="none" stroke="#0000ff" stroke-width="2"/>' +
    "</svg>";
  const shapes = parseSvgShapes(svg);
  check("svg shape count (rect fill, line stroke, circle stroke)", shapes.length === 3, String(shapes.length));
  check("svg default fill black", shapes[0]?.fill === "#000000");
  check("svg line stroke color", shapes[1]?.fill === "#00ff00" && shapes[1].rings.length > 0);
  const l = new VectorLayer();
  for (const s of shapes) l.paint(s.rings, 1);
  check("svg stroke paints a band", l.faceAt({ x: 50, y: 80 }) === 1 && l.faceAt({ x: 50, y: 70 }) === 0);
  check("svg circle stroke is a ring", l.faceAt({ x: 80, y: 30 }) === 1 && l.faceAt({ x: 70, y: 30 }) === 0);
  l.free();
}

// Traced-style gentle cubics must stay curved through the kernel.
{
  const d = "M0 0 C 35 -10, 65 -10, 100 0 C 110 35, 110 65, 100 100 C 65 110, 35 110, 0 100 C -10 65, -10 35, 0 0 Z";
  const l = new VectorLayer();
  l.paint(parsePathData(d), 1);
  let quads = 0;
  let lines = 0;
  for (const r of l.regions()) for (const ring of r.rings) for (const s of ring.segs) s.kind === "Q" ? quads++ : lines++;
  check("gentle cubics stay curved", quads > 0 && lines === 0, `quads=${quads} lines=${lines}`);
  l.free();
}

// moveVertices carries curve controls with their endpoints.
{
  const l = new VectorLayer();
  l.paint([{ start: { x: 0, y: 0 }, segs: [{ kind: "Q", c: { x: 50, y: -50 }, to: { x: 100, y: 0 } }, { kind: "L", to: { x: 100, y: 100 } }, { kind: "L", to: { x: 0, y: 100 } }] }], 1);
  const ctrl = () => l.edges().find((e) => e.ctrl)?.ctrl;
  check("moveVertices accepted", l.moveVertices([{ from: { x: 0, y: 0 }, to: { x: 0, y: -20 } }, { from: { x: 100, y: 0 }, to: { x: 100, y: -20 } }]));
  const c = ctrl();
  check("control translates with both ends", !!c && Math.abs(c.x - 50) < 0.1 && Math.abs(c.y + 70) < 0.1, JSON.stringify(c));
  check("moveVertices refuses a missing vertex", !l.moveVertices([{ from: { x: 7, y: 7 }, to: { x: 8, y: 8 } }]));
  l.free();
}

// replaceChain swaps a polyline run for one cubic and keeps fills.
{
  const l = new VectorLayer();
  const poly = [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 130, y: 25 }, { x: 135, y: 50 }, { x: 130, y: 75 }, { x: 100, y: 100 }, { x: 0, y: 100 },
  ];
  l.paint([{ start: poly[0], segs: poly.slice(1).map((p) => ({ kind: "L" as const, to: p })) }], 1);
  l.paint([rectRing(-50, 25, 50, 50)], 2);
  const vertsBefore = l.vertices().length;
  const chain = poly.slice(1, 6);
  const ok = l.replaceChain(chain, [{ kind: "C", c1: { x: 150, y: 10 }, c2: { x: 150, y: 90 }, to: { x: 100, y: 100 } }]);
  check("replaceChain accepted", ok);
  check("replaceChain dropped vertices", l.vertices().length < vertsBefore, `${vertsBefore} -> ${l.vertices().length}`);
  check("replaceChain kept fills", l.faceAt({ x: 50, y: 50 }) === 1 && l.faceAt({ x: -25, y: 50 }) === 2 && l.faceAt({ x: 130, y: 50 }) === 1);
  check("replaceChain refuses a non-edge", !l.replaceChain([{ x: 0, y: 0 }, { x: 77, y: 77 }], [{ kind: "L", to: { x: 77, y: 77 } }]));
  l.free();
}

console.log(failures === 0 ? "\nkernel.check: all passed" : `\nkernel.check: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
