/**
 * Node check for direct-select Simplify / Smooth (chain refitting through the
 * kernel). Run with `npm run check:refit`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VectorLayer, initKernelSync, rectRing, type Px } from "../../vector/kernel";
import { simplifyRings } from "./fit-curve";
import { chainsOf, rekeyPicks, simplifyChains, smoothChains, vertexKey } from "./refit";

class FakePath2D {
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  bezierCurveTo() {}
  closePath() {}
}
(globalThis as { Path2D?: unknown }).Path2D = FakePath2D;

const wasmPath = fileURLToPath(new URL("../../vector/pkg/kernel_bg.wasm", import.meta.url));
initKernelSync(readFileSync(wasmPath));

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function segStats(layer: VectorLayer): { quads: number; lines: number } {
  let quads = 0;
  let lines = 0;
  for (const r of layer.regions()) for (const ring of r.rings) for (const s of ring.segs) s.kind === "Q" ? quads++ : lines++;
  return { quads, lines };
}

function pickAll(layer: VectorLayer): Map<string, Px> {
  return new Map(layer.vertices().map((v) => [vertexKey(v), v]));
}

/** A 48-gon ring 80px wide (like a traced brush loop): outer + opposite hole. */
function tracedLoop(): VectorLayer {
  const l = new VectorLayer();
  const poly = (r: number, hole = false) => {
    const pts: Px[] = [];
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      pts.push({ x: 200 + r * Math.cos(a), y: 200 + r * Math.sin(a) });
    }
    if (hole) pts.reverse();
    return { start: pts[0], segs: pts.slice(1).map((p) => ({ kind: "L" as const, to: p })) };
  };
  l.paint([poly(120), poly(80, true)], 1);
  return l;
}

// Simplify a traced loop with everything picked: far fewer vertices, all curves, fill kept.
{
  const l = tracedLoop();
  const before = l.vertices().length;
  const { changed, picks } = simplifyChains(l, pickAll(l), 1.5);
  const after = l.vertices().length;
  const stats = segStats(l);
  check("simplify changed", changed);
  check("simplify dropped most vertices", after < before / 2, `${before} -> ${after}`);
  check("simplify made curves", stats.quads > 0 && stats.lines === 0, JSON.stringify(stats));
  check("simplify kept the fill", l.faceAt({ x: 300, y: 200 }) === 1 && l.faceAt({ x: 200, y: 200 }) === 0);
  const re = rekeyPicks(l, picks);
  check("simplify re-picked surviving knots", re.size === after, `${re.size} of ${after}`);
  l.free();
}

// Simplify with only part of a ring picked: anchors stay, other vertices untouched.
{
  const l = tracedLoop();
  const verts = l.vertices();
  // Pick a run of outer-ring vertices (radius 120) with angle in (0, 90°).
  const picked = new Map<string, Px>();
  for (const v of verts) {
    const r = Math.hypot(v.x - 200, v.y - 200);
    const a = Math.atan2(v.y - 200, v.x - 200);
    if (r > 100 && a > 0.05 && a < Math.PI / 2 - 0.05) picked.set(vertexKey(v), v);
  }
  const chains = chainsOf(l.edges(), picked);
  check("partial pick is one open chain", chains.length === 1 && !chains[0].closed, `${chains.length}`);
  const anchors = chains[0] ? [chains[0].verts[0], chains[0].verts[chains[0].verts.length - 1]] : [];
  const before = l.vertices().length;
  const { changed } = simplifyChains(l, picked, 1.5);
  const after = l.vertices();
  check("partial simplify changed", changed);
  check("partial simplify dropped picked vertices only", after.length < before && after.length >= before - picked.size, `${before} -> ${after.length}`);
  check(
    "anchors survive",
    anchors.every((a) => after.some((v) => Math.hypot(v.x - a.x, v.y - a.y) < 0.06)),
  );
  check("unpicked quadrant untouched", after.filter((v) => Math.hypot(v.x - 200, v.y - 200) > 100 && v.x < 200).length === 23);
  l.free();
}

// Smooth a square: vertices stay, every edge becomes a curve, fill kept.
{
  const l = new VectorLayer();
  l.paint([rectRing(0, 0, 100, 100)], 1);
  const { changed, picks } = smoothChains(l, pickAll(l), 1 / 3);
  const stats = segStats(l);
  check("smooth changed", changed);
  const corners = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  check("smooth kept the corners", corners.every((c) => l.vertices().some((v) => v.x === c.x && v.y === c.y)));
  check("smooth curved every edge", stats.quads > 0 && stats.lines === 0, JSON.stringify(stats));
  check("smooth kept the fill", l.faceAt({ x: 50, y: 50 }) === 1);
  check("smooth bulges past the chord", l.faceAt({ x: 50, y: -5 }) === 1, "midpoint of the top edge bulges outward");
  check("smooth re-picked every vertex", rekeyPicks(l, picks).size === l.vertices().length, `${rekeyPicks(l, picks).size} of ${l.vertices().length}`);
  l.free();
}

// Smooth one vertex of a square: only its two edges change.
{
  const l = new VectorLayer();
  l.paint([rectRing(0, 0, 100, 100)], 1);
  const v = l.vertices().find((p) => p.x === 100 && p.y === 0)!;
  smoothChains(l, new Map([[vertexKey(v), v]]), 1 / 3);
  const straight = l.edges().filter((e) => !e.ctrl);
  check("single smooth keeps the two far edges straight", straight.length === 2, `${straight.length}`);
  check("single smooth curves the rest", l.edges().length > 2 && l.edges().length - straight.length >= 2);
  check(
    "single smooth leaves the far corners alone",
    straight.every((e) => [e.a, e.b].every((p) => (p.x === 0 && (p.y === 0 || p.y === 100)) || (p.x === 100 && p.y === 100))),
  );
  l.free();
}

// Smooth with a shared fill boundary: the neighbour's fill follows the new curve.
{
  const l = new VectorLayer();
  l.paint([rectRing(0, 0, 100, 100)], 1);
  l.paint([rectRing(100, 0, 100, 100)], 2);
  const shared = l.edges().find((e) => e.a.x === 100 && e.b.x === 100)!;
  const mid = { x: 100, y: 50 };
  // Pick the two shared-edge endpoints: the chain is just that edge between two degree-3 anchors → no interior → no-op.
  const picked = new Map([[vertexKey(shared.a), shared.a], [vertexKey(shared.b), shared.b]]);
  const r = smoothChains(l, picked, 1 / 3);
  check("junction vertices are anchors, not interior", !r.changed);
  check("fills intact", l.faceAt({ x: 50, y: 50 }) === 1 && l.faceAt({ x: 150, y: 50 }) === 2 && l.faceAt(mid) !== undefined);
  l.free();
}

// Splitting a curved edge with replaceChain (double-click add vertex) keeps the curve and fill.
{
  const l = new VectorLayer();
  l.paint([{ start: { x: 0, y: 0 }, segs: [{ kind: "Q", c: { x: 50, y: -60 }, to: { x: 100, y: 0 } }, { kind: "L", to: { x: 100, y: 100 } }, { kind: "L", to: { x: 0, y: 100 } }] }], 1);
  const e = l.edges().find((x) => x.ctrl)!;
  const t = 0.5;
  const lerp = (p: Px, q: Px): Px => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  const c1 = lerp(e.a, e.ctrl!);
  const c2 = lerp(e.ctrl!, e.b);
  const mid = lerp(c1, c2);
  const insideBefore = l.faceAt({ x: 50, y: -25 });
  check("split accepted", l.replaceChain([e.a, e.b], [{ kind: "Q", c: c1, to: mid }, { kind: "Q", c: c2, to: e.b }]));
  check("split added a vertex", l.vertices().length === 5, `${l.vertices().length}`);
  check("split kept the curve", l.edges().filter((x) => x.ctrl).length === 2);
  check("split kept the fill", l.faceAt({ x: 50, y: -25 }) === insideBefore && l.faceAt({ x: 50, y: 50 }) === 1);
  l.free();
}

// Trace simplify runs on the rings, before paint. 0 keeps them; a loose tol drops corners.
{
  const pts: Px[] = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    pts.push({ x: 200 + 80 * Math.cos(a), y: 200 + 80 * Math.sin(a) });
  }
  const ring = { start: pts[0], segs: pts.slice(1).map((p) => ({ kind: "L" as const, to: p })) };
  const kept = simplifyRings([ring], 0);
  check("simplify off keeps the trace", kept[0] === ring);
  const loose = simplifyRings([ring], 1.5);
  check("simplify drops corners", loose[0].segs.length < ring.segs.length, `${ring.segs.length} -> ${loose[0].segs.length}`);
  check("simplify emits cubics", loose[0].segs.every((s) => s.kind === "C"));
  check("simplify stays closed", loose[0].segs[loose[0].segs.length - 1].to.x === ring.start.x && loose[0].segs[loose[0].segs.length - 1].to.y === ring.start.y);
}

console.log(failures === 0 ? "\nrefit.check: all passed" : `\nrefit.check: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
