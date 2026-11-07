/**
 * Bundled demo documents for the welcome panel. The Paper-era examples were
 * dropped with the kernel rewrite (v4 content); "New" creates a blank
 * document — see TimelineSession.onDocNew.
 */
import type { SerializedDocument } from "./document";

export const EXAMPLE_DOCUMENTS: readonly {
  id: string;
  label: string;
  document: SerializedDocument;
}[] = [];
