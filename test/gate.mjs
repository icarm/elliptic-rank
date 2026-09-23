import { placement, qualifies, judge, admitted, recordsAmong, boardRecords, BOARD_TOP_K } from '../src/gate.ts'

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

// Per-torsion admission. The board has 20 trivial-torsion rivals; a candidate
// worse than all of them overall still gets in if it is top-K among the rivals
// with its own torsion subgroup — and never gets in on torsion when it is not.
const worst = { naive_height: 100, faltings_height: 100, conductor: '1' + '0'.repeat(30), discriminant: '-' + '9'.repeat(40) }
const trivial = board.map((r) => ({ ...r, torsion: '[]' }))
const j0 = judge({ ...worst, torsion: '[2]' }, trivial)
check('first of its torsion subgroup: torsion place 1, overall 21', j0.torsion?.naive === 1 && j0.placement.naive === 21, JSON.stringify(j0))
check('admitted via torsion alone', admitted(j0) && !qualifies(j0.placement))
const j1 = judge({ ...worst, torsion: '[]' }, trivial)
check('same torsion as every rival: torsion pool = overall pool', j1.torsion?.naive === 21 && !admitted(j1), JSON.stringify(j1))
const j3 = judge({ ...worst, torsion: '[2]' }, [...trivial, ...board.map((r) => ({ ...r, torsion: '[2]' }))])
check('21st within a full torsion pool is out', j3.torsion?.naive === 21 && !admitted(j3), JSON.stringify(j3))
const j4 = judge({ ...worst, torsion: '[2]' }, board.map((r) => ({ ...r, torsion: null })))
check('rivals with unknown torsion are not in any torsion pool', j4.torsion?.naive === 1 && admitted(j4), JSON.stringify(j4))
// Anything qualifying overall is admitted regardless of torsion.
check('overall qualifier admitted', admitted(judge({ ...rival(5), torsion: '[3]' }, trivial)))

// Records: ties share the ★ badge, but a strict (Zulip-announced) record needs
// the sole holder. Curve #0 (11a3) and 11a2 tie on conductor 11 and |Δ| = 11.
const c11a3 = { naive_height: 10.048, faltings_height: -1.113, conductor: '11', discriminant: '-11' }
const c11a2 = { naive_height: 31.8, faltings_height: 0.497, conductor: '11', discriminant: '-11' }
const flags = (f) => [f.naive, f.faltings, f.conductor, f.discriminant].map(Number).join('')
check('tie shares the badge', flags(recordsAmong(c11a2, [c11a3])) === '0011')
check('tie is not a strict record', flags(recordsAmong(c11a2, [c11a3], true)) === '0000')
check('sole holder is a strict record', flags(recordsAmong(c11a3, [c11a2], true)) === '1100')
check('strictly smaller everywhere', flags(recordsAmong(c11a3, [{ ...c11a2, conductor: '14', discriminant: '28' }], true)) === '1111')
check('missing value is never a record', !recordsAmong({ ...c11a3, conductor: null, faltings_height: null }, [], true).conductor)
check('empty board: every recorded metric is a strict record', flags(recordsAmong(c11a3, [], true)) === '1111')

// boardRecords (the batch sweep behind /curves, /recent and user pages) must
// agree with recordsAmong (the per-curve rule behind curve pages and the gate)
// on every curve: each judged against every other curve of rank ≥ its own.
// Random boards with few distinct values, so ties, equal ranks and missing
// metrics are all common; discriminant signs vary to exercise magnitude order.
let seed = 12345
const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n)
let mismatches = 0
for (let trial = 0; trial < 300; trial++) {
  const n = 1 + rand(25)
  const curves = Array.from({ length: n }, (_, id) => ({
    id,
    rank_lower_bound: rand(5),
    naive_height: rand(8),
    faltings_height: rand(4) === 0 ? null : rand(8) / 2,
    conductor: rand(3) === 0 ? null : String(1 + rand(12) * 7),
    discriminant: (rand(2) ? '-' : '') + String(1 + rand(12) * 13),
  }))
  const batch = boardRecords(curves)
  for (const c of curves) {
    const rivals = curves.filter((o) => o.id !== c.id && o.rank_lower_bound >= c.rank_lower_bound)
    const want = flags(recordsAmong(c, rivals))
    const got = flags(batch.get(c.id))
    if (want !== got) {
      mismatches++
      if (mismatches <= 3) console.log(`  trial ${trial} curve ${c.id}: boardRecords ${got}, recordsAmong ${want}`)
    }
  }
}
check('boardRecords agrees with recordsAmong on 300 random boards', mismatches === 0, `${mismatches} mismatches`)
check('boardRecords on an empty board', boardRecords([]).size === 0)

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall gate checks passed')
