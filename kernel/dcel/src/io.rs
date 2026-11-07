//! Compact little-endian snapshot of a map. Restoring is O(n); nothing is
//! recomputed, so a saved frame loads as fast as it is read.

use crate::{EMPTY, Face, HalfEdge, Map};

const MAGIC: &[u8; 4] = b"FCV1";
const NONE: u32 = u32::MAX;

struct Writer(Vec<u8>);

impl Writer {
    fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn i32(&mut self, v: i32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], String> {
        if self.at + n > self.bytes.len() {
            return Err("truncated map".into());
        }
        let out = &self.bytes[self.at..self.at + n];
        self.at += n;
        Ok(out)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn i32(&mut self) -> Result<i32, String> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn count(&mut self) -> Result<usize, String> {
        let n = self.u32()? as usize;
        if n > self.bytes.len() {
            return Err("bad count".into());
        }
        Ok(n)
    }
}

pub(crate) fn to_bytes(map: &Map) -> Vec<u8> {
    let mut w = Writer(Vec::with_capacity(16 + map.verts.len() * 8 + map.halfs.len() * 28));
    w.0.extend_from_slice(MAGIC);
    w.u32(map.verts.len() as u32);
    for &(x, y) in &map.verts {
        w.i32(x);
        w.i32(y);
    }
    w.u32(map.halfs.len() as u32);
    for half in &map.halfs {
        w.u32(half.origin);
        w.u32(half.next);
        w.u32(half.face);
        w.u32(half.fill);
        w.u32(half.stroke.unwrap_or(NONE));
        match half.ctrl {
            Some((x, y)) => {
                w.u8(1);
                w.i32(x);
                w.i32(y);
            }
            None => w.u8(0),
        }
    }
    w.u32(map.faces.len() as u32);
    for face in &map.faces {
        w.u32(face.fill);
        w.u32(face.outer.unwrap_or(NONE));
        w.u32(face.inner.len() as u32);
        for &inner in &face.inner {
            w.u32(inner);
        }
    }
    w.0
}

pub(crate) fn from_bytes(bytes: &[u8]) -> Result<Map, String> {
    let mut r = Reader { bytes, at: 0 };
    if r.take(4)? != MAGIC {
        return Err("not a FlipCel vector map".into());
    }
    let nv = r.count()?;
    let mut verts = Vec::with_capacity(nv);
    for _ in 0..nv {
        verts.push((r.i32()?, r.i32()?));
    }
    let nh = r.count()?;
    if nh % 2 != 0 {
        return Err("odd half-edge count".into());
    }
    let mut halfs = Vec::with_capacity(nh);
    for _ in 0..nh {
        let origin = r.u32()?;
        let next = r.u32()?;
        let face = r.u32()?;
        let fill = r.u32()?;
        let stroke = r.u32()?;
        let ctrl = if r.u8()? == 1 { Some((r.i32()?, r.i32()?)) } else { None };
        halfs.push(HalfEdge {
            origin,
            next,
            face,
            fill,
            stroke: (stroke != NONE).then_some(stroke),
            ctrl,
        });
    }
    let nf = r.count()?;
    let mut faces = Vec::with_capacity(nf);
    for _ in 0..nf {
        let fill = r.u32()?;
        let outer = r.u32()?;
        let ni = r.count()?;
        let mut inner = Vec::with_capacity(ni);
        for _ in 0..ni {
            inner.push(r.u32()?);
        }
        faces.push(Face { fill, outer: (outer != NONE).then_some(outer), inner });
    }
    if faces.is_empty() {
        faces.push(Face { fill: EMPTY, outer: None, inner: Vec::new() });
    }
    for half in &halfs {
        if half.origin as usize >= verts.len() || half.next as usize >= halfs.len() || half.face as usize >= faces.len() {
            return Err("dangling index".into());
        }
    }
    for face in &faces {
        if face.outer.is_some_and(|h| h as usize >= halfs.len()) || face.inner.iter().any(|&h| h as usize >= halfs.len()) {
            return Err("dangling face index".into());
        }
    }
    Ok(Map { verts, halfs, faces })
}
