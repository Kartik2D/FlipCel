//! Cut every crossing pair of edges at one shared twip.
//!
//! Pieces that were already in a planar map are not `fresh`; only pairs with
//! at least one fresh piece are tested. Candidates come from a sweep over
//! bounding boxes sorted by their left edge.

use std::cmp::Ordering;
use std::collections::HashMap;

use crate::Piece;
use crate::geom::*;

pub(crate) fn slice(pieces: Vec<Piece>) -> Vec<Piece> {
    let mut segs: Vec<Seg> = pieces
        .into_iter()
        .filter(|piece| piece.a != piece.b)
        .map(|piece| Seg {
            bounds: seg_bounds(piece.a, piece.b, piece.ctrl),
            piece,
            splits: Vec::new(),
        })
        .collect();
    let any_fresh = segs.iter().any(|seg| seg.piece.fresh);
    if any_fresh {
        let mut order: Vec<usize> = (0..segs.len()).collect();
        order.sort_by_key(|&i| segs[i].bounds.0);
        for (oi, &i) in order.iter().enumerate() {
            let bi = segs[i].bounds;
            for &j in &order[oi + 1..] {
                let bj = segs[j].bounds;
                if bj.0 > bi.2 {
                    break;
                }
                if !(segs[i].piece.fresh || segs[j].piece.fresh) {
                    continue;
                }
                if bj.1 > bi.3 || bi.1 > bj.3 {
                    continue;
                }
                split_pair(&mut segs, i, j);
            }
        }
    }
    let mut out = Vec::new();
    for seg in &segs {
        emit(seg, &mut out);
    }
    dedupe(out)
}

struct Seg {
    piece: Piece,
    bounds: (i32, i32, i32, i32),
    splits: Vec<Split>,
}

#[derive(Clone, Copy)]
struct Split {
    num: i128,
    den: i128,
    at: P,
}

fn split_pair(segs: &mut [Seg], i: usize, j: usize) {
    let left = segs[i].piece;
    let right = segs[j].piece;
    match (left.ctrl, right.ctrl) {
        (None, None) => split_lines(segs, i, j),
        (None, Some(ctrl)) => {
            for (u, t, at) in line_quad(left.a, left.b, right.a, ctrl, right.b) {
                push_split(&mut segs[i], u, at);
                push_split(&mut segs[j], t, at);
            }
        }
        (Some(ctrl), None) => {
            for (u, t, at) in line_quad(right.a, right.b, left.a, ctrl, left.b) {
                push_split(&mut segs[i], t, at);
                push_split(&mut segs[j], u, at);
            }
        }
        (Some(ca), Some(cb)) => {
            for (ta, tb, at) in quad_quad(left.a, ca, left.b, right.a, cb, right.b) {
                push_split(&mut segs[i], ta, at);
                push_split(&mut segs[j], tb, at);
            }
        }
    }
}

fn split_lines(segs: &mut [Seg], i: usize, j: usize) {
    let (ax, ay) = segs[i].piece.a;
    let (bx, by) = segs[i].piece.b;
    let (cx, cy) = segs[j].piece.a;
    let (dx, dy) = segs[j].piece.b;
    let rx = (bx as i64) - (ax as i64);
    let ry = (by as i64) - (ay as i64);
    let sx = (dx as i64) - (cx as i64);
    let sy = (dy as i64) - (cy as i64);
    let qx = (cx as i64) - (ax as i64);
    let qy = (cy as i64) - (ay as i64);
    let den = cross(rx, ry, sx, sy);
    if den == 0 {
        if cross(qx, qy, rx, ry) == 0 {
            let (ia, ib) = (segs[i].piece.a, segs[i].piece.b);
            let (ja, jb) = (segs[j].piece.a, segs[j].piece.b);
            if let Some((num, den)) = strict_t(ia, ib, ja) {
                segs[i].splits.push(Split { num, den, at: ja });
            }
            if let Some((num, den)) = strict_t(ia, ib, jb) {
                segs[i].splits.push(Split { num, den, at: jb });
            }
            if let Some((num, den)) = strict_t(ja, jb, ia) {
                segs[j].splits.push(Split { num, den, at: ia });
            }
            if let Some((num, den)) = strict_t(ja, jb, ib) {
                segs[j].splits.push(Split { num, den, at: ib });
            }
        }
        return;
    }
    let t_num = cross(qx, qy, sx, sy);
    let u_num = cross(qx, qy, rx, ry);
    if in_closed(t_num, den) && in_closed(u_num, den) && !(is_end(t_num, den) && is_end(u_num, den)) {
        let at = if !is_end(t_num, den) {
            point_at(segs[i].piece.a, segs[i].piece.b, t_num, den)
        } else {
            point_at(segs[j].piece.a, segs[j].piece.b, u_num, den)
        };
        if !is_end(t_num, den) {
            segs[i].splits.push(Split { num: t_num, den, at });
        }
        if !is_end(u_num, den) {
            segs[j].splits.push(Split { num: u_num, den, at });
        }
    }
}

/// Record a crossing on `seg` unless the snapped point is already one of its
/// own ends. A crossing that lands on the other segment's end still splits
/// this one, so the two share that vertex.
fn push_split(seg: &mut Seg, t: f64, at: P) {
    if at == seg.piece.a || at == seg.piece.b {
        return;
    }
    let splits = &mut seg.splits;
    if !(1e-5..1.0 - 1e-5).contains(&t) {
        return;
    }
    let den = 1_000_000i128;
    let num = (t * den as f64).round() as i128;
    if splits.iter().any(|split| split.at == at) {
        return;
    }
    splits.push(Split { num, den, at });
}

fn in_closed(num: i128, den: i128) -> bool {
    let (num, den) = norm_frac(num, den);
    num >= 0 && num <= den
}

fn is_end(num: i128, den: i128) -> bool {
    let (num, den) = norm_frac(num, den);
    num == 0 || num == den
}

fn strict_t(a: P, b: P, p: P) -> Option<(i128, i128)> {
    let rx = (b.0 as i64) - (a.0 as i64);
    let ry = (b.1 as i64) - (a.1 as i64);
    let px = (p.0 as i64) - (a.0 as i64);
    let py = (p.1 as i64) - (a.1 as i64);
    if cross(px, py, rx, ry) != 0 {
        return None;
    }
    let len2 = rx as i128 * rx as i128 + ry as i128 * ry as i128;
    if len2 == 0 {
        return None;
    }
    let dot = px as i128 * rx as i128 + py as i128 * ry as i128;
    if dot > 0 && dot < len2 { Some((dot, len2)) } else { None }
}

fn emit(seg: &Seg, out: &mut Vec<Piece>) {
    let mut ts = vec![
        Split { num: 0, den: 1, at: seg.piece.a },
        Split { num: 1, den: 1, at: seg.piece.b },
    ];
    ts.extend(seg.splits.iter().copied().filter(|split| {
        let (num, den) = norm_frac(split.num, split.den);
        num > 0 && num < den
    }));
    ts.sort_by(|left, right| cmp_frac((left.num, left.den), (right.num, right.den)));
    ts.dedup_by(|left, right| {
        left.at == right.at || cmp_frac((left.num, left.den), (right.num, right.den)) == Ordering::Equal
    });
    for pair in ts.windows(2) {
        let a = pair[0].at;
        let b = pair[1].at;
        if a == b {
            continue;
        }
        let ctrl = span_ctrl(seg.piece, pair[0], pair[1]);
        out.push(Piece { a, b, ctrl, ..seg.piece });
    }
}

fn span_ctrl(piece: Piece, t0: Split, t1: Split) -> Option<P> {
    let ctrl = piece.ctrl?;
    let u = frac_f64(t0.num, t0.den);
    let v = frac_f64(t1.num, t1.den);
    let ctrl = round_p(blossom(piece.a, ctrl, piece.b, u, v));
    if near_chord(t0.at, t1.at, ctrl) { None } else { Some(ctrl) }
}

fn frac_f64(num: i128, den: i128) -> f64 {
    let (num, den) = norm_frac(num, den);
    num as f64 / den as f64
}

fn norm_frac(num: i128, den: i128) -> (i128, i128) {
    if den < 0 { (-num, -den) } else { (num, den) }
}

fn point_at(a: P, b: P, num: i128, den: i128) -> P {
    let (num, den) = norm_frac(num, den);
    if num == 0 {
        return a;
    }
    if num == den {
        return b;
    }
    let x = a.0 as i128 + round_div((b.0 as i128 - a.0 as i128) * num, den);
    let y = a.1 as i128 + round_div((b.1 as i128 - a.1 as i128) * num, den);
    (clamp_i32(x), clamp_i32(y))
}

fn round_div(num: i128, den: i128) -> i128 {
    let (num, den) = norm_frac(num, den);
    let half = den / 2;
    if num >= 0 { (num + half) / den } else { (num - half) / den }
}

fn clamp_i32(value: i128) -> i32 {
    value.clamp(i32::MIN as i128, i32::MAX as i128) as i32
}

fn cmp_frac(a: (i128, i128), b: (i128, i128)) -> Ordering {
    let (an, ad) = norm_frac(a.0, a.1);
    let (bn, bd) = norm_frac(b.0, b.1);
    (an * bd).cmp(&(bn * ad))
}

/// Coincident pieces become one. Labels prefer whichever side has them, ring
/// masks cancel (two coincident boundaries of one even-odd region are no
/// boundary), strokes and freshness survive.
fn dedupe(parts: Vec<Piece>) -> Vec<Piece> {
    let mut map: HashMap<(P, P, Option<P>), Piece> = HashMap::new();
    for mut piece in parts {
        if piece.a == piece.b {
            continue;
        }
        if piece.b < piece.a {
            std::mem::swap(&mut piece.a, &mut piece.b);
            piece.under = piece.under.map(|(l, r)| (r, l));
            piece.top = piece.top.map(|(l, r)| (r, l));
        }
        // A curve and the chord between the same vertices are different edges.
        map.entry((piece.a, piece.b, piece.ctrl))
            .and_modify(|kept| *kept = merge(*kept, piece))
            .or_insert(piece);
    }
    let mut out: Vec<_> = map.into_values().collect();
    out.sort_by(|left, right| {
        left.a
            .cmp(&right.a)
            .then(left.b.cmp(&right.b))
            .then(left.ctrl.cmp(&right.ctrl))
    });
    out
}

fn merge(keep: Piece, add: Piece) -> Piece {
    Piece {
        a: keep.a,
        b: keep.b,
        ctrl: keep.ctrl,
        under: keep.under.or(add.under),
        top: keep.top.or(add.top),
        mask: keep.mask ^ add.mask,
        stroke: keep.stroke.or(add.stroke),
        fresh: keep.fresh || add.fresh,
    }
}

/// `(t_line, t_quad, snapped point)`.
fn line_quad(a: P, b: P, p0: P, ctrl: P, p2: P) -> Vec<(f64, f64, P)> {
    let dx = (b.0 - a.0) as f64;
    let dy = (b.1 - a.1) as f64;
    let vx = 2.0 * (ctrl.0 - p0.0) as f64;
    let vy = 2.0 * (ctrl.1 - p0.1) as f64;
    let wx = (p0.0 as i64 - 2 * ctrl.0 as i64 + p2.0 as i64) as f64;
    let wy = (p0.1 as i64 - 2 * ctrl.1 as i64 + p2.1 as i64) as f64;
    let px = (p0.0 - a.0) as f64;
    let py = (p0.1 - a.1) as f64;
    let c0 = px * dy - py * dx;
    let c1 = vx * dy - vy * dx;
    let c2 = wx * dy - wy * dx;
    let mut hits = Vec::new();
    let len2 = dx * dx + dy * dy;
    if len2 < 1e-9 {
        return hits;
    }
    // Roots just past an end still count: the point snaps to that end and
    // splits the other segment there, so a vertex resting on an edge is shared.
    for t in solve_quad(c2, c1, c0) {
        if !(-1e-4..=1.0 + 1e-4).contains(&t) {
            continue;
        }
        let t = t.clamp(0.0, 1.0);
        let (x, y) = quad_at(p0, ctrl, p2, t);
        let u = ((x - a.0 as f64) * dx + (y - a.1 as f64) * dy) / len2;
        if !(-1e-4..=1.0 + 1e-4).contains(&u) {
            continue;
        }
        let at = (x.round() as i32, y.round() as i32);
        hits.push((u, t, at));
    }
    hits
}

#[derive(Clone, Copy)]
struct Bez {
    p0: (f64, f64),
    c: (f64, f64),
    p2: (f64, f64),
}

fn quad_quad(a0: P, ac: P, a1: P, b0: P, bc: P, b1: P) -> Vec<(f64, f64, P)> {
    let a = Bez::from_i(a0, ac, a1);
    let b = Bez::from_i(b0, bc, b1);
    let mut hits = Vec::new();
    bez_hit(a, 0.0, 1.0, b, 0.0, 1.0, 0, &mut hits);
    hits
}

impl Bez {
    fn from_i(p0: P, c: P, p2: P) -> Self {
        Self {
            p0: (p0.0 as f64, p0.1 as f64),
            c: (c.0 as f64, c.1 as f64),
            p2: (p2.0 as f64, p2.1 as f64),
        }
    }

    fn span(self) -> f64 {
        let (x0, y0, x1, y1) = self.bounds();
        (x1 - x0).max(y1 - y0)
    }

    fn overlaps(self, other: Self) -> bool {
        let (ax0, ay0, ax1, ay1) = self.bounds();
        let (bx0, by0, bx1, by1) = other.bounds();
        ax0 <= bx1 && bx0 <= ax1 && ay0 <= by1 && by0 <= ay1
    }

    fn bounds(self) -> (f64, f64, f64, f64) {
        let xs = [self.p0.0, self.c.0, self.p2.0];
        let ys = [self.p0.1, self.c.1, self.p2.1];
        (
            xs.into_iter().fold(f64::MAX, f64::min),
            ys.into_iter().fold(f64::MAX, f64::min),
            xs.into_iter().fold(f64::MIN, f64::max),
            ys.into_iter().fold(f64::MIN, f64::max),
        )
    }

    fn split(self) -> (Self, Self) {
        let m01 = ((self.p0.0 + self.c.0) * 0.5, (self.p0.1 + self.c.1) * 0.5);
        let m12 = ((self.c.0 + self.p2.0) * 0.5, (self.c.1 + self.p2.1) * 0.5);
        let mid = ((m01.0 + m12.0) * 0.5, (m01.1 + m12.1) * 0.5);
        (
            Self { p0: self.p0, c: m01, p2: mid },
            Self { p0: mid, c: m12, p2: self.p2 },
        )
    }
}

fn chord_cross(a: Bez, b: Bez) -> Option<(f64, f64, P)> {
    let (ax, ay) = a.p0;
    let (bx, by) = a.p2;
    let (cx, cy) = b.p0;
    let (dx, dy) = b.p2;
    let rx = bx - ax;
    let ry = by - ay;
    let sx = dx - cx;
    let sy = dy - cy;
    let den = rx * sy - ry * sx;
    if den.abs() < 1e-9 {
        return None;
    }
    let qx = cx - ax;
    let qy = cy - ay;
    let t = (qx * sy - qy * sx) / den;
    let u = (qx * ry - qy * rx) / den;
    if !(1e-4..1.0 - 1e-4).contains(&t) || !(1e-4..1.0 - 1e-4).contains(&u) {
        return None;
    }
    let x = ax + t * rx;
    let y = ay + t * ry;
    Some((t, u, (x.round() as i32, y.round() as i32)))
}

/// Subdivide until both spans are under a twip, then intersect the chords.
/// The depth bound comfortably covers the whole i32 range (two curves of
/// 2^31 twips each need about 64 halvings).
#[allow(clippy::too_many_arguments)]
fn bez_hit(
    a: Bez,
    ta0: f64,
    ta1: f64,
    b: Bez,
    tb0: f64,
    tb1: f64,
    depth: u32,
    hits: &mut Vec<(f64, f64, P)>,
) {
    if !a.overlaps(b) {
        return;
    }
    if a.span() < 0.75 && b.span() < 0.75 {
        let Some((t, u, at)) = chord_cross(a, b) else {
            return;
        };
        let ta = ta0 + t * (ta1 - ta0);
        let tb = tb0 + u * (tb1 - tb0);
        if !(1e-3..1.0 - 1e-3).contains(&ta) || !(1e-3..1.0 - 1e-3).contains(&tb) {
            return;
        }
        if hits.iter().any(|hit| hit.2 == at) {
            return;
        }
        hits.push((ta, tb, at));
        return;
    }
    if depth > 80 {
        return;
    }
    if a.span() >= b.span() {
        let (left, right) = a.split();
        let mid = (ta0 + ta1) * 0.5;
        bez_hit(left, ta0, mid, b, tb0, tb1, depth + 1, hits);
        bez_hit(right, mid, ta1, b, tb0, tb1, depth + 1, hits);
    } else {
        let (left, right) = b.split();
        let mid = (tb0 + tb1) * 0.5;
        bez_hit(a, ta0, ta1, left, tb0, mid, depth + 1, hits);
        bez_hit(a, ta0, ta1, right, mid, tb1, depth + 1, hits);
    }
}
