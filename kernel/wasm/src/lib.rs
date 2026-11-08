//! wasm-bindgen surface over `dcel::Map`.
//!
//! Coordinates cross the boundary as twips (`i32`, 20 per CSS pixel) except
//! for the readback helpers `contours`, `edges`, `verts`, and `bounds`, which
//! return pixels for drawing.
//!
//! Packed ring format (`Int32Array`): `ringCount, (segCount, x0, y0, (tag,
//! c1x, c1y, c2x, c2y, x, y) * segCount) * ringCount`. Tag 0 is a line (only
//! `x, y` used), 1 a quadratic (`c1`), 2 a cubic (`c1`, `c2`).

use dcel::{Affine, BoolOp, Map, Mode, Ring, Seg, TWIPS_PER_PX};
use wasm_bindgen::prelude::*;

const SEG_STRIDE: usize = 7;

fn px(twips: i32) -> f32 {
    twips as f32 / TWIPS_PER_PX as f32
}

fn parse_rings(data: &[i32]) -> Vec<Ring> {
    let mut rings = Vec::new();
    let mut at = 0usize;
    let read = |at: &mut usize| -> Option<i32> {
        let v = data.get(*at).copied();
        *at += 1;
        v
    };
    let Some(ring_count) = read(&mut at) else {
        return rings;
    };
    for _ in 0..ring_count.max(0) {
        let Some(seg_count) = read(&mut at) else { break };
        let (Some(x0), Some(y0)) = (read(&mut at), read(&mut at)) else { break };
        let mut ring = Ring { start: (x0, y0), segs: Vec::with_capacity(seg_count.max(0) as usize) };
        for _ in 0..seg_count.max(0) {
            if at + SEG_STRIDE > data.len() {
                break;
            }
            let s = &data[at..at + SEG_STRIDE];
            at += SEG_STRIDE;
            let to = (s[5], s[6]);
            ring.segs.push(match s[0] {
                1 => Seg::Quad((s[1], s[2]), to),
                2 => Seg::Cubic((s[1], s[2]), (s[3], s[4]), to),
                _ => Seg::Line(to),
            });
        }
        rings.push(ring);
    }
    rings
}

fn pack_rings(rings: &[Ring]) -> Vec<i32> {
    let mut out = vec![rings.len() as i32];
    for ring in rings {
        out.push(ring.segs.len() as i32);
        out.push(ring.start.0);
        out.push(ring.start.1);
        for seg in &ring.segs {
            match *seg {
                Seg::Line(to) => out.extend_from_slice(&[0, 0, 0, 0, 0, to.0, to.1]),
                Seg::Quad(c, to) => out.extend_from_slice(&[1, c.0, c.1, 0, 0, to.0, to.1]),
                Seg::Cubic(c1, c2, to) => out.extend_from_slice(&[2, c1.0, c1.1, c2.0, c2.1, to.0, to.1]),
            }
        }
    }
    out
}

fn mode_of(mode: u32, target: u32) -> Mode {
    match mode {
        1 => Mode::Erase,
        2 => Mode::Inside(target),
        3 => Mode::Behind,
        _ => Mode::Over,
    }
}

fn affine_of(xf: &[f64]) -> Affine {
    if xf.len() < 6 {
        return Affine::IDENTITY;
    }
    Affine { a: xf[0], b: xf[1], c: xf[2], d: xf[3], e: xf[4], f: xf[5] }
}

fn ctrl_of(has_ctrl: bool, cx: i32, cy: i32) -> Option<(i32, i32)> {
    has_ctrl.then_some((cx, cy))
}

#[wasm_bindgen]
pub struct VectorMap {
    map: Map,
}

impl Default for VectorMap {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl VectorMap {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self { map: Map::new() }
    }

    #[wasm_bindgen(js_name = fromBytes)]
    pub fn from_bytes(bytes: &[u8]) -> Result<VectorMap, JsError> {
        Map::from_bytes(bytes).map(|map| VectorMap { map }).map_err(|e| JsError::new(&e))
    }

    #[wasm_bindgen(js_name = toBytes)]
    pub fn to_bytes(&self) -> Vec<u8> {
        self.map.to_bytes()
    }

    #[wasm_bindgen(js_name = clone)]
    pub fn clone_map(&self) -> VectorMap {
        VectorMap { map: self.map.clone() }
    }

    /// Inbetween of this map (t = 0) and `other` (t = 1).
    pub fn lerp(&self, other: &VectorMap, t: f64) -> VectorMap {
        VectorMap {
            map: self.map.lerp(&other.map, t),
        }
    }

    #[wasm_bindgen(js_name = isEmpty)]
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn digest(&self) -> u64 {
        self.map.digest()
    }

    /// `mode`: 0 over, 1 erase, 2 inside(`target`), 3 behind.
    pub fn paint(&mut self, rings: &[i32], fill: u32, mode: u32, target: u32) {
        self.map.paint(&parse_rings(rings), fill, mode_of(mode, target));
    }

    #[wasm_bindgen(js_name = fillAt)]
    pub fn fill_at(&mut self, x: i32, y: i32, fill: u32) -> bool {
        self.map.fill_at((x, y), fill)
    }

    #[wasm_bindgen(js_name = faceAt)]
    pub fn face_at(&self, x: i32, y: i32) -> u32 {
        self.map.face_at((x, y))
    }

    /// `[x, y]` in twips, or empty.
    #[wasm_bindgen(js_name = nearestVertex)]
    pub fn nearest_vertex(&self, x: i32, y: i32, tol: i32) -> Vec<i32> {
        self.map.nearest_vertex((x, y), tol).map_or(Vec::new(), |(vx, vy)| vec![vx, vy])
    }

    /// `[ax, ay, bx, by, hasCtrl, cx, cy]` in twips, or empty.
    #[wasm_bindgen(js_name = nearestEdge)]
    pub fn nearest_edge(&self, x: i32, y: i32, tol: i32) -> Vec<i32> {
        match self.map.nearest_edge((x, y), tol) {
            Some((a, b, ctrl)) => {
                let (has, c) = match ctrl {
                    Some(c) => (1, c),
                    None => (0, ((a.0 + b.0) / 2, (a.1 + b.1) / 2)),
                };
                vec![a.0, a.1, b.0, b.1, has, c.0, c.1]
            }
            None => Vec::new(),
        }
    }

    #[wasm_bindgen(js_name = moveVertex)]
    pub fn move_vertex(&mut self, x: i32, y: i32, nx: i32, ny: i32) -> bool {
        self.map.move_vertex((x, y), (nx, ny))
    }

    /// Flat `[fromX, fromY, toX, toY, ...]` twips; one rebuild for all moves.
    #[wasm_bindgen(js_name = moveVertices)]
    pub fn move_vertices(&mut self, moves: &[i32]) -> bool {
        let moves: Vec<((i32, i32), (i32, i32))> =
            moves.chunks_exact(4).map(|m| ((m[0], m[1]), (m[2], m[3]))).collect();
        self.map.move_vertices(&moves)
    }

    #[wasm_bindgen(js_name = curveEdge)]
    #[allow(clippy::too_many_arguments)]
    pub fn curve_edge(&mut self, ax: i32, ay: i32, bx: i32, by: i32, has_ctrl: bool, cx: i32, cy: i32, tx: i32, ty: i32) -> bool {
        self.map.curve_edge((ax, ay), (bx, by), ctrl_of(has_ctrl, cx, cy), (tx, ty))
    }

    /// `chain` is flat `[x, y, x, y, ...]` twips; `ring` is one packed ring
    /// whose start is the chain's first vertex and whose segments end at its last.
    #[wasm_bindgen(js_name = replaceChain)]
    pub fn replace_chain(&mut self, chain: &[i32], ring: &[i32]) -> bool {
        let chain: Vec<(i32, i32)> = chain.chunks_exact(2).map(|p| (p[0], p[1])).collect();
        let rings = parse_rings(ring);
        match rings.first() {
            Some(r) => self.map.replace_chain(&chain, &r.segs),
            None => false,
        }
    }

    #[wasm_bindgen(js_name = removeEdge)]
    #[allow(clippy::too_many_arguments)]
    pub fn remove_edge(&mut self, ax: i32, ay: i32, bx: i32, by: i32, has_ctrl: bool, cx: i32, cy: i32) -> bool {
        self.map.remove_edge((ax, ay), (bx, by), ctrl_of(has_ctrl, cx, cy))
    }

    /// Flat `[from, to, from, to, ...]`.
    #[wasm_bindgen(js_name = remapFills)]
    pub fn remap_fills(&mut self, pairs: &[u32]) {
        let pairs: Vec<(u32, u32)> = pairs.chunks_exact(2).map(|p| (p[0], p[1])).collect();
        self.map.remap_fills(&pairs);
    }

    /// `[a, b, c, d, e, f]` with `e`, `f` in twips.
    pub fn transform(&mut self, xf: &[f64]) {
        self.map.transform(&affine_of(xf));
    }

    #[wasm_bindgen(js_name = splitOff)]
    pub fn split_off(&mut self, rings: &[i32]) -> VectorMap {
        VectorMap { map: self.map.split_off(&parse_rings(rings)) }
    }

    #[wasm_bindgen(js_name = splitOffFace)]
    pub fn split_off_face(&mut self, x: i32, y: i32) -> VectorMap {
        VectorMap { map: self.map.split_off_face((x, y)) }
    }

    #[wasm_bindgen(js_name = splitOffFills)]
    pub fn split_off_fills(&mut self, fills: &[u32]) -> VectorMap {
        VectorMap { map: self.map.split_off_fills(fills) }
    }

    pub fn stamp(&mut self, other: &VectorMap, xf: &[f64]) {
        self.map.stamp(&other.map, &affine_of(xf));
    }

    /// Distinct fill ids in use.
    pub fn fills(&self) -> Vec<u32> {
        self.map.fills()
    }

    /// `[x0, y0, x1, y1]` in pixels, or empty.
    pub fn bounds(&self) -> Vec<f32> {
        match self.map.bounds() {
            Some((x0, y0, x1, y1)) => {
                let s = TWIPS_PER_PX as f32;
                vec![x0 as f32 / s, y0 as f32 / s, x1 as f32 / s, y1 as f32 / s]
            }
            None => Vec::new(),
        }
    }

    /// Filled faces in pixels: `fill, ringCount, (segCount, x0, y0, (tag, cx, cy, x, y) * segCount) * ringCount`, repeated.
    /// Tag 0 is a line, 1 a quadratic. Draw each face with the even-odd rule.
    pub fn contours(&self) -> Vec<f32> {
        let mut out = Vec::new();
        for (fill, rings) in self.map.regions() {
            out.push(fill as f32);
            out.push(rings.len() as f32);
            for ring in &rings {
                out.push(ring.segs.len() as f32);
                out.push(px(ring.start.0));
                out.push(px(ring.start.1));
                for seg in &ring.segs {
                    match *seg {
                        Seg::Line(to) => out.extend_from_slice(&[0.0, 0.0, 0.0, px(to.0), px(to.1)]),
                        Seg::Quad(c, to) => out.extend_from_slice(&[1.0, px(c.0), px(c.1), px(to.0), px(to.1)]),
                        Seg::Cubic(_, _, to) => out.extend_from_slice(&[0.0, 0.0, 0.0, px(to.0), px(to.1)]),
                    }
                }
            }
        }
        out
    }

    /// Filled faces in twips, same layout as `contours` but as `Int32Array`
    /// with tag `1` carrying the control point.
    pub fn regions(&self) -> Vec<i32> {
        let mut out = Vec::new();
        for (fill, rings) in self.map.regions() {
            out.push(fill as i32);
            out.extend(pack_rings(&rings));
        }
        out
    }

    /// Every edge in pixels: `ax, ay, bx, by, hasCtrl, cx, cy`.
    pub fn edges(&self) -> Vec<f32> {
        let verts = self.map.vertices();
        let mut out = Vec::with_capacity(self.map.half_edges().len() / 2 * 7);
        for pair in self.map.half_edges().chunks(2) {
            let a = verts[pair[0].origin as usize];
            let b = verts[pair[1].origin as usize];
            out.extend_from_slice(&[px(a.0), px(a.1), px(b.0), px(b.1)]);
            match pair[0].ctrl {
                Some(c) => out.extend_from_slice(&[1.0, px(c.0), px(c.1)]),
                None => out.extend_from_slice(&[0.0, (px(a.0) + px(b.0)) / 2.0, (px(a.1) + px(b.1)) / 2.0]),
            }
        }
        out
    }

    /// Every edge in twips: `ax, ay, bx, by, hasCtrl, cx, cy`.
    #[wasm_bindgen(js_name = edgeTwips)]
    pub fn edge_twips(&self) -> Vec<i32> {
        let verts = self.map.vertices();
        let mut out = Vec::with_capacity(self.map.half_edges().len() / 2 * 7);
        for pair in self.map.half_edges().chunks(2) {
            let a = verts[pair[0].origin as usize];
            let b = verts[pair[1].origin as usize];
            out.extend_from_slice(&[a.0, a.1, b.0, b.1]);
            match pair[0].ctrl {
                Some(c) => out.extend_from_slice(&[1, c.0, c.1]),
                None => out.extend_from_slice(&[0, (a.0 + b.0) / 2, (a.1 + b.1) / 2]),
            }
        }
        out
    }

    /// Vertices in pixels: `x, y, ...`.
    pub fn verts(&self) -> Vec<f32> {
        self.map.vertices().iter().flat_map(|&(x, y)| [px(x), px(y)]).collect()
    }

    /// Vertices in twips.
    #[wasm_bindgen(js_name = vertTwips)]
    pub fn vert_twips(&self) -> Vec<i32> {
        self.map.vertices().iter().flat_map(|&(x, y)| [x, y]).collect()
    }

    #[wasm_bindgen(js_name = vertexCount)]
    pub fn vertex_count(&self) -> u32 {
        self.map.vertex_count() as u32
    }
}

/// Boolean of two packed ring sets. `op`: 0 union, 1 intersect, 2 subtract, 3 xor.
#[wasm_bindgen(js_name = regionOp)]
pub fn region_op(a: &[i32], b: &[i32], op: u32) -> Vec<i32> {
    let op = match op {
        1 => BoolOp::Intersect,
        2 => BoolOp::Subtract,
        3 => BoolOp::Xor,
        _ => BoolOp::Union,
    };
    pack_rings(&dcel::region_op(&parse_rings(a), &parse_rings(b), op))
}
