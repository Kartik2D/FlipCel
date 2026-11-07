//! From a planar set of pieces to a labeled map with holes.
//!
//! `build` interns vertices, links half-edges around each vertex, walks the
//! `next` cycles, and attaches every non-positive cycle to the face that
//! contains it by casting a ray to the left from the cycle's leftmost point.
//! `label` floods fills from the unbounded face across edges; `dissolve`
//! drops edges with the same fill on both sides.

use std::collections::{HashMap, VecDeque};

use crate::geom::*;
use crate::slice::slice;
use crate::{BoolOp, EMPTY, Face, HalfEdge, Map, Mode, Overlay, Piece};

pub(crate) const NONE: u32 = u32::MAX;

pub(crate) struct Built {
    pub verts: Vec<P>,
    pub halfs: Vec<HalfEdge>,
    pub pairs: Vec<Piece>,
    pub faces: Vec<Face>,
    pub face_halves: Vec<Vec<u32>>,
}

pub(crate) struct Labeled {
    pub built: Built,
    pub fills: Vec<u32>,
    pub masks: Vec<u32>,
}

pub(crate) fn overlay(pieces: Vec<Piece>, ov: Overlay) -> Labeled {
    let pieces = slice(pieces);
    let built = build(pieces);
    let (fills, masks) = label(&built, ov);
    Labeled { built, fills, masks }
}

pub(crate) fn finish(labeled: &Labeled) -> Map {
    let kept = dissolve(&labeled.built, &labeled.fills);
    let built = build(kept);
    let fills = fills_from_labels(&built);
    into_map(built, fills)
}

pub(crate) fn assemble(pieces: Vec<Piece>, ov: Overlay) -> Map {
    finish(&overlay(pieces, ov))
}

/// Split a labeled build into the faces where `inside[face]` holds and the rest.
pub(crate) fn partition(labeled: &Labeled, inside: &[bool]) -> (Map, Map) {
    let built = &labeled.built;
    let mut lifted = Vec::new();
    let mut rest = Vec::new();
    for (k, piece) in built.pairs.iter().enumerate() {
        let fa = built.halfs[2 * k].face as usize;
        let fb = built.halfs[2 * k + 1].face as usize;
        let (la, lb) = (labeled.fills[fa], labeled.fills[fb]);
        let (ia, ib) = (inside[fa], inside[fb]);
        let lift = (if ia { la } else { EMPTY }, if ib { lb } else { EMPTY });
        let stay = (if ia { EMPTY } else { la }, if ib { EMPTY } else { lb });
        let plain = Piece { top: None, mask: 0, fresh: false, ..*piece };
        if lift != (EMPTY, EMPTY) || (piece.stroke.is_some() && ia && ib) {
            lifted.push(Piece { under: Some(lift), ..plain });
        }
        if stay != (EMPTY, EMPTY) || (piece.stroke.is_some() && !ia && !ib) {
            rest.push(Piece { under: Some(stay), ..plain });
        }
    }
    (assemble(lifted, Overlay::None), assemble(rest, Overlay::None))
}

pub(crate) fn build(pieces: Vec<Piece>) -> Built {
    let mut index: HashMap<P, u32> = HashMap::new();
    let mut verts: Vec<P> = Vec::new();
    let mut intern = |point: P| -> u32 {
        if let Some(&id) = index.get(&point) {
            return id;
        }
        let id = verts.len() as u32;
        verts.push(point);
        index.insert(point, id);
        id
    };
    let mut halfs = Vec::with_capacity(pieces.len() * 2);
    let mut pairs = Vec::with_capacity(pieces.len());
    for piece in pieces {
        if piece.a == piece.b {
            continue;
        }
        let a = intern(piece.a);
        let b = intern(piece.b);
        let blank = HalfEdge {
            origin: a,
            next: NONE,
            face: NONE,
            fill: EMPTY,
            stroke: piece.stroke,
            ctrl: piece.ctrl,
        };
        halfs.push(blank);
        halfs.push(HalfEdge { origin: b, ..blank });
        pairs.push(piece);
    }
    link(&mut halfs, &verts);
    let cycles = walk(&mut halfs);
    let (faces, face_halves) = attach(&verts, &mut halfs, &cycles);
    Built { verts, halfs, pairs, faces, face_halves }
}

fn into_map(built: Built, fills: Vec<u32>) -> Map {
    let Built { verts, mut halfs, mut faces, .. } = built;
    for half in halfs.iter_mut() {
        half.fill = fills[half.face as usize];
    }
    for (face, fill) in faces.iter_mut().zip(fills) {
        face.fill = fill;
    }
    Map { verts, halfs, faces }
}

fn fills_from_labels(built: &Built) -> Vec<u32> {
    let mut fills = vec![EMPTY; built.faces.len()];
    for (k, piece) in built.pairs.iter().enumerate() {
        let (l, r) = piece.under.unwrap_or((EMPTY, EMPTY));
        fills[built.halfs[2 * k].face as usize] = l;
        fills[built.halfs[2 * k + 1].face as usize] = r;
    }
    fills
}

fn dissolve(built: &Built, fills: &[u32]) -> Vec<Piece> {
    built
        .pairs
        .iter()
        .enumerate()
        .filter_map(|(k, piece)| {
            let l = fills[built.halfs[2 * k].face as usize];
            let r = fills[built.halfs[2 * k + 1].face as usize];
            if l == r && piece.stroke.is_none() {
                return None;
            }
            Some(Piece { under: Some((l, r)), top: None, mask: 0, fresh: false, ..*piece })
        })
        .collect()
}

fn edge_geometry(verts: &[P], halfs: &[HalfEdge], half: u32) -> (P, P, Option<P>) {
    let a = verts[halfs[half as usize].origin as usize];
    let b = verts[halfs[(half ^ 1) as usize].origin as usize];
    (a, b, halfs[half as usize].ctrl)
}

/// Direction a half-edge leaves its origin: the tangent for a curve.
fn leave_dir(verts: &[P], halfs: &[HalfEdge], half: u32) -> (f64, f64) {
    let (a, b, ctrl) = edge_geometry(verts, halfs, half);
    if let Some(c) = ctrl
        && c != a
    {
        return ((c.0 - a.0) as f64, (c.1 - a.1) as f64);
    }
    ((b.0 - a.0) as f64, (b.1 - a.1) as f64)
}

/// Direction to the midpoint, which separates a curve from its chord and two
/// curves that share a tangent.
fn mid_dir(verts: &[P], halfs: &[HalfEdge], half: u32) -> (f64, f64) {
    let (a, b, ctrl) = edge_geometry(verts, halfs, half);
    let (x, y) = edge_at(a, b, ctrl, 0.5);
    (x - a.0 as f64, y - a.1 as f64)
}

fn link(halfs: &mut [HalfEdge], verts: &[P]) {
    let mut outgoing: Vec<Vec<u32>> = vec![Vec::new(); verts.len()];
    for (index, half) in halfs.iter().enumerate() {
        outgoing[half.origin as usize].push(index as u32);
    }
    for edges in &mut outgoing {
        if edges.is_empty() {
            continue;
        }
        edges.sort_by(|&a, &b| {
            cmp_dir(leave_dir(verts, halfs, a), leave_dir(verts, halfs, b))
                .then_with(|| cmp_dir(mid_dir(verts, halfs, a), mid_dir(verts, halfs, b)))
                .then(a.cmp(&b))
        });
        let n = edges.len();
        for i in 0..n {
            let incoming = edges[i] ^ 1;
            halfs[incoming as usize].next = edges[(i + n - 1) % n];
        }
    }
}

/// Follow `next` links; stores the cycle id in `face` for `attach` to replace.
fn walk(halfs: &mut [HalfEdge]) -> Vec<u32> {
    let mut cycles = Vec::new();
    for start in 0..halfs.len() {
        if halfs[start].face != NONE {
            continue;
        }
        let id = cycles.len() as u32;
        let mut edge = start as u32;
        for _ in 0..=halfs.len() {
            halfs[edge as usize].face = id;
            let next = halfs[edge as usize].next;
            if next == NONE || halfs[next as usize].face != NONE {
                break;
            }
            edge = next;
        }
        cycles.push(start as u32);
    }
    cycles
}

struct UnionFind(Vec<usize>);

impl UnionFind {
    fn new(n: usize) -> Self {
        Self((0..n).collect())
    }
    fn find(&mut self, mut i: usize) -> usize {
        while self.0[i] != i {
            self.0[i] = self.0[self.0[i]];
            i = self.0[i];
        }
        i
    }
    fn union(&mut self, a: usize, b: usize) {
        let ra = self.find(a);
        let rb = self.find(b);
        if ra != rb {
            self.0[ra] = rb;
        }
    }
}

/// Group cycles into faces. Face 0 is the unbounded face.
fn attach(verts: &[P], halfs: &mut [HalfEdge], cycles: &[u32]) -> (Vec<Face>, Vec<Vec<u32>>) {
    let n = cycles.len();
    let mut cycle_halves: Vec<Vec<u32>> = vec![Vec::new(); n];
    for (index, half) in halfs.iter().enumerate() {
        cycle_halves[half.face as usize].push(index as u32);
    }
    let mut area = vec![0i128; n];
    let mut leftmost = vec![(f64::MAX, f64::MAX); n];
    for c in 0..n {
        for &h in &cycle_halves[c] {
            let (a, b, ctrl) = edge_geometry(verts, halfs, h);
            area[c] += edge_area6(a, b, ctrl);
            let pa = (a.0 as f64, a.1 as f64);
            if pa < leftmost[c] {
                leftmost[c] = pa;
            }
            if let Some(ctrl) = ctrl
                && let Some(t) = quad_extremum(a.0, ctrl.0, b.0)
            {
                let p = quad_at(a, ctrl, b, t);
                if p < leftmost[c] {
                    leftmost[c] = p;
                }
            }
        }
    }
    let mut sets = UnionFind::new(n + 1);
    for c in 0..n {
        if area[c] > 0 {
            continue;
        }
        match ray_left(verts, halfs, leftmost[c], Some(c as u32)) {
            Some(hit) => sets.union(c, halfs[hit as usize].face as usize),
            None => sets.union(c, n),
        }
    }
    let unbounded = sets.find(n);
    let mut face_of_root: HashMap<usize, usize> = HashMap::new();
    face_of_root.insert(unbounded, 0);
    let mut faces = vec![Face { fill: EMPTY, outer: None, inner: Vec::new() }];
    let mut face_halves: Vec<Vec<u32>> = vec![Vec::new()];
    let mut cycle_face = vec![0usize; n];
    for c in 0..n {
        let root = sets.find(c);
        let face = *face_of_root.entry(root).or_insert_with(|| {
            faces.push(Face { fill: EMPTY, outer: None, inner: Vec::new() });
            face_halves.push(Vec::new());
            faces.len() - 1
        });
        cycle_face[c] = face;
    }
    // A bounded face needs exactly one positive cycle. Anything else is a
    // degenerate arrangement; fold it into the unbounded face.
    let mut remap: Vec<usize> = (0..faces.len()).collect();
    for c in 0..n {
        if area[c] > 0 {
            let face = cycle_face[c];
            if face != 0 && faces[face].outer.is_none() {
                faces[face].outer = Some(cycles[c]);
            }
        }
    }
    for face in 1..faces.len() {
        if faces[face].outer.is_none() {
            remap[face] = 0;
        }
    }
    let mut compacted: Vec<Face> = Vec::new();
    let mut compacted_halves: Vec<Vec<u32>> = Vec::new();
    let mut new_index = vec![0usize; faces.len()];
    for face in 0..faces.len() {
        if remap[face] != face {
            continue;
        }
        new_index[face] = compacted.len();
        compacted.push(Face { fill: EMPTY, outer: faces[face].outer, inner: Vec::new() });
        compacted_halves.push(Vec::new());
    }
    for c in 0..n {
        let face = new_index[remap[cycle_face[c]]];
        if compacted[face].outer != Some(cycles[c]) {
            compacted[face].inner.push(cycles[c]);
        }
        for &h in &cycle_halves[c] {
            halfs[h as usize].face = face as u32;
        }
        compacted_halves[face].extend(&cycle_halves[c]);
    }
    let _ = face_halves;
    (compacted, compacted_halves)
}

/// One crossing of the horizontal line through `sy` with an edge, under
/// "just below the line" semantics: a vertex on the line counts for the edges
/// that continue below it. `key` orders ties at a shared vertex by the slope
/// of the downward direction; `dy` is the sign of the a→b tangent's y.
struct RayHit {
    x: f64,
    key: f64,
    dy: i8,
}

fn ray_hits(a: P, b: P, ctrl: Option<P>, sy: f64, out: &mut Vec<RayHit>) {
    let (ax, ay) = (a.0 as f64, a.1 as f64);
    let (bx, by) = (b.0 as f64, b.1 as f64);
    let Some(c) = ctrl else {
        if (ay <= sy) == (by <= sy) {
            return;
        }
        let slope = (bx - ax) / (by - ay);
        out.push(RayHit {
            x: ax + (sy - ay) * slope,
            key: slope,
            dy: if by > ay { 1 } else { -1 },
        });
        return;
    };
    let (cx, cy) = (c.0 as f64, c.1 as f64);
    let qa = ay - 2.0 * cy + by;
    let qb = 2.0 * (cy - ay);
    let qc = ay - sy;
    let big = 1e18;
    if ay == sy {
        let goes_down = qb > 0.0 || (qb == 0.0 && qa > 0.0);
        if goes_down {
            let tx = 2.0 * (cx - ax);
            let key = if qb != 0.0 { tx / qb } else { tx.signum() * big };
            out.push(RayHit { x: ax, key, dy: 1 });
        }
    }
    if by == sy {
        let d1 = qb + 2.0 * qa;
        let goes_down = d1 < 0.0 || (d1 == 0.0 && qa > 0.0);
        if goes_down {
            let tx = 2.0 * (bx - cx);
            let key = if d1 != 0.0 { tx / d1 } else { -tx.signum() * big };
            out.push(RayHit { x: bx, key, dy: -1 });
        }
    }
    let roots: Vec<f64> = if qa == 0.0 {
        if qb == 0.0 { Vec::new() } else { vec![-qc / qb] }
    } else {
        let disc = qb * qb - 4.0 * qa * qc;
        if disc <= 0.0 {
            Vec::new()
        } else {
            let root = disc.sqrt();
            vec![(-qb - root) / (2.0 * qa), (-qb + root) / (2.0 * qa)]
        }
    };
    for t in roots {
        if t <= 0.0 || t >= 1.0 {
            continue;
        }
        if (ay == sy && t < 1e-7) || (by == sy && t > 1.0 - 1e-7) {
            continue;
        }
        let ty = qb + 2.0 * qa * t;
        if ty == 0.0 {
            continue;
        }
        let (x, _) = quad_at(a, c, b, t);
        let (tx, _) = quad_tangent(a, c, b, t);
        out.push(RayHit { x, key: tx / ty, dy: if ty > 0.0 { 1 } else { -1 } });
    }
}

/// Nearest edge crossing the leftward ray from `start`, as the half-edge
/// whose face lies on the ray's side (to the right of the hit). Edges of the
/// cycle `skip` are ignored.
pub(crate) fn ray_left(verts: &[P], halfs: &[HalfEdge], start: (f64, f64), skip: Option<u32>) -> Option<u32> {
    let (sx, sy) = start;
    let mut best: Option<(f64, f64, u32)> = None;
    let mut hits = Vec::new();
    for k in 0..halfs.len() / 2 {
        let h0 = (2 * k) as u32;
        if let Some(c) = skip
            && (halfs[h0 as usize].face == c || halfs[h0 as usize + 1].face == c)
        {
            continue;
        }
        let (a, b, ctrl) = edge_geometry(verts, halfs, h0);
        hits.clear();
        ray_hits(a, b, ctrl, sy, &mut hits);
        for hit in &hits {
            if hit.x >= sx - 1e-7 {
                continue;
            }
            let half = if hit.dy < 0 { h0 } else { h0 + 1 };
            let better = match best {
                None => true,
                Some((bx, bk, _)) => hit.x > bx || (hit.x == bx && hit.key > bk),
            };
            if better {
                best = Some((hit.x, hit.key, half));
            }
        }
    }
    best.map(|(_, _, half)| half)
}

fn label(built: &Built, ov: Overlay) -> (Vec<u32>, Vec<u32>) {
    let n = built.faces.len();
    let mut under = vec![EMPTY; n];
    let mut top = vec![EMPTY; n];
    let mut mask = vec![0u32; n];
    let mut seen = vec![false; n];
    seen[0] = true;
    let mut queue = VecDeque::from([0usize]);
    while let Some(face) = queue.pop_front() {
        for &h in &built.face_halves[face] {
            let other = built.halfs[(h ^ 1) as usize].face as usize;
            if seen[other] {
                continue;
            }
            let piece = &built.pairs[(h / 2) as usize];
            let to_right = h % 2 == 0;
            let pick = |labels: Option<(u32, u32)>, current: u32| match labels {
                Some((l, r)) => {
                    if to_right {
                        r
                    } else {
                        l
                    }
                }
                None => current,
            };
            under[other] = pick(piece.under, under[face]);
            top[other] = pick(piece.top, top[face]);
            mask[other] = mask[face] ^ piece.mask;
            seen[other] = true;
            queue.push_back(other);
        }
    }
    let fills = (0..n).map(|f| final_fill(ov, under[f], top[f], mask[f])).collect();
    (fills, mask)
}

fn final_fill(ov: Overlay, under: u32, top: u32, mask: u32) -> u32 {
    match ov {
        Overlay::None => under,
        Overlay::Paint(fill, mode) => {
            let inside = mask & 1 != 0;
            match mode {
                Mode::Over => {
                    if inside {
                        fill
                    } else {
                        under
                    }
                }
                Mode::Erase => {
                    if inside {
                        EMPTY
                    } else {
                        under
                    }
                }
                Mode::Inside(target) => {
                    if inside && under == target {
                        fill
                    } else {
                        under
                    }
                }
                Mode::Behind => {
                    if inside && under == EMPTY {
                        fill
                    } else {
                        under
                    }
                }
            }
        }
        Overlay::Stamp => {
            if top != EMPTY {
                top
            } else {
                under
            }
        }
        Overlay::Region(op) => {
            let a = mask & 1 != 0;
            let b = mask & 2 != 0;
            let keep = match op {
                BoolOp::Union => a || b,
                BoolOp::Intersect => a && b,
                BoolOp::Subtract => a && !b,
                BoolOp::Xor => a != b,
            };
            if keep { 1 } else { EMPTY }
        }
    }
}
