/**
 * Persistence — JSON document export + IndexedDB restore slot
 *
 * Documents are plain versioned JSON. File → Save JSON downloads the payload
 * and writes the same object to IndexedDB for startup “Restore previous file”.
 */
import type {
  AssetMeta,
  LayerTrack,
  SerializedDocument,
  SymbolDefinition,
} from "./document";
import { trackKind } from "./document";
import { normalizeSymbol } from "./symbols";
import { DEFAULT_STAGE_HEIGHT, DEFAULT_STAGE_WIDTH } from "../state/index";
import { AUTOSAVE_KEY, DOC_STORE, openDatabase } from "./assets";

// ============================================================
// Validation
// ============================================================

function parseAssetRecord(
  raw: unknown,
): Record<string, AssetMeta> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, AssetMeta> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || !value || typeof value !== "object") continue;
    const item = value as Partial<AssetMeta>;
    if (typeof item.name !== "string" || typeof item.mime !== "string") continue;
    out[id] = {
      name: item.name,
      mime: item.mime,
      size: Number(item.size) || 0,
      ...(typeof item.width === "number" ? { width: item.width } : {}),
      ...(typeof item.height === "number" ? { height: item.height } : {}),
      ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeTrack(track: LayerTrack): LayerTrack {
  const kind = trackKind(track);
  const audio =
    kind === "audio" && track.audio && typeof track.audio.assetId === "string"
      ? {
          assetId: track.audio.assetId,
          startFrame: Math.round(Number(track.audio.startFrame) || 0),
        }
      : undefined;
  return {
    ...track,
    kind,
    locked: !!track.locked,
    visible: track.visible !== false,
    ...(audio ? { audio } : { audio: undefined }),
  };
}

/**
 * Structural validation for untrusted payloads (files, old autosaves).
 * Returns the typed document or throws with a readable message.
 */
export function parseSerializedDocument(data: unknown): SerializedDocument {
  if (typeof data === "string") data = JSON.parse(data);
  if (typeof data !== "object" || data === null) {
    throw new Error("Not a document (expected a JSON object)");
  }
  const doc = data as Partial<SerializedDocument>;
  if (doc.version !== 4) {
    throw new Error(
      `Unsupported document version: ${String(doc.version)} (FlipCel now saves kernel documents, v4)`,
    );
  }
  if (!Array.isArray(doc.tracks) || typeof doc.content !== "object" || doc.content === null) {
    throw new Error("Malformed document (missing tracks/content)");
  }
  for (const track of doc.tracks) {
    if (typeof track?.id !== "string" || !Array.isArray(track?.keyframes)) {
      throw new Error("Malformed document (bad layer track)");
    }
  }
  const assets = parseAssetRecord(doc.assets);
  const symbols: Record<string, SymbolDefinition> = {};
  if (doc.symbols && typeof doc.symbols === "object") {
    for (const [key, raw] of Object.entries(doc.symbols)) {
      const sym = normalizeSymbol(raw, key);
      if (sym) symbols[sym.id] = sym;
    }
  }
  const palette = Array.isArray(doc.palette)
    ? doc.palette.filter((c): c is string => typeof c === "string")
    : [];
  return {
    version: 4,
    palette,
    stage: {
      width: Number(doc.stage?.width) || DEFAULT_STAGE_WIDTH,
      height: Number(doc.stage?.height) || DEFAULT_STAGE_HEIGHT,
      color: typeof doc.stage?.color === "string" ? doc.stage.color : "#ffffff",
    },
    frameRate: Number(doc.frameRate) || 12,
    duration: Number(doc.duration) || 1,
    tracks: doc.tracks.map((track) => normalizeTrack(track)),
    content: doc.content as Record<string, string>,
    ...(typeof doc.name === "string" && doc.name.trim()
      ? { name: doc.name.trim() }
      : {}),
    ...(Array.isArray(doc.tags) ? { tags: doc.tags } : {}),
    ...(assets ? { assets } : {}),
    ...(Object.keys(symbols).length > 0 ? { symbols } : {}),
  };
}

// ============================================================
// JSON export / open
// ============================================================

export function downloadDocument(doc: SerializedDocument, filename?: string): void {
  const json = JSON.stringify(doc);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename ?? `flipcel-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export type PickedDocumentFile = {
  doc: SerializedDocument;
  filename: string;
};

/**
 * Open a file picker and resolve with the parsed document + filename, or null
 * when the user cancels.
 */
export function pickDocumentFile(): Promise<PickedDocumentFile | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.style.display = "none";
    document.body.appendChild(input);

    const cleanup = () => input.remove();

    input.addEventListener("change", () => {
      const file = input.files?.[0];
      cleanup();
      if (!file) {
        resolve(null);
        return;
      }
      file
        .text()
        .then((text) =>
          resolve({
            doc: parseSerializedDocument(text),
            filename: file.name || "Untitled.json",
          }),
        )
        .catch(reject);
    });
    // Cancel: resolve null when focus returns without a change event.
    input.addEventListener("cancel", () => {
      cleanup();
      resolve(null);
    });

    input.click();
  });
}

// ============================================================
// IndexedDB autosave
// ============================================================

export async function saveAutosave(doc: SerializedDocument): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DOC_STORE, "readwrite");
      tx.objectStore(DOC_STORE).put(doc, AUTOSAVE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadAutosave(): Promise<SerializedDocument | null> {
  const db = await openDatabase();
  try {
    const raw = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(DOC_STORE, "readonly");
      const request = tx.objectStore(DOC_STORE).get(AUTOSAVE_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!raw) return null;
    return parseSerializedDocument(raw);
  } finally {
    db.close();
  }
}

export async function clearAutosave(): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DOC_STORE, "readwrite");
      tx.objectStore(DOC_STORE).delete(AUTOSAVE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
