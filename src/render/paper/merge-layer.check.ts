// Kernel fixture. Run: npm run check:merge
import paper from "paper";
import {
  addToLayer,
  addToLayerSequential,
  mergeJsons,
  paintInsideLayer,
  plainAdopt,
  subtractFromLayer,
} from "./merge-layer";
import { fillArea } from "./path-geometry";

paper.setup(new paper.Size(1, 1));
const adopt = plainAdopt(false);
// Headless Paper has no canvas to resolve named colors; use hex.
const RED = "#ff0000";
const BLUE = "#0000ff";
const GREEN = "#00ff00";

function eq(name: string, got: unknown, want: unknown): void {
  if (got !== want) throw new Error(`${name}: got ${String(got)}, want ${String(want)}`);
}
function near(name: string, got: number, want: number, tol = 1): void {
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
function circle(x: number, y: number, r: number, color: string): paper.Path {
  return new paper.Path.Circle({ center: [x, y], radius: r, fillColor: color });
}
function ring(x: number, y: number, ro: number, ri: number, color: string): paper.CompoundPath {
  const cp = new paper.CompoundPath({
    children: [
      new paper.Path.Circle({ center: [x, y], radius: ro }),
      new paper.Path.Circle({ center: [x, y], radius: ri }),
    ],
    fillColor: color,
  });
  cp.fillRule = "evenodd";
  return cp;
}
function fills(layer: paper.Layer, color?: string): paper.PathItem[] {
  return layer.children.filter(
    (c): c is paper.PathItem =>
      (c instanceof paper.Path || c instanceof paper.CompoundPath) &&
      (!color || c.fillColor?.toCSS(true) === new paper.Color(color).toCSS(true)),
  );
}
const area = (items: paper.PathItem[]) => items.reduce((s, i) => s + fillArea(i), 0);
const PI = Math.PI;

// 1. ring − crossing bar
{
  const layer = fresh();
  const r = ring(0, 0, 100, 70, RED);
  const bar = rect(-10, -200, 10, 200, BLUE);
  const ringArea = fillArea(r);
  const overlap = fillArea(r.intersect(bar, { insert: false }));
  addToLayer(layer, [bar], adopt);
  eq("ring-bar: red pieces", fills(layer, RED).length, 2);
  eq("ring-bar: blue pieces", fills(layer, BLUE).length, 1);
  near("ring-bar: red area", area(fills(layer, RED)), ringArea - overlap);
}

// 2. nested other-color stroke punches a hole
{
  const layer = fresh();
  rect(0, 0, 100, 100, RED);
  const small = circle(50, 50, 10, BLUE);
  addToLayer(layer, [small], adopt);
  eq("nested: items", fills(layer).length, 2);
  near("nested: red area", area(fills(layer, RED)), 10000 - PI * 100);
  eq("nested: red is compound", fills(layer, RED)[0] instanceof paper.CompoundPath, true);
}

// 3. stroke fully covering a fill removes it
{
  const layer = fresh();
  circle(50, 50, 10, RED);
  const big = rect(0, 0, 100, 100, BLUE);
  addToLayer(layer, [big], adopt);
  eq("covered: items", fills(layer).length, 1);
  eq("covered: color", fills(layer)[0].fillColor?.toCSS(true), new paper.Color(BLUE).toCSS(true));
}

// 4. eraser: full cover removes; 97% erase keeps the 3% sliver
{
  const layer = fresh();
  circle(50, 50, 10, RED);
  subtractFromLayer(layer, [rect(0, 0, 100, 100, "#000000")], adopt);
  eq("erase-cover: items", fills(layer).length, 0);

  const layer2 = fresh();
  rect(0, 0, 100, 100, RED);
  subtractFromLayer(layer2, [rect(-10, -10, 97, 110, "#000000")], adopt);
  eq("erase-sliver: items", fills(layer2).length, 1);
  near("erase-sliver: area", area(fills(layer2)), 300);
}

// 5. same-color edge-adjacent fills unite
{
  const layer = fresh();
  rect(0, 0, 100, 100, RED);
  addToLayer(layer, [rect(100, 0, 200, 100, RED)], adopt);
  eq("adjacent: items", fills(layer).length, 1);
  near("adjacent: area", area(fills(layer)), 20000);
}

// 6. inside on shape: paint clipped to the clicked fill; earlier stroke untouched
{
  const layer = fresh();
  rect(0, 0, 200, 200, RED);
  addToLayer(layer, [rect(90, -50, 110, 250, BLUE)], adopt);
  const left = fills(layer, RED).find((p) => p.bounds.center.x < 100)!;
  const right = fills(layer, RED).find((p) => p.bounds.center.x > 100)!;
  const rightArea = fillArea(right);
  const paint = circle(100, 100, 80, GREEN);
  const expectGreen = fillArea(paint.intersect(left, { insert: false }));
  paintInsideLayer(layer, [paint], left, adopt);
  eq("inside: blue pieces", fills(layer, BLUE).length, 1);
  near("inside: blue area", area(fills(layer, BLUE)), 20 * 300);
  near("inside: green area", area(fills(layer, GREEN)), expectGreen);
  near("inside: red total", area(fills(layer, RED)), 90 * 200 - expectGreen + rightArea);
  near("inside: right untouched", area(fills(layer, RED).filter((p) => p.bounds.center.x > 100)), rightArea);
}

// 7. behind: paint − existing (nested becomes a hole), same-color neighbor united
{
  const layer = fresh();
  rect(0, 0, 100, 100, RED);
  circle(200, 100, 20, BLUE);
  rect(350, 50, 450, 150, GREEN);
  const paint = rect(50, 50, 350, 150, GREEN);
  paintInsideLayer(layer, [paint], null, adopt);
  near("behind: red intact", area(fills(layer, RED)), 10000);
  near("behind: blue intact", area(fills(layer, BLUE)), PI * 400);
  eq("behind: green pieces", fills(layer, GREEN).length, 1);
  near("behind: green area", area(fills(layer, GREEN)), 300 * 100 - 50 * 50 - PI * 400 + 10000);
}

// 8. behind + tuck: overlapping a stroke must not cut it (coincident-edge subtract)
{
  const layer = fresh();
  const stroke = ring(0, 0, 100, 70, RED);
  const redArea = fillArea(stroke);
  const paint = rect(-80, -80, 80, 80, BLUE);
  const overlap = fillArea(paint.intersect(stroke, { insert: false }));
  const paintArea = fillArea(paint);
  paintInsideLayer(layer, [paint], null, adopt);
  eq("behind-tuck: red pieces", fills(layer, RED).length, 1);
  near("behind-tuck: red area", area(fills(layer, RED)), redArea);
  near("behind-tuck: blue area", area(fills(layer, BLUE)), paintArea - overlap);
}

// 8b. behind + tuck: eroded hole around a stroke (no curve crossings)
{
  const layer = fresh();
  const stroke = rect(100, 100, 114, 300, RED);
  const redArea = fillArea(stroke);
  const outer = new paper.Path.Rectangle({ from: [0, 0], to: [400, 400], insert: false });
  const hole = new paper.Path.Rectangle({ from: [102, 102], to: [112, 298], insert: false });
  hole.reverse();
  const paint = new paper.CompoundPath({ children: [outer, hole], fillColor: BLUE });
  paint.fillRule = "evenodd";
  paintInsideLayer(layer, [paint], null, adopt);
  eq("behind-eroded: red pieces", fills(layer, RED).length, 1);
  near("behind-eroded: red area", area(fills(layer, RED)), redArea);
  near("behind-eroded: blue area", area(fills(layer, BLUE)), 400 * 400 - redArea);
}

// 9. stale EMF tag on a base item: still cut when EMF is off, isolated when on
{
  const layer = fresh();
  const base = rect(0, 0, 100, 100, RED);
  base.data = { emfKeyframeFrame: 3 };
  addToLayer(layer, [rect(40, -50, 60, 150, BLUE)], plainAdopt(false));
  eq("emf-off: red pieces", fills(layer, RED).length, 2);

  const layer2 = fresh();
  const base2 = rect(0, 0, 100, 100, RED);
  base2.data = { emfKeyframeFrame: 3 };
  addToLayer(layer2, [rect(40, -50, 60, 150, BLUE)], plainAdopt(true));
  eq("emf-on: red untouched", fills(layer2, RED).length, 1);
}

// 10. worker path: JSON in, JSON out
{
  const layer = fresh();
  ring(0, 0, 100, 70, RED);
  const base = layer.exportJSON() as string;
  const scratch = new paper.Layer();
  rect(-10, -200, 10, 200, BLUE);
  const add = scratch.exportJSON() as string;
  const out = mergeJsons(base, add);
  const result = fresh();
  result.importJSON(out);
  eq("json: red pieces", fills(result, RED).length, 2);
  eq("json: blue pieces", fills(result, BLUE).length, 1);
}

// 11. stacked painter's order: back fill must not delete the front fill
{
  const layer = fresh();
  const back = rect(0, 0, 100, 100, RED);
  const front = rect(25, 25, 75, 75, BLUE);
  addToLayerSequential(layer, [back, front], adopt);
  eq("stacked: red remains", fills(layer, RED).length, 1);
  eq("stacked: blue remains", fills(layer, BLUE).length, 1);
  near("stacked: blue area", area(fills(layer, BLUE)), 2500);
}

console.log("merge kernel: all checks passed");
