// Node-side loader for the project's PARI/GP WASM build (src/gp-sta.js glue +
// src/gp-sta.wasm, built by scripts/build-pari-wasm.sh). Mirrors src/pari.ts,
// which loads the same module inside the Worker: gp_embedded prints its
// output, so the returned gp() collects the printed lines (errors included,
// as "*** ..." lines) and returns them as the command's output string.
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export async function loadGp(size = 16 << 20) {
  const factory = require('../src/gp-sta.js')
  const wasmBinary = fs.readFileSync(new URL('../src/gp-sta.wasm', import.meta.url))
  const wasmModule = new WebAssembly.Module(wasmBinary)
  let out = []
  const mod = await factory({
    noInitialRun: true,
    print: (line) => out.push(line),
    printErr: (line) => out.push(line),
    instantiateWasm(imports, receiveInstance) {
      const instance = new WebAssembly.Instance(wasmModule, imports)
      receiveInstance(instance, wasmModule)
      return instance.exports
    },
  })
  mod.ccall('gp_embedded_init', null, ['number', 'number'], [size, size])
  const run = mod.cwrap('gp_embedded', 'number', ['string'])
  return (cmd) => {
    out = []
    run(cmd)
    return out.join('\n')
  }
}
