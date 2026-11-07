/**
 * Library thumbnails: symbol frame 0 rendered to a small PNG data URL via
 * the stage renderer's offscreen content drawing. Cached per symbol by a
 * content signature so `publish()` stays cheap.
 */
import { coveringKeyframeOf } from "../document/keyframes";
import type { SymbolDefinition, SymbolResolver } from "../document/symbols";
import type { StageRenderer } from "./stage-renderer";
import { instanceContent } from "../vector/content";

const THUMB_SIZE = 64;
const PAD = 4;

let renderer: StageRenderer | null = null;

export function setThumbnailRenderer(r: StageRenderer | null): void {
  renderer = r;
  cache.clear();
}

/** Changes whenever frame 0 of the symbol (or its layer set) changes. */
export function symbolThumbnailSignature(symbol: SymbolDefinition): string {
  const parts: string[] = [];
  for (const t of symbol.tracks) {
    if (!t.visible) continue;
    parts.push(coveringKeyframeOf(t, 0)?.contentId ?? "");
  }
  return parts.join("|");
}

const cache = new Map<string, { sig: string; url: string | null }>();

export function clearSymbolThumbnailCache(): void {
  cache.clear();
}

export function symbolThumbnailUrl(
  symbol: SymbolDefinition,
  _resolver: SymbolResolver,
): string | null {
  const sig = symbolThumbnailSignature(symbol);
  const hit = cache.get(symbol.id);
  if (hit && hit.sig === sig) return hit.url;
  const url = renderThumbnail(symbol);
  cache.set(symbol.id, { sig, url });
  return url;
}

function renderThumbnail(symbol: SymbolDefinition): string | null {
  if (!renderer || typeof document === "undefined") return null;
  try {
    const json = instanceContent(
      { symbol: symbol.id, iid: "thumb", mode: "single", firstFrame: 0 },
      { x: 0, y: 0 },
    );
    const b = renderer.contentBounds([json]);
    if (!b || !(b.width > 0 || b.height > 0)) return null;
    const side = Math.max(b.width, b.height, 1e-6);
    const square = {
      x: b.x + b.width / 2 - side / 2,
      y: b.y + b.height / 2 - side / 2,
      width: side,
      height: side,
    };
    const inner = THUMB_SIZE - PAD * 2;
    const canvas = renderer.renderContentToCanvas([json], square, { width: inner, height: inner });
    const out = document.createElement("canvas");
    out.width = THUMB_SIZE;
    out.height = THUMB_SIZE;
    out.getContext("2d")?.drawImage(canvas, PAD, PAD);
    return out.toDataURL("image/png");
  } catch {
    return null;
  }
}
