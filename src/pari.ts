// Loader for the PARI/GP WASM module (@sagemath/pari) inside a Cloudflare Worker.
// We import the wasm as a precompiled WebAssembly.Module and hand it to the
// emscripten glue via `instantiateWasm`, so the glue never touches fetch/fs.
//
// @ts-expect-error - emscripten CJS glue, no type declarations
import createPariModule from '@sagemath/pari/dist/gp-sta.js'
// Patched copy of the upstream wasm: its memory is pinned to 64MB instead of the
// stock 2GB, which a Worker can't allocate (128MB cap). See scripts/patch-wasm.mjs.
// @ts-expect-error - wrangler imports .wasm as a compiled WebAssembly.Module
import wasmModule from './gp-sta.wasm'

// PARI stack size (used for both parisize and parisizemax — the embedded build
// requires them equal). gp_embedded_init uses ~2x this within the wasm's 64MB
// linear memory (see patch-wasm.mjs), so it must stay well under 32MB. 16MB
// verifies the rank-28 record curve with comfortable headroom (it needs <8MB).
const PARI_SIZE = 16 * 1024 * 1024

export type Gp = (cmd: string) => string

async function init(): Promise<Gp> {
  // The glue takes a Node branch (process exists under nodejs_compat) that
  // references __dirname only to locate the wasm — which we override below.
  // A bare __dirname resolves through the global object, so a dummy suffices.
  ;(globalThis as Record<string, unknown>).__dirname = '/'

  const mod = await createPariModule({
    noInitialRun: true,
    print: () => {},
    printErr: () => {},
    instantiateWasm(
      imports: WebAssembly.Imports,
      receiveInstance: (inst: WebAssembly.Instance, mod?: WebAssembly.Module) => void,
    ) {
      const instance = new WebAssembly.Instance(wasmModule as WebAssembly.Module, imports)
      receiveInstance(instance, wasmModule as WebAssembly.Module)
      return instance.exports
    },
  })
  mod.ccall('gp_embedded_init', null, ['number', 'number'], [PARI_SIZE, PARI_SIZE])
  return mod.cwrap('gp_embedded', 'string', ['string']) as Gp
}

let cached: Promise<Gp> | null = null

// Lazily initialize once per isolate and reuse across requests.
export function getGp(): Promise<Gp> {
  if (!cached) cached = init()
  return cached
}
