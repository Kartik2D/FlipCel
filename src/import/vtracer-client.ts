import wasmUrl from "@visioncortex/vtracer/pkg/vtracer_wasm_bg.wasm?url";
import type { VtracerJob, VtracerResult } from "./vtracer-worker";

type Waiter = {
  resolve: (svg: string) => void;
  reject: (error: Error) => void;
};

const wasmHref = () => new URL(wasmUrl, document.baseURI).href;

class VtracerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Waiter>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./vtracer-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<VtracerResult>) => {
      const { id, svg, error } = event.data;
      const waiter = this.pending.get(id);
      this.pending.delete(id);
      if (!waiter) return;
      if (error || svg === undefined) waiter.reject(new Error(error ?? "empty trace"));
      else waiter.resolve(svg);
    };
    worker.onerror = (event) => {
      const err = new Error(event.message || "vtracer worker error");
      for (const waiter of this.pending.values()) waiter.reject(err);
      this.pending.clear();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  trace(imageData: ImageData, options: Record<string, unknown>): Promise<string> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const pixels = imageData.data.slice().buffer;
      const message: VtracerJob = {
        id,
        wasmUrl: wasmHref(),
        width: imageData.width,
        height: imageData.height,
        pixels,
        options,
      };
      try {
        this.ensureWorker().postMessage(message, [pixels]);
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}

let client: VtracerClient | null = null;

export function traceWithVtracer(
  imageData: ImageData,
  options: Record<string, unknown>,
): Promise<string> {
  if (!client) client = new VtracerClient();
  return client.trace(imageData, options);
}
