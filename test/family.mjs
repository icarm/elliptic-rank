import { curveFamilies, legacyFamily, familyByKey, impliedByParent, FAMILIES } from '../src/family.ts'

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

// c4 = -48 a4 and c6 = -864 a6 for a short model y^2 = x^3 + a4 x + a6.
const cinvs = (a4, a6) => [String(-48n * BigInt(a4)), String(-864n * BigInt(a6))]
const fams = (a4, a6) => curveFamilies(...cinvs(a4, a6)).join(',')
const is = (name, got, want) => check(name, got === want, `got [${got}], want [${want}]`)

is('y^2 = x^3 + 1 is Mordell', fams(0, 1), 'mordell')
is('y^2 = x^3 + 7 is Mordell only', fams(0, 7), 'mordell')
is('y^2 = x^3 - 432 (Fermat cubic) is a cube sum', fams(0, -432), 'mordell,cubesum')
is('y^2 = x^3 - 432*4 (x^3 + y^3 = 2) is a cube sum', fams(0, -1728), 'mordell,cubesum')
is('y^2 = x^3 + 432 is not a cube sum', fams(0, 432), 'mordell')
is('y^2 = x^3 - x is congruent (n = 1)', fams(-1, 0), 'quartic,congruent')
is('y^2 = x^3 - 4x is congruent (n = 2)', fams(-4, 0), 'quartic,congruent')
is('y^2 = x^3 - 36x is congruent (n = 6)', fams(-36, 0), 'quartic,congruent')
is('y^2 = x^3 + x is a quartic twist only', fams(1, 0), 'quartic')
is('y^2 = x^3 + 4x is a quartic twist only', fams(4, 0), 'quartic')
is('y^2 = x^3 - 2x is a quartic twist only', fams(-2, 0), 'quartic')
is('11a3 is in no family', curveFamilies('16', '-152').join(','), '')
// Minimal models need not be short: 27a1 = [0,0,1,0,-7] (c6 = 5832) is the
// Fermat cubic, and 27a3 = [0,0,1,0,0] (c6 = -216) its 3-isogenous partner.
is('27a1 (minimal model of the Fermat cubic) is a cube sum', curveFamilies('0', '5832').join(','), 'mordell,cubesum')
is('27a3 is Mordell only', curveFamilies('0', '-216').join(','), 'mordell')
// A non-minimal model of a cube sum: scale 27a1 by u = 2 (c6 times 2^6).
is('cube-sum test is model-independent', curveFamilies('0', String(5832n * 64n)).join(','), 'mordell,cubesum')
// Curve #2901: n = 797507543735 (Rogers; Watkins et al.), stored minimal c4.
const n = 797507543735n
is('large congruent number', curveFamilies(String(48n * n * n), '0').join(','), 'quartic,congruent')
is('large non-square is a quartic twist only', curveFamilies(String(48n * n * n + 48n), '0').join(','), 'quartic')

// legacyFamily keeps the original single-family meaning of the `family` fields.
check('legacy: Mordell', legacyFamily(...cinvs(0, 7)) === 'mordell')
check('legacy: cube sum is still "mordell"', legacyFamily(...cinvs(0, -432)) === 'mordell')
check('legacy: congruent', legacyFamily(...cinvs(-1, 0)) === 'congruent')
check('legacy: quartic twist only is null', legacyFamily(...cinvs(1, 0)) === null)
check('legacy: no family is null', legacyFamily('16', '-152') === null)

// A subfamily's record is implied when the curve also holds the parent's.
const holding = (...keys) => (k) => keys.includes(k)
check('congruent record implied by quartic record', impliedByParent('congruent', holding('quartic', 'congruent')))
check('congruent record alone is not implied', !impliedByParent('congruent', holding('congruent')))
check('cube-sum record implied by Mordell record', impliedByParent('cubesum', holding('mordell', 'cubesum')))
check('a family of all j-invariant curves is never implied', !impliedByParent('quartic', holding('quartic')) && !impliedByParent('mordell', holding('mordell')))

check('familyByKey round-trips', FAMILIES.every((f) => familyByKey(f.key) === f) && familyByKey('nope') === null && familyByKey(undefined) === null)

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall family checks passed')
