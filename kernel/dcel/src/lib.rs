//! Merge-drawing planar map. The edges are the document.
//!
//! A `Map` is a doubly connected edge list over integer twips. Every edit
//! takes the edges that still exist, adds what the edit brings, and rebuilds
//! the map from that set: crossings become vertices, faces are relabeled, and
//! an edge with the same fill on both sides disappears.

mod build;
mod geom;
mod io;
mod slice;

pub use geom::{P, cubic_to_quads};

use build::{Labeled, assemble, overlay, partition, ray_left};
use geom::*;

pub const EMPTY: u32 = 0;
pub const TWIPS_PER_PX: i32 = 20;

/// One segment of a ring, ending at its last point.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Seg {
    Line(P),
    /// `(ctrl, to)`
    Quad(P, P),
    /// `(ctrl1, ctrl2, to)`; converted to quadratics on input.
    Cubic(P, P, P),
}

/// A closed loop. The last segment is joined back to `start` if it does not end there.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Ring {
    pub start: P,
    pub segs: Vec<Seg>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// The region takes the new fill.
    Over,
    /// The region becomes empty.
    Erase,
    /// Only the parts of the region that currently have this fill change.
    Inside(u32),
    /// Only the empty parts of the region change.
    Behind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoolOp {
    Union,
    Intersect,
    Subtract,
    Xor,
}

/// `x' = a x + c y + e`, `y' = b x + d y + f`, with `e`/`f` in twips.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Affine {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
}

impl Affine {
    pub const IDENTITY: Affine = Affine { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 0.0, f: 0.0 };

    pub fn apply(&self, p: P) -> P {
        let x = p.0 as f64;
        let y = p.1 as f64;
        round_p((self.a * x + self.c * y + self.e, self.b * x + self.d * y + self.f))
    }

    pub fn is_identity(&self) -> bool {
        *self == Self::IDENTITY
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HalfEdge {
    pub origin: u32,
    pub next: u32,
    pub face: u32,
    pub fill: u32,
    pub stroke: Option<u32>,
    /// Absolute control point of the quadratic to the twin's origin. `None` is straight.
    pub ctrl: Option<P>,
}

/// A face is one outer cycle (none for the unbounded face) plus hole cycles,
/// each given by one half-edge on it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Face {
    pub fill: u32,
    pub outer: Option<u32>,
    pub inner: Vec<u32>,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Piece {
    a: P,
    b: P,
    ctrl: Option<P>,
    /// Fill on the left and right of a→b, when this edge already carried fills.
    under: Option<(u32, u32)>,
    /// Fills of a stamped map, which override `under` where present.
    top: Option<(u32, u32)>,
    /// Nonzero winding contribution of this directed edge `a → b` for the
    /// paint ring (slot 0) and the second region of a boolean (slot 1).
    wind: [i8; 2],
    stroke: Option<u32>,
    /// Needs intersection tests against its neighbours.
    fresh: bool,
}

impl Piece {
    pub(crate) fn flip(&mut self) {
        std::mem::swap(&mut self.a, &mut self.b);
        self.under = self.under.map(|(l, r)| (r, l));
        self.top = self.top.map(|(l, r)| (r, l));
        self.wind = [-self.wind[0], -self.wind[1]];
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Overlay {
    None,
    Paint(u32, Mode),
    Stamp,
    Region(BoolOp),
}

#[derive(Clone, Debug)]
pub struct Map {
    verts: Vec<P>,
    halfs: Vec<HalfEdge>,
    faces: Vec<Face>,
}

impl Default for Map {
    fn default() -> Self {
        Self::new()
    }
}

impl Map {
    pub fn new() -> Self {
        Self {
            verts: Vec::new(),
            halfs: Vec::new(),
            faces: vec![Face { fill: EMPTY, outer: None, inner: Vec::new() }],
        }
    }

    // ----- editing -----

    /// Overlay a nonzero-winding region. Straight polygon input: see `paint_polygon`.
    pub fn paint(&mut self, rings: &[Ring], fill: u32, mode: Mode) {
        let mut pieces = self.to_pieces();
        let before = pieces.len();
        for ring in rings {
            ring_pieces(ring, 0, None, &mut pieces);
        }
        if pieces.len() == before {
            return;
        }
        *self = assemble(pieces, Overlay::Paint(fill, mode));
    }

    pub fn paint_polygon(&mut self, pts: &[P], fill: u32) {
        self.paint(&[polygon(pts)], fill, Mode::Over);
    }

    pub fn paint_polygon_with(&mut self, pts: &[P], fill: u32, stroke: Option<u32>) {
        let mut pieces = self.to_pieces();
        let before = pieces.len();
        let ring = polygon(pts);
        ring_pieces(&ring, 0, None, &mut pieces);
        for piece in &mut pieces[before..] {
            piece.stroke = stroke;
        }
        if pieces.len() == before {
            return;
        }
        *self = assemble(pieces, Overlay::Paint(fill, Mode::Over));
    }

    /// Paint bucket: recolor the face under a point. The unbounded face is never filled.
    pub fn fill_at(&mut self, p: P, fill: u32) -> bool {
        let face = self.face_index_at(p);
        if face == 0 {
            return false;
        }
        if self.faces[face].fill == fill {
            return true;
        }
        self.faces[face].fill = fill;
        for half in self.halfs.iter_mut() {
            if half.face as usize == face {
                half.fill = fill;
            }
        }
        self.rebuild();
        true
    }

    pub fn move_vertex(&mut self, from: P, to: P) -> bool {
        self.move_vertices(&[(from, to)])
    }

    /// Move several vertices at once (`(from, to)` pairs) with a single
    /// rebuild, so no intermediate position can weld or split anything.
    /// A curve's control follows its endpoints: by the full offset when
    /// both ends move together, by half when only one does. Returns false
    /// if any `from` is not a vertex.
    pub fn move_vertices(&mut self, moves: &[(P, P)]) -> bool {
        if moves.iter().any(|(from, _)| !self.has_vertex(*from)) {
            return false;
        }
        if moves.iter().all(|(from, to)| from == to) {
            return true;
        }
        let delta_of = |p: P| moves.iter().find(|(from, _)| *from == p).map(|(from, to)| sub(*to, *from));
        let mut pieces = self.to_pieces();
        for piece in &mut pieces {
            let da = delta_of(piece.a);
            let db = delta_of(piece.b);
            if da.is_none() && db.is_none() {
                continue;
            }
            if let Some(d) = da {
                piece.a = (piece.a.0 + d.0 as i32, piece.a.1 + d.1 as i32);
            }
            if let Some(d) = db {
                piece.b = (piece.b.0 + d.0 as i32, piece.b.1 + d.1 as i32);
            }
            if let Some(c) = piece.ctrl {
                let (sx, sy) = [da, db].into_iter().flatten().fold((0i64, 0i64), |acc, d| (acc.0 + d.0, acc.1 + d.1));
                let moved = ((sx + sx.signum()) / 2, (sy + sy.signum()) / 2);
                let c = (c.0 + moved.0 as i32, c.1 + moved.1 as i32);
                piece.ctrl = if near_chord(piece.a, piece.b, c) { None } else { Some(c) };
            }
            piece.fresh = true;
        }
        pieces.retain(|piece| piece.a != piece.b);
        *self = assemble(pieces, Overlay::None);
        true
    }

    /// Bend the edge identified by `(a, b, ctrl)`. A control on the chord straightens it.
    pub fn curve_edge(&mut self, a: P, b: P, ctrl: Option<P>, to: P) -> bool {
        let mut pieces = self.to_pieces();
        let mut found = false;
        for piece in &mut pieces {
            if !same_edge(piece, a, b, ctrl) {
                continue;
            }
            found = true;
            piece.ctrl = if near_chord(piece.a, piece.b, to) { None } else { Some(to) };
            piece.fresh = true;
        }
        if !found {
            return false;
        }
        *self = assemble(pieces, Overlay::None);
        true
    }

    /// Replace the edges along `chain` (consecutive vertices, every interior
    /// one of degree 2) with `segs`, which must run from the first vertex to
    /// the last. The fills on either side carry over to the new edges.
    /// Nothing changes unless every consecutive pair is an existing edge.
    pub fn replace_chain(&mut self, chain: &[P], segs: &[Seg]) -> bool {
        if chain.len() < 2 || segs.is_empty() {
            return false;
        }
        let first = chain[0];
        let last = chain[chain.len() - 1];
        let pieces = self.to_pieces();
        let mut removed = vec![false; pieces.len()];
        let mut under: Option<(u32, u32)> = None;
        let mut stroke: Option<u32> = None;
        for pair in chain.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            if a == b {
                return false;
            }
            let Some(index) = pieces
                .iter()
                .enumerate()
                .position(|(i, p)| !removed[i] && ((p.a == a && p.b == b) || (p.a == b && p.b == a)))
            else {
                return false;
            };
            let piece = pieces[index];
            let oriented = piece.under.map(|(l, r)| if piece.a == a { (l, r) } else { (r, l) });
            match (under, oriented) {
                (None, o) => under = o,
                (Some(u), Some(o)) if u != o => return false,
                _ => {}
            }
            stroke = stroke.or(piece.stroke);
            removed[index] = true;
        }
        // Interior vertices must not touch anything else, or the chain would tear.
        let interior = if first == last { &chain[..chain.len() - 1] } else { &chain[1..chain.len() - 1] };
        for &v in interior {
            let degree = pieces.iter().filter(|p| p.a == v || p.b == v).count();
            if degree != 2 {
                return false;
            }
        }
        let mut fresh = Vec::new();
        let end = walk_segs(first, segs, |a, b, ctrl| {
            fresh.push(Piece { a, b, ctrl, under, top: None, wind: [0, 0], stroke, fresh: true });
        });
        if end != last {
            return false;
        }
        let mut kept: Vec<Piece> = pieces.iter().zip(&removed).filter(|(_, r)| !**r).map(|(p, _)| *p).collect();
        kept.append(&mut fresh);
        *self = assemble(kept, Overlay::None);
        true
    }

    /// Delete one edge. The faces on either side merge; the first label the
    /// flood reaches wins.
    pub fn remove_edge(&mut self, a: P, b: P, ctrl: Option<P>) -> bool {
        let mut pieces = self.to_pieces();
        let before = pieces.len();
        pieces.retain(|piece| !same_edge(piece, a, b, ctrl));
        if pieces.len() == before {
            return false;
        }
        *self = assemble(pieces, Overlay::None);
        true
    }

    /// Replace fill ids. Edges between faces that now share a fill dissolve.
    pub fn remap_fills(&mut self, pairs: &[(u32, u32)]) {
        if pairs.is_empty() {
            return;
        }
        let map = |fill: u32| pairs.iter().find(|(from, _)| *from == fill).map_or(fill, |(_, to)| *to);
        let mut pieces = self.to_pieces();
        for piece in &mut pieces {
            piece.under = piece.under.map(|(l, r)| (map(l), map(r)));
        }
        *self = assemble(pieces, Overlay::None);
    }

    pub fn transform(&mut self, xf: &Affine) {
        if xf.is_identity() {
            return;
        }
        let pieces = transformed_pieces(self.to_pieces(), xf);
        *self = assemble(pieces, Overlay::None);
    }

    pub fn transformed(&self, xf: &Affine) -> Map {
        let mut out = self.clone();
        out.transform(xf);
        out
    }

    /// Lift everything inside a nonzero-winding region into a new map; the rest stays.
    pub fn split_off(&mut self, rings: &[Ring]) -> Map {
        let mut pieces = self.to_pieces();
        for ring in rings {
            ring_pieces(ring, 0, None, &mut pieces);
        }
        let labeled = overlay(pieces, Overlay::None);
        let inside: Vec<bool> = labeled.winds.iter().map(|w| w[0] != 0).collect();
        self.take_partition(labeled, &inside)
    }

    /// Lift the face under a point into a new map.
    pub fn split_off_face(&mut self, p: P) -> Map {
        let face = self.face_index_at(p);
        if face == 0 || self.faces[face].fill == EMPTY {
            return Map::new();
        }
        let labeled = overlay(self.to_pieces(), Overlay::None);
        // Faces survive `overlay` unchanged, but their indices come from a
        // fresh build; find the one that still contains the point.
        let target = face_index_in(&labeled.built.verts, &labeled.built.halfs, p);
        let inside: Vec<bool> = (0..labeled.built.faces.len()).map(|f| f == target).collect();
        self.take_partition(labeled, &inside)
    }

    /// Lift every face whose fill is in `fills`.
    pub fn split_off_fills(&mut self, fills: &[u32]) -> Map {
        let labeled = overlay(self.to_pieces(), Overlay::None);
        let inside: Vec<bool> = labeled.fills.iter().map(|fill| *fill != EMPTY && fills.contains(fill)).collect();
        self.take_partition(labeled, &inside)
    }

    fn take_partition(&mut self, labeled: Labeled, inside: &[bool]) -> Map {
        let (lifted, rest) = partition(&labeled, inside);
        *self = rest;
        lifted
    }

    /// Drop another map on top of this one. Its filled faces win; its empty
    /// faces show what is underneath.
    pub fn stamp(&mut self, other: &Map, xf: &Affine) {
        let mut pieces = self.to_pieces();
        let top = transformed_pieces(other.to_pieces(), xf);
        if top.is_empty() {
            return;
        }
        pieces.extend(top.into_iter().map(|piece| Piece { top: piece.under, under: None, fresh: true, ..piece }));
        *self = assemble(pieces, Overlay::Stamp);
    }

    fn rebuild(&mut self) {
        *self = assemble(self.to_pieces(), Overlay::None);
    }

    // ----- queries -----

    /// Fill under a point; `EMPTY` outside every shape.
    pub fn face_at(&self, p: P) -> u32 {
        self.faces[self.face_index_at(p)].fill
    }

    pub fn face_index_at(&self, p: P) -> usize {
        face_index_in(&self.verts, &self.halfs, p)
    }

    pub fn nearest_vertex(&self, p: P, tol: i32) -> Option<P> {
        let tol2 = tol as i64 * tol as i64;
        self.verts
            .iter()
            .copied()
            .map(|v| {
                let (dx, dy) = sub(v, p);
                (dx * dx + dy * dy, v)
            })
            .filter(|(d2, _)| *d2 <= tol2)
            .min_by_key(|(d2, _)| *d2)
            .map(|(_, v)| v)
    }

    /// Nearest edge within `tol` twips as `(a, b, ctrl)`.
    pub fn nearest_edge(&self, p: P, tol: i32) -> Option<(P, P, Option<P>)> {
        let point = (p.0 as f64, p.1 as f64);
        let mut best: Option<(f64, (P, P, Option<P>))> = None;
        for pair in self.halfs.chunks(2) {
            let a = self.verts[pair[0].origin as usize];
            let b = self.verts[pair[1].origin as usize];
            let (x0, y0, x1, y1) = seg_bounds(a, b, pair[0].ctrl);
            if (p.0 + tol) < x0 || (p.0 - tol) > x1 || (p.1 + tol) < y0 || (p.1 - tol) > y1 {
                continue;
            }
            let d = point_edge_dist(point, a, b, pair[0].ctrl);
            if d <= tol as f64 && best.is_none_or(|(bd, _)| d < bd) {
                best = Some((d, (a, b, pair[0].ctrl)));
            }
        }
        best.map(|(_, edge)| edge)
    }

    pub fn has_vertex(&self, p: P) -> bool {
        self.verts.contains(&p)
    }

    pub fn connected(&self, a: P, b: P) -> bool {
        self.halfs.chunks(2).any(|pair| {
            let p = self.verts[pair[0].origin as usize];
            let q = self.verts[pair[1].origin as usize];
            (p == a && q == b) || (p == b && q == a)
        })
    }

    pub fn is_empty(&self) -> bool {
        self.halfs.is_empty()
    }

    pub fn vertex_count(&self) -> usize {
        self.verts.len()
    }

    pub fn vertices(&self) -> &[P] {
        &self.verts
    }

    pub fn half_edges(&self) -> &[HalfEdge] {
        &self.halfs
    }

    pub fn twin(i: u32) -> u32 {
        i ^ 1
    }

    pub fn faces(&self) -> &[Face] {
        &self.faces
    }

    /// Distinct fills in use, ascending.
    pub fn fills(&self) -> Vec<u32> {
        let mut fills: Vec<u32> = self.faces.iter().map(|face| face.fill).filter(|fill| *fill != EMPTY).collect();
        fills.sort_unstable();
        fills.dedup();
        fills
    }

    /// Tight bounds in twips, or `None` when empty.
    pub fn bounds(&self) -> Option<(f64, f64, f64, f64)> {
        let mut out: Option<(f64, f64, f64, f64)> = None;
        for pair in self.halfs.chunks(2) {
            let a = self.verts[pair[0].origin as usize];
            let b = self.verts[pair[1].origin as usize];
            let bb = match pair[0].ctrl {
                Some(c) => quad_bounds(a, c, b),
                None => (a.0.min(b.0) as f64, a.1.min(b.1) as f64, a.0.max(b.0) as f64, a.1.max(b.1) as f64),
            };
            out = Some(match out {
                None => bb,
                Some(o) => (o.0.min(bb.0), o.1.min(bb.1), o.2.max(bb.2), o.3.max(bb.3)),
            });
        }
        out
    }

    /// The boundary of a cycle as a ring.
    pub fn cycle_ring(&self, start: u32) -> Ring {
        let mut ring = Ring { start: self.verts[self.halfs[start as usize].origin as usize], segs: Vec::new() };
        let mut edge = start;
        for _ in 0..=self.halfs.len() {
            let half = self.halfs[edge as usize];
            let to = self.verts[self.halfs[(edge ^ 1) as usize].origin as usize];
            ring.segs.push(match half.ctrl {
                Some(c) => Seg::Quad(c, to),
                None => Seg::Line(to),
            });
            edge = half.next;
            if edge == start || edge == build::NONE {
                break;
            }
        }
        ring
    }

    /// Every filled face as `(fill, rings)`: the outer ring first, then holes.
    pub fn regions(&self) -> Vec<(u32, Vec<Ring>)> {
        self.faces
            .iter()
            .filter(|face| face.fill != EMPTY && face.outer.is_some())
            .map(|face| {
                let mut rings = vec![self.cycle_ring(face.outer.unwrap())];
                rings.extend(face.inner.iter().map(|&start| self.cycle_ring(start)));
                (face.fill, rings)
            })
            .collect()
    }

    pub fn digest(&self) -> u64 {
        let mut hash = 0xcbf29ce484222325u64;
        let mix = |hash: &mut u64, value: u64| {
            *hash ^= value;
            *hash = hash.wrapping_mul(0x100000001b3);
        };
        for &(x, y) in &self.verts {
            mix(&mut hash, x as u32 as u64);
            mix(&mut hash, y as u32 as u64);
        }
        for half in &self.halfs {
            mix(&mut hash, half.origin as u64);
            mix(&mut hash, half.next as u64);
            mix(&mut hash, half.fill as u64);
            mix(&mut hash, half.stroke.unwrap_or(0) as u64);
            if let Some((x, y)) = half.ctrl {
                mix(&mut hash, x as u32 as u64);
                mix(&mut hash, y as u32 as u64);
            }
        }
        for face in &self.faces {
            mix(&mut hash, face.fill as u64);
        }
        hash
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        io::to_bytes(self)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Map, String> {
        io::from_bytes(bytes)
    }

    fn to_pieces(&self) -> Vec<Piece> {
        self.halfs
            .chunks(2)
            .filter_map(|pair| {
                let a = self.verts[pair[0].origin as usize];
                let b = self.verts[pair[1].origin as usize];
                if a == b {
                    return None;
                }
                Some(Piece {
                    a,
                    b,
                    ctrl: pair[0].ctrl.or(pair[1].ctrl),
                    under: Some((pair[0].fill, pair[1].fill)),
                    top: None,
                    wind: [0, 0],
                    stroke: pair[0].stroke.or(pair[1].stroke),
                    fresh: false,
                })
            })
            .collect()
    }
}

/// Boolean operation on two nonzero-winding regions; the result is a list of
/// rings (outer boundaries and holes) suitable for `paint`.
pub fn region_op(a: &[Ring], b: &[Ring], op: BoolOp) -> Vec<Ring> {
    let mut pieces = Vec::new();
    for ring in a {
        ring_pieces(ring, 0, None, &mut pieces);
    }
    for ring in b {
        ring_pieces(ring, 1, None, &mut pieces);
    }
    let map = assemble(pieces, Overlay::Region(op));
    map.regions().into_iter().flat_map(|(_, rings)| rings).collect()
}

pub fn polygon(pts: &[P]) -> Ring {
    let mut pts: Vec<P> = pts.to_vec();
    if pts.len() >= 2 && pts.first() == pts.last() {
        pts.pop();
    }
    pts.dedup();
    let Some((&start, rest)) = pts.split_first() else {
        return Ring::default();
    };
    Ring { start, segs: rest.iter().map(|&p| Seg::Line(p)).collect() }
}

fn face_index_in(verts: &[P], halfs: &[HalfEdge], p: P) -> usize {
    // Sample the centre of the twip so the ray never starts on a vertex.
    let start = (p.0 as f64 + 0.5, p.1 as f64 + 0.5);
    match ray_left(verts, halfs, start, None) {
        Some(half) => halfs[half as usize].face as usize,
        None => 0,
    }
}

fn same_edge(piece: &Piece, a: P, b: P, ctrl: Option<P>) -> bool {
    piece.ctrl == ctrl && ((piece.a == a && piece.b == b) || (piece.a == b && piece.b == a))
}

fn transformed_pieces(mut pieces: Vec<Piece>, xf: &Affine) -> Vec<Piece> {
    if xf.is_identity() {
        return pieces;
    }
    for piece in &mut pieces {
        piece.a = xf.apply(piece.a);
        piece.b = xf.apply(piece.b);
        piece.ctrl = piece.ctrl.map(|c| xf.apply(c)).filter(|&c| !near_chord(piece.a, piece.b, c));
        piece.fresh = true;
    }
    pieces.retain(|piece| piece.a != piece.b);
    pieces
}

/// Walk `segs` from `start`, emitting `(a, b, ctrl)` for each quadratic or
/// straight piece (cubics are split into quadratics). Returns the end point.
fn walk_segs(start: P, segs: &[Seg], mut emit: impl FnMut(P, P, Option<P>)) -> P {
    let mut cur = start;
    let mut push = |a: P, b: P, ctrl: Option<P>| {
        if a == b {
            return;
        }
        let ctrl = ctrl.filter(|&c| !near_chord(a, b, c));
        emit(a, b, ctrl);
    };
    for seg in segs {
        match *seg {
            Seg::Line(to) => {
                push(cur, to, None);
                cur = to;
            }
            Seg::Quad(c, to) => {
                push(cur, to, Some(c));
                cur = to;
            }
            Seg::Cubic(c1, c2, to) => {
                let f = |p: P| (p.0 as f64, p.1 as f64);
                for (ctrl, q) in cubic_to_quads(f(cur), f(c1), f(c2), f(to), CUBIC_TOL) {
                    let q = round_p(q);
                    push(cur, q, Some(round_p(ctrl)));
                    cur = q;
                }
                cur = to;
            }
        }
    }
    cur
}

fn ring_pieces(ring: &Ring, slot: usize, top: Option<(u32, u32)>, out: &mut Vec<Piece>) {
    let mut wind = [0i8; 2];
    wind[slot] = 1;
    let mut emit = |a: P, b: P, ctrl: Option<P>| {
        out.push(Piece { a, b, ctrl, under: None, top, wind, stroke: None, fresh: true });
    };
    let cur = walk_segs(ring.start, &ring.segs, &mut emit);
    if cur != ring.start {
        emit(cur, ring.start, None);
    }
}
