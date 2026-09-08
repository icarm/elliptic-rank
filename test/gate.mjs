import { placement, qualifies, BOARD_TOP_K } from '../src/gate.ts'

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

// A rival with every metric set. Conductors and discriminants are decimal
// strings compared by magnitude, so vary their length to exercise lessDecimal.
const rival = (i) => ({
  naive_height: 10 + i,
  faltings_height: 1 + i,
  conductor: String(10 ** i),
  discriminant: (i % 2 ? '-' : '') + '9'.repeat(i + 1),
})
const board = Array.from({ length: 20 }, (_, i) => rival(i))

// Empty board: everything places first.
const first = placement(rival(5), [])
check('empty board: first on every metric', first.naive === 1 && first.faltings === 1 && first.conductor === 1 && first.disc === 1)
check('empty board qualifies', qualifies(first))

// Strictly smaller than all rivals: a record, place 1.
const rec = placement({ naive_height: 0, faltings_height: 0, conductor: '1', discriminant: '1' }, board)
check('record places 1st', rec.naive === 1 && rec.faltings === 1 && rec.conductor === 1 && rec.disc === 1, JSON.stringify(rec))

// Larger than all rivals: place 21 on everything, declined.
const last = placement(
  { naive_height: 100, faltings_height: 100, conductor: '1' + '0'.repeat(30), discriminant: '-' + '9'.repeat(40) },
  board,
)
check('worst places 21st', last.naive === 21 && last.faltings === 21 && last.conductor === 21 && last.disc === 21, JSON.stringify(last))
check('worst does not qualify', !qualifies(last))

// Ties do not count against you: a candidate equal to rival 9 (the 10th
// smallest) has only rivals 0..8 strictly below it, so it places 10th — inside
// K=10 — while a candidate equal to rival 10 places 11th and is out.
const tie = placement(rival(9), board)
check('tie on 10th place is 10th', tie.naive === 10 && tie.faltings === 10 && tie.conductor === 10 && tie.disc === 10, JSON.stringify(tie))
check('tie on Kth place qualifies', qualifies(tie, 10))
check('11th place is out', !qualifies(placement(rival(10), board), 10))
check('BOARD_TOP_K is 10', BOARD_TOP_K === 10)

// One good metric is enough.
const mixed = placement({ naive_height: 100, faltings_height: 100, conductor: '1' + '0'.repeat(30), discriminant: '5' }, board)
check('qualifies via a single metric (disc)', qualifies(mixed) && mixed.disc === 1 && mixed.naive === 21, JSON.stringify(mixed))

// Missing metrics: a candidate without a conductor cannot qualify on it, and
// rivals without a Faltings height or conductor are skipped, not counted.
const noCond = placement({ naive_height: 100, faltings_height: 100, conductor: null, discriminant: '-' + '9'.repeat(40) }, board)
check('null conductor -> null placement', noCond.conductor === null && !qualifies(noCond))
const sparse = board.map((r) => ({ ...r, faltings_height: null, conductor: null }))
const vsSparse = placement({ naive_height: 100, faltings_height: 100, conductor: '7', discriminant: '5' }, sparse)
check('rivals lacking a metric are skipped', vsSparse.faltings === 1 && vsSparse.conductor === 1 && vsSparse.naive === 21, JSON.stringify(vsSparse))

// Discriminant sign is ignored (magnitude only).
const neg = placement({ naive_height: 100, faltings_height: 100, conductor: null, discriminant: '-99' }, [
  { naive_height: 0, faltings_height: 0, conductor: null, discriminant: '100' },
  { naive_height: 0, faltings_height: 0, conductor: null, discriminant: '-98' },
])
check('|Δ| compares by magnitude', neg.disc === 2, JSON.stringify(neg))

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall gate checks passed')
