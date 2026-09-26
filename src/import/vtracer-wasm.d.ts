declare module "virtual:vtracer-wasm" {
  export function vectorize_rgba(
    data: Uint8Array,
    width: number,
    height: number,
    options: Record<string, unknown>,
  ): string;
  export function init(input: string): Promise<unknown>;
}

