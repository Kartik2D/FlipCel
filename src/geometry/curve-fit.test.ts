import { fitOutline, simplifyPolyline } from "./curve-fit";
import type { FittedAnchor, Vec } from "./curve-fit";

function fail(msg: string): never {
  throw new Error(msg);
}

function circle(cx: number, cy: number, r: number, n: number): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push({ x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r });
  }
  return out;
}

function square(side: number, step: number): Vec[] {
  const out: Vec[] = [];
  const corners = [
    { x: 0, y: 0 },
    { x: side, y: 0 },
    { x: side, y: side },
    { x: 0, y: side },
  ];
  for (let c = 0; c < 4; c++) {
    const a = corners[c];
    const b = corners[(c + 1) % 4];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.round(d / step));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

function sCurve(): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i <= 80; i++) {
    const t = i / 80;
    out.push({ x: t * 160, y: Math.sin(t * Math.PI * 2) * 36 });
  }
  return out;
}

function noisyBlob(): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < 96; i++) {
    const t = (i / 96) * Math.PI * 2;
    const r = 50 + 12 * Math.sin(3 * t) + 0.8 * Math.sin(13 * t);
    out.push({ x: Math.cos(t) * r, y: Math.sin(t) * r });
  }
  return out;
}

function cubicsOf(anchors: FittedAnchor[], closed: boolean): Vec[][] {
  const n = anchors.length;
  const count = closed ? n : n - 1;
  const segs: Vec[][] = [];
  for (let i = 0; i < count; i++) {
    const a = anchors[i];
    const b = anchors[(i + 1) % n];
    segs.push([
      { x: a.x, y: a.y },
      { x: a.x + a.handleOut.x, y: a.y + a.handleOut.y },
      { x: b.x + b.handleIn.x, y: b.y + b.handleIn.y },
      { x: b.x, y: b.y },
    ]);
  }
  return segs;
}

function bezier(p: Vec[], t: number): Vec {
  const m = 1 - t;
  const b0 = m * m * m;
  const b1 = 3 * m * m * t;
  const b2 = 3 * m * t * t;
  const b3 = t * t * t;
  return {
    x: b0 * p[0].x + b1 * p[1].x + b2 * p[2].x + b3 * p[3].x,
    y: b0 * p[0].y + b1 * p[1].y + b2 * p[2].y + b3 * p[3].y,
  };
}

function maxDeviation(points: Vec[], anchors: FittedAnchor[], closed: boolean): number {
  const segs = cubicsOf(anchors, closed);
  let max = 0;
  for (const p of points) {
    let best = Infinity;
    for (const seg of segs) {
      for (let s = 0; s <= 24; s++) {
        const b = bezier(seg, s / 24);
        best = Math.min(best, Math.hypot(p.x - b.x, p.y - b.y));
      }
    }
    if (best > max) max = best;
  }
  return max;
}

function radialError(anchors: FittedAnchor[], cx: number, cy: number, r: number): number {
  const segs = cubicsOf(anchors, true);
  let max = 0;
  for (const seg of segs) {
    for (let s = 0; s <= 20; s++) {
      const b = bezier(seg, s / 20);
      const err = Math.abs(Math.hypot(b.x - cx, b.y - cy) - r);
      if (err > max) max = err;
    }
  }
  return max;
}

function crosses(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const c1 = abx * (c.y - a.y) - aby * (c.x - a.x);
  const c2 = abx * (d.y - a.y) - aby * (d.x - a.x);
  const cdx = d.x - c.x;
  const cdy = d.y - c.y;
  const c3 = cdx * (a.y - c.y) - cdy * (a.x - c.x);
  const c4 = cdx * (b.y - c.y) - cdy * (b.x - c.x);
  return c1 * c2 < 0 && c3 * c4 < 0;
}

function assertNoSelfIntersection(anchors: FittedAnchor[], closed: boolean, label: string): void {
  for (const seg of cubicsOf(anchors, closed)) {
    if (crosses(seg[0], seg[1], seg[2], seg[3])) {
      fail(`${label}: control polygon self-intersects`);
    }
    const samples: Vec[] = [];
    for (let i = 0; i <= 16; i++) samples.push(bezier(seg, i / 16));
    for (let i = 0; i < samples.length - 1; i++) {
      for (let j = i + 2; j < samples.length - 1; j++) {
        if (crosses(samples[i], samples[i + 1], samples[j], samples[j + 1])) {
          fail(`${label}: cubic samples self-intersect`);
        }
      }
    }
  }
}

const circlePts = circle(0, 0, 40, 72);
const circleFit = fitOutline(circlePts, { tolerance: 0.8, closed: true });
if (circleFit.length < 4 || circleFit.length > 6) {
  fail(`circle segments: got ${circleFit.length}, want 4..6`);
}
const radial = radialError(circleFit, 0, 0, 40);
if (radial > 0.8) fail(`circle radial error ${radial.toFixed(3)} > 0.8`);
{
  let handle = 0;
  for (const a of circleFit) {
    handle += Math.hypot(a.handleIn.x, a.handleIn.y) + Math.hypot(a.handleOut.x, a.handleOut.y);
    const al = Math.hypot(a.handleIn.x, a.handleIn.y);
    const bl = Math.hypot(a.handleOut.x, a.handleOut.y);
    if (al < 1 || bl < 1) fail("circle anchor lost a handle");
    const d = (a.handleIn.x * a.handleOut.x + a.handleIn.y * a.handleOut.y) / (al * bl);
    if (d > -0.95) fail(`circle join not G1 (dot ${d.toFixed(3)})`);
  }
  if (handle < 1) fail("circle should be curved");
}
assertNoSelfIntersection(circleFit, true, "circle");

const squarePts = square(100, 5);
const squareFit = fitOutline(squarePts, { tolerance: 1.5, closed: true });
if (squareFit.length !== 4) fail(`square segments: got ${squareFit.length}, want 4`);
const wantCorners = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];
for (const corner of wantCorners) {
  const hit = squareFit.some((a) => Math.hypot(a.x - corner.x, a.y - corner.y) < 1e-3);
  if (!hit) fail(`square missing corner ${corner.x},${corner.y}`);
}
for (const a of squareFit) {
  if (Math.hypot(a.handleIn.x, a.handleIn.y) > 1e-3) fail("square handleIn not zero");
  if (Math.hypot(a.handleOut.x, a.handleOut.y) > 1e-3) fail("square handleOut not zero");
}
assertNoSelfIntersection(squareFit, true, "square");

const squareResampled = simplifyPolyline(squarePts, { tolerance: 1.5, closed: true });
if (squareResampled.length !== 4) {
  fail(`resampled square segments: got ${squareResampled.length}, want 4`);
}
for (const a of squareResampled) {
  if (Math.hypot(a.handleIn.x, a.handleIn.y) > 1e-3) fail("resampled square handle not zero");
  if (Math.hypot(a.handleOut.x, a.handleOut.y) > 1e-3) fail("resampled square handle not zero");
}

const blob = noisyBlob();
const blobTol = 3;
const blobFit = fitOutline(blob, { tolerance: blobTol, closed: true });
if (blobFit.length >= blob.length / 2) {
  fail(`blob not simplified: ${blobFit.length} anchors from ${blob.length} points`);
}
const blobDev = maxDeviation(blob, blobFit, true);
if (blobDev > blobTol + 0.05) fail(`blob deviation ${blobDev.toFixed(3)} > ${blobTol}`);
assertNoSelfIntersection(blobFit, true, "blob");

const ess = sCurve();
const essFit = fitOutline(ess, { tolerance: 1.5, closed: false });
const interior = essFit.slice(1, -1);
const nearInflection = interior.some((a) => Math.abs(a.x - 80) < 16);
if (!nearInflection) {
  const xs = essFit.map((a) => a.x.toFixed(1)).join(", ");
  fail(`S-curve has no anchor near the inflection; xs=${xs}`);
}
assertNoSelfIntersection(essFit, false, "s-curve");

// Locked end tangent (partial selection of a smooth anchor) stays on that side.
{
  const arc: Vec[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = (Math.PI / 2) * (i / 24);
    arc.push({ x: Math.cos(t) * 40, y: Math.sin(t) * 40 });
  }
  const locked = fitOutline(arc, {
    tolerance: 0.5,
    closed: false,
    tangentStart: { x: 0, y: 1 },
  });
  const h = locked[0].handleOut;
  const hl = Math.hypot(h.x, h.y);
  if (hl < 1) fail("locked tangent produced no handle");
  const align = h.y / hl;
  if (align < 0.98) fail(`locked tangent drifted (align ${align.toFixed(3)})`);
}

console.log("curve-fit tests ok");
