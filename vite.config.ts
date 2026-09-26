import fs from 'node:fs'
import { createRequire } from 'node:module'
import { defineConfig, type Plugin } from 'vite'

const require = createRequire(import.meta.url)

/** @visioncortex/vtracer ships wasm-pack `--target nodejs` (fs + __dirname). Rewrite to ESM fetch. */
function vtracerWasmBrowser(): Plugin {
  const virtual = 'virtual:vtracer-wasm'
  const boot = `const wasmPath = \`\${__dirname}/vtracer_wasm_bg.wasm\`;
const wasmBytes = require('fs').readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
let wasmInstance = new WebAssembly.Instance(wasmModule, __wbg_get_imports());
let wasm = wasmInstance.exports;
wasm.__wbindgen_start();`

  const init = `let wasm;
export async function init(input) {
  if (wasm) return wasm;
  const bytes = await (await fetch(input)).arrayBuffer();
  const result = await WebAssembly.instantiate(bytes, __wbg_get_imports());
  wasm = result.instance.exports;
  wasm.__wbindgen_start();
  return wasm;
}`

  return {
    name: 'vtracer-wasm-browser',
    resolveId(id) {
      if (id === virtual) return virtual
    },
    load(id) {
      if (id !== virtual) return
      const gluePath = require.resolve('@visioncortex/vtracer/pkg/vtracer_wasm.js')
      const code = fs.readFileSync(gluePath, 'utf8')
      if (!code.includes(boot)) {
        throw new Error(
          `vtracer wasm glue boot block changed; update vite.config.ts\n${code.slice(-400)}`,
        )
      }
      return (
        code
          .replace(/exports\.vectorize_bytes = vectorize_bytes;\s*/g, '')
          .replace(/exports\.vectorize_rgba = vectorize_rgba;\s*/g, '')
          .replace(boot, init) + '\nexport { vectorize_bytes, vectorize_rgba };\n'
      )
    },
  }
}

const vtracerPlugin = vtracerWasmBrowser()

// https://vitejs.dev/config/
export default defineConfig({
  // Relative so one build works on GitHub Pages (/FlipCel/) and Firebase Hosting (/).
  base: './',
  plugins: [vtracerPlugin],
  worker: {
    plugins: () => [vtracerPlugin],
  },
})
