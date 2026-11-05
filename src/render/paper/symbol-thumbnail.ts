/**
 * Library thumbnails: symbol frame 0 rendered to a small SVG data URL in a
 * reusable offscreen PaperScope. Cached per symbol by a content signature so
 * `publish()` stays cheap.
 */
import paper from "paper";
import { coveringKeyframeOf } from "../../document/keyframes";
import type { SymbolDefinition, SymbolResolver } from "../../document/symbols";
import {
  clearSymbolTemplateCache,
  createInstance,
  hydrateInstance,
} from "./symbol-instances";

const THUMB_SIZE = 64;
const PAD = 4;

let scratch: paper.PaperScope | null = null;
function scratchScope(): paper.PaperScope | null {
  if (scratch) return scratch;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("hidpi", "off");
  canvas.width = THUMB_SIZE;
  canvas.height = THUMB_SIZE;
  const scope = new paper.PaperScope();
  scope.setup(canvas);
  scope.settings.applyMatrix = true;
  scratch = scope;
  return scope;
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

/**
 * Cached SVG data URL for a symbol's first frame, or null when empty. Nested
 * symbols are rendered through `resolver`; the parent thumbnail refreshes
 * only when its own frame 0 changes.
 */
export function symbolThumbnailUrl(
  symbol: SymbolDefinition,
  resolver: SymbolResolver,
): string | null {
  const sig = symbolThumbnailSignature(symbol);
  const hit = cache.get(symbol.id);
  if (hit && hit.sig === sig) return hit.url;
  const url = renderThumbnail(symbol, resolver);
  cache.set(symbol.id, { sig, url });
  return url;
}

function renderThumbnail(symbol: SymbolDefinition, resolver: SymbolResolver): string | null {
  const mainScope = paper;
  const scope = scratchScope();
  if (!scope) return null;
  try {
    scope.activate();
    scope.project.clear();
    const layer = new scope.Layer();
    const inst = createInstance(
      { symbol: symbol.id, iid: "thumb", mode: "single", firstFrame: 0 },
      { x: 0, y: 0 },
      scope,
    );
    layer.addChild(inst);
    hydrateInstance(inst, resolver, 0, scope);
    const b = inst.bounds;
    if (!b || !(b.width > 0 || b.height > 0)) return null;
    const scale = (THUMB_SIZE - PAD * 2) / Math.max(b.width, b.height, 1e-6);
    inst.scale(scale, b.center);
    const nb = inst.bounds;
    inst.translate(new scope.Point(THUMB_SIZE / 2 - nb.center.x, THUMB_SIZE / 2 - nb.center.y));
    const svg = scope.project.exportSVG({
      bounds: new scope.Rectangle(0, 0, THUMB_SIZE, THUMB_SIZE),
      matrix: new scope.Matrix(),
      asString: true,
      precision: 2,
    }) as string;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  } catch {
    return null;
  } finally {
    scope.project.clear();
    clearSymbolTemplateCache(scope);
    mainScope.activate();
  }
}
