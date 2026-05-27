import fs from 'node:fs'
import { canonicalKey } from './src/verify.ts'

const factory = (await import('@sagemath/pari/dist/gp-sta.js')).default
const wasmBinary = fs.readFileSync('src/gp-sta.wasm')
const mod = await factory({
  noInitialRun: true, print: () => {}, printErr: () => {},
  instantiateWasm(i, r) { const x = new WebAssembly.Instance(new WebAssembly.Module(wasmBinary), i); r(x); return x.exports },
})
mod.ccall('gp_embedded_init', null, ['number', 'number'], [16 << 20, 16 << 20])
const gp = (s) => mod.cwrap('gp_embedded', 'string', ['string'])(s)

// Scale a model by u: [a1,a2,a3,a4,a6] -> [u a1, u^2 a2, u^3 a3, u^4 a4, u^6 a6].
// This gives a different (non-minimal) Weierstrass model of the *same* curve.
function scale(ainvs, u) {
  // Expand short [a4,a6] form to [a1,a2,a3,a4,a6] before scaling.
  const full = ainvs.length === 2 ? ['0', '0', '0', ainvs[0], ainvs[1]] : ainvs
  const [a1, a2, a3, a4, a6] = full.map(BigInt)
  const U = BigInt(u)
  return [a1 * U, a2 * U ** 2n, a3 * U ** 3n, a4 * U ** 4n, a6 * U ** 6n].map(String)
}

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

const curves = {
  'rank-12': ['0', '0', '1', '-6349808647', '193146346911036'],
  '37a (rank 1)': ['0', '0', '1', '-1', '0'],
  '389a (rank 2)': ['0', '1', '1', '-2', '0'],
  'short [a4,a6]': ['-1', '0'],
}

for (const [name, ainvs] of Object.entries(curves)) {
  const base = canonicalKey(gp, ainvs)
  const k2 = canonicalKey(gp, scale(ainvs, 2))
  const k6 = canonicalKey(gp, scale(ainvs, 6))
  const k30 = canonicalKey(gp, scale(ainvs, 30))
  check(`${name}: scale x2 -> same key`, k2.key === base.key, `${base.key} vs ${k2.key}`)
  check(`${name}: scale x6 -> same key`, k6.key === base.key)
  check(`${name}: scale x30 -> same key`, k30.key === base.key)
}

// Distinct curves must get distinct keys.
const a = canonicalKey(gp, ['0', '0', '1', '-1', '0']) // 37a
const b = canonicalKey(gp, ['0', '1', '1', '-2', '0']) // 389a
check('distinct curves -> distinct keys', a.key !== b.key, `${a.key} vs ${b.key}`)

// A quadratic twist (different curve, same j) must get a different key.
const e = canonicalKey(gp, ['0', '0', '0', '-1', '0']) // y^2 = x^3 - x
const eTwist = canonicalKey(gp, ['0', '0', '0', '-9', '0']) // twist by 3: y^2 = x^3 - 9x
check('quadratic twist -> different key', e.key !== eTwist.key, `${e.key} vs ${eTwist.key}`)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
