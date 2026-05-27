// Loader for the PARI/GP WASM module (@sagemath/pari) inside a Cloudflare Worker.
// We import the wasm as a precompiled WebAssembly.Module and hand it to the
// emscripten glue via `instantiateWasm`, so the glue never touches fetch/fs.
//
// @ts-expect-error - emscripten CJS glue, no type declarations
import createPariModule from '@sagemath/pari/dist/gp-sta.js'
// @ts-expect-error - wrangler imports .wasm as a compiled WebAssembly.Module
import wasmModule from '@sagemath/pari/dist/gp-sta.wasm'

// PARI stack size. Even the rank-28 record curve verifies in <4MB, and Workers
// cap total memory at 128MB, so 64MB is comfortable with huge headroom.
const PARI_SIZE = 64 * 1024 * 1024

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
