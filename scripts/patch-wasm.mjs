// The @sagemath/pari wasm hardcodes a 2GB linear memory (min=max=32752 pages).
// A Cloudflare Worker is capped at 128MB, and the 2GB memory ArrayBuffer exceeds
// it the moment the module instantiates — so the first PARI request is killed by
// the runtime ("hung"). PARI needs only ~32MB for even the rank-28 record curve,
// so we patch the memory section down to a fixed 64MB (min=max=1024 pages).
//
// Reads the upstream wasm and writes the patched copy into src/. Re-run after
// upgrading @sagemath/pari:  node scripts/patch-wasm.mjs
import fs from 'node:fs'
import path from 'node:path'

const SRC = 'node_modules/@sagemath/pari/dist/gp-sta.wasm'
const OUT = 'src/gp-sta.wasm'
const TARGET_PAGES = 1024 // 1024 * 64KiB = 64MB

const b = fs.readFileSync(SRC)

// Walk sections to find the memory section (id 5).
let p = 8 // skip magic (4) + version (4)
function readLeb() {
  let result = 0,
    shift = 0,
    byte,
    len = 0
  do {
    byte = b[p++]
    result |= (byte & 0x7f) << shift
    shift += 7
    len++
  } while (byte & 0x80)
  return { value: result >>> 0, len }
}

// Encode `value` as LEB128 padded to exactly `len` bytes (non-minimal but valid),
// so the patch is byte-for-byte length-preserving (no section-length fixups).
function encodeLebPadded(value, len) {
  const out = []
  for (let i = 0; i < len; i++) {
    let byte = value & 0x7f
    value >>>= 7
    if (i < len - 1) byte |= 0x80
    out.push(byte)
  }
  return out
}

let patched = false
while (p < b.length) {
  const id = b[p++]
  const { value: secLen } = readLeb()
  const secEnd = p + secLen
  if (id === 5) {
    const { value: count } = readLeb()
    if (count !== 1) throw new Error(`unexpected memory count ${count}`)
    const flags = b[p++]
    if (!(flags & 1)) throw new Error('memory has no max; unexpected build')
    const minOff = p
    const min = readLeb()
    const maxOff = p
    const max = readLeb()
    console.log(`found memory: min=${min.value} max=${max.value} pages (${(max.value * 64) / 1024}MB)`)
    for (const [off, info] of [
      [minOff, min],
      [maxOff, max],
    ]) {
      const bytes = encodeLebPadded(TARGET_PAGES, info.len)
      for (let i = 0; i < info.len; i++) b[off + i] = bytes[i]
    }
    patched = true
    break
  }
  p = secEnd
}

if (!patched) throw new Error('memory section not found')
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, b)
console.log(`wrote ${OUT} with memory pinned to ${TARGET_PAGES} pages (${(TARGET_PAGES * 64) / 1024}MB)`)
