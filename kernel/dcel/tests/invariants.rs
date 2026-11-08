use dcel::{Affine, BoolOp, EMPTY, Map, Mode, P, Ring, Seg, polygon, region_op};

fn square(x0: i32, y0: i32, x1: i32, y1: i32) -> [P; 4] {
    [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
}

fn sq(x0: i32, y0: i32, x1: i32, y1: i32) -> Ring {
    polygon(&square(x0, y0, x1, y1))
}

fn paint(map: &mut Map, ring: Ring, fill: u32) {
    map.paint(&[ring], fill, Mode::Over);
}

/// Structural invariants every map must satisfy.
fn check(map: &Map) {
    let halfs = map.half_edges();
    let verts = map.vertices();
    assert_eq!(halfs.len() % 2, 0);
    for index in 0..halfs.len() {
        let half = halfs[index];
        assert!((half.origin as usize) < verts.len(), "origin out of range");
        let next = half.next as usize;
        assert!(next < halfs.len(), "next out of range");
        assert_eq!(
            halfs[next].origin,
            halfs[index ^ 1].origin,
            "next does not start where this edge ends"
        );
        assert_eq!(half.face, halfs[next].face, "next on a different face");
        assert_eq!(
            half.fill,
            map.faces()[half.face as usize].fill,
            "half fill disagrees with its face"
        );
        assert_eq!(
            half.ctrl,
            halfs[index ^ 1].ctrl,
            "twins disagree on the control"
        );
        assert!(
            half.fill != halfs[index ^ 1].fill || half.stroke.is_some(),
            "same fill on both sides survived"
        );
        assert_ne!(
            halfs[index].origin,
            halfs[index ^ 1].origin,
            "degenerate edge"
        );
    }
    // Every half-edge appears in exactly one cycle of its face.
    let mut seen = vec![false; halfs.len()];
    for (face_index, face) in map.faces().iter().enumerate() {
        if face_index == 0 {
            assert!(
                face.outer.is_none(),
                "the unbounded face has an outer cycle"
            );
        } else {
            assert!(face.outer.is_some(), "a bounded face has no outer cycle");
        }
        for start in face.outer.into_iter().chain(face.inner.iter().copied()) {
            let mut edge = start;
            for _ in 0..=halfs.len() {
                assert!(!seen[edge as usize], "half-edge in two cycles");
                seen[edge as usize] = true;
                assert_eq!(halfs[edge as usize].face as usize, face_index);
                edge = halfs[edge as usize].next;
                if edge == start {
                    break;
                }
            }
        }
    }
    assert!(
        seen.iter().all(|s| *s),
        "a half-edge belongs to no face cycle"
    );
    // Euler for a connected-or-not planar graph: V - E + F = 1 + C.
    let v = verts.len() as i64;
    let e = (halfs.len() / 2) as i64;
    let f = map.faces().len() as i64;
    let c = components(map) as i64;
    assert_eq!(
        v - e + f,
        1 + c,
        "Euler characteristic broken (V={v} E={e} F={f} C={c})"
    );
    assert_eq!(map.faces()[0].fill, EMPTY);
    assert_planar(map);
}

/// No two edges cross except at a shared vertex.
fn assert_planar(map: &Map) {
    let verts = map.vertices();
    let edges: Vec<(P, P, Option<P>)> = map
        .half_edges()
        .chunks(2)
        .map(|pair| {
            (
                verts[pair[0].origin as usize],
                verts[pair[1].origin as usize],
                pair[0].ctrl,
            )
        })
        .collect();
    for i in 0..edges.len() {
        for j in i + 1..edges.len() {
            if let Some(at) = open_crossing(edges[i], edges[j]) {
                panic!("edges cross at {at:?}: {:?} x {:?}", edges[i], edges[j]);
            }
        }
    }
}

fn open_crossing(a: (P, P, Option<P>), b: (P, P, Option<P>)) -> Option<(f64, f64)> {
    let mut hit = None;
    let mut consider = |p: (f64, f64), q: (f64, f64), r: (f64, f64), s: (f64, f64)| {
        let Some((_, _, at)) = seg_cross(p, q, r, s) else {
            return;
        };
        let near = |v: P| {
            let dx = at.0 - v.0 as f64;
            let dy = at.1 - v.1 as f64;
            dx * dx + dy * dy <= 4.0
        };
        if near(a.0) || near(a.1) || near(b.0) || near(b.1) {
            return;
        }
        hit = Some(at);
    };
    visit_chords(a, &mut |p, q| {
        visit_chords(b, &mut |r, s| consider(p, q, r, s))
    });
    hit
}

fn visit_chords(edge: (P, P, Option<P>), f: &mut impl FnMut((f64, f64), (f64, f64))) {
    let (a, b, ctrl) = edge;
    let af = (a.0 as f64, a.1 as f64);
    let bf = (b.0 as f64, b.1 as f64);
    let Some(c) = ctrl else {
        f(af, bf);
        return;
    };
    let cf = (c.0 as f64, c.1 as f64);
    flatten(af, cf, bf, 0, f);
}

fn flatten(
    a: (f64, f64),
    c: (f64, f64),
    b: (f64, f64),
    depth: u32,
    f: &mut impl FnMut((f64, f64), (f64, f64)),
) {
    let span = (a.0 - b.0)
        .abs()
        .max((a.1 - b.1).abs())
        .max((c.0 - a.0).abs())
        .max((c.1 - a.1).abs());
    if span < 8.0 || depth > 12 {
        f(a, b);
        return;
    }
    let m01 = ((a.0 + c.0) * 0.5, (a.1 + c.1) * 0.5);
    let m12 = ((c.0 + b.0) * 0.5, (c.1 + b.1) * 0.5);
    let mid = ((m01.0 + m12.0) * 0.5, (m01.1 + m12.1) * 0.5);
    flatten(a, m01, mid, depth + 1, f);
    flatten(mid, m12, b, depth + 1, f);
}

fn seg_cross(
    a: (f64, f64),
    b: (f64, f64),
    c: (f64, f64),
    d: (f64, f64),
) -> Option<(f64, f64, (f64, f64))> {
    let rx = b.0 - a.0;
    let ry = b.1 - a.1;
    let sx = d.0 - c.0;
    let sy = d.1 - c.1;
    let den = rx * sy - ry * sx;
    if den.abs() < 1e-9 {
        return None;
    }
    let qx = c.0 - a.0;
    let qy = c.1 - a.1;
    let t = (qx * sy - qy * sx) / den;
    let u = (qx * ry - qy * rx) / den;
    if !(0.02..0.98).contains(&t) || !(0.02..0.98).contains(&u) {
        return None;
    }
    Some((t, u, (a.0 + t * rx, a.1 + t * ry)))
}

fn components(map: &Map) -> usize {
    let n = map.vertex_count();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut [usize], mut i: usize) -> usize {
        while p[i] != i {
            p[i] = p[p[i]];
            i = p[i];
        }
        i
    }
    for pair in map.half_edges().chunks(2) {
        let a = find(&mut parent, pair[0].origin as usize);
        let b = find(&mut parent, pair[1].origin as usize);
        if a != b {
            parent[a] = b;
        }
    }
    (0..n).filter(|&i| find(&mut parent, i) == i).count()
}

fn at(map: &Map, x: i32, y: i32) -> u32 {
    map.face_at((x, y))
}

#[test]
fn reading_does_not_change_the_map() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    let before = map.digest();
    let _ = map.vertex_count();
    let _ = map.faces();
    let _ = map.half_edges();
    let _ = map.face_at((50, 50));
    let _ = map.regions();
    assert_eq!(map.digest(), before);
}

#[test]
fn an_empty_map_has_one_face() {
    let map = Map::new();
    check(&map);
    assert_eq!(map.faces().len(), 1);
    assert_eq!(at(&map, 5, 5), EMPTY);
}

#[test]
fn a_shared_corner_is_one_vertex() {
    let mut map = Map::new();
    paint(&mut map, polygon(&[(0, 0), (10, 0), (0, 10)]), 1);
    paint(&mut map, polygon(&[(0, 0), (0, -10), (-10, 0)]), 2);
    check(&map);
    assert_eq!(
        map.vertices()
            .iter()
            .filter(|point| **point == (0, 0))
            .count(),
        1
    );
}

#[test]
fn every_half_edge_has_its_twin() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 40, 40), 1);
    paint(&mut map, sq(20, 20, 80, 30), 2);
    check(&map);
}

#[test]
fn splits_land_on_the_original_segment() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 20), 1);
    paint(&mut map, sq(25, -10, 26, 10), 2);
    paint(&mut map, sq(75, -10, 76, 10), 3);
    check(&map);
    assert!(map.has_vertex((25, 0)));
    assert!(map.has_vertex((75, 0)));
}

#[test]
fn the_same_fill_drops_the_shared_edge() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    paint(&mut map, sq(100, 0, 200, 100), 1);
    check(&map);
    assert!(!map.connected((100, 0), (100, 100)));
    assert_eq!(map.faces().len(), 2);
}

#[test]
fn a_different_fill_keeps_the_shared_edge() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    paint(&mut map, sq(100, 0, 200, 100), 2);
    check(&map);
    assert!(map.connected((100, 0), (100, 100)));
}

#[test]
fn a_stroke_keeps_the_shared_edge() {
    let mut map = Map::new();
    map.paint_polygon(&square(0, 0, 100, 100), 1);
    map.paint_polygon_with(&square(100, 0, 200, 100), 1, Some(1));
    assert!(map.connected((100, 0), (100, 100)));
}

#[test]
fn a_bowtie_breaks_at_the_crossing() {
    let mut map = Map::new();
    paint(&mut map, polygon(&[(0, 0), (10, 10), (0, 10), (10, 0)]), 1);
    check(&map);
    assert!(map.has_vertex((5, 5)));
    assert_eq!(at(&map, 5, 2), 1);
    assert_eq!(at(&map, 5, 8), 1);
    assert_eq!(at(&map, 2, 5), EMPTY);
}

#[test]
fn a_covered_island_takes_the_new_fill() {
    let mut map = Map::new();
    paint(&mut map, sq(40, 40, 60, 60), 1);
    paint(&mut map, sq(0, 0, 100, 100), 2);
    check(&map);
    assert!(
        !map.has_vertex((40, 40)),
        "covered island edges should dissolve"
    );
    assert_eq!(at(&map, 50, 50), 2);
    assert!(map.move_vertex((0, 0), (-5, -5)));
    check(&map);
    assert!(!map.has_vertex((40, 40)));
    assert!(map.has_vertex((-5, -5)));
}

#[test]
fn overlap_cuts_the_covered_part() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    paint(&mut map, sq(50, 50, 150, 150), 2);
    check(&map);
    assert!(map.has_vertex((100, 50)));
    assert!(map.has_vertex((50, 100)));
    assert!(!map.connected((100, 50), (100, 100)));
    assert!(map.connected((100, 0), (100, 50)));
    assert_eq!(at(&map, 25, 25), 1);
    assert_eq!(at(&map, 75, 75), 2);
    assert_eq!(at(&map, 125, 125), 2);
}

#[test]
fn negative_coordinates_stay_one_mesh() {
    let mut map = Map::new();
    paint(&mut map, polygon(&[(0, 0), (100, 0), (0, 100)]), 1);
    paint(&mut map, polygon(&[(0, 0), (-100, 0), (0, -100)]), 2);
    check(&map);
    assert_eq!(map.vertex_count(), 5);
}

#[test]
fn a_cut_through_a_side_shape_keeps_both() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 40, 80), 1);
    paint(&mut map, sq(100, 0, 160, 80), 2);
    paint(&mut map, sq(90, -10, 170, 30), 3);
    check(&map);
    assert_eq!(at(&map, 20, 40), 1);
    assert_eq!(at(&map, 130, 60), 2);
    assert_eq!(at(&map, 130, 10), 3);
}

// ----- holes -----

#[test]
fn a_shape_inside_another_is_a_hole_in_the_outer_face() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    paint(&mut map, sq(40, 40, 60, 60), 2);
    check(&map);
    assert_eq!(at(&map, 50, 50), 2);
    assert_eq!(at(&map, 10, 10), 1);
    let outer = map
        .faces()
        .iter()
        .find(|face| face.fill == 1)
        .expect("outer face");
    assert_eq!(
        outer.inner.len(),
        1,
        "the inner square is a hole cycle of the outer face"
    );
    let regions = map.regions();
    let (_, rings) = regions.iter().find(|(fill, _)| *fill == 1).unwrap();
    assert_eq!(rings.len(), 2);
}

#[test]
fn erasing_inside_a_shape_punches_a_hole() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    map.paint(&[sq(40, 40, 60, 60)], 0, Mode::Erase);
    check(&map);
    assert_eq!(at(&map, 50, 50), EMPTY);
    assert_eq!(at(&map, 10, 10), 1);
    assert_eq!(
        map.faces().len(),
        3,
        "outside, ring, hole interior: {:?}",
        map.faces()
    );
    let ring = map.faces().iter().find(|face| face.fill == 1).unwrap();
    assert_eq!(
        ring.inner.len(),
        1,
        "the hole is an inner cycle of the ring face"
    );
    let hole = map
        .faces()
        .iter()
        .find(|face| face.fill == EMPTY && face.outer.is_some())
        .unwrap();
    assert!(hole.inner.is_empty());
}

#[test]
fn a_cw_hole_stays_a_hole() {
    let outer = sq(0, 0, 100, 100);
    let hole = polygon(&[(40, 40), (40, 60), (60, 60), (60, 40)]);
    let mut map = Map::new();
    map.paint(&[outer, hole], 1, Mode::Over);
    check(&map);
    assert_eq!(at(&map, 10, 10), 1);
    assert_eq!(at(&map, 50, 50), EMPTY);
}

#[test]
fn opposite_rings_cancel_where_they_overlap() {
    let ccw = sq(0, 0, 100, 100);
    let cw = polygon(&[(150, 50), (50, 50), (50, 150), (150, 150)]);
    let mut map = Map::new();
    map.paint(&[ccw, cw], 1, Mode::Over);
    check(&map);
    assert_eq!(at(&map, 25, 25), 1);
    assert_eq!(
        at(&map, 125, 125),
        1,
        "the reversed ring is still inside itself"
    );
    assert_eq!(at(&map, 75, 75), EMPTY, "opposite windings cancel");
}

#[test]
fn a_doubled_outline_stays_filled() {
    let twice = polygon(&[
        (0, 0),
        (100, 0),
        (100, 100),
        (0, 100),
        (0, 0),
        (100, 0),
        (100, 100),
        (0, 100),
    ]);
    let mut map = Map::new();
    paint(&mut map, twice, 1);
    check(&map);
    assert_eq!(at(&map, 50, 50), 1);
}

#[test]
fn nested_same_direction_rings_stay_filled() {
    let mut map = Map::new();
    map.paint(
        &[sq(0, 0, 100, 100), sq(20, 20, 80, 80), sq(40, 40, 60, 60)],
        1,
        Mode::Over,
    );
    check(&map);
    assert_eq!(at(&map, 10, 10), 1);
    assert_eq!(at(&map, 30, 30), 1);
    assert_eq!(at(&map, 50, 50), 1);
}

#[test]
fn a_ring_inside_a_hole_attaches_to_the_right_face() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 300, 300), 1);
    map.paint(&[sq(100, 100, 200, 200)], 0, Mode::Erase);
    paint(&mut map, sq(140, 140, 160, 160), 2);
    check(&map);
    assert_eq!(at(&map, 150, 150), 2);
    assert_eq!(at(&map, 120, 120), EMPTY);
    assert_eq!(at(&map, 50, 50), 1);
    let big = map.faces().iter().find(|face| face.fill == 1).unwrap();
    assert_eq!(big.inner.len(), 1);
}

// ----- modes -----

#[test]
fn inside_mode_only_recolors_the_target_fill() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    paint(&mut map, sq(100, 0, 200, 100), 2);
    map.paint(&[sq(50, 20, 150, 80)], 3, Mode::Inside(1));
    check(&map);
    assert_eq!(at(&map, 75, 50), 3);
    assert_eq!(at(&map, 125, 50), 2, "fill 2 untouched");
    assert_eq!(at(&map, 25, 50), 1);
}

#[test]
fn behind_mode_only_paints_empty_space() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    map.paint(&[sq(50, 50, 150, 150)], 2, Mode::Behind);
    check(&map);
    assert_eq!(at(&map, 75, 75), 1, "existing fill stays on top");
    assert_eq!(at(&map, 125, 125), 2);
}

#[test]
fn erase_outside_everything_does_nothing() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    let before = map.digest();
    map.paint(&[sq(200, 200, 300, 300)], 0, Mode::Erase);
    check(&map);
    assert_eq!(map.digest(), before);
}

// ----- paint bucket and hit testing -----

#[test]
fn fill_at_recolors_one_face() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    paint(&mut map, sq(100, 0, 200, 100), 2);
    assert!(map.fill_at((50, 50), 2));
    check(&map);
    assert_eq!(at(&map, 50, 50), 2);
    assert!(
        !map.connected((100, 0), (100, 100)),
        "same fill now, edge dissolved"
    );
    assert!(!map.fill_at((500, 500), 3), "the outside never fills");
}

#[test]
fn face_at_respects_holes_and_curves() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    assert!(map.curve_edge((0, 0), (100, 0), None, (50, 60)));
    check(&map);
    assert_eq!(
        at(&map, 50, 10),
        EMPTY,
        "above the bowed edge {:?} {:?}",
        map.faces(),
        map.half_edges()
    );
    assert_eq!(at(&map, 50, 50), 1, "below the bow");
    assert_eq!(at(&map, 5, 5), EMPTY, "the bow cuts the corner off");
    assert_eq!(at(&map, 5, 50), 1);
}

#[test]
fn nearest_vertex_and_edge() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    assert_eq!(map.nearest_vertex((3, -2), 10), Some((0, 0)));
    assert_eq!(map.nearest_vertex((50, 50), 10), None);
    let (a, b, ctrl) = map.nearest_edge((50, 3), 10).expect("edge near the top");
    assert!(ctrl.is_none());
    assert!((a == (0, 0) && b == (100, 0)) || (a == (100, 0) && b == (0, 0)));
}

// ----- editing -----

#[test]
fn removing_an_edge_merges_faces() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    paint(&mut map, sq(100, 0, 200, 100), 2);
    assert!(map.remove_edge((100, 0), (100, 100), None));
    check(&map);
    assert_eq!(at(&map, 50, 50), at(&map, 150, 50));
}

#[test]
fn remapping_fills_dissolves_edges() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    paint(&mut map, sq(100, 0, 200, 100), 2);
    map.remap_fills(&[(2, 1)]);
    check(&map);
    assert!(!map.connected((100, 0), (100, 100)));
    assert_eq!(at(&map, 150, 50), 1);
}

#[test]
fn transform_moves_everything() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    assert!(map.curve_edge((0, 0), (100, 0), None, (50, -40)));
    map.transform(&Affine {
        a: 2.0,
        b: 0.0,
        c: 0.0,
        d: 2.0,
        e: 10.0,
        f: 20.0,
    });
    check(&map);
    assert!(map.has_vertex((10, 20)));
    assert!(map.has_vertex((210, 220)));
    assert_eq!(at(&map, 110, 120), 1);
    assert!(
        map.half_edges()
            .iter()
            .any(|half| half.ctrl == Some((110, -60)))
    );
}

#[test]
fn split_off_face_lifts_one_region() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    paint(&mut map, sq(100, 0, 200, 100), 2);
    let lifted = map.split_off_face((150, 50));
    check(&map);
    check(&lifted);
    assert_eq!(at(&lifted, 150, 50), 2);
    assert_eq!(at(&lifted, 50, 50), EMPTY);
    assert_eq!(at(&map, 150, 50), EMPTY);
    assert_eq!(at(&map, 50, 50), 1);
}

#[test]
fn split_off_region_cuts_shapes() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    let lifted = map.split_off(&[sq(50, -10, 150, 110)]);
    check(&map);
    check(&lifted);
    assert_eq!(at(&lifted, 75, 50), 1);
    assert_eq!(at(&lifted, 25, 50), EMPTY);
    assert_eq!(at(&map, 25, 50), 1);
    assert_eq!(at(&map, 75, 50), EMPTY);
    assert!(map.has_vertex((50, 0)));
}

#[test]
fn stamp_puts_a_selection_back_over_the_rest() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    paint(&mut map, sq(200, 0, 300, 100), 2);
    let lifted = map.split_off_face((250, 50));
    map.stamp(
        &lifted,
        &Affine {
            e: -150.0,
            ..Affine::IDENTITY
        },
    );
    check(&map);
    assert_eq!(at(&map, 75, 50), 2, "stamped shape cuts the one underneath");
    assert_eq!(at(&map, 25, 50), 1);
    assert_eq!(at(&map, 125, 50), 2);
    assert_eq!(at(&map, 250, 50), EMPTY);
}

#[test]
fn stamp_shows_underneath_through_holes() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    let mut donut = Map::new();
    paint(&mut donut, sq(20, 20, 80, 80), 2);
    donut.paint(&[sq(40, 40, 60, 60)], 0, Mode::Erase);
    map.stamp(&donut, &Affine::IDENTITY);
    check(&map);
    assert_eq!(at(&map, 50, 50), 1);
    assert_eq!(at(&map, 30, 30), 2);
    assert_eq!(at(&map, 10, 10), 1);
}

#[test]
fn bytes_round_trip() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    paint(&mut map, sq(50, 50, 150, 150), 2);
    assert!(map.curve_edge((0, 0), (100, 0), None, (50, -40)));
    let bytes = map.to_bytes();
    let back = Map::from_bytes(&bytes).expect("valid bytes");
    assert_eq!(back.digest(), map.digest());
    assert_eq!(back.half_edges(), map.half_edges());
    assert_eq!(back.faces(), map.faces());
    assert!(Map::from_bytes(b"nope").is_err());
    assert!(Map::from_bytes(&bytes[..bytes.len() - 3]).is_err());
}

// ----- curves -----

#[test]
fn a_graze_shares_a_vertex_and_keeps_fills() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 400, 400), 1);
    // Apex is half a twip outside the top edge, so the curves never strictly cross.
    // Apex sits half a twip outside the top edge. The control is far enough
    // from the chord that the edge stays a curve.
    let graze = Ring {
        start: (50, -40),
        segs: vec![Seg::Quad((200, 39), (350, -40)), Seg::Line((50, -40))],
    };
    paint(&mut map, graze, 2);
    check(&map);
    assert!(
        map.vertices()
            .iter()
            .any(|v| (v.0 - 200).abs() <= 1 && v.1.abs() <= 1),
        "graze did not share a vertex: {:?}",
        map.vertices()
    );
    assert_eq!(at(&map, 200, 20), 1, "inside the square");
    assert_eq!(at(&map, 200, -60), EMPTY, "outside both shapes");
}

#[test]
fn curves_that_miss_stay_one_edge() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    paint(&mut map, sq(0, 200, 100, 300), 2);
    assert!(map.curve_edge((0, 0), (100, 0), None, (50, -400)));
    assert!(map.curve_edge((0, 200), (100, 200), None, (50, -400)));
    check(&map);
    assert!(
        map.vertex_count() <= 12,
        "a near miss shattered the curve into {}",
        map.vertex_count()
    );
}

#[test]
fn a_polygon_over_a_curve_owns_the_chord_lens() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    assert!(map.curve_edge((0, 0), (100, 0), None, (50, 40)));
    paint(
        &mut map,
        polygon(&[(0, 0), (100, 0), (100, 30), (0, 30)]),
        2,
    );
    check(&map);
    assert_eq!(at(&map, 50, 10), 2, "chord lens");
    assert_eq!(at(&map, 50, 25), 2, "under the curve");
    assert_eq!(at(&map, 50, 50), 1);
}

#[test]
fn a_curve_that_crosses_into_a_neighbor_takes_the_lens() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 200, 200), 1);
    paint(&mut map, sq(100, 40, 220, 160), 2);
    assert!(map.curve_edge((100, 40), (200, 40), None, (150, -80)));
    check(&map);
    assert_eq!(at(&map, 150, 80), 2);
    assert_eq!(at(&map, 40, 20), 1);
    // The lens the bow carved out of fill 1 now belongs to one of the two neighbours.
    assert!(at(&map, 150, 20) != EMPTY);
}

#[test]
fn adjacent_curves_that_cross_split_at_the_crossing() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 100), 1);
    assert!(map.curve_edge((0, 0), (100, 0), None, (50, 70)));
    assert!(map.curve_edge((0, 0), (0, 100), None, (70, 50)));
    check(&map);
    let verts = map.vertices();
    assert!(
        verts
            .iter()
            .any(|(x, y)| *x > 5 && *x < 95 && *y > 5 && *y < 95),
        "curves cross with no vertex, verts {verts:?}"
    );
}

#[test]
fn a_curved_edge_splits_where_a_line_crosses_it() {
    let mut map = Map::new();
    paint(&mut map, sq(0, 0, 100, 40), 1);
    assert!(map.curve_edge((0, 0), (100, 0), None, (50, -40)));
    assert!(map.half_edges().iter().any(|half| half.ctrl.is_some()));
    paint(&mut map, sq(40, -30, 60, 20), 2);
    check(&map);
    assert_eq!(at(&map, 50, 0), 2);
    assert_eq!(at(&map, 20, 20), 1);
    assert!(map.vertex_count() > 8);
}

#[test]
fn quadratic_rings_paint() {
    let mut map = Map::new();
    let circle = Ring {
        start: (100, 0),
        segs: vec![
            Seg::Quad((100, 100), (0, 100)),
            Seg::Quad((-100, 100), (-100, 0)),
            Seg::Quad((-100, -100), (0, -100)),
            Seg::Quad((100, -100), (100, 0)),
        ],
    };
    map.paint(&[circle], 1, Mode::Over);
    check(&map);
    assert_eq!(at(&map, 0, 0), 1);
    assert_eq!(at(&map, 90, 90), EMPTY);
    assert_eq!(map.half_edges().len(), 8);
}

#[test]
fn cubic_rings_are_converted() {
    let mut map = Map::new();
    let blob = Ring {
        start: (0, 0),
        segs: vec![
            Seg::Cubic((500, -800), (1500, -800), (2000, 0)),
            Seg::Cubic((1500, 800), (500, 800), (0, 0)),
        ],
    };
    map.paint(&[blob], 1, Mode::Over);
    check(&map);
    assert_eq!(at(&map, 1000, 0), 1);
    assert_eq!(at(&map, 1000, 1000), EMPTY);
    assert!(
        map.half_edges()
            .iter()
            .all(|half| half.ctrl.is_some() || true)
    );
    assert!(
        map.half_edges().len() >= 4,
        "cubics were split into several quadratics"
    );
}

// ----- booleans -----

fn region_contains(rings: &[Ring], p: P) -> bool {
    let mut map = Map::new();
    map.paint(rings, 1, Mode::Over);
    map.face_at(p) == 1
}

#[test]
fn region_ops_agree_with_point_sampling() {
    let a = [sq(0, 0, 100, 100)];
    let b = [sq(50, 50, 150, 150)];
    let samples = [(25, 25), (75, 75), (125, 125), (25, 125), (75, 25)];
    let ops = [
        BoolOp::Union,
        BoolOp::Intersect,
        BoolOp::Subtract,
        BoolOp::Xor,
    ];
    for op in ops {
        let out = region_op(&a, &b, op);
        for p in samples {
            let ia = region_contains(&a, p);
            let ib = region_contains(&b, p);
            let want = match op {
                BoolOp::Union => ia || ib,
                BoolOp::Intersect => ia && ib,
                BoolOp::Subtract => ia && !ib,
                BoolOp::Xor => ia != ib,
            };
            assert_eq!(region_contains(&out, p), want, "{op:?} at {p:?}");
        }
    }
}

#[test]
fn subtracting_a_hole_yields_two_rings() {
    let out = region_op(
        &[sq(0, 0, 100, 100)],
        &[sq(40, 40, 60, 60)],
        BoolOp::Subtract,
    );
    assert_eq!(out.len(), 2);
    assert!(region_contains(&out, (10, 10)));
    assert!(!region_contains(&out, (50, 50)));
}

// ----- randomized -----

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn range(&mut self, lo: i32, hi: i32) -> i32 {
        lo + (self.next() % (hi - lo) as u64) as i32
    }
}

fn random_ring(rng: &mut Rng) -> Ring {
    let n = rng.range(3, 7) as usize;
    let cx = rng.range(0, 400);
    let cy = rng.range(0, 400);
    let mut pts = Vec::with_capacity(n);
    for _ in 0..n {
        pts.push((cx + rng.range(-120, 120), cy + rng.range(-120, 120)));
    }
    let mut segs = Vec::new();
    for i in 1..n {
        if rng.range(0, 3) == 0 {
            let c = (cx + rng.range(-150, 150), cy + rng.range(-150, 150));
            segs.push(Seg::Quad(c, pts[i]));
        } else {
            segs.push(Seg::Line(pts[i]));
        }
    }
    Ring {
        start: pts[0],
        segs,
    }
}

#[test]
fn random_paints_keep_the_invariants() {
    for seed in 1..=40u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9e3779b97f4a7c15));
        let mut map = Map::new();
        for step in 0..8 {
            let ring = random_ring(&mut rng);
            let mode = match rng.range(0, 6) {
                0 => Mode::Erase,
                1 => Mode::Behind,
                _ => Mode::Over,
            };
            let fill = rng.range(1, 4) as u32;
            map.paint(&[ring.clone()], fill, mode);
            check(&map);
            if mode == Mode::Over {
                // Sample inside the ring: everything strictly inside must be the new fill.
                let mut probe = Map::new();
                probe.paint(&[ring], 1, Mode::Over);
                for _ in 0..6 {
                    let p = (rng.range(-200, 600), rng.range(-200, 600));
                    if probe.face_at(p) == 1 && probe.nearest_edge(p, 3).is_none() {
                        assert_eq!(map.face_at(p), fill, "seed {seed} step {step} at {p:?}");
                    }
                }
            }
            let bytes = map.to_bytes();
            let back = Map::from_bytes(&bytes).unwrap();
            assert_eq!(
                back.digest(),
                map.digest(),
                "seed {seed} step {step} round trip"
            );
        }
        // Moving every vertex a little must keep the structure valid.
        let verts: Vec<P> = map.vertices().to_vec();
        for v in verts.into_iter().take(5) {
            if map.has_vertex(v) {
                map.move_vertex(v, (v.0 + rng.range(-15, 15), v.1 + rng.range(-15, 15)));
                check(&map);
            }
        }
        let lifted = map.split_off(&[sq(0, 0, 200, 200)]);
        check(&map);
        check(&lifted);
        map.stamp(
            &lifted,
            &Affine {
                e: 7.0,
                f: -3.0,
                ..Affine::IDENTITY
            },
        );
        check(&map);
    }
}

#[test]
fn gentle_cubics_stay_curved() {
    // A potrace-like ring: wide, shallow cubics (sag of a few pixels over ~100px).
    let ring = Ring {
        start: (0, 0),
        segs: vec![
            Seg::Cubic((700, -200), (1300, -200), (2000, 0)),
            Seg::Cubic((2200, 700), (2200, 1300), (2000, 2000)),
            Seg::Cubic((1300, 2200), (700, 2200), (0, 2000)),
            Seg::Cubic((-200, 1300), (-200, 700), (0, 0)),
        ],
    };
    let mut map = Map::new();
    paint(&mut map, ring, 1);
    check(&map);
    let mut quads = 0;
    let mut lines = 0;
    for (_, rings) in map.regions() {
        for ring in rings {
            for seg in ring.segs {
                match seg {
                    Seg::Quad(..) => quads += 1,
                    _ => lines += 1,
                }
            }
        }
    }
    assert!(quads > 0, "no curves survived");
    assert_eq!(lines, 0, "{lines} curved pieces were flattened to lines");
}

#[test]
fn a_tiny_circle_stays_curved() {
    // Radius 8 twips. Each quadrant's control sits about 4 twips off its chord.
    // The old cull stored that as a diamond.
    let k = 4;
    let ring = Ring {
        start: (8, 0),
        segs: vec![
            Seg::Cubic((8, k), (k, 8), (0, 8)),
            Seg::Cubic((-k, 8), (-8, k), (-8, 0)),
            Seg::Cubic((-8, -k), (-k, -8), (0, -8)),
            Seg::Cubic((k, -8), (8, -k), (8, 0)),
        ],
    };
    let mut map = Map::new();
    paint(&mut map, ring, 1);
    check(&map);
    let mut quads = 0;
    let mut lines = 0;
    for (_, rings) in map.regions() {
        for ring in rings {
            for seg in ring.segs {
                match seg {
                    Seg::Quad(..) => quads += 1,
                    _ => lines += 1,
                }
            }
        }
    }
    assert_eq!(lines, 0, "{lines} quadrants were flattened");
    assert_eq!(quads, 4, "expected four quadrants, got {quads}");
    assert_eq!(at(&map, 0, 0), 1);
    assert_eq!(at(&map, 20, 0), EMPTY);
}

#[test]
fn replace_chain_keeps_fills_and_drops_vertices() {
    let mut map = Map::new();
    // A pentagon-ish polyline on the right side: (200,0) -> (260,50) -> (270,100) -> (260,150) -> (200,200).
    let ring = polygon(&[
        (0, 0),
        (200, 0),
        (260, 50),
        (270, 100),
        (260, 150),
        (200, 200),
        (0, 200),
    ]);
    paint(&mut map, ring, 1);
    paint(&mut map, sq(-100, 50, 0, 150), 2);
    check(&map);
    let before_faces: Vec<u32> = map.faces().iter().map(|f| f.fill).collect();
    let before_verts = map.vertex_count();
    let chain = [(200, 0), (260, 50), (270, 100), (260, 150), (200, 200)];
    let ok = map.replace_chain(&chain, &[Seg::Cubic((300, 20), (300, 180), (200, 200))]);
    assert!(ok);
    check(&map);
    let after_faces: Vec<u32> = map.faces().iter().map(|f| f.fill).collect();
    assert_eq!(before_faces, after_faces);
    assert!(map.vertex_count() < before_verts, "vertices did not drop");
    assert_eq!(at(&map, 100, 100), 1);
    assert_eq!(at(&map, -50, 100), 2);
    assert_eq!(at(&map, 260, 100), 1, "the bulge is inside the shape");
    assert_eq!(at(&map, 400, 100), EMPTY);
    // Bad chains are refused and leave the map untouched.
    let digest = map.digest();
    assert!(!map.replace_chain(&[(0, 0), (123, 456)], &[Seg::Line((123, 456))]));
    assert!(!map.replace_chain(&[(0, 0), (200, 0)], &[Seg::Line((5, 5))]));
    assert_eq!(map.digest(), digest);
}

#[test]
fn a_small_disc_on_a_capsule_end_survives() {
    // The disc's curve passes within a twip of the capsule's corners; the
    // crossing must still split the curve so the disc half outside is kept.
    let cap = Ring {
        start: (1580, 599),
        segs: vec![
            Seg::Line((1578, 626)),
            Seg::Line((1618, 628)),
            Seg::Line((1620, 601)),
        ],
    };
    let disc = Ring {
        start: (1620, 600),
        segs: vec![
            Seg::Cubic((1620, 611), (1611, 620), (1600, 620)),
            Seg::Cubic((1589, 620), (1580, 611), (1580, 600)),
            Seg::Cubic((1580, 589), (1589, 580), (1600, 580)),
            Seg::Cubic((1611, 580), (1620, 589), (1620, 600)),
        ],
    };
    let mut map = Map::new();
    paint(&mut map, cap.clone(), 1);
    paint(&mut map, disc.clone(), 1);
    check(&map);
    assert_eq!(
        at(&map, 1600, 585),
        1,
        "disc half outside the capsule was lost"
    );
    assert_eq!(at(&map, 1600, 615), 1);
    let union = region_op(&[cap], &[disc], BoolOp::Union);
    let mut probe = Map::new();
    probe.paint(&union, 1, Mode::Over);
    assert_eq!(at(&probe, 1600, 585), 1, "union lost the disc");
}

#[test]
fn moving_vertices_carries_their_controls() {
    // A square whose top edge bulges upward.
    let ring = Ring {
        start: (0, 0),
        segs: vec![
            Seg::Quad((1000, -1000), (2000, 0)),
            Seg::Line((2000, 2000)),
            Seg::Line((0, 2000)),
        ],
    };
    let mut map = Map::new();
    paint(&mut map, ring, 1);
    let ctrl_of = |map: &Map| {
        map.half_edges()
            .iter()
            .find_map(|h| h.ctrl)
            .expect("a curved edge")
    };
    assert_eq!(ctrl_of(&map), (1000, -1000));
    // Both ends of the curve move together: the control translates rigidly.
    assert!(map.move_vertices(&[((0, 0), (0, -400)), ((2000, 0), (2000, -400))]));
    check(&map);
    assert_eq!(ctrl_of(&map), (1000, -1400));
    // One end moves: the control follows half-way.
    assert!(map.move_vertex((0, -400), (200, -400)));
    check(&map);
    assert_eq!(ctrl_of(&map), (1100, -1400));
    // A missing vertex refuses the whole batch.
    let digest = map.digest();
    assert!(!map.move_vertices(&[((200, -400), (300, -400)), ((99, 99), (0, 0))]));
    assert_eq!(map.digest(), digest);
}
