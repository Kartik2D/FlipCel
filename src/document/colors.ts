import type { LayerTrack } from "./document";
import { hexToRgb, rgbToHex } from "../color/spaces";

export function normalizeDocumentHex(hex: string): string {
  const trimmed = hex.trim();
  if (!trimmed) return "#000000";
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (withHash.length === 4) {
    const [, r, g, b] = withHash;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return withHash.toLowerCase();
}

function paperColorToHex(value: unknown): string | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const [r, g, b] = value;
  if (typeof r !== "number" || typeof g !== "number" || typeof b !== "number") {
    return null;
  }
  if (r > 1 || g > 1 || b > 1) {
    return normalizeDocumentHex(rgbToHex(r, g, b));
  }
  return normalizeDocumentHex(rgbToHex(r * 255, g * 255, b * 255));
}

function hexToPaperRgb(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(normalizeDocumentHex(hex));
  return [r / 255, g / 255, b / 255];
}

function collectColorsFromValue(
  value: unknown,
  out: string[],
  seen: Set<string>,
): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectColorsFromValue(item, out, seen);
    return;
  }
  if (typeof value !== "object") return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "fillColor" || key === "strokeColor") {
      const hex = paperColorToHex(child);
      if (hex && !seen.has(hex)) {
        seen.add(hex);
        out.push(hex);
      }
      continue;
    }
    collectColorsFromValue(child, out, seen);
  }
}

/** Mutate Paper JSON values, replacing matching fill/stroke colors. */
function replaceColorsInValue(
  value: unknown,
  fromHex: string,
  toRgb: [number, number, number],
): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) {
    let changed = false;
    for (const item of value) {
      if (replaceColorsInValue(item, fromHex, toRgb)) changed = true;
    }
    return changed;
  }
  if (typeof value !== "object") return false;

  let changed = false;
  const obj = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(obj)) {
    if (key === "fillColor" || key === "strokeColor") {
      const hex = paperColorToHex(child);
      if (hex === fromHex && Array.isArray(child)) {
        const next: number[] = [...toRgb];
        if (typeof child[3] === "number") next.push(child[3]);
        obj[key] = next;
        changed = true;
      }
      continue;
    }
    if (replaceColorsInValue(child, fromHex, toRgb)) changed = true;
  }
  return changed;
}

/**
 * Replace every fill/stroke matching `fromHex` with `toHex` in a Paper layer
 * JSON string. Returns the rewritten JSON, or null if nothing changed.
 */
export function replaceColorInPaperJson(
  json: string,
  fromHex: string,
  toHex: string,
): string | null {
  if (!json) return null;
  const from = normalizeDocumentHex(fromHex);
  const to = normalizeDocumentHex(toHex);
  if (from === to) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!replaceColorsInValue(parsed, from, hexToPaperRgb(to))) return null;
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

/** Extract unique fill/stroke colors from a Paper.js layer JSON string. */
export function colorsFromPaperJson(json: string): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    const out: string[] = [];
    const seen = new Set<string>();
    collectColorsFromValue(parsed, out, seen);
    return out;
  } catch {
    return [];
  }
}

/** Collect unique document colors from keyframe artwork. */
export function collectDocumentColors(
  tracks: LayerTrack[],
  content: ReadonlyMap<string, string>,
): string[] {
  const seen = new Set<string>();
  const colors: string[] = [];

  const add = (hex: string) => {
    const normalized = normalizeDocumentHex(hex);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    colors.push(normalized);
  };

  for (const track of tracks) {
    for (const kf of track.keyframes) {
      for (const color of colorsFromPaperJson(content.get(kf.contentId) ?? "")) {
        add(color);
      }
    }
  }

  return colors;
}
