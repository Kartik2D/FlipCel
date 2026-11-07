/**
 * Ring construction — SVG path data, traced potrace output, shape
 * primitives, and symmetry expansion, all producing kernel `Ring`s (pixels).
 */
import {
  BoolOp,
  applyAffine,
  mulAffine,
  regionOpRings,
  rotateAbout,
  transformRing,
  type Affine,
  type Px,
  type Ring,
  type Seg,
} from "./kernel";

// ------------------------------------------------------------
// SVG path data
// ------------------------------------------------------------

const NUM_RE = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

function tokenize(d: string): Array<string | number> {
  const out: Array<string | number> = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    if (m[1]) out.push(m[1]);
    else out.push(parseFloat(m[2]));
  }
  return out;
}

/** Approximate an elliptical arc with cubic segments (SVG F.6.5). */
function arcToCubics(
  from: Px,
  rx: number,
  ry: number,
  rotDeg: number,
  large: boolean,
  sweep: boolean,
  to: Px,
): Seg[] {
  if (rx === 0 || ry === 0) return [{ kind: "L", to }];
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (from.x - to.x) / 2;
  const dy = (from.y - to.y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let coef = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den));
  if (large === sweep) coef = -coef;
  const cxp = (coef * rx * y1) / ry;
  const cyp = (-coef * ry * x1) / rx;
  const cx = cos * cxp - sin * cyp + (from.x + to.x) / 2;
  const cy = sin * cxp + cos * cyp + (from.y + to.y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const th1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let dth = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sweep && dth > 0) dth -= Math.PI * 2;
  else if (sweep && dth < 0) dth += Math.PI * 2;
  const n = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2)));
  const step = dth / n;
  const segs: Seg[] = [];
  let t0 = th1;
  const pt = (t: number): Px => ({
    x: cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin,
    y: cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos,
  });
  const dpt = (t: number): Px => ({
    x: -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin,
    y: -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos,
  });
  for (let i = 0; i < n; i++) {
    const t1 = t0 + step;
    const alpha = (Math.sin(step) * (Math.sqrt(4 + 3 * Math.tan(step / 2) ** 2) - 1)) / 3;
    const p0 = pt(t0);
    const p3 = i === n - 1 ? to : pt(t1);
    const d0 = dpt(t0);
    const d1 = dpt(t1);
    segs.push({
      kind: "C",
      c1: { x: p0.x + alpha * d0.x, y: p0.y + alpha * d0.y },
      c2: { x: p3.x - alpha * d1.x, y: p3.y - alpha * d1.y },
      to: p3,
    });
    t0 = t1;
  }
  return segs;
}

/**
 * Parse SVG path data into closed rings. Open subpaths are closed implicitly
 * (everything is a fill). Degenerate subpaths (< 2 distinct points) drop.
 */
export function parsePathData(d: string, xf: Affine | null = null): Ring[] {
  const toks = tokenize(d);
  const rings: Ring[] = [];
  let cur: Ring | null = null;
  let p: Px = { x: 0, y: 0 };
  let startP: Px = { x: 0, y: 0 };
  let lastCtrl = null as Px | null;
  let lastCmd = "";
  let i = 0;
  const T = (q: Px): Px => (xf ? applyAffine(xf, q) : q);
  const num = (): number => {
    const v = toks[i++];
    return typeof v === "number" ? v : NaN;
  };
  const flush = () => {
    if (cur && (cur.segs.length >= 2 || (cur.segs.length === 1 && cur.segs[0].kind !== "L"))) {
      rings.push(cur);
    }
    cur = null;
  };
  const begin = (q: Px) => {
    flush();
    p = q;
    startP = q;
    cur = { start: T(q), segs: [] };
  };
  const push = (s: Seg) => {
    if (!cur) cur = { start: T(p), segs: [] };
    cur.segs.push(s);
  };
  const line = (q: Px) => {
    push({ kind: "L", to: T(q) });
    p = q;
    lastCtrl = null;
  };
  const cubic = (c1: Px, c2: Px, q: Px) => {
    push({ kind: "C", c1: T(c1), c2: T(c2), to: T(q) });
    lastCtrl = c2;
    p = q;
  };
  const quad = (c: Px, q: Px) => {
    push({ kind: "Q", c: T(c), to: T(q) });
    lastCtrl = c;
    p = q;
  };

  let cmd = "";
  while (i < toks.length) {
    const t = toks[i];
    if (typeof t === "string") {
      cmd = t;
      i++;
    } else if (cmd === "M") cmd = "L";
    else if (cmd === "m") cmd = "l";
    const rel = cmd === cmd.toLowerCase() && cmd !== "z";
    const ox = rel ? p.x : 0;
    const oy = rel ? p.y : 0;
    switch (cmd.toUpperCase()) {
      case "M": {
        const x = num() + ox;
        const y = num() + oy;
        begin({ x, y });
        break;
      }
      case "L": {
        const x = num() + ox;
        const y = num() + oy;
        line({ x, y });
        break;
      }
      case "H":
        line({ x: num() + ox, y: p.y });
        break;
      case "V":
        line({ x: p.x, y: num() + oy });
        break;
      case "C": {
        const c1 = { x: num() + ox, y: num() + oy };
        const c2 = { x: num() + ox, y: num() + oy };
        const q = { x: num() + ox, y: num() + oy };
        cubic(c1, c2, q);
        break;
      }
      case "S": {
        const c2 = { x: num() + ox, y: num() + oy };
        const q = { x: num() + ox, y: num() + oy };
        const refl =
          lastCtrl && /[CcSs]/.test(lastCmd)
            ? { x: 2 * p.x - lastCtrl.x, y: 2 * p.y - lastCtrl.y }
            : p;
        cubic(refl, c2, q);
        break;
      }
      case "Q": {
        const c = { x: num() + ox, y: num() + oy };
        const q = { x: num() + ox, y: num() + oy };
        quad(c, q);
        break;
      }
      case "T": {
        const q = { x: num() + ox, y: num() + oy };
        const refl =
          lastCtrl && /[QqTt]/.test(lastCmd)
            ? { x: 2 * p.x - lastCtrl.x, y: 2 * p.y - lastCtrl.y }
            : p;
        quad(refl, q);
        break;
      }
      case "A": {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = num() !== 0;
        const sweep = num() !== 0;
        const q = { x: num() + ox, y: num() + oy };
        for (const s of arcToCubics(p, rx, ry, rot, large, sweep, q)) {
          if (s.kind === "C") cubic(s.c1, s.c2, s.to);
          else line(s.to);
        }
        break;
      }
      case "Z":
        p = startP;
        flush();
        break;
      default:
        i++;
        break;
    }
    lastCmd = cmd;
    if (Number.isNaN(p.x) || Number.isNaN(p.y)) break;
  }
  flush();
  return rings;
}

/** Parse `transform="..."` (translate/scale/rotate/matrix) into an affine. */
export function parseTransform(src: string | null | undefined): Affine {
  let m: Affine = [1, 0, 0, 1, 0, 0];
  if (!src) return m;
  const re = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(src))) {
    const args = (hit[2].match(NUM_RE) ?? []).map(Number);
    let t: Affine | null = null;
    switch (hit[1]) {
      case "matrix":
        if (args.length >= 6) t = [args[0], args[1], args[2], args[3], args[4], args[5]];
        break;
      case "translate":
        t = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
        break;
      case "scale":
        t = [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0];
        break;
      case "rotate":
        t = rotateAbout(args[0] ?? 0, { x: args[1] ?? 0, y: args[2] ?? 0 });
        break;
    }
    if (t) m = mulAffine(m, t);
  }
  return m;
}

export interface SvgShape {
  rings: Ring[];
  /** CSS color string or null (none / inherit). */
  fill: string | null;
}

/**
 * Extract fillable shapes from an SVG document (paths, rects, circles,
 * ellipses, polygons, lines ignored), applying nested `transform`s and an
 * optional outer transform. No DOM required.
 */
export function parseSvgShapes(svg: string, outer: Affine | null = null): SvgShape[] {
  const out: SvgShape[] = [];
  const stack: Array<{ xf: Affine; fill: string | null; stroke: string | null; strokeWidth: number }> = [
    { xf: outer ?? [1, 0, 0, 1, 0, 0], fill: null, stroke: null, strokeWidth: 1 },
  ];
  const tagRe = /<\s*(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)\s*>/g;
  let m: RegExpExecArray | null;
  const attr = (attrs: string, name: string): string | null => {
    const r = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
    return r ? r[1] : null;
  };
  const paintOf = (attrs: string, prop: string, inherited: string | null): string | null => {
    const f = attr(attrs, prop);
    if (f != null) return f === "none" ? "none" : f;
    const style = attr(attrs, "style");
    if (style) {
      const s = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(style);
      if (s) return s[1].trim();
    }
    return inherited;
  };
  const fillOf = (attrs: string, inherited: string | null) => paintOf(attrs, "fill", inherited);
  const strokeOf = (attrs: string, inherited: string | null) => paintOf(attrs, "stroke", inherited);
  const strokeWidthOf = (attrs: string, inherited: number): number => {
    const w = paintOf(attrs, "stroke-width", null);
    if (w == null) return inherited;
    const v = parseFloat(w);
    return Number.isFinite(v) ? v : inherited;
  };
  while ((m = tagRe.exec(svg))) {
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrs = m[3];
    const selfClose = m[4] === "/";
    const top = stack[stack.length - 1];
    if (closing) {
      if (tag === "g" || tag === "svg" || tag === "symbol") {
        if (stack.length > 1) stack.pop();
      }
      continue;
    }
    if (tag === "defs" || tag === "clippath" || tag === "mask") {
      // Skip non-rendered subtree.
      const end = new RegExp(`</\\s*${tag}\\s*>`, "i");
      end.lastIndex = tagRe.lastIndex;
      const rest = svg.slice(tagRe.lastIndex);
      const e = end.exec(rest);
      if (e) tagRe.lastIndex += e.index + e[0].length;
      continue;
    }
    const xf = mulAffine(top.xf, parseTransform(attr(attrs, "transform")));
    const fill = fillOf(attrs, top.fill);
    const stroke = strokeOf(attrs, top.stroke);
    const strokeWidth = strokeWidthOf(attrs, top.strokeWidth);
    if (tag === "g" || tag === "svg" || tag === "symbol") {
      if (!selfClose) stack.push({ xf, fill, stroke, strokeWidth });
      continue;
    }
    let rings: Ring[] = [];
    /** Open polylines (line / polyline) only contribute strokes. */
    let openPolyline: Px[] | null = null;
    const n = (name: string, def = 0) => {
      const v = attr(attrs, name);
      return v == null ? def : parseFloat(v) || 0;
    };
    switch (tag) {
      case "path": {
        const d = attr(attrs, "d");
        if (d) rings = parsePathData(d, xf);
        break;
      }
      case "rect": {
        const x = n("x");
        const y = n("y");
        const w = n("width");
        const h = n("height");
        const rx = Math.min(n("rx", n("ry")), w / 2);
        const ry = Math.min(n("ry", n("rx")), h / 2);
        if (w > 0 && h > 0) {
          rings = [
            rx > 0 && ry > 0
              ? transformRing(roundRectRing(x, y, w, h, rx, ry), xf)
              : transformRing(
                  {
                    start: { x, y },
                    segs: [
                      { kind: "L", to: { x: x + w, y } },
                      { kind: "L", to: { x: x + w, y: y + h } },
                      { kind: "L", to: { x, y: y + h } },
                    ],
                  },
                  xf,
                ),
          ];
        }
        break;
      }
      case "circle":
      case "ellipse": {
        const cx = n("cx");
        const cy = n("cy");
        const rx = tag === "circle" ? n("r") : n("rx");
        const ry = tag === "circle" ? n("r") : n("ry");
        if (rx > 0 && ry > 0) rings = [transformRing(ellipseRing(cx, cy, rx, ry), xf)];
        break;
      }
      case "polygon":
      case "polyline": {
        const pts = (attr(attrs, "points")?.match(NUM_RE) ?? []).map(Number);
        const poly: Px[] = [];
        for (let k = 0; k + 1 < pts.length; k += 2) {
          poly.push(applyAffine(xf, { x: pts[k], y: pts[k + 1] }));
        }
        if (tag === "polyline") openPolyline = poly;
        else if (poly.length >= 3) {
          rings = [{ start: poly[0], segs: poly.slice(1).map((to) => ({ kind: "L", to })) }];
        }
        break;
      }
      case "line": {
        openPolyline = [
          applyAffine(xf, { x: n("x1"), y: n("y1") }),
          applyAffine(xf, { x: n("x2"), y: n("y2") }),
        ];
        break;
      }
      default:
        continue;
    }
    if (rings.length > 0 && fill !== "none") {
      // SVG default fill is black when unspecified.
      out.push({ rings, fill: fill ?? "#000000" });
    }
    if (stroke && stroke !== "none" && strokeWidth > 0) {
      // Stroke width scales with the (uniform-ish) transform.
      const scale = Math.sqrt(Math.abs(xf[0] * xf[3] - xf[1] * xf[2])) || 1;
      const width = strokeWidth * scale;
      const strokeOut: Ring[] = [];
      if (openPolyline && openPolyline.length >= 2) strokeOut.push(...strokeRings(openPolyline, width, false));
      for (const r of rings) strokeOut.push(...outlineRing(r, width));
      if (strokeOut.length > 0) out.push({ rings: strokeOut, fill: stroke });
    }
  }
  return out;
}

/** All rings of an SVG regardless of fill (potrace output is single-color). */
export function parseSvgRings(svg: string, outer: Affine | null = null): Ring[] {
  const rings: Ring[] = [];
  for (const s of parseSvgShapes(svg, outer)) rings.push(...s.rings);
  return rings;
}

/** `width="…" height="…"` of the root `<svg>`, if present. */
export function svgSize(svg: string): { width: number; height: number } | null {
  const root = /<svg\b([^>]*)>/.exec(svg);
  if (!root) return null;
  const w = /\swidth="([^"]+)"/.exec(root[1]);
  const h = /\sheight="([^"]+)"/.exec(root[1]);
  if (!w || !h) {
    const vb = /viewBox="([^"]+)"/.exec(root[1]);
    if (!vb) return null;
    const nums = (vb[1].match(NUM_RE) ?? []).map(Number);
    return nums.length === 4 ? { width: nums[2], height: nums[3] } : null;
  }
  return { width: parseFloat(w[1]), height: parseFloat(h[1]) };
}

// ------------------------------------------------------------
// Primitives
// ------------------------------------------------------------

const KAPPA = 0.5522847498307936;

export function ellipseRing(cx: number, cy: number, rx: number, ry: number): Ring {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return {
    start: { x: cx + rx, y: cy },
    segs: [
      { kind: "C", c1: { x: cx + rx, y: cy + ky }, c2: { x: cx + kx, y: cy + ry }, to: { x: cx, y: cy + ry } },
      { kind: "C", c1: { x: cx - kx, y: cy + ry }, c2: { x: cx - rx, y: cy + ky }, to: { x: cx - rx, y: cy } },
      { kind: "C", c1: { x: cx - rx, y: cy - ky }, c2: { x: cx - kx, y: cy - ry }, to: { x: cx, y: cy - ry } },
      { kind: "C", c1: { x: cx + kx, y: cy - ry }, c2: { x: cx + rx, y: cy - ky }, to: { x: cx + rx, y: cy } },
    ],
  };
}

export function roundRectRing(
  x: number,
  y: number,
  w: number,
  h: number,
  rx: number,
  ry: number = rx,
): Ring {
  rx = Math.min(rx, w / 2);
  ry = Math.min(ry, h / 2);
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  const r = x + w;
  const b = y + h;
  return {
    start: { x: x + rx, y },
    segs: [
      { kind: "L", to: { x: r - rx, y } },
      { kind: "C", c1: { x: r - rx + kx, y }, c2: { x: r, y: y + ry - ky }, to: { x: r, y: y + ry } },
      { kind: "L", to: { x: r, y: b - ry } },
      { kind: "C", c1: { x: r, y: b - ry + ky }, c2: { x: r - rx + kx, y: b }, to: { x: r - rx, y: b } },
      { kind: "L", to: { x: x + rx, y: b } },
      { kind: "C", c1: { x: x + rx - kx, y: b }, c2: { x, y: b - ry + ky }, to: { x, y: b - ry } },
      { kind: "L", to: { x, y: y + ry } },
      { kind: "C", c1: { x, y: y + ry - ky }, c2: { x: x + rx - kx, y }, to: { x: x + rx, y } },
    ],
  };
}

/**
 * Outline of a polyline stroked with round joins/caps, as rings
 * (union of per-segment capsules). Used for stroke-style shapes.
 */
export function strokeRings(points: readonly Px[], width: number, closed = false): Ring[] {
  const r = Math.max(0.25, width / 2);
  const pts = points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 1e-6);
  if (pts.length === 0) return [];
  if (pts.length === 1) return [ellipseRing(pts[0].x, pts[0].y, r, r)];
  const segs: Ring[] = [];
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * r;
    const ny = (dx / len) * r;
    // Capsule: rectangle + end discs (even-odd between them is avoided by union).
    segs.push({
      start: { x: a.x + nx, y: a.y + ny },
      segs: [
        { kind: "L", to: { x: b.x + nx, y: b.y + ny } },
        { kind: "L", to: { x: b.x - nx, y: b.y - ny } },
        { kind: "L", to: { x: a.x - nx, y: a.y - ny } },
      ],
    });
    segs.push(ellipseRing(a.x, a.y, r, r));
  }
  if (!closed) segs.push(ellipseRing(pts[pts.length - 1].x, pts[pts.length - 1].y, r, r));
  // Union all pieces so overlaps don't cancel under even-odd.
  let acc: Ring[] = [segs[0]];
  for (let i = 1; i < segs.length; i++) acc = regionOpRings(acc, [segs[i]], BoolOp.Union);
  return acc;
}

/** Stroke outline for a closed ring (line segments + flattened curves). */
export function outlineRing(ring: Ring, width: number): Ring[] {
  return strokeRings(flattenRing(ring), width, true);
}

/** Flatten curves to a polyline (for stroke outlines / hit tests). */
export function flattenRing(ring: Ring, steps = 12): Px[] {
  const pts: Px[] = [ring.start];
  let p = ring.start;
  for (const s of ring.segs) {
    if (s.kind === "L") pts.push(s.to);
    else if (s.kind === "Q") {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        pts.push({
          x: u * u * p.x + 2 * u * t * s.c.x + t * t * s.to.x,
          y: u * u * p.y + 2 * u * t * s.c.y + t * t * s.to.y,
        });
      }
    } else {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        pts.push({
          x: u * u * u * p.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.to.x,
          y: u * u * u * p.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t * t * t * s.to.y,
        });
      }
    }
    p = s.to;
  }
  return pts;
}

// ------------------------------------------------------------
// Symmetry (world space)
// ------------------------------------------------------------

export interface SymmetryLike {
  enabled: boolean;
  mode: "vertical" | "horizontal" | "radial";
  originX: number;
  originY: number;
  radialCount: number;
}

const CLIP_EXTENT = 1e5;

/** Ring covering the source side / sector of the symmetry setup. */
export function symmetrySourceRing(s: SymmetryLike, side: number): Ring {
  const { originX: ox, originY: oy } = s;
  const R = CLIP_EXTENT;
  if (s.mode === "vertical") {
    return side >= 0
      ? { start: { x: ox, y: oy - R }, segs: [{ kind: "L", to: { x: ox + R, y: oy - R } }, { kind: "L", to: { x: ox + R, y: oy + R } }, { kind: "L", to: { x: ox, y: oy + R } }] }
      : { start: { x: ox - R, y: oy - R }, segs: [{ kind: "L", to: { x: ox, y: oy - R } }, { kind: "L", to: { x: ox, y: oy + R } }, { kind: "L", to: { x: ox - R, y: oy + R } }] };
  }
  if (s.mode === "horizontal") {
    return side >= 0
      ? { start: { x: ox - R, y: oy }, segs: [{ kind: "L", to: { x: ox + R, y: oy } }, { kind: "L", to: { x: ox + R, y: oy + R } }, { kind: "L", to: { x: ox - R, y: oy + R } }] }
      : { start: { x: ox - R, y: oy - R }, segs: [{ kind: "L", to: { x: ox + R, y: oy - R } }, { kind: "L", to: { x: ox + R, y: oy } }, { kind: "L", to: { x: ox - R, y: oy } }] };
  }
  const count = Math.max(2, s.radialCount);
  const sector = ((side % count) + count) % count;
  const a0 = (sector / count) * Math.PI * 2;
  const a1 = ((sector + 1) / count) * Math.PI * 2;
  return {
    start: { x: ox, y: oy },
    segs: [
      { kind: "L", to: { x: ox + Math.cos(a0) * R, y: oy + Math.sin(a0) * R } },
      { kind: "L", to: { x: ox + Math.cos(a1) * R, y: oy + Math.sin(a1) * R } },
    ],
  };
}

/** Transforms mapping the source piece onto every other symmetry region. */
export function symmetryTransforms(s: SymmetryLike): Affine[] {
  if (s.mode === "vertical") return [[-1, 0, 0, 1, 2 * s.originX, 0]];
  if (s.mode === "horizontal") return [[1, 0, 0, -1, 0, 2 * s.originY]];
  const count = Math.max(2, s.radialCount);
  const out: Affine[] = [];
  for (let k = 1; k < count; k++) {
    out.push(rotateAbout((k * 360) / count, { x: s.originX, y: s.originY }));
  }
  return out;
}

/**
 * Clip `rings` to the gesture's source region and mirror the result into
 * every other region. Returns rings covering all copies (even-odd union).
 */
export function expandSymmetry(rings: Ring[], s: SymmetryLike, side: number | null): Ring[] {
  if (!s.enabled || side == null || rings.length === 0) return rings;
  const clipped = regionOpRings(rings, [symmetrySourceRing(s, side)], BoolOp.Intersect);
  if (clipped.length === 0) return [];
  let acc = clipped;
  for (const m of symmetryTransforms(s)) {
    acc = regionOpRings(acc, clipped.map((r) => transformRing(r, m)), BoolOp.Union);
  }
  return acc;
}
