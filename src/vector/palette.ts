/**
 * Palette — document-level color table. Kernel faces carry a fill id;
 * id `n` (n ≥ 1) is `colors[n - 1]`. Id 0 is empty (unfilled).
 */
import { EMPTY_FILL } from "./kernel";

export function normalizeHex(hex: string): string {
  const t = hex.trim().toLowerCase();
  if (!t) return "#000000";
  const h = t.startsWith("#") ? t : `#${t}`;
  if (h.length === 4) return `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  if (h.length === 5) return `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  if (h.length === 9) return h.slice(0, 7);
  return h.length === 7 ? h : "#000000";
}

/** Accept `rgb(...)` / `#rgb` / `#rrggbb` → `#rrggbb`. */
export function cssToHex(css: string): string {
  const s = css.trim().toLowerCase();
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(s);
  if (m) {
    const c = (v: string) => Math.max(0, Math.min(255, Math.round(parseFloat(v)))).toString(16).padStart(2, "0");
    return `#${c(m[1])}${c(m[2])}${c(m[3])}`;
  }
  const ms = /^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(s);
  if (ms) {
    const c = (v: string) => Math.max(0, Math.min(255, Math.round(parseFloat(v)))).toString(16).padStart(2, "0");
    return `#${c(ms[1])}${c(ms[2])}${c(ms[3])}`;
  }
  if (s === "black") return "#000000";
  if (s === "white") return "#ffffff";
  return normalizeHex(s);
}

export class Palette {
  private colors: string[] = [];
  private index = new Map<string, number>();

  constructor(colors: readonly string[] = []) {
    this.reset(colors);
  }

  /** Replace the table (document load). Ids are positional. */
  reset(colors: readonly string[]): void {
    this.colors = [];
    this.index.clear();
    for (const c of colors) {
      const hex = normalizeHex(c);
      this.colors.push(hex);
      if (!this.index.has(hex)) this.index.set(hex, this.colors.length);
    }
  }

  /** Rename an entry in place (document-wide recolor). */
  rename(fill: number, hex: string): boolean {
    const n = normalizeHex(hex);
    const i = fill - 1;
    if (i < 0 || i >= this.colors.length || this.colors[i] === n) return false;
    const prev = this.colors[i];
    this.colors[i] = n;
    // Rebuild the lookup: first id wins per hex.
    this.index.clear();
    this.colors.forEach((c, k) => {
      if (!this.index.has(c)) this.index.set(c, k + 1);
    });
    void prev;
    return true;
  }

  /** `[duplicateId, canonicalId]` pairs for entries that share a hex. */
  duplicatePairs(): Array<readonly [number, number]> {
    const out: Array<readonly [number, number]> = [];
    this.colors.forEach((c, k) => {
      const canonical = this.index.get(c);
      if (canonical != null && canonical !== k + 1) out.push([k + 1, canonical] as const);
    });
    return out;
  }

  private push(hex: string): number {
    this.colors.push(hex);
    const id = this.colors.length;
    if (!this.index.has(hex)) this.index.set(hex, id);
    return id;
  }

  /** Fill id for a color, adding it when new. */
  fillFor(hex: string): number {
    const n = normalizeHex(hex);
    return this.index.get(n) ?? this.push(n);
  }

  /** Existing fill id or null. */
  lookup(hex: string): number | null {
    return this.index.get(normalizeHex(hex)) ?? null;
  }

  colorOf(fill: number): string | null {
    if (fill === EMPTY_FILL) return null;
    return this.colors[fill - 1] ?? null;
  }

  size(): number {
    return this.colors.length;
  }

  toJSON(): string[] {
    return [...this.colors];
  }

  /** Ids used by `hexes`, in palette order. */
  idsOf(hexes: Iterable<string>): number[] {
    const out: number[] = [];
    for (const h of hexes) {
      const id = this.lookup(h);
      if (id != null) out.push(id);
    }
    return out;
  }
}
