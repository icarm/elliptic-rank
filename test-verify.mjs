import fs from 'node:fs'
import { canonicalKey, naiveLogHeight, verify } from './src/verify.ts'

// Build a gp() callable from the PARI WASM module (same module the Worker uses).
const factory = (await import('@sagemath/pari/dist/gp-sta.js')).default
const wasmBinary = fs.readFileSync('node_modules/@sagemath/pari/dist/gp-sta.wasm')
const mod = await factory({
  noInitialRun: true,
  print: () => {},
  printErr: () => {},
  instantiateWasm(imports, recv) {
    const inst = new WebAssembly.Instance(new WebAssembly.Module(wasmBinary), imports)
    recv(inst)
    return inst.exports
  },
})
mod.ccall('gp_embedded_init', null, ['number', 'number'], [64 << 20, 64 << 20])
const gp = (s) => mod.cwrap('gp_embedded', 'string', ['string'])(s)

const RK12 = {
  ainvs: ['0', '0', '1', '-6349808647', '193146346911036'],
  points: [
    ['49421', '200114'], ['49493', '333458'], ['49513', '362258'],
    ['49632', '502899'], ['49667', '538049'], ['49797', '654674'],
    ['49899', '735713'], ['50012', '818375'], ['50165', '921837'],
    ['50215', '954017'], ['51108', '1454591'], ['-3659', '14708205'],
  ],
}
const RK28 = {
  ainvs: ['1', '-1', '1',
    '-20067762415575526585033208209338542750930230312178956502',
    '34481611795030556467032985690390720374855944359319180361266008296291939448732243429'],
  points: [
    ['-2124150091254381073292137463','259854492051899599030515511070780628911531'],
    ['2334509866034701756884754537','18872004195494469180868316552803627931531'],
    ['-1671736054062369063879038663','251709377261144287808506947241319126049131'],
    ['2139130260139156666492982137','36639509171439729202421459692941297527531'],
    ['1534706764467120723885477337','85429585346017694289021032862781072799531'],
    ['-2731079487875677033341575063','262521815484332191641284072623902143387531'],
    ['2775726266844571649705458537','12845755474014060248869487699082640369931'],
    ['1494385729327188957541833817','88486605527733405986116494514049233411451'],
    ['1868438228620887358509065257','59237403214437708712725140393059358589131'],
    ['2008945108825743774866542537','47690677880125552882151750781541424711531'],
    ['2348360540918025169651632937','17492930006200557857340332476448804363531'],
    ['-1472084007090481174470008663','246643450653503714199947441549759798469131'],
    ['2924128607708061213363288937','28350264431488878501488356474767375899531'],
    ['5374993891066061893293934537','286188908427263386451175031916479893731531'],
    ['1709690768233354523334008557','71898834974686089466159700529215980921631'],
    ['2450954011353593144072595187','4445228173532634357049262550610714736531'],
    ['2969254709273559167464674937','32766893075366270801333682543160469687531'],
    ['2711914934941692601332882937','2068436612778381698650413981506590613531'],
    ['20078586077996854528778328937','2779608541137806604656051725624624030091531'],
    ['2158082450240734774317810697','34994373401964026809969662241800901254731'],
    ['2004645458247059022403224937','48049329780704645522439866999888475467531'],
    ['2975749450947996264947091337','33398989826075322320208934410104857869131'],
    ['-2102490467686285150147347863','259576391459875789571677393171687203227531'],
    ['311583179915063034902194537','168104385229980603540109472915660153473931'],
    ['2773931008341865231443771817','12632162834649921002414116273769275813451'],
    ['2156581188143768409363461387','35125092964022908897004150516375178087331'],
    ['3866330499872412508815659137','121197755655944226293036926715025847322531'],
    ['2230868289773576023778678737','28558760030597485663387020600768640028531'],
  ],
}

function show(name, input) {
  const t = Date.now()
  const r = verify(gp, input)
  const ms = Date.now() - t
  const ind = r.independence
  console.log(
    `${name.padEnd(26)} ok=${String(r.ok).padEnd(5)} ` +
    `rank>=${ind?.rankLowerBound ?? '-'} onCurve=${r.allPointsOnCurve} ` +
    `reg>0=${ind ? ind.independent : '-'} naiveH=${r.height?.naiveLogHeight?.slice(0, 7) ?? '-'} ` +
    `(${ms}ms)` + (r.errors.length ? `  errors=${JSON.stringify(r.errors)}` : ''),
  )
}

show('rank-12 (valid)', RK12)
show('rank-28 record (valid)', RK28)

// Regression for the p=2 minimal-model height fix: the same curve (Elkies' 2009
// rank-13 Mordell curve) in its original non-minimal model y^2 = x^3 + 16m and
// in its minimal model y^2 + y = x^3 + (m-1)/4, with one witness point mapped
// through (X,Y) -> (X/4, (Y-4)/8). Same canonical key and naive height
// (95.847...).
const ELKIES_NONMIN = {
  ainvs: ['0', '0', '0', '0', '48163745551486811536'],
  points: [['-3427960', '-2807507244']],
}
const ELKIES_MIN = {
  ainvs: ['0', '0', '1', '0', '752558524241981430'],
  points: [['-856990', '-350938406']],
}
const rNonMin = verify(gp, ELKIES_NONMIN)
const rMin = verify(gp, ELKIES_MIN)
show('elkies-13 non-minimal', ELKIES_NONMIN)
show('elkies-13 minimal', ELKIES_MIN)
// Compare heights numerically: gp precision (\p) persists across verify calls,
// so the strings can carry different digit counts for the same value.
const h = (r) => Number(r.height.naiveLogHeight.replace(/\s+/g, '').replace(/E/i, 'e'))
if (
  !rNonMin.ok || !rMin.ok ||
  rNonMin.canonical.key !== rMin.canonical.key ||
  Math.abs(h(rNonMin) - h(rMin)) > 1e-9
) {
  console.error('FAIL: naive height / key differ between models of the same curve')
  process.exitCode = 1
} else if (
  JSON.stringify(rNonMin.curve.ainvs) !== JSON.stringify(ELKIES_MIN.ainvs) ||
  JSON.stringify(rNonMin.points.map((p) => p.point)) !== JSON.stringify(ELKIES_MIN.points) ||
  rNonMin.curve.discriminant !== rMin.curve.discriminant
) {
  console.error('FAIL: non-minimal model was not returned in global minimal storage form')
  process.exitCode = 1
} else {
  console.log(`elkies model check OK: key=${rMin.canonical.key.slice(0, 30)}… naiveH=${rMin.height.naiveLogHeight.slice(0, 10)}`)
}

// Faltings height is computed from the minimal model's period lattice, so it is
// present for every verified curve regardless of whether primes were supplied.
if (!rMin.faltingsHeight || !Number.isFinite(Number(rMin.faltingsHeight.replace(/\s+/g, '').replace(/E/i, 'e')))) {
  console.error('FAIL: Faltings height should be recorded without primes')
  process.exitCode = 1
} else {
  console.log(`faltings without primes OK: ${rMin.faltingsHeight.slice(0, 12)}`)
}

// Regression for exact minimal-model key/height with a non-minimal model scaled
// by a prime above the old bounded trial-division range.
const SCALE_PRIME = 1000003n
const scalePow = (n) => SCALE_PRIME ** BigInt(n)
const baseKey = canonicalKey(gp, ['-1', '1'])
const scaledKey = canonicalKey(gp, [
  String(-scalePow(4)),
  String(scalePow(6)),
])
const baseHeight = naiveLogHeight(gp, ['-1', '1'])
const scaledHeight = naiveLogHeight(gp, [
  String(-scalePow(4)),
  String(scalePow(6)),
])
if (baseKey.key !== scaledKey.key || Math.abs(Number(baseHeight) - Number(scaledHeight)) > 1e-9) {
  console.error('FAIL: large-prime scaled model changed canonical key or naive height')
  process.exitCode = 1
} else {
  console.log(`large-prime scaled key/height OK: key=${scaledKey.key}, naiveH=${scaledHeight.slice(0, 10)}`)
}
const unicodeMinus = verify(gp, { ainvs: RK12.ainvs, points: [['\u22123659', '14708205']] })
if (!unicodeMinus.ok || unicodeMinus.points[0]?.point[0] !== '-3659') {
  console.error('FAIL: unicode minus sign was not accepted as a numeric sign')
  process.exitCode = 1
} else {
  console.log('unicode minus sign accepted OK')
}
// Regression: duplicated primes of bad reduction must not inflate the
// conductor (conductorFromPrimes multiplies p^f_p over the list, so each bad
// prime must appear exactly once). 5077a1: y^2 + y = x^3 - 7x + 6, rank 3,
// prime discriminant = conductor = 5077. Duplicates and leading zeros both
// normalize away.
const dupPrimes = verify(gp, {
  ainvs: ['0', '0', '1', '-7', '6'],
  points: [['-2', '3'], ['-1', '3'], ['0', '2']],
  primes: ['5077', '5077', '0005077'],
})
if (!dupPrimes.ok || dupPrimes.conductor !== '5077' || JSON.stringify(dupPrimes.badPrimes) !== '["5077"]') {
  console.error(`FAIL: duplicated primes changed the conductor or bad primes: got ${dupPrimes.conductor}, ${JSON.stringify(dupPrimes.badPrimes)}`)
  process.exitCode = 1
} else {
  console.log('duplicated primes conductor OK: 5077')
}

// Bad primes are recorded canonically: deduplicated, sorted ascending, and
// with extraneous good primes (here 7) dropped rather than stored. The
// congruent-number-5 curve y^2 = x^3 - 25x: disc 10^6, conductor 800 = 2^5*5^2,
// generator (-4, 6).
const unsortedPrimes = verify(gp, {
  ainvs: ['0', '0', '0', '-25', '0'],
  points: [['-4', '6']],
  primes: ['5', '02', '5', '2', '7'],
})
if (
  !unsortedPrimes.ok ||
  unsortedPrimes.conductor !== '800' ||
  JSON.stringify(unsortedPrimes.badPrimes) !== '["2","5"]'
) {
  console.error(
    `FAIL: bad primes not canonicalized: conductor ${unsortedPrimes.conductor}, badPrimes ${JSON.stringify(unsortedPrimes.badPrimes)}`,
  )
  process.exitCode = 1
} else {
  console.log('bad primes canonicalized OK: [2, 5], conductor 800')
}

// failure cases
show('singular curve', { ainvs: ['0', '0'], points: [['0', '0']] })
const offCurve = verify(gp, { ainvs: ['0', '0', '1', '-6349808647', '193146346911036'], points: [['1', '1']] })
show('point off curve', { ainvs: ['0', '0', '1', '-6349808647', '193146346911036'], points: [['1', '1']] })
if (!offCurve.errors.some((e) => e.includes('point[0] = [1, 1] does not lie on the curve'))) {
  console.error('FAIL: off-curve point error did not identify the point')
  process.exitCode = 1
}
show('dependent (P,P)', { ainvs: RK12.ainvs, points: [RK12.points[0], RK12.points[0]] })
show('injection attempt', { ainvs: ['0', '0', '1', '0', 'ellinit([0,1])'], points: [['0', '0']] })

const tooLargeToken = verify(gp, {
  ainvs: ['1' + '0'.repeat(256), '0'],
  points: [['0', '0']],
})
if (!tooLargeToken.errors.some((e) => e.includes('too many digits'))) {
  console.error('FAIL: oversized numeric token was not rejected before PARI')
  process.exitCode = 1
} else {
  console.log('oversized numeric token rejected OK')
}

const manyPrimes = verify(gp, {
  ainvs: ['0', '0'],
  points: [['0', '0']],
  primes: Array.from({ length: 257 }, () => '2'),
})
if (!manyPrimes.errors.some((e) => e.includes('too many primes'))) {
  console.error('FAIL: oversized prime list was not rejected before PARI')
  process.exitCode = 1
} else {
  console.log('oversized prime list rejected OK')
}
