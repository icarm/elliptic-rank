// Loader for the project's PARI/GP WASM build inside a Cloudflare Worker.
// src/gp-sta.{js,wasm} are built from upstream PARI 2.17.2 by
// scripts/build-pari-wasm.sh, with linear memory fixed at 64MB at link time
// (a Worker isolate is capped at 128MB, and an unbounded/2GB memory section
// gets the isolate killed on instantiation). We import the wasm as a
// precompiled WebAssembly.Module and hand it to the emscripten glue via
// `instantiateWasm`, so the glue never touches fetch/fs.
//
// Upstream gp_embedded(cmd) PRINTS its output and returns only an error flag,
// so the Gp wrapper collects print/printErr lines and returns them joined —
// the same shape the old @sagemath/pari build's patched gp_embedded returned,
// PARI errors included as "*** ..." lines (verify.ts greps for that marker).

// @ts-expect-error - emscripten CJS glue, no type declarations
import createPariModule from './gp-sta.js'
// @ts-expect-error - wrangler imports .wasm as a compiled WebAssembly.Module
import wasmModule from './gp-sta.wasm'

// PARI stack size (used for both parisize and parisizemax — the embedded build
// requires them equal). pari_init uses ~2x this within the wasm's fixed 64MB
// linear memory, so it must stay well under 32MB. 16MB verifies the rank-28
// record curve (needs <8MB) and runs ellrank's full 2-descent on the rank-20
// 2-torsion record with comfortable headroom.
const PARI_SIZE = 16 * 1024 * 1024

export type Gp = (cmd: string) => string

async function init(): Promise<Gp> {
  // The glue's environment sniffing needs two dummies in workerd:
  // __filename defined makes it take its first script-location branch instead
  // of the worker branch, which dereferences self.location.href — undefined in
  // workerd (bare __filename/__dirname resolve through the global object).
  // __dirname is then used only to locate the wasm, which instantiateWasm
  // overrides anyway.
  ;(globalThis as Record<string, unknown>).__filename = '/gp-sta.js'
  ;(globalThis as Record<string, unknown>).__dirname = '/'

  let out: string[] = []
  const mod = await createPariModule({
    noInitialRun: true,
    print: (line: string) => out.push(line),
    printErr: (line: string) => out.push(line),
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
  const run = mod.cwrap('gp_embedded', 'number', ['string']) as (cmd: string) => number
  return (cmd) => {
    out = []
    run(cmd)
    return out.join('\n')
  }
}

let cached: Promise<Gp> | null = null

// Lazily initialize once per isolate and reuse across requests.
export function getGp(): Promise<Gp> {
  if (!cached) cached = init()
  return cached
}
