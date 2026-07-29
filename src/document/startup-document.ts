/**
 * Bundled demo document shown on first launch (no autosave yet).
 * "New" still creates a blank document — see TimelineSession.onDocNew.
 */
import raw from "./startup.json";
import { parseSerializedDocument } from "./persistence";
import type { SerializedDocument } from "./document";

export const STARTUP_DOCUMENT: SerializedDocument = parseSerializedDocument(raw);
