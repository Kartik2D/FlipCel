import type { LayerTrack } from "./document";

function rgbToHex(r: number, g: number, b: number): string {
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

function normalizeHex(hex: string): string {
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
    return normalizeHex(rgbToHex(r, g, b));
  }
  return normalizeHex(rgbToHex(r * 255, g * 255, b * 255));
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
    const normalized = normalizeHex(hex);
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
