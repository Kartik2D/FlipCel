//! Integer predicates, quadratic helpers, and the cubic-to-quadratic converter.

use std::cmp::Ordering;

/// A point in twips. 20 twips are one CSS pixel.
pub type P = (i32, i32);

pub fn cross(ax: i64, ay: i64, bx: i64, by: i64) -> i128 {
    ax as i128 * by as i128 - ay as i128 * bx as i128
}

pub fn sub(a: P, b: P) -> (i64, i64) {
    (a.0 as i64 - b.0 as i64, a.1 as i64 - b.1 as i64)
}

/// Six times the signed area swept by one edge: the shoelace term plus the
/// parabolic bulge of a quadratic (two thirds of its control triangle).
pub fn edge_area6(a: P, b: P, ctrl: Option<P>) -> i128 {
    let mut area = 3 * cross(a.0 as i64, a.1 as i64, b.0 as i64, b.1 as i64);
    if let Some(c) = ctrl {
        let (cax, cay) = sub(c, a);
        let (bax, bay) = sub(b, a);
        area += 2 * cross(cax, cay, bax, bay);
    }
    area
}

pub fn quad_at(a: P, c: P, b: P, t: f64) -> (f64, f64) {
    let u = 1.0 - t;
    (
        u * u * a.0 as f64 + 2.0 * u * t * c.0 as f64 + t * t * b.0 as f64,
        u * u * a.1 as f64 + 2.0 * u * t * c.1 as f64 + t * t * b.1 as f64,
    )
}

pub fn quad_tangent(a: P, c: P, b: P, t: f64) -> (f64, f64) {
    (
        2.0 * ((1.0 - t) * (c.0 - a.0) as f64 + t * (b.0 - c.0) as f64),
        2.0 * ((1.0 - t) * (c.1 - a.1) as f64 + t * (b.1 - c.1) as f64),
    )
}

/// Point on the edge at `t`; straight edges interpolate the chord.
pub fn edge_at(a: P, b: P, ctrl: Option<P>, t: f64) -> (f64, f64) {
    match ctrl {
        Some(c) => quad_at(a, c, b, t),
        None => (
            a.0 as f64 + (b.0 - a.0) as f64 * t,
            a.1 as f64 + (b.1 - a.1) as f64 * t,
        ),
    }
}

/// Tolerance (twips) for approximating cubics with quadratics: half a pixel.
pub const CUBIC_TOL: f64 = 10.0;

/// Squared distance (twips) a control may sit from the chord and still count as
/// straight: 5 twips = a quarter pixel.
const CHORD_TOL2: i128 = 25;

/// A control within a quarter pixel of the chord is a straight edge.
pub fn near_chord(a: P, b: P, p: P) -> bool {
    let rx = (b.0 as i128) - (a.0 as i128);
    let ry = (b.1 as i128) - (a.1 as i128);
    let len2 = rx * rx + ry * ry;
    if len2 == 0 {
        return true;
    }
    let cross = rx * ((p.1 as i128) - (a.1 as i128)) - ry * ((p.0 as i128) - (a.0 as i128));
    cross * cross <= len2 * CHORD_TOL2
}

pub fn blossom(a: P, c: P, b: P, u: f64, v: f64) -> (f64, f64) {
    let mix = |a: i32, c: i32, b: i32| {
        (1.0 - u) * (1.0 - v) * a as f64 + ((1.0 - u) * v + u * (1.0 - v)) * c as f64 + u * v * b as f64
    };
    (mix(a.0, c.0, b.0), mix(a.1, c.1, b.1))
}

pub fn solve_quad(a: f64, b: f64, c: f64) -> Vec<f64> {
    if a.abs() < 1e-12 {
        if b.abs() < 1e-12 {
            return Vec::new();
        }
        return vec![-c / b];
    }
    let disc = b * b - 4.0 * a * c;
    if disc < 0.0 {
        return Vec::new();
    }
    let root = disc.sqrt();
    vec![(-b - root) / (2.0 * a), (-b + root) / (2.0 * a)]
}

/// Conservative bounds: the control hull of the edge.
pub fn seg_bounds(a: P, b: P, ctrl: Option<P>) -> (i32, i32, i32, i32) {
    let mut x0 = a.0.min(b.0);
    let mut y0 = a.1.min(b.1);
    let mut x1 = a.0.max(b.0);
    let mut y1 = a.1.max(b.1);
    if let Some(c) = ctrl {
        x0 = x0.min(c.0);
        y0 = y0.min(c.1);
        x1 = x1.max(c.0);
        y1 = y1.max(c.1);
    }
    (x0, y0, x1, y1)
}

/// Tight bounds of a quadratic, including its parametric extrema.
pub fn quad_bounds(a: P, c: P, b: P) -> (f64, f64, f64, f64) {
    let mut x0 = a.0.min(b.0) as f64;
    let mut y0 = a.1.min(b.1) as f64;
    let mut x1 = a.0.max(b.0) as f64;
    let mut y1 = a.1.max(b.1) as f64;
    if let Some(t) = quad_extremum(a.0, c.0, b.0) {
        let (x, _) = quad_at(a, c, b, t);
        x0 = x0.min(x);
        x1 = x1.max(x);
    }
    if let Some(t) = quad_extremum(a.1, c.1, b.1) {
        let (_, y) = quad_at(a, c, b, t);
        y0 = y0.min(y);
        y1 = y1.max(y);
    }
    (x0, y0, x1, y1)
}

/// Parameter of the extremum of one coordinate, if it lies strictly inside the edge.
pub fn quad_extremum(a: i32, c: i32, b: i32) -> Option<f64> {
    let den = a as i64 - 2 * c as i64 + b as i64;
    if den == 0 {
        return None;
    }
    let t = (a as i64 - c as i64) as f64 / den as f64;
    (t > 0.0 && t < 1.0).then_some(t)
}

pub fn quadrant(x: f64, y: f64) -> u8 {
    if x > 0.0 && y >= 0.0 {
        0
    } else if x <= 0.0 && y > 0.0 {
        1
    } else if x < 0.0 && y <= 0.0 {
        2
    } else {
        3
    }
}

/// Angular order of two directions around the origin.
pub fn cmp_dir(a: (f64, f64), b: (f64, f64)) -> Ordering {
    let qa = quadrant(a.0, a.1);
    let qb = quadrant(b.0, b.1);
    if qa != qb {
        return qa.cmp(&qb);
    }
    let cross = a.0 * b.1 - a.1 * b.0;
    0.0.partial_cmp(&cross).unwrap_or(Ordering::Equal)
}

/// Distance from a point to an edge, by sampling the curve.
pub fn point_edge_dist(p: (f64, f64), a: P, b: P, ctrl: Option<P>) -> f64 {
    match ctrl {
        None => point_segment_dist(p, (a.0 as f64, a.1 as f64), (b.0 as f64, b.1 as f64)),
        Some(c) => {
            let mut best = f64::MAX;
            let mut prev = (a.0 as f64, a.1 as f64);
            for i in 1..=24 {
                let cur = quad_at(a, c, b, i as f64 / 24.0);
                best = best.min(point_segment_dist(p, prev, cur));
                prev = cur;
            }
            best
        }
    }
}

pub fn point_segment_dist(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let dx = b.0 - a.0;
    let dy = b.1 - a.1;
    let len2 = dx * dx + dy * dy;
    let t = if len2 == 0.0 {
        0.0
    } else {
        (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len2).clamp(0.0, 1.0)
    };
    let x = a.0 + dx * t - p.0;
    let y = a.1 + dy * t - p.1;
    (x * x + y * y).sqrt()
}

type F2 = (f64, f64);

fn lerp(a: F2, b: F2, t: f64) -> F2 {
    (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
}

/// The cubic restricted to `[t0, t1]`, as a cubic (polar form).
fn cubic_sub(p: [F2; 4], t0: f64, t1: f64) -> [F2; 4] {
    let polar = |u: f64, v: f64, w: f64| {
        let ab = lerp(p[0], p[1], u);
        let bc = lerp(p[1], p[2], u);
        let cd = lerp(p[2], p[3], u);
        let abc = lerp(ab, bc, v);
        let bcd = lerp(bc, cd, v);
        lerp(abc, bcd, w)
    };
    [polar(t0, t0, t0), polar(t0, t0, t1), polar(t0, t1, t1), polar(t1, t1, t1)]
}

/// Approximate a cubic with quadratics within `tol` (in the same units as the
/// points). Returns `(ctrl, to)` pairs; the last `to` is exactly `p3`.
pub fn cubic_to_quads(p0: F2, p1: F2, p2: F2, p3: F2, tol: f64) -> Vec<(F2, F2)> {
    let dx = p3.0 - 3.0 * p2.0 + 3.0 * p1.0 - p0.0;
    let dy = p3.1 - 3.0 * p2.1 + 3.0 * p1.1 - p0.1;
    let err = (dx * dx + dy * dy).sqrt() * 3f64.sqrt() / 36.0;
    let n = ((err / tol.max(1e-9)).cbrt().ceil() as usize).clamp(1, 64);
    let p = [p0, p1, p2, p3];
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let t0 = i as f64 / n as f64;
        let t1 = (i + 1) as f64 / n as f64;
        let q = cubic_sub(p, t0, t1);
        let ctrl = (
            (3.0 * (q[1].0 + q[2].0) - (q[0].0 + q[3].0)) / 4.0,
            (3.0 * (q[1].1 + q[2].1) - (q[0].1 + q[3].1)) / 4.0,
        );
        let to = if i + 1 == n { p3 } else { q[3] };
        out.push((ctrl, to));
    }
    out
}

pub fn round_p(p: F2) -> P {
    (p.0.round() as i32, p.1.round() as i32)
}
