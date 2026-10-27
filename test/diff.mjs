import { diffWords, excerptDiff, clipText, CURVE_REF } from '../src/diff.ts'

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
  // `curve #846` (with a space) is one token like `curve#846`, so changing
  // the id replaces the whole reference rather than just `#846`.
  ['spaced reference is one token', 'see curve #845 too', 'see curve #846 too', '=see |-curve #845|+curve #846|= too'],
  ['link kept across punctuation change', 'related to curve#846.', 'related to curve#846, proven.', '=related to curve#846|+, proven|=.'],
]
for (const [name, a, b, want] of cases) {
  const d = diffWords(a, b)
  check(name, show(d) === want, JSON.stringify(show(d)))
}

// Whatever the input, the segments reconstruct both versions, no segment is
// empty, and neighbouring segments never share an op.
const words = ['curve#7', 'curve #8', 'Curve #10', 'curve', 'Curve', '#9', 'rank', '31', 'x', '\n', 'the', 'a', '.', 'y^2', '(x-1),']
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

// Curve references: with or without the space, never after a word character.
const refs = (s) => [...s.matchAll(CURVE_REF)].map((m) => m[0] + '=' + m[1])
check('curve#5569 and curve #5569 are references', JSON.stringify(refs('curve#5569, curve #5569.')) === '["curve#5569=5569","curve #5569=5569"]', JSON.stringify(refs('curve#5569, curve #5569.')))
check('Curve #5504 and Curve#5737 are references', JSON.stringify(refs('Curve #5504. Curve#5737')) === '["Curve #5504=5504","Curve#5737=5737"]')
check('(curve #12) is a reference', JSON.stringify(refs('(curve #12)')) === '["curve #12=12"]')
check('not after a word character, nor with two spaces', refs('mycurve #5 subcurve#6 curve  #7 curve #x CURVE #8').length === 0, JSON.stringify(refs('mycurve #5 subcurve#6 curve  #7 curve #x CURVE #8')))

// Every curve reference in a text lies within a single segment of any diff
// involving it, so renderCommentContent links it whole.
const refsWhole = (segs) => {
  const text = segs.map((s) => s.text).join('')
  let pos = 0
  const bounds = new Set([0])
  for (const s of segs) bounds.add((pos += s.text.length))
  return [...text.matchAll(CURVE_REF)].every((m) => {
    for (let k = m.index + 1; k < m.index + m[0].length; k++) if (bounds.has(k)) return false
    return true
  })
}
seed = 7
let whole = true
for (let t = 0; t < 2000 && whole; t++) {
  const a = text()
  const b = text()
  const d = diffWords(a, b)
  // Check the old side (= and -) and the new side (= and +) separately.
  whole = refsWhole(d.filter((s) => s.op !== '+')) && refsWhole(d.filter((s) => s.op !== '-'))
  if (!whole) check('curve references stay whole', false, JSON.stringify({ a, b, d: show(d) }))
}
check('2000 random pairs: curve references never split across segments', whole)

// clipText cuts at whitespace, and never inside a curve reference.
check('clipText: short text untouched', clipText('see curve #12', 280) === 'see curve #12')
check('clipText: cuts at whitespace', clipText('alpha beta gamma delta', 13) === 'alpha beta…', clipText('alpha beta gamma delta', 13))
check('clipText: never inside a curve reference', clipText('xxxxxxxxxxxx curve#5569', 20) === 'xxxxxxxxxxxx…', clipText('xxxxxxxxxxxx curve#5569', 20))
// The nearest whitespace is the space inside `curve #5569`; cutting there would
// split the reference, so the cut moves back to its start.
check('clipText: hard cut moves back off a reference', clipText('aaaaaaaaaaaaaaaaaa,curve #5569', 28) === 'aaaaaaaaaaaaaaaaaa,…', clipText('aaaaaaaaaaaaaaaaaa,curve #5569', 28))

// excerptDiff keeps the changes and some context, eliding the rest.
const longA = 'Intro sentence that goes on for quite a while before anything changes here. ' +
  'The middle stays the same for a long stretch of text, long enough to be elided. '.repeat(3) +
  'Found by search; rank 31 proven. Closing remarks follow, which are also long enough to clip off.'
const longB = longA.replace('Intro sentence', 'Opening sentence').replace('rank 31', 'rank 32')
const ex = excerptDiff(diffWords(longA, longB), 30)
const exText = show(ex)
check('excerpt keeps both changes', ex.some((s) => s.op === '-' && s.text === 'Intro') && ex.some((s) => s.op === '+' && s.text === '32'), exText)
check('excerpt elides the long unchanged middle and the tail', exText.includes(' … ') && exText.endsWith('…') && exText.length < longB.length / 2, exText)
const exLead = excerptDiff(diffWords('word '.repeat(40) + 'old', 'word '.repeat(40) + 'new'), 30)
check('excerpt trims leading context with …', exLead[0].op === '=' && exLead[0].text.startsWith('…') && exLead[0].text.length <= 32, show(exLead))
const huge = excerptDiff(diffWords('x', 'y ' + 'z '.repeat(500)), 30, 100)
check('excerpt stops at the budget with …', huge.map((s) => s.text).join('').length <= 102 && huge[huge.length - 1].text.endsWith('…'), show(huge))
// Random texts: excerpts never split a curve reference, and every '-'/'+'
// segment shown is the start of (or all of) a real change.
seed = 11
let exOk = true
for (let t = 0; t < 2000 && exOk; t++) {
  const a = text()
  const b = text()
  const segs = diffWords(a, b)
  const exc = excerptDiff(segs, 10, 60)
  // Each segment is linkified on its own, as renderCommentDiff does.
  const linked = exc.flatMap((s) => [...s.text.matchAll(CURVE_REF)].map((m) => m[0]))
  const real = new Set([...(a + ' ' + b).matchAll(CURVE_REF)].map((m) => m[0]))
  exOk = linked.every((r) => real.has(r)) && refsWhole(exc.filter((s) => s.op !== '+')) && refsWhole(exc.filter((s) => s.op !== '-'))
  if (!exOk) check('excerpt keeps references whole', false, JSON.stringify({ a, b, ex: show(exc) }))
}
check('2000 random excerpts: no split or invented curve references', exOk)

if (failures) {
  console.log(`${failures} diff check(s) failed`)
  process.exit(1)
}
console.log('all diff checks passed')
