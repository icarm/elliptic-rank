import { curveFamily, familyByKey, FAMILIES } from '../src/family.ts'

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

// c4 = -48 a4 and c6 = -864 a6 for a short model y^2 = x^3 + a4 x + a6.
const short = (a4, a6) => curveFamily(String(-48n * BigInt(a4)), String(-864n * BigInt(a6)))

check('y^2 = x^3 + 1 is Mordell', short(0, 1) === 'mordell')
check('y^2 = x^3 - 432 is Mordell', short(0, -432) === 'mordell')
check('y^2 = x^3 - x is congruent (n = 1)', short(-1, 0) === 'congruent')
check('y^2 = x^3 - 4x is congruent (n = 2)', short(-4, 0) === 'congruent')
check('y^2 = x^3 - 36x is congruent (n = 6)', short(-36, 0) === 'congruent')
check('y^2 = x^3 + x is not congruent', short(1, 0) === null)
check('y^2 = x^3 + 4x is not congruent', short(4, 0) === null)
check('y^2 = x^3 - 2x is not congruent', short(-2, 0) === null)
check('11a3 is in no family', curveFamily('16', '-152') === null)
// Curve #2901: n = 797507543735 (Rogers; Watkins et al.), stored minimal c4.
const n = 797507543735n
check('large congruent number', curveFamily(String(48n * n * n), '0') === 'congruent')
check('large non-square is not congruent', curveFamily(String(48n * n * n + 48n), '0') === null)
check('familyByKey round-trips', FAMILIES.every((f) => familyByKey(f.key) === f) && familyByKey('nope') === null && familyByKey(undefined) === null)

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall family checks passed')
