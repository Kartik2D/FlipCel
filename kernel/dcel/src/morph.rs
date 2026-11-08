//! Lerp of two planar maps.
//!
//! Filled faces are matched (same fill first, then centroid and area). Cycles
//! of a matched pair are walked in order and each vertex is written once, so a
//! corner shared by two faces cannot split. Each edge is emitted once, with
//! the fills it already had on each side, and `assemble` rebuilds the map.

use std::collections::HashSet;

use crate::build::assemble;
use crate::geom::{P, edge_at, near_chord, round_p};
use crate::{EMPTY, Map, Overlay, Piece};

impl Map {
    /// Inbetween of `self` (t = 0) and `other` (t = 1).
    pub fn lerp(&self, other: &Map, t: f64) -> Map {
        if !t.is_finite() || t <= 0.0 {
            return self.clone();
        }
        if t >= 1.0 {
            return other.clone();
        }
        let a_faces = faces_of(self);
        let b_faces = faces_of(other);
        let (pairs, only_a, only_b) = match_faces(&a_faces, &b_faces);
        let mut pos_a = vec![None; self.verts.len()];
        let mut pos_b = vec![None; other.verts.len()];
        let mut acc = Acc::default();

        for (ia, ib) in pairs {
            let fa = &a_faces[ia];
            let fb = &b_faces[ib];
            acc.correspond(self, other, &fa.outer, &fb.outer, &mut pos_a, &mut pos_b, t);
            let (holes, only_ha, only_hb) = match_loops(&fa.holes, &fb.holes);
            for (ha, hb) in holes {
                acc.correspond(
                    self,
                    other,
                    &fa.holes[ha],
                    &fb.holes[hb],
                    &mut pos_a,
                    &mut pos_b,
                    t,
                );
            }
            for h in only_ha {
                acc.scale(self, &fa.holes[h], &mut pos_a, 1.0 - t, true);
            }
            for h in only_hb {
                acc.scale(other, &fb.holes[h], &mut pos_b, t, false);
            }
        }
        for i in only_a {
            acc.scale_face(self, &a_faces[i], &mut pos_a, 1.0 - t, true);
        }
        for i in only_b {
            acc.scale_face(other, &b_faces[i], &mut pos_b, t, false);
        }

        let pieces = acc
            .edges
            .into_iter()
            .map(|e| Piece {
                a: e.a,
                b: e.b,
                ctrl: e.ctrl,
                under: Some((e.left, e.right)),
                top: None,
                wind: [0, 0],
                stroke: e.stroke,
                fresh: true,
            })
            .collect();
        assemble(pieces, Overlay::None)
    }
}

struct EdgeEmit {
    a: P,
    b: P,
    ctrl: Option<P>,
    left: u32,
    right: u32,
    stroke: Option<u32>,
}

#[derive(Default)]
struct Acc {
    seen: HashSet<(bool, u32)>,
    edges: Vec<EdgeEmit>,
}

impl Acc {
    fn correspond(
        &mut self,
        a_map: &Map,
        b_map: &Map,
        a: &Loop,
        b: &Loop,
        pos_a: &mut [Option<P>],
        pos_b: &mut [Option<P>],
        t: f64,
    ) {
        if a.pts.is_empty() || b.pts.is_empty() {
            return;
        }
        let b = align(b, a.pts[0], a.cx, a.cy);
        let claimed = a.cycle.verts.iter().any(|&v| pos_a[v as usize].is_some());
        if claimed || a.pts.len() >= b.pts.len() {
            self.write(a_map, a, &b, pos_a, t, true);
        } else {
            self.write(b_map, &b, a, pos_b, t, false);
        }
    }

    /// `host` is the longer cycle's map. `from_a` means that map is pose A.
    fn write(
        &mut self,
        host: &Map,
        longer: &Loop,
        shorter: &Loop,
        pos: &mut [Option<P>],
        t: f64,
        from_a: bool,
    ) {
        let n = longer.pts.len();
        let m = shorter.pts.len();
        let (fracs, _) = fractions(&longer.pts, &longer.cycle.ctrls);
        let there = |i: usize| -> P {
            if n == m {
                shorter.pts[i]
            } else {
                sample(&shorter.pts, &shorter.cycle.ctrls, fracs[i])
            }
        };
        for i in 0..n {
            let v = longer.cycle.verts[i] as usize;
            if pos[v].is_some() {
                continue;
            }
            let here = longer.pts[i];
            let other = there(i);
            pos[v] = Some(if from_a {
                lerp(here, other, t)
            } else {
                lerp(other, here, t)
            });
        }
        for i in 0..n {
            let h = longer.cycle.halfs[i];
            if !self.seen.insert((from_a, h / 2)) {
                continue;
            }
            let j = (i + 1) % n;
            let (Some(p0), Some(p1)) = (
                pos[longer.cycle.verts[i] as usize],
                pos[longer.cycle.verts[j] as usize],
            ) else {
                continue;
            };
            let end_frac = if j == 0 { 1.0 } else { fracs[j] };
            let (q0, q1, qc) = if n == m {
                (shorter.pts[i], shorter.pts[j], shorter.cycle.ctrls[i])
            } else {
                (
                    sample(&shorter.pts, &shorter.cycle.ctrls, fracs[i]),
                    sample(&shorter.pts, &shorter.cycle.ctrls, end_frac),
                    None,
                )
            };
            let (ca, cb, a0, a1, b0, b1) = if from_a {
                (
                    longer.cycle.ctrls[i],
                    qc,
                    longer.pts[i],
                    longer.pts[j],
                    q0,
                    q1,
                )
            } else {
                (
                    qc,
                    longer.cycle.ctrls[i],
                    q0,
                    q1,
                    longer.pts[i],
                    longer.pts[j],
                )
            };
            let half = host.halfs[h as usize];
            let twin = host.halfs[(h ^ 1) as usize];
            self.push(
                p0,
                p1,
                blend_ctrl(p0, p1, ca, cb, a0, a1, b0, b1, t),
                half.fill,
                twin.fill,
                half.stroke.or(twin.stroke),
            );
        }
    }

    fn scale_face(
        &mut self,
        map: &Map,
        face: &FaceLoops,
        pos: &mut [Option<P>],
        s: f64,
        from_a: bool,
    ) {
        for lp in std::iter::once(&face.outer).chain(face.holes.iter()) {
            self.scale_at(map, lp, pos, face.outer.cx, face.outer.cy, s, from_a);
        }
    }

    fn scale(&mut self, map: &Map, lp: &Loop, pos: &mut [Option<P>], s: f64, from_a: bool) {
        self.scale_at(map, lp, pos, lp.cx, lp.cy, s, from_a);
    }

    fn scale_at(
        &mut self,
        map: &Map,
        lp: &Loop,
        pos: &mut [Option<P>],
        cx: f64,
        cy: f64,
        s: f64,
        from_a: bool,
    ) {
        let n = lp.pts.len();
        for i in 0..n {
            let v = lp.cycle.verts[i] as usize;
            if pos[v].is_none() {
                pos[v] = Some(scale_about(lp.pts[i], cx, cy, s));
            }
        }
        for i in 0..n {
            let h = lp.cycle.halfs[i];
            if !self.seen.insert((from_a, h / 2)) {
                continue;
            }
            let j = (i + 1) % n;
            let (Some(p0), Some(p1)) = (
                pos[lp.cycle.verts[i] as usize],
                pos[lp.cycle.verts[j] as usize],
            ) else {
                continue;
            };
            let ctrl = lp.cycle.ctrls[i].map(|c| scale_about(c, cx, cy, s));
            let half = map.halfs[h as usize];
            let twin = map.halfs[(h ^ 1) as usize];
            self.push(
                p0,
                p1,
                ctrl,
                half.fill,
                twin.fill,
                half.stroke.or(twin.stroke),
            );
        }
    }

    fn push(&mut self, a: P, b: P, ctrl: Option<P>, left: u32, right: u32, stroke: Option<u32>) {
        if a == b {
            return;
        }
        let ctrl = ctrl.filter(|&c| !near_chord(a, b, c));
        self.edges.push(EdgeEmit {
            a,
            b,
            ctrl,
            left,
            right,
            stroke,
        });
    }
}

struct Cycle {
    verts: Vec<u32>,
    ctrls: Vec<Option<P>>,
    halfs: Vec<u32>,
}

impl Clone for Cycle {
    fn clone(&self) -> Self {
        Self {
            verts: self.verts.clone(),
            ctrls: self.ctrls.clone(),
            halfs: self.halfs.clone(),
        }
    }
}

struct Loop {
    cycle: Cycle,
    pts: Vec<P>,
    cx: f64,
    cy: f64,
    area: f64,
}

impl Clone for Loop {
    fn clone(&self) -> Self {
        Self {
            cycle: self.cycle.clone(),
            pts: self.pts.clone(),
            cx: self.cx,
            cy: self.cy,
            area: self.area,
        }
    }
}

struct FaceLoops {
    fill: u32,
    outer: Loop,
    holes: Vec<Loop>,
}

fn faces_of(map: &Map) -> Vec<FaceLoops> {
    map.faces
        .iter()
        .filter(|face| face.fill != EMPTY)
        .filter_map(|face| {
            let outer = loop_at(map, face.outer?)?;
            let holes = face
                .inner
                .iter()
                .filter_map(|&start| loop_at(map, start))
                .collect();
            Some(FaceLoops {
                fill: face.fill,
                outer,
                holes,
            })
        })
        .collect()
}

fn loop_at(map: &Map, start: u32) -> Option<Loop> {
    let cycle = cycle_at(map, start);
    if cycle.verts.len() < 2 {
        return None;
    }
    let pts: Vec<P> = cycle.verts.iter().map(|&v| map.verts[v as usize]).collect();
    let (cx, cy, area) = stats(&pts);
    Some(Loop {
        cycle,
        pts,
        cx,
        cy,
        area,
    })
}

fn cycle_at(map: &Map, start: u32) -> Cycle {
    let mut verts = Vec::new();
    let mut ctrls = Vec::new();
    let mut halfs = Vec::new();
    let mut edge = start;
    for _ in 0..=map.halfs.len() {
        if edge as usize >= map.halfs.len() {
            break;
        }
        let half = map.halfs[edge as usize];
        verts.push(half.origin);
        ctrls.push(half.ctrl);
        halfs.push(edge);
        edge = half.next;
        if edge == start {
            break;
        }
    }
    Cycle {
        verts,
        ctrls,
        halfs,
    }
}

/// Rotate so the vertex nearest `target` is first, measured from each
/// cycle's own centroid. A world-space nearest misses when the move is
/// shorter than the face.
fn align(lp: &Loop, target: P, ox: f64, oy: f64) -> Loop {
    let tx = target.0 as f64 - ox;
    let ty = target.1 as f64 - oy;
    let mut best = 0usize;
    let mut best_d = f64::MAX;
    for (i, p) in lp.pts.iter().enumerate() {
        let dx = (p.0 as f64 - lp.cx) - tx;
        let dy = (p.1 as f64 - lp.cy) - ty;
        let d = dx * dx + dy * dy;
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    if best == 0 {
        return lp.clone();
    }
    let mut out = lp.clone();
    out.cycle.verts.rotate_left(best);
    out.cycle.ctrls.rotate_left(best);
    out.cycle.halfs.rotate_left(best);
    out.pts.rotate_left(best);
    out
}

fn match_faces(a: &[FaceLoops], b: &[FaceLoops]) -> (Vec<(usize, usize)>, Vec<usize>, Vec<usize>) {
    let mut used_a = vec![false; a.len()];
    let mut used_b = vec![false; b.len()];
    let mut pairs = Vec::new();
    take_pairs(a, b, &mut used_a, &mut used_b, &mut pairs, true);
    take_pairs(a, b, &mut used_a, &mut used_b, &mut pairs, false);
    let only_a = (0..a.len()).filter(|&i| !used_a[i]).collect();
    let only_b = (0..b.len()).filter(|&i| !used_b[i]).collect();
    (pairs, only_a, only_b)
}

fn take_pairs(
    a: &[FaceLoops],
    b: &[FaceLoops],
    used_a: &mut [bool],
    used_b: &mut [bool],
    pairs: &mut Vec<(usize, usize)>,
    same_fill: bool,
) {
    let mut cand = Vec::new();
    for i in 0..a.len() {
        if used_a[i] {
            continue;
        }
        for j in 0..b.len() {
            if used_b[j] {
                continue;
            }
            if same_fill && a[i].fill != b[j].fill {
                continue;
            }
            if !same_fill && a[i].fill == b[j].fill {
                continue;
            }
            cand.push((
                geom_cost(
                    a[i].outer.cx,
                    a[i].outer.cy,
                    a[i].outer.area,
                    b[j].outer.cx,
                    b[j].outer.cy,
                    b[j].outer.area,
                ),
                i,
                j,
            ));
        }
    }
    cand.sort_by(|p, q| p.0.partial_cmp(&q.0).unwrap_or(std::cmp::Ordering::Equal));
    for (_, i, j) in cand {
        if used_a[i] || used_b[j] {
            continue;
        }
        used_a[i] = true;
        used_b[j] = true;
        pairs.push((i, j));
    }
}

fn match_loops(a: &[Loop], b: &[Loop]) -> (Vec<(usize, usize)>, Vec<usize>, Vec<usize>) {
    let mut used_a = vec![false; a.len()];
    let mut used_b = vec![false; b.len()];
    let mut cand = Vec::new();
    for i in 0..a.len() {
        for j in 0..b.len() {
            cand.push((
                geom_cost(a[i].cx, a[i].cy, a[i].area, b[j].cx, b[j].cy, b[j].area),
                i,
                j,
            ));
        }
    }
    cand.sort_by(|p, q| p.0.partial_cmp(&q.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut pairs = Vec::new();
    for (_, i, j) in cand {
        if used_a[i] || used_b[j] {
            continue;
        }
        used_a[i] = true;
        used_b[j] = true;
        pairs.push((i, j));
    }
    let only_a = (0..a.len()).filter(|&i| !used_a[i]).collect();
    let only_b = (0..b.len()).filter(|&i| !used_b[i]).collect();
    (pairs, only_a, only_b)
}

fn geom_cost(ax: f64, ay: f64, aa: f64, bx: f64, by: f64, ba: f64) -> f64 {
    let dx = ax - bx;
    let dy = ay - by;
    let dist = (dx * dx + dy * dy).sqrt();
    let scale = aa.abs().sqrt().max(1.0) + ba.abs().sqrt().max(1.0);
    let area_pen = (aa - ba).abs() / (aa.abs() + ba.abs()).max(1.0);
    dist / scale + area_pen
}

/// Signed area and centroid of the chord polygon.
fn stats(pts: &[P]) -> (f64, f64, f64) {
    let n = pts.len();
    if n == 0 {
        return (0.0, 0.0, 0.0);
    }
    let mut twice = 0.0;
    let mut cx = 0.0;
    let mut cy = 0.0;
    for i in 0..n {
        let p = pts[i];
        let q = pts[(i + 1) % n];
        let cross = p.0 as f64 * q.1 as f64 - q.0 as f64 * p.1 as f64;
        twice += cross;
        cx += (p.0 as f64 + q.0 as f64) * cross;
        cy += (p.1 as f64 + q.1 as f64) * cross;
    }
    let area = twice * 0.5;
    if area.abs() < 1.0 {
        let (mut sx, mut sy) = (0.0, 0.0);
        for p in pts {
            sx += p.0 as f64;
            sy += p.1 as f64;
        }
        return (sx / n as f64, sy / n as f64, area);
    }
    (cx / (6.0 * area), cy / (6.0 * area), area)
}

fn fractions(pts: &[P], ctrls: &[Option<P>]) -> (Vec<f64>, f64) {
    let n = pts.len();
    let mut acc = vec![0.0; n];
    let mut total = 0.0;
    for i in 0..n {
        acc[i] = total;
        total += seg_len(pts[i], pts[(i + 1) % n], ctrls[i]);
    }
    if total < 1e-6 {
        return (vec![0.0; n], 0.0);
    }
    (acc.iter().map(|s| s / total).collect(), total)
}

fn sample(pts: &[P], ctrls: &[Option<P>], f: f64) -> P {
    let n = pts.len();
    if n == 0 {
        return (0, 0);
    }
    if n == 1 {
        return pts[0];
    }
    let mut lens = Vec::with_capacity(n);
    let mut total = 0.0;
    for i in 0..n {
        let len = seg_len(pts[i], pts[(i + 1) % n], ctrls[i]);
        lens.push(len);
        total += len;
    }
    if total < 1e-6 {
        return pts[0];
    }
    let mut target = f.rem_euclid(1.0) * total;
    for i in 0..n {
        let len = lens[i];
        if target <= len || i + 1 == n {
            let u = if len < 1e-9 {
                0.0
            } else {
                (target / len).clamp(0.0, 1.0)
            };
            return round_p(edge_at(pts[i], pts[(i + 1) % n], ctrls[i], u));
        }
        target -= len;
    }
    pts[0]
}

fn seg_len(a: P, b: P, ctrl: Option<P>) -> f64 {
    let Some(c) = ctrl else {
        return hypot(a, b);
    };
    let mut len = 0.0;
    let mut prev = (a.0 as f64, a.1 as f64);
    for i in 1..=8 {
        let p = edge_at(a, b, Some(c), i as f64 / 8.0);
        len += ((p.0 - prev.0).powi(2) + (p.1 - prev.1).powi(2)).sqrt();
        prev = p;
    }
    len
}

fn hypot(a: P, b: P) -> f64 {
    let dx = (b.0 - a.0) as f64;
    let dy = (b.1 - a.1) as f64;
    (dx * dx + dy * dy).sqrt()
}

fn lerp(a: P, b: P, t: f64) -> P {
    round_p((
        a.0 as f64 + (b.0 as f64 - a.0 as f64) * t,
        a.1 as f64 + (b.1 as f64 - a.1 as f64) * t,
    ))
}

fn scale_about(p: P, cx: f64, cy: f64, s: f64) -> P {
    round_p((cx + (p.0 as f64 - cx) * s, cy + (p.1 as f64 - cy) * s))
}

fn blend_ctrl(
    p0: P,
    p1: P,
    ca: Option<P>,
    cb: Option<P>,
    a0: P,
    a1: P,
    b0: P,
    b1: P,
    t: f64,
) -> Option<P> {
    let c0 = ca.unwrap_or(mid(a0, a1));
    let c1 = cb.unwrap_or(mid(b0, b1));
    let c = lerp(c0, c1, t);
    if near_chord(p0, p1, c) { None } else { Some(c) }
}

fn mid(a: P, b: P) -> P {
    round_p((
        (a.0 as f64 + b.0 as f64) * 0.5,
        (a.1 as f64 + b.1 as f64) * 0.5,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Affine;

    fn edges(map: &Map) -> usize {
        map.half_edges().len() / 2
    }

    fn vertical_at(map: &Map, x: i32) -> usize {
        map.half_edges()
            .chunks(2)
            .filter(|pair| {
                let a = map.vertices()[pair[0].origin as usize];
                let b = map.vertices()[pair[1].origin as usize];
                a.0 == x && b.0 == x
            })
            .count()
    }

    #[test]
    fn two_squares_meet_in_the_middle() {
        let mut a = Map::new();
        a.paint_polygon(&[(0, 0), (40, 0), (40, 40), (0, 40)], 1);
        let mut b = Map::new();
        b.paint_polygon(&[(80, 0), (120, 0), (120, 40), (80, 40)], 1);
        let m = a.lerp(&b, 0.5);
        let mut verts = m.vertices().to_vec();
        verts.sort();
        assert_eq!(verts, vec![(40, 0), (40, 40), (80, 0), (80, 40)]);
        assert_eq!(m.face_at((60, 20)), 1);
        assert_eq!(m.face_at((10, 20)), EMPTY);
        assert_eq!(edges(&m), 4);
    }

    #[test]
    fn adjacent_rectangles_keep_one_shared_edge() {
        let mut a = Map::new();
        a.paint_polygon(&[(0, 0), (100, 0), (100, 100), (0, 100)], 1);
        a.paint_polygon(&[(100, 0), (200, 0), (200, 100), (100, 100)], 2);
        assert_eq!(vertical_at(&a, 100), 1, "paint did not share the edge");
        let b = a.transformed(&Affine {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 0.0,
            f: 200.0,
        });
        let m = a.lerp(&b, 0.5);
        assert_eq!(edges(&m), edges(&a));
        assert_eq!(vertical_at(&m, 100), 1);
        assert_eq!(m.face_at((50, 150)), 1);
        assert_eq!(m.face_at((150, 150)), 2);
    }

    #[test]
    fn an_unmatched_face_shrinks() {
        let mut a = Map::new();
        a.paint_polygon(&[(0, 0), (100, 0), (100, 100), (0, 100)], 1);
        a.paint_polygon(&[(200, 0), (300, 0), (300, 100), (200, 100)], 2);
        let mut b = Map::new();
        b.paint_polygon(&[(0, 0), (100, 0), (100, 100), (0, 100)], 1);
        let m = a.lerp(&b, 0.5);
        assert_eq!(m.face_at((50, 50)), 1);
        assert_eq!(m.face_at((250, 50)), 2);
        assert_eq!(m.face_at((210, 10)), EMPTY);
    }
}
