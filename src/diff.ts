// Word-level diff of two commentary versions, for the commentary history page.
// Dependency-free, like ./gate, so test/diff.mjs can drive it.

// A run of text that is in both versions ('='), only the old one ('-') or only
// the new one ('+').
export interface DiffSegment {
  op: '=' | '-' | '+'
  text: string
}

// Above this many cells (old tokens × new tokens, after trimming the common
// prefix and suffix) the LCS table is not built and the changed middle is shown
// as one removal and one insertion. Commentary is capped at 4000 characters, so
// only near-total rewrites of long texts get here, and for those a wholesale
// replacement is about as readable anyway.
const MAX_CELLS = 4_000_000

// A reference to a curve in commentary, `curve#123` or `curve #123` (or with a
// capital C, as at the start of a sentence), which pages.renderCommentContent
// links to that curve; group 1 is the id. It must not follow a word character
// (as the tokenizer below counts them), so each match starts a token.
export const CURVE_REF = /(?<![\p{L}\p{N}\p{M}#_])[Cc]urve ?#(\d+)/gu

// Curve references, runs of whitespace, words, and single punctuation marks,
// so that "curve#7." → "curve#7," changes only the punctuation. A curve
// reference is one token, so its link is never split across segments; '#'
// and '_' count as word characters.
function tokenize(s: string): string[] {
  return s.match(/[Cc]urve ?#\d+|\s+|[\p{L}\p{N}\p{M}#_]+|[^\s\p{L}\p{N}\p{M}#_]/gu) ?? []
}

// Diff `a` (old) against `b` (new): segments whose '=' and '-' texts
// concatenate to `a`, and whose '=' and '+' texts concatenate to `b`.
export function diffWords(a: string, b: string): DiffSegment[] {
  const x = tokenize(a)
  const y = tokenize(b)
  let pre = 0
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++
  let suf = 0
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++
  const xm = x.slice(pre, x.length - suf)
  const ym = y.slice(pre, y.length - suf)

  const raw: DiffSegment[] = []
  const push = (op: DiffSegment['op'], text: string) => raw.push({ op, text })
  for (const t of x.slice(0, pre)) push('=', t)
  const n = xm.length
  const m = ym.length
  if (n * m > MAX_CELLS) {
    for (const t of xm) push('-', t)
    for (const t of ym) push('+', t)
  } else {
    // lcs[i * (m + 1) + j]: length of the LCS of xm[i..] and ym[j..]. Lengths
    // are at most 4000 (COMMENT_MAX characters), so 16 bits suffice.
    const w = m + 1
    const lcs = new Uint16Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = xm[i] === ym[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && xm[i] === ym[j]) {
        push('=', xm[i++])
        j++
      } else if (j >= m || (i < n && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
        push('-', xm[i++])
      } else {
        push('+', ym[j++])
      }
    }
  }
  for (const t of x.slice(x.length - suf)) push('=', t)
  return tidy(raw)
}

// Group the token-level ops into readable runs: within each stretch of changes
// show everything removed, then everything inserted, folding in the bare
// whitespace kept between changed words (so "a b" → "c d" reads as one
// replacement, not two with a kept space between), and merge neighbours with
// the same op.
function tidy(raw: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = []
  const emit = (op: DiffSegment['op'], text: string) => {
    if (text === '') return
    const last = out[out.length - 1]
    if (last && last.op === op) last.text += text
    else out.push({ op, text })
  }
  const isGap = (k: number) => raw[k].op === '=' && /^\s+$/.test(raw[k].text)
  for (let i = 0; i < raw.length; ) {
    if (raw[i].op === '=') {
      emit('=', raw[i++].text)
      continue
    }
    let del = ''
    let ins = ''
    for (; i < raw.length && (raw[i].op !== '=' || (isGap(i) && i + 1 < raw.length && raw[i + 1].op !== '=')); i++) {
      if (raw[i].op !== '+') del += raw[i].text
      if (raw[i].op !== '-') ins += raw[i].text
    }
    emit('-', del)
    emit('+', ins)
  }
  return out
}

// Where to end a prefix of `s` of about `n` characters without splitting a
// word or a curve reference: at the last whitespace in the second half of the
// window (or at `n` if there is none, e.g. a long URL), moved back to the
// start of any curve reference that would still straddle it.
function cutBefore(s: string, n: number): number {
  if (n >= s.length) return s.length
  let k = n
  while (k > n / 2 && !/\s/.test(s[k])) k--
  if (k <= n / 2) k = n
  for (const m of s.matchAll(CURVE_REF)) {
    if (m.index < k && k < m.index + m[0].length) return m.index
  }
  return k
}

// Where to start a suffix of `s` of about `n` characters, by the same rules as
// cutBefore: just after whitespace in the first half of the window, moved
// forward past any curve reference it would split.
function cutAfter(s: string, n: number): number {
  if (n >= s.length) return 0
  const start = s.length - n
  let k = start
  while (k < start + n / 2 && !/\s/.test(s[k - 1])) k++
  if (k >= start + n / 2) k = start
  for (const m of s.matchAll(CURVE_REF)) {
    if (m.index < k && k < m.index + m[0].length) return m.index + m[0].length
  }
  return k
}

// `s` clipped to about `n` characters with a trailing '…', cut as by cutBefore.
export function clipText(s: string, n: number): string {
  return s.length > n ? s.slice(0, cutBefore(s, n)) + '…' : s
}

// A short excerpt of a diff for the activity feed: the changes, with up to
// `context` characters of unchanged text on each side of them and long
// unchanged stretches between changes elided with '…', stopping with a '…'
// once about `budget` characters have been shown. Cuts follow cutBefore and
// cutAfter, so curve references survive whole.
export function excerptDiff(segs: DiffSegment[], context = 60, budget = 400): DiffSegment[] {
  const out: DiffSegment[] = []
  let used = 0
  for (let i = 0; i < segs.length && used < budget; i++) {
    const { op } = segs[i]
    let text = segs[i].text
    if (op === '=') {
      const first = i === 0
      const last = i === segs.length - 1
      if (first && last) text = clipText(text, Math.min(budget, 2 * context))
      else if (first) text = text.length > context ? '…' + text.slice(cutAfter(text, context)) : text
      else if (last) text = clipText(text, context)
      else if (text.length > 2 * context + 3) {
        text = text.slice(0, cutBefore(text, context)) + ' … ' + text.slice(cutAfter(text, context))
      }
    }
    if (used + text.length > budget) {
      text = text.slice(0, cutBefore(text, budget - used)) + '…'
      used = budget
    } else used += text.length
    out.push({ op, text })
  }
  // Ran out of budget before the last segment, and the last one shown doesn't
  // already end in an ellipsis.
  if (out.length < segs.length && !out[out.length - 1]?.text.endsWith('…')) out.push({ op: '=', text: ' …' })
  return out
}
