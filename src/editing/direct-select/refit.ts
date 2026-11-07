/**
 * Chain-based curve refitting for direct-select.
 *
 * A *chain* is a maximal run of picked degree-2 vertices, extended one vertex
 * past both ends to an anchor that stays fixed (a fully picked loop closes on
 * itself). Simplify refits each chain with as few cubics as fit within a
 * tolerance; Smooth turns each chain into a Catmull-Rom cubic spline. Both
 * go through the kernel's `replaceChain`, so fills on either side carry over.
 */
import type { KernelEdge, Px, Seg, VectorLayer } from "../../vector/kernel";
import { fitCubics, flattenSegs } from "./fit-curve";

/** Position match: above f32 readback noise, below half a twip (see controller EPS). */
const POS_EPS = 1e-3;
const EPS = 1e-9;

export const vertexKey = (p: Px): string => `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
const same = (a: Px, b: Px): boolean => Math.abs(a.x - b.x) < POS_EPS && Math.abs(a.y - b.y) < POS_EPS;
const sameEdge = (e: KernelEdge, f: KernelEdge): boolean =>
  (same(e.a, f.a) && same(e.b, f.b)) || (same(e.a, f.b) && same(e.b, f.a));
const unit = (v: Px): Px => {
  const l = Math.hypot(v.x, v.y);
  return l > EPS ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 };
};
const neg = (v: Px): Px => ({ x: -v.x, y: -v.y });
const other = (e: KernelEdge, from: Px): Px => (same(e.a, from) ? e.b : e.a);

/** Edge `e` as a segment leaving `from`. */
function orientSeg(e: KernelEdge, from: Px): Seg {
  const to = other(e, from);
  return e.ctrl ? { kind: "Q", c: e.ctrl, to } : { kind: "L", to };
}

/** A run of vertices joined by `edges[i]` (verts[i] → verts[i+1]). Closed chains repeat verts[0] last. */
export interface Chain {
  verts: Px[];
  edges: KernelEdge[];
  closed: boolean;
}

/** Vertex → incident edges. */
export function adjacency(edges: readonly KernelEdge[]): Map<string, KernelEdge[]> {
  const adj = new Map<string, KernelEdge[]>();
  for (const e of edges) {
    for (const p of [e.a, e.b]) {
      const k = vertexKey(p);
      const list = adj.get(k);
      if (list) list.push(e);
      else adj.set(k, [e]);
    }
  }
  return adj;
}

export function chainsOf(edges: readonly KernelEdge[], picked: ReadonlyMap<string, Px>): Chain[] {
  const adj = adjacency(edges);
  const interior = (p: Px) => picked.has(vertexKey(p)) && adj.get(vertexKey(p))?.length === 2;
  const visited = new Set<string>();
  const chains: Chain[] = [];
  for (const v of picked.values()) {
    if (visited.has(vertexKey(v)) || !interior(v)) continue;
    const [e0, e1] = adj.get(vertexKey(v))!;
    visited.add(vertexKey(v));
    // Walk one direction until a non-interior vertex (the anchor) or back to v.
    const walk = (first: KernelEdge): Chain => {
      const verts: Px[] = [];
      const walked: KernelEdge[] = [];
      let prev = v;
      let e = first;
      for (;;) {
        const n = other(e, prev);
        walked.push(e);
        verts.push(n);
        if (same(n, v)) return { verts, edges: walked, closed: true };
        if (!interior(n)) return { verts, edges: walked, closed: false };
        visited.add(vertexKey(n));
        const [x, y] = adj.get(vertexKey(n))!;
        e = sameEdge(x, e) ? y : x;
        prev = n;
      }
    };
    const fwd = walk(e0);
    if (fwd.closed) {
      chains.push({ verts: [v, ...fwd.verts], edges: fwd.edges, closed: true });
      continue;
    }
    const back = walk(e1);
    chains.push({
      verts: [...back.verts.reverse(), v, ...fwd.verts],
      edges: [...back.edges.reverse(), ...fwd.edges],
      closed: false,
    });
  }
  return chains;
}

/** Unit direction leaving `at` along `e` (toward its control, or its far end when straight). */
function edgeDir(e: KernelEdge, at: Px): Px {
  const to = e.ctrl ?? other(e, at);
  return unit({ x: to.x - at.x, y: to.y - at.y });
}

/**
 * Travel-direction tangent at an open chain's end anchor. Follows the edge on
 * the far side of the anchor when it has exactly one (keeps G1 with the rest);
 * otherwise the chain's own edge there.
 */
function anchorTangents(adj: Map<string, KernelEdge[]>, c: Chain): [Px, Px] {
  const into = (anchor: Px, chainEdge: KernelEdge): Px => {
    const inc = adj.get(vertexKey(anchor)) ?? [];
    const outside = inc.length === 2 ? inc.find((e) => !sameEdge(e, chainEdge)) : undefined;
    return outside ? neg(edgeDir(outside, anchor)) : edgeDir(chainEdge, anchor);
  };
  const last = c.verts.length - 1;
  return [into(c.verts[0], c.edges[0]), neg(into(c.verts[last], c.edges[last - 1]))];
}

/** Catmull-Rom (travel-direction) tangent at every chain vertex. */
function splineTangents(adj: Map<string, KernelEdge[]>, c: Chain): Px[] {
  const n = c.verts.length;
  const out: Px[] = new Array(n);
  if (c.closed) {
    const m = n - 1;
    for (let i = 0; i < n; i++) {
      const prev = c.verts[(i - 1 + m) % m];
      const next = c.verts[(i + 1) % m];
      out[i] = unit({ x: next.x - prev.x, y: next.y - prev.y });
    }
    return out;
  }
  const [t0, t1] = anchorTangents(adj, c);
  out[0] = t0;
  out[n - 1] = t1;
  for (let i = 1; i < n - 1; i++) {
    out[i] = unit({ x: c.verts[i + 1].x - c.verts[i - 1].x, y: c.verts[i + 1].y - c.verts[i - 1].y });
  }
  return out;
}

export interface RefitResult {
  changed: boolean;
  /**
   * Positions to pick afterwards: surviving interior vertices plus every
   * vertex the refit introduced (cubics become runs of quadratics).
   */
  picks: Px[];
}

/** Vertices of `art` not present in `before`. */
function addedVertices(art: VectorLayer, before: ReadonlySet<string>): Px[] {
  return art.vertices().filter((v) => !before.has(vertexKey(v)));
}

/**
 * Refit every chain with as few cubics as stay within `tol` (world px) of the
 * current outline. Surviving interior knots become the new picks.
 */
export function simplifyChains(art: VectorLayer, picked: ReadonlyMap<string, Px>, tol: number): RefitResult {
  const edges = art.edges();
  const adj = adjacency(edges);
  const before = new Set(art.vertices().map(vertexKey));
  const picks: Px[] = [];
  let changed = false;
  for (const c of chainsOf(edges, picked)) {
    const pts = flattenSegs(c.verts[0], c.edges.map((e, i) => orientSeg(e, c.verts[i])));
    let t0: Px;
    let t1: Px;
    if (c.closed) {
      const m = c.verts.length - 1;
      t0 = unit({ x: c.verts[1].x - c.verts[m - 1].x, y: c.verts[1].y - c.verts[m - 1].y });
      t1 = t0;
    } else {
      [t0, t1] = anchorTangents(adj, c);
    }
    const cubics = fitCubics(pts, tol, t0, t1);
    if (cubics.length === 0 || !art.replaceChain(c.verts, cubics)) {
      picks.push(...c.verts.slice(c.closed ? 0 : 1, -1));
      continue;
    }
    changed = true;
    picks.push(...cubics.slice(0, -1).map((s) => s.to));
    if (c.closed) picks.push(c.verts[0]);
  }
  if (changed) picks.push(...addedVertices(art, before));
  return { changed, picks };
}

/**
 * Turn every chain into a cubic spline through its vertices. `amount` is the
 * handle length as a fraction of each edge's chord (1/3 ≈ Catmull-Rom).
 */
export function smoothChains(art: VectorLayer, picked: ReadonlyMap<string, Px>, amount: number): RefitResult {
  const edges = art.edges();
  const adj = adjacency(edges);
  const before = new Set(art.vertices().map(vertexKey));
  const picks: Px[] = [];
  let changed = false;
  for (const c of chainsOf(edges, picked)) {
    const t = splineTangents(adj, c);
    const segs: Seg[] = [];
    for (let i = 0; i + 1 < c.verts.length; i++) {
      const a = c.verts[i];
      const b = c.verts[i + 1];
      const d = Math.hypot(b.x - a.x, b.y - a.y) * amount;
      segs.push({
        kind: "C",
        c1: { x: a.x + t[i].x * d, y: a.y + t[i].y * d },
        c2: { x: b.x - t[i + 1].x * d, y: b.y - t[i + 1].y * d },
        to: b,
      });
    }
    if (art.replaceChain(c.verts, segs)) changed = true;
    picks.push(...c.verts.slice(c.closed ? 0 : 1, -1));
  }
  if (changed) picks.push(...addedVertices(art, before));
  return { changed, picks };
}

/** Kernel vertices round to twips (0.05px); matching picks to them tolerates that. */
const REKEY_TOL_PX = 0.06;

/** The current kernel vertices nearest each target, keyed for picking. */
export function rekeyPicks(art: VectorLayer, targets: readonly Px[]): Map<string, Px> {
  const verts = art.vertices();
  const next = new Map<string, Px>();
  for (const t of targets) {
    let best: Px | null = null;
    let bestD = REKEY_TOL_PX;
    for (const v of verts) {
      const d = Math.hypot(v.x - t.x, v.y - t.y);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    if (best) next.set(vertexKey(best), best);
  }
  return next;
}
