/**
 * Persistence — .inkwell files + IndexedDB autosave
 *
 * The file format is the serialized document model (JSON, versioned).
 * Autosave writes the same payload to IndexedDB (structured clone, no
 * stringify cost, no localStorage size cap) debounced from history snapshots.
 */
import type { SerializedDocument } from "./document";
import { DEFAULT_STAGE_HEIGHT, DEFAULT_STAGE_WIDTH } from "./stores";

const DB_NAME = "inkwell";
const DB_VERSION = 1;
const STORE_NAME = "documents";
const AUTOSAVE_KEY = "autosave";

export const INKWELL_FILE_EXTENSION = ".inkwell";

// ============================================================
// Validation
// ============================================================

/**
 * Structural validation for untrusted payloads (files, old autosaves).
 * Returns the typed document or throws with a readable message.
 */
export function parseSerializedDocument(data: unknown): SerializedDocument {
  if (typeof data === "string") data = JSON.parse(data);
  if (typeof data !== "object" || data === null) {
    throw new Error("Not an Inkwell document (expected a JSON object)");
  }
  const doc = data as Partial<SerializedDocument>;
  if (doc.version !== 1) {
    throw new Error(`Unsupported document version: ${String(doc.version)}`);
  }
  if (!Array.isArray(doc.tracks) || typeof doc.content !== "object" || doc.content === null) {
    throw new Error("Malformed Inkwell document (missing tracks/content)");
  }
  for (const track of doc.tracks) {
    if (typeof track?.id !== "string" || !Array.isArray(track?.keyframes)) {
      throw new Error("Malformed Inkwell document (bad layer track)");
    }
  }
  return {
    version: 1,
    stage: {
      width: Number(doc.stage?.width) || DEFAULT_STAGE_WIDTH,
      height: Number(doc.stage?.height) || DEFAULT_STAGE_HEIGHT,
      color: typeof doc.stage?.color === "string" ? doc.stage.color : "#ffffff",
    },
    frameRate: Number(doc.frameRate) || 12,
    duration: Number(doc.duration) || 1,
    tracks: doc.tracks,
    content: doc.content as Record<string, string>,
  };
}

// ============================================================
// File save / open
// ============================================================

export function downloadDocument(doc: SerializedDocument, filename?: string): void {
  const json = JSON.stringify(doc);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename ?? `inkwell-${Date.now()}${INKWELL_FILE_EXTENSION}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Open a file picker and resolve with the parsed document, or null when the
 * user cancels.
 */
export function pickDocumentFile(): Promise<SerializedDocument | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `${INKWELL_FILE_EXTENSION},application/json`;
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
        .then((text) => resolve(parseSerializedDocument(text)))
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

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveAutosave(doc: SerializedDocument): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(doc, AUTOSAVE_KEY);
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
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(AUTOSAVE_KEY);
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
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(AUTOSAVE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Debounce helper for autosave-on-snapshot. */
export function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
}
