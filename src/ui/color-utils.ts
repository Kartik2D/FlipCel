/**
 * Color Utility Functions
 *
 * Conversion utilities for RGB, HEX, HSV, HSL, and OKHSL color spaces.
 * OKHSL implementation based on Björn Ottosson's work:
 * https://bottosson.github.io/posts/colorpicker/
 */

export function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((x) => {
        const hex = Math.round(x).toString(16);
        return hex.length === 1 ? "0" + hex : hex;
      })
      .join("")
  );
}

export function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? [
        parseInt(result[1], 16),
        parseInt(result[2], 16),
        parseInt(result[3], 16),
      ]
    : [0, 0, 0];
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h = 0;
  const d = max - min;
  const s = max === 0 ? 0 : d / max;
  const v = max;

  if (max !== min) {
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return [h * 360, s * 100, v * 100];
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h = h / 360;
  s = s / 100;
  v = v / 100;
  let r = 0,
    g = 0,
    b = 0;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);

  switch (i % 6) {
    case 0:
      r = v;
      g = t;
      b = p;
      break;
    case 1:
      r = q;
      g = v;
      b = p;
      break;
    case 2:
      r = p;
      g = v;
      b = t;
      break;
    case 3:
      r = p;
      g = q;
      b = v;
      break;
    case 4:
      r = t;
      g = p;
      b = v;
      break;
    case 5:
      r = v;
      g = p;
      b = q;
      break;
  }
  return [r * 255, g * 255, b * 255];
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      case b:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }
  return [h * 360, s * 100, l * 100];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = h / 360;
  s = s / 100;
  l = l / 100;

  if (s === 0) {
    const gray = l * 255;
    return [gray, gray, gray];
  }

  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = hue2rgb(p, q, h + 1 / 3);
  const g = hue2rgb(p, q, h);
  const b = hue2rgb(p, q, h - 1 / 3);

  return [r * 255, g * 255, b * 255];
}

// ============================================================
// OKHSL Color Space (Björn Ottosson)
// ============================================================

// sRGB to linear sRGB
function srgbToLinear(x: number): number {
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

// Linear sRGB to sRGB
function linearToSrgb(x: number): number {
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

// Linear sRGB to Oklab
function linearSrgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

// Oklab to linear sRGB
function oklabToLinearSrgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

// Compute maximum saturation for a given hue in Oklab
function computeMaxSaturation(a: number, b: number): number {
  let k0: number, k1: number, k2: number, k3: number, k4: number;
  let wl: number, wm: number, ws: number;

  if (-1.88170328 * a - 0.80936493 * b > 1) {
    k0 = +1.19086277; k1 = +1.76576728; k2 = +0.59662641; k3 = +0.75515197; k4 = +0.56771245;
    wl = +4.0767416621; wm = -3.3077115913; ws = +0.2309699292;
  } else if (1.81444104 * a - 1.19445276 * b > 1) {
    k0 = +0.73956515; k1 = -0.45954404; k2 = +0.08285427; k3 = +0.1254107; k4 = +0.14503204;
    wl = -1.2684380046; wm = +2.6097574011; ws = -0.3413193965;
  } else {
    k0 = +1.35733652; k1 = -0.00915799; k2 = -1.1513021; k3 = -0.50559606; k4 = +0.00692167;
    wl = -0.0041960863; wm = -0.7034186147; ws = +1.707614701;
  }

  let S = k0 + k1 * a + k2 * b + k3 * a * a + k4 * a * b;

  const k_l = +0.3963377774 * a + 0.2158037573 * b;
  const k_m = -0.1055613458 * a - 0.0638541728 * b;
  const k_s = -0.0894841775 * a - 1.291485548 * b;

  {
    const l_ = 1 + S * k_l;
    const m_ = 1 + S * k_m;
    const s_ = 1 + S * k_s;

    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;

    const l_dS = 3 * k_l * l_ * l_;
    const m_dS = 3 * k_m * m_ * m_;
    const s_dS = 3 * k_s * s_ * s_;

    const l_dS2 = 6 * k_l * k_l * l_;
    const m_dS2 = 6 * k_m * k_m * m_;
    const s_dS2 = 6 * k_s * k_s * s_;

    const f = wl * l + wm * m + ws * s;
    const f1 = wl * l_dS + wm * m_dS + ws * s_dS;
    const f2 = wl * l_dS2 + wm * m_dS2 + ws * s_dS2;

    S = S - (f * f1) / (f1 * f1 - 0.5 * f * f2);
  }

  return S;
}

// Find cusp (maximum chroma point) for a given hue
function findCusp(a: number, b: number): [number, number] {
  const S_cusp = computeMaxSaturation(a, b);
  const [r, g, b_] = oklabToLinearSrgb(1, S_cusp * a, S_cusp * b);
  const L_cusp = Math.cbrt(1 / Math.max(r, g, b_));
  const C_cusp = L_cusp * S_cusp;
  return [L_cusp, C_cusp];
}

// Toe function for perceptual lightness
function toe(x: number): number {
  const k_1 = 0.206;
  const k_2 = 0.03;
  const k_3 = (1 + k_1) / (1 + k_2);
  return 0.5 * (k_3 * x - k_1 + Math.sqrt((k_3 * x - k_1) * (k_3 * x - k_1) + 4 * k_2 * k_3 * x));
}

function toeInv(x: number): number {
  const k_1 = 0.206;
  const k_2 = 0.03;
  const k_3 = (1 + k_1) / (1 + k_2);
  return (x * x + k_1 * x) / (k_3 * (x + k_2));
}

// Finds intersection of the line L = L0*(1-t)+t*L1, C = t*C1 with the sRGB gamut.
// a,b must be normalised (a^2+b^2 = 1). Ported directly from Björn Ottosson's reference.
function findGamutIntersection(
  a: number,
  b: number,
  L1: number,
  C1: number,
  L0: number,
  cusp: [number, number],
): number {
  let t: number;
  if ((L1 - L0) * cusp[1] - (cusp[0] - L0) * C1 <= 0) {
    t = (cusp[1] * L0) / (C1 * cusp[0] + cusp[1] * (L0 - L1));
  } else {
    t = (cusp[1] * (L0 - 1)) / (C1 * (cusp[0] - 1) + cusp[1] * (L0 - L1));

    const dL = L1 - L0;
    const dC = C1;

    const k_l = +0.3963377774 * a + 0.2158037573 * b;
    const k_m = -0.1055613458 * a - 0.0638541728 * b;
    const k_s = -0.0894841775 * a - 1.291485548 * b;

    const l_dt = dL + dC * k_l;
    const m_dt = dL + dC * k_m;
    const s_dt = dL + dC * k_s;

    const L = L0 * (1 - t) + t * L1;
    const C = t * C1;

    const l_ = L + C * k_l;
    const m_ = L + C * k_m;
    const s_ = L + C * k_s;

    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;

    const ldt = 3 * l_dt * l_ * l_;
    const mdt = 3 * m_dt * m_ * m_;
    const sdt = 3 * s_dt * s_ * s_;

    const ldt2 = 6 * l_dt * l_dt * l_;
    const mdt2 = 6 * m_dt * m_dt * m_;
    const sdt2 = 6 * s_dt * s_dt * s_;

    const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s - 1;
    const r1 = 4.0767416621 * ldt - 3.3077115913 * mdt + 0.2309699292 * sdt;
    const r2 = 4.0767416621 * ldt2 - 3.3077115913 * mdt2 + 0.2309699292 * sdt2;
    const u_r = r1 / (r1 * r1 - 0.5 * r * r2);
    let t_r = -r * u_r;

    const gG = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s - 1;
    const g1 = -1.2684380046 * ldt + 2.6097574011 * mdt - 0.3413193965 * sdt;
    const g2 = -1.2684380046 * ldt2 + 2.6097574011 * mdt2 - 0.3413193965 * sdt2;
    const u_g = g1 / (g1 * g1 - 0.5 * gG * g2);
    let t_g = -gG * u_g;

    const bB = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s - 1;
    const b1 = -0.0041960863 * ldt - 0.7034186147 * mdt + 1.707614701 * sdt;
    const b2 = -0.0041960863 * ldt2 - 0.7034186147 * mdt2 + 1.707614701 * sdt2;
    const u_b = b1 / (b1 * b1 - 0.5 * bB * b2);
    let t_b = -bB * u_b;

    t_r = u_r >= 0 ? t_r : 1e5;
    t_g = u_g >= 0 ? t_g : 1e5;
    t_b = u_b >= 0 ? t_b : 1e5;

    t += Math.min(t_r, Math.min(t_g, t_b));
  }
  return t;
}

function getStMax(cusp: [number, number]): [number, number] {
  return [cusp[1] / cusp[0], cusp[1] / (1 - cusp[0])];
}

// Returns the three control chroma values (C_0, C_mid, C_max) used by OKHSL.
function getCs(L: number, a_: number, b_: number): [number, number, number] {
  const cusp = findCusp(a_, b_);
  const C_max = findGamutIntersection(a_, b_, L, 1, L, cusp);
  const [S_max, T_max] = getStMax(cusp);

  const S_mid =
    0.11516993 +
    1 /
      (7.4477897 +
        4.1590124 * b_ +
        a_ *
          (-2.19557347 +
            1.75198401 * b_ +
            a_ *
              (-2.13704948 -
                10.02301043 * b_ +
                a_ * (-4.24894561 + 5.38770819 * b_ + 4.69891013 * a_))));

  const T_mid =
    0.11239642 +
    1 /
      (1.6132032 -
        0.68124379 * b_ +
        a_ *
          (0.40370612 +
            0.90148123 * b_ +
            a_ *
              (-0.27087943 +
                0.6122399 * b_ +
                a_ * (0.00299215 - 0.45399568 * b_ - 0.14661872 * a_))));

  const k = C_max / Math.min(L * S_max, (1 - L) * T_max);

  let C_mid: number;
  {
    const C_a = L * S_mid;
    const C_b = (1 - L) * T_mid;
    C_mid =
      0.9 *
      k *
      Math.sqrt(Math.sqrt(1 / (1 / (C_a * C_a * C_a * C_a) + 1 / (C_b * C_b * C_b * C_b))));
  }

  let C_0: number;
  {
    const C_a = L * 0.4;
    const C_b = (1 - L) * 0.8;
    C_0 = Math.sqrt(1 / (1 / (C_a * C_a) + 1 / (C_b * C_b)));
  }

  return [C_0, C_mid, C_max];
}

// OKHSL → sRGB (faithful port of Björn Ottosson's reference)
export function okhslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = h / 360;
  s = s / 100;
  l = l / 100;

  if (l >= 1) return [255, 255, 255];
  if (l <= 0) return [0, 0, 0];

  const a_ = Math.cos(2 * Math.PI * h);
  const b_ = Math.sin(2 * Math.PI * h);
  const L = toeInv(l);

  const [C_0, C_mid, C_max] = getCs(L, a_, b_);

  let C: number;
  let t: number, k_0: number, k_1: number, k_2: number;
  if (s < 0.8) {
    t = 1.25 * s;
    k_0 = 0;
    k_1 = 0.8 * C_0;
    k_2 = 1 - k_1 / C_mid;
  } else {
    t = 5 * (s - 0.8);
    k_0 = C_mid;
    k_1 = (0.2 * C_mid * C_mid * 1.25 * 1.25) / C_0;
    k_2 = 1 - k_1 / (C_max - C_mid);
  }

  C = k_0 + (t * k_1) / (1 - k_2 * t);

  const [r_lin, g_lin, b_lin] = oklabToLinearSrgb(L, C * a_, C * b_);
  return [
    Math.round(Math.max(0, Math.min(1, linearToSrgb(r_lin))) * 255),
    Math.round(Math.max(0, Math.min(1, linearToSrgb(g_lin))) * 255),
    Math.round(Math.max(0, Math.min(1, linearToSrgb(b_lin))) * 255),
  ];
}

export function rgbToOkhsl(r: number, g: number, b: number): [number, number, number] {
  const [L, a, b_raw] = linearSrgbToOklab(
    srgbToLinear(r / 255),
    srgbToLinear(g / 255),
    srgbToLinear(b / 255),
  );

  const C = Math.sqrt(a * a + b_raw * b_raw);
  const a_ = C > 0 ? a / C : 1;
  const b_ = C > 0 ? b_raw / C : 0;

  const h = 0.5 + (0.5 * Math.atan2(-b_raw, -a)) / Math.PI;

  if (C < 1e-4) {
    return [h * 360, 0, toe(L) * 100];
  }

  const [C_0, C_mid, C_max] = getCs(L, a_, b_);

  let s: number;
  if (C < C_mid) {
    const k_0 = 0;
    const k_1 = 0.8 * C_0;
    const k_2 = 1 - k_1 / C_mid;
    const t = (C - k_0) / (k_1 + k_2 * (C - k_0));
    s = t * 0.8;
  } else {
    const k_0 = C_mid;
    const k_1 = (0.2 * C_mid * C_mid * 1.25 * 1.25) / C_0;
    const k_2 = 1 - k_1 / (C_max - C_mid);
    const t = (C - k_0) / (k_1 + k_2 * (C - k_0));
    s = 0.8 + 0.2 * t;
  }

  return [h * 360, Math.max(0, Math.min(1, s)) * 100, toe(L) * 100];
}

// ============================================================
// OKHSV Color Space (Björn Ottosson)
// ============================================================

export function okhsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h = h / 360;
  s = s / 100;
  v = v / 100;

  if (v <= 0) return [0, 0, 0];

  const a_ = Math.cos(2 * Math.PI * h);
  const b_ = Math.sin(2 * Math.PI * h);

  const cusp = findCusp(a_, b_);
  const [S_max, T] = getStMax(cusp);
  const S_0 = 0.5;
  const k = 1 - S_0 / S_max;

  const L_v = 1 - (s * S_0) / (S_0 + T - T * k * s);
  const C_v = (s * T * S_0) / (S_0 + T - T * k * s);

  let L = v * L_v;
  let C = v * C_v;

  const L_vt = toeInv(L_v);
  const C_vt = L_v > 0 ? (C_v * L_vt) / L_v : 0;

  const L_new = toeInv(L);
  C = L > 0 ? (C * L_new) / L : 0;
  L = L_new;

  const [rs, gs, bs] = oklabToLinearSrgb(L_vt, a_ * C_vt, b_ * C_vt);
  const scale_L = Math.cbrt(1 / Math.max(rs, gs, bs, 0));

  L *= scale_L;
  C *= scale_L;

  const [r_lin, g_lin, b_lin] = oklabToLinearSrgb(L, C * a_, C * b_);
  return [
    Math.round(Math.max(0, Math.min(1, linearToSrgb(r_lin))) * 255),
    Math.round(Math.max(0, Math.min(1, linearToSrgb(g_lin))) * 255),
    Math.round(Math.max(0, Math.min(1, linearToSrgb(b_lin))) * 255),
  ];
}

export function rgbToOkhsv(r: number, g: number, b: number): [number, number, number] {
  const [L_raw, a, b_val] = linearSrgbToOklab(
    srgbToLinear(r / 255),
    srgbToLinear(g / 255),
    srgbToLinear(b / 255),
  );

  let C = Math.sqrt(a * a + b_val * b_val);
  let L = L_raw;
  const h = 0.5 + (0.5 * Math.atan2(-b_val, -a)) / Math.PI;

  if (C < 1e-4) {
    return [h * 360, 0, toe(L) * 100];
  }

  const a_ = a / C;
  const b_ = b_val / C;

  const cusp = findCusp(a_, b_);
  const [S_max, T] = getStMax(cusp);
  const S_0 = 0.5;
  const k = 1 - S_0 / S_max;

  const t = T / (C + L * T);
  const L_v = t * L;
  const C_v = t * C;

  const L_vt = toeInv(L_v);
  const C_vt = L_v > 0 ? (C_v * L_vt) / L_v : 0;

  const [rs, gs, bs] = oklabToLinearSrgb(L_vt, a_ * C_vt, b_ * C_vt);
  const scale_L = Math.cbrt(1 / Math.max(rs, gs, bs, 0));

  L /= scale_L;
  C /= scale_L;

  C = L > 0 ? (C * toe(L)) / L : 0;
  L = toe(L);

  const v = L_v > 0 ? L / L_v : 0;
  const s = ((S_0 + T) * C_v) / (T * S_0 + T * k * C_v);

  return [h * 360, Math.max(0, Math.min(1, s)) * 100, Math.max(0, Math.min(1, v)) * 100];
}

// ============================================================
// Color-space adapter layer (generic picker)
// ============================================================

export type ColorSpaceId = "hsv" | "hsl" | "okhsl" | "okhsv";

export interface ChannelMeta {
  id: string;
  label: string;
  min: number;
  max: number;
  cyclic?: boolean;
}

export type ChannelValues = Record<string, number>;

export interface ColorSpaceAdapter {
  id: ColorSpaceId;
  label: string;
  channels: ChannelMeta[];
  defaultPlaneX: string;
  defaultPlaneY: string;
  fromHex(hex: string): ChannelValues;
  toRgb(values: ChannelValues): [number, number, number];
}

export function clampChannelValues(adapter: ColorSpaceAdapter, values: ChannelValues): ChannelValues {
  const out: ChannelValues = {};
  for (const ch of adapter.channels) {
    let v = values[ch.id] ?? (ch.min + ch.max) / 2;
    if (ch.cyclic && ch.min === 0 && ch.max === 360) {
      v = ((v % 360) + 360) % 360;
    } else {
      v = Math.max(ch.min, Math.min(ch.max, v));
    }
    out[ch.id] = v;
  }
  return out;
}

export function valuesToHex(adapter: ColorSpaceAdapter, values: ChannelValues): string {
  const [r, g, b] = adapter.toRgb(clampChannelValues(adapter, values));
  return rgbToHex(r, g, b);
}

export const hsvAdapter: ColorSpaceAdapter = {
  id: "hsv", label: "HSV",
  channels: [
    { id: "h", label: "Hue", min: 0, max: 360, cyclic: true },
    { id: "s", label: "Saturation", min: 0, max: 100 },
    { id: "v", label: "Value", min: 0, max: 100 },
  ],
  defaultPlaneX: "s", defaultPlaneY: "v",
  fromHex(hex) { const rgb = hexToRgb(hex); const [h, s, v] = rgbToHsv(...rgb); return { h, s, v }; },
  toRgb(v) { return hsvToRgb(v.h ?? 0, v.s ?? 0, v.v ?? 0); },
};

export const hslAdapter: ColorSpaceAdapter = {
  id: "hsl", label: "HSL",
  channels: [
    { id: "h", label: "Hue", min: 0, max: 360, cyclic: true },
    { id: "s", label: "Saturation", min: 0, max: 100 },
    { id: "l", label: "Lightness", min: 0, max: 100 },
  ],
  defaultPlaneX: "h", defaultPlaneY: "l",
  fromHex(hex) { const rgb = hexToRgb(hex); const [h, s, l] = rgbToHsl(...rgb); return { h, s, l }; },
  toRgb(v) { return hslToRgb(v.h ?? 0, v.s ?? 0, v.l ?? 0); },
};

export const okhslAdapter: ColorSpaceAdapter = {
  id: "okhsl", label: "OKHSL",
  channels: [
    { id: "h", label: "Hue", min: 0, max: 360, cyclic: true },
    { id: "s", label: "Saturation", min: 0, max: 100 },
    { id: "l", label: "Lightness", min: 0, max: 100 },
  ],
  defaultPlaneX: "h", defaultPlaneY: "l",
  fromHex(hex) { const rgb = hexToRgb(hex); const [h, s, l] = rgbToOkhsl(...rgb); return { h, s, l }; },
  toRgb(v) { return okhslToRgb(v.h ?? 0, v.s ?? 0, v.l ?? 0); },
};

export const okhsvAdapter: ColorSpaceAdapter = {
  id: "okhsv", label: "OKHSV",
  channels: [
    { id: "h", label: "Hue", min: 0, max: 360, cyclic: true },
    { id: "s", label: "Saturation", min: 0, max: 100 },
    { id: "v", label: "Value", min: 0, max: 100 },
  ],
  defaultPlaneX: "h", defaultPlaneY: "v",
  fromHex(hex) { const rgb = hexToRgb(hex); const [h, s, v] = rgbToOkhsv(...rgb); return { h, s, v }; },
  toRgb(v) { return okhsvToRgb(v.h ?? 0, v.s ?? 0, v.v ?? 0); },
};

export const COLOR_SPACE_ADAPTERS: Record<ColorSpaceId, ColorSpaceAdapter> = {
  hsv: hsvAdapter, hsl: hslAdapter, okhsl: okhslAdapter, okhsv: okhsvAdapter,
};

export function getColorSpaceAdapter(id: ColorSpaceId): ColorSpaceAdapter {
  return COLOR_SPACE_ADAPTERS[id];
}

