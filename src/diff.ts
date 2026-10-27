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
