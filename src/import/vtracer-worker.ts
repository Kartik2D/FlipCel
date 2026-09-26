import { init, vectorize_rgba } from "virtual:vtracer-wasm";

export type VtracerJob = {
  id: number;
  wasmUrl: string;
  width: number;
  height: number;
  pixels: ArrayBuffer;
  options: Record<string, unknown>;
};

export type VtracerResult = {
  id: number;
  svg?: string;
  error?: string;
};

let wasmReady: Promise<unknown> | null = null;

function ensureWasm(wasmUrl: string): Promise<unknown> {
  if (!wasmReady) wasmReady = init(wasmUrl);
  return wasmReady;
}

onmessage = async (event: MessageEvent<VtracerJob>) => {
  const { id, wasmUrl, width, height, pixels, options } = event.data;
  try {
    await ensureWasm(wasmUrl);
    const svg = vectorize_rgba(new Uint8Array(pixels), width, height, options);
    postMessage({ id, svg } satisfies VtracerResult);
  } catch (error) {
    postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies VtracerResult);
  }
};
