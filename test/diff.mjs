import { diffWords } from '../src/diff.ts'

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!cond) failures++
}

// Compact form for comparisons: "=kept|-gone|+new".
const show = (segs) => segs.map((s) => s.op + s.text).join('|')
// The old and new texts a diff reconstructs.
const sides = (segs) => [
  segs.filter((s) => s.op !== '+').map((s) => s.text).join(''),
  segs.filter((s) => s.op !== '-').map((s) => s.text).join(''),
]

const cases = [
  ['identical', 'same text here', 'same text here', '=same text here'],
  ['both empty', '', '', ''],
  ['from empty', '', 'new words', '+new words'],
  ['to empty (cleared)', 'old words', '', '-old words'],
  ['one word replaced', 'rank 31 found by search', 'rank 32 found by search', '=rank |-31|+32|= found by search'],
  ['word appended', 'see curve#12', 'see curve#12 and curve#13', '=see curve#12|+ and curve#13'],
  ['word removed mid-sentence', 'a very big curve', 'a big curve', '=a |-very |=big curve'],
  // Adjacent changed words separated by kept spaces read as one replacement.
  ['phrase replaced as one run', 'the old wording here', 'the new phrasing here', '=the |-old wording|+new phrasing|= here'],
  ['newline added', 'line one\nline two', 'line one\nline 1.5\nline two', '=line one\nline |+1.5\nline |=two'],
  // Punctuation is its own token: changing it leaves the word (and a curve
  // link) unmarked.
  ['punctuation only', 'Found by wgxli.', 'Found by wgxli; see curve#846.', '=Found by wgxli|+; see curve#846|=.'],
  ['link kept across punctuation change', 'related to curve#846.', 'related to curve#846, proven.', '=related to curve#846|+, proven|=.'],
]
for (const [name, a, b, want] of cases) {
  const d = diffWords(a, b)
  check(name, show(d) === want, JSON.stringify(show(d)))
}

// Whatever the input, the segments reconstruct both versions, no segment is
// empty, and neighbouring segments never share an op.
const words = ['curve#7', 'rank', '31', 'x', '\n', 'the', 'a', '.', 'y^2', '(x-1),']
let seed = 1
const rand = (k) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % k)
const text = () => Array.from({ length: rand(30) }, () => words[rand(words.length)]).join(rand(3) ? ' ' : '  ')
let ok = true
for (let t = 0; t < 2000 && ok; t++) {
  const a = text()
  const b = rand(2) ? text() : a.replace(/x/g, 'y')
  const d = diffWords(a, b)
  const [ra, rb] = sides(d)
  ok = ra === a && rb === b && d.every((s, i) => s.text !== '' && (i === 0 || d[i - 1].op !== s.op))
  if (!ok) check('random round trip', false, JSON.stringify({ a, b, d: show(d) }))
}
check('2000 random pairs round-trip with tidy segments', ok)

// A near-total rewrite of maximal-length commentary (4000 one-letter words
// both sides, nothing in common) skips the LCS table and stays quick.
const big1 = Array.from({ length: 2000 }, () => 'a').join(' ')
const big2 = Array.from({ length: 2000 }, () => 'b').join(' ')
const t0 = Date.now()
const dBig = diffWords(big1, big2)
const ms = Date.now() - t0
check('large rewrite: one removal, one insertion', show(dBig) === `-${big1}|+${big2}`)
check('large rewrite is fast', ms < 200, `${ms}ms`)

if (failures) {
  console.log(`${failures} diff check(s) failed`)
  process.exit(1)
}
console.log('all diff checks passed')
