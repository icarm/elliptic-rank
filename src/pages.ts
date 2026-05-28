// Server-rendered HTML pages. Plain template literals (like eq677), with a
// shared layout that already accommodates an authenticated user in the header
// so GitHub login / profiles can slot in later without reworking the chrome.

import type { VerifyResult } from './verify'
import { COMMENT_MAX, type CommentView } from './store'

export interface User {
  id: number
  provider: string
  email?: string | null
  display_name?: string | null
  avatar_url?: string | null
}

export interface TokenRow {
  id: number
  name: string | null
  prefix: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export function escapeHtml(s: unknown): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Inline SVG favicon: a stylized elliptic curve (oval component + open branch).
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>` +
      `<g fill='none' stroke='%232a6df4' stroke-width='2.4'>` +
      `<ellipse cx='11' cy='16' rx='5' ry='8'/>` +
      `<path d='M21 3 C 15 10, 15 22, 21 29'/></g></svg>`,
  )

function authNav(user: User | null): string {
  if (user) {
    const name = escapeHtml(user.display_name || user.email || 'user')
    return (
      `<a href="/profile" class="auth-user">${name}</a>` +
      `<form class="auth-logout" method="post" action="/auth/logout"><button type="submit">log out</button></form>`
    )
  }
  return `<a href="/auth/github">log in with GitHub</a>`
}

export function layout(title: string, bodyInner: string, user: User | null = null): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="icon" type="image/svg+xml" href="${FAVICON}" />
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <header>
      <div class="inner">
        <h1><a href="/">Elliptic Rank</a></h1>
        <nav><span class="auth-nav">${authNav(user)}</span></nav>
      </div>
    </header>
    <main>${bodyInner}</main>
    <footer>
      <a href="/api">API</a> &nbsp;&middot;&nbsp;
      <a class="external" href="https://github.com/icarm/elliptic-rank">source</a> &nbsp;&middot;&nbsp;
      <a class="external" href="https://icarm.io">icarm.io</a>
    </footer>
  </body>
</html>
`
}

const SAMPLE_AINVS = '0, 0, 1, -6349808647, 193146346911036'
const SAMPLE_POINTS = `49421, 200114
49493, 333458
49513, 362258
49632, 502899
49667, 538049
49797, 654674
49899, 735713
50012, 818375
50165, 921837
50215, 954017
51108, 1454591
-3659, 14708205`

export interface PlotCurve {
  id: number
  rank_lower_bound: number
  naive_height: number
  faltings_height: number | null
  conductor: string | null
}

// Natural log of a non-negative big integer given as a decimal string.
function logBigInt(s: string): number {
  const t = s.replace('-', '')
  const k = Math.min(15, t.length)
  return Math.log(Number(t.slice(0, k))) + (t.length - k) * Math.LN10
}

interface PlotPoint {
  id: number
  rank: number
  x: number
}

// Server-rendered SVG scatter of a quantity `q` (e.g. naive/Faltings height or
// log conductor, on the vertical axis) against rank (horizontal). Each dot is an
// anchor to the curve's page — clickable, no JS.
function scatterPlot(pts: PlotPoint[], qLabel: string, qFmt: (v: number) => string): string {
  if (pts.length === 0) {
    return `<p class="muted plot-empty">No curves with a recorded ${qLabel} yet.</p>`
  }
  const W = 720, H = 440, L = 60, R = 18, T = 18, B = 46
  const plotW = W - L - R, plotH = H - T - B
  const qs = pts.map((p) => p.x)
  let qmin = Math.min(...qs), qmax = Math.max(...qs)
  if (qmin === qmax) { qmin -= 1; qmax += 1 }
  const qpad = (qmax - qmin) * 0.05
  qmin -= qpad
  qmax += qpad
  const rankMax = Math.max(...pts.map((p) => p.rank)) + 1
  const X = (r: number) => L + (r / rankMax) * plotW
  const Y = (q: number) => T + plotH - ((q - qmin) / (qmax - qmin)) * plotH

  let grid = ''
  const rStep = rankMax <= 16 ? 1 : Math.ceil(rankMax / 12)
  for (let r = 0; r <= rankMax; r += rStep) {
    const x = X(r).toFixed(1)
    grid += `<line class="grid" x1="${x}" y1="${T}" x2="${x}" y2="${T + plotH}"/><text class="tick" x="${x}" y="${T + plotH + 18}" text-anchor="middle">${r}</text>`
  }
  for (let i = 0; i <= 5; i++) {
    const q = qmin + (i / 5) * (qmax - qmin)
    const y = Y(q).toFixed(1)
    grid += `<line class="grid" x1="${L}" y1="${y}" x2="${W - R}" y2="${y}"/><text class="tick" x="${L - 8}" y="${(Y(q) + 4).toFixed(1)}" text-anchor="end">${qFmt(q)}</text>`
  }
  const dots = pts
    .map((p) => {
      const x = X(p.rank).toFixed(1)
      const y = Y(p.x).toFixed(1)
      return `<a href="/curve/${p.id}"><circle class="dot" cx="${x}" cy="${y}" r="4"><title>rank &ge; ${p.rank}, ${qLabel} ${qFmt(p.x)}</title></circle></a>`
    })
    .join('')
  return `<svg class="rank-plot" viewBox="0 0 ${W} ${H}" role="img" aria-label="${qLabel} versus rank scatter plot">
      ${grid}
      <line class="axis" x1="${L}" y1="${T}" x2="${L}" y2="${T + plotH}"/>
      <line class="axis" x1="${L}" y1="${T + plotH}" x2="${W - R}" y2="${T + plotH}"/>
      <text class="axis-title" x="${L + plotW / 2}" y="${H - 6}" text-anchor="middle">rank (lower bound) &rarr;</text>
      <text class="axis-title" transform="rotate(-90)" x="${-(T + plotH / 2)}" y="15" text-anchor="middle">${qLabel} &rarr;</text>
      ${dots}
    </svg>`
}

export function landingPage(user: User | null = null, curves: PlotCurve[] = []): string {
  const inner = `
      <section class="hero">
        <p class="lede">Can we find elliptic curves of <a class="external" href="https://en.wikipedia.org/wiki/Rank_of_an_elliptic_curve"><em>high rank</em></a> and <em>small height or <a class="external" href="https://en.wikipedia.org/wiki/Conductor_of_an_elliptic_curve">conductor</a></em>?</p>
        <div class="eq-line">
          <span class="eq">y<sup>2</sup> + a<sub>1</sub>xy + a<sub>3</sub>y = x<sup>3</sup> + a<sub>2</sub>x<sup>2</sup> + a<sub>4</sub>x + a<sub>6</sub></span>
        </div>
      </section>
      <p>This site tracks elliptic curves <em>E</em>/&#8474; of high Mordell&ndash;Weil rank relative to their
      height &mdash; a leaderboard in the spirit of <a class="external" href="https://web.math.pmf.unizg.hr/~duje/tors/rankhist.html">Dujella's rank tables</a>,
      but ranking by height as well.</p>
      <p>Every entry is backed by an explicit list of rational points. We certify a <strong>rank lower bound</strong>
      without computing the exact rank: each point is checked to lie on the curve, and their
      N&eacute;ron&ndash;Tate height-pairing matrix is checked to be positive definite &mdash; so the points are
      independent in <em>E</em>(&#8474;), proving rank &ge; the number of points.</p>
      <section class="board">
        <h2>Plots</h2>
        <p class="muted board-caption">Each dot is a curve &mdash; click one for its witness. The frontier is down and to the right: high rank, small height/conductor. <a href="/database.json" download>Download the database (JSON) &darr;</a></p>
        <h3>naive height vs rank</h3>
        <p class="muted board-caption">Naive height = <span class="eq">log&#8201;max(|c<sub>4</sub>|<sup>3</sup>, |c<sub>6</sub>|<sup>2</sup>)</span>. Recorded for every curve.</p>
        ${scatterPlot(
          curves.map((c) => ({ id: c.id, rank: c.rank_lower_bound, x: c.naive_height })),
          'naive height',
          (v) => v.toFixed(0),
        )}
        <h3>Faltings height vs rank</h3>
        <p class="muted board-caption">Stable Faltings height (LMFDB normalization), computed from the period lattice and the minimal discriminant. Recorded when a submission supplies the curve's bad primes.</p>
        ${scatterPlot(
          curves.filter((c) => c.faltings_height != null).map((c) => ({ id: c.id, rank: c.rank_lower_bound, x: c.faltings_height as number })),
          'Faltings height',
          (v) => v.toFixed(1),
        )}
        <h3>log conductor vs rank</h3>
        <p class="muted board-caption">Natural log of the conductor <em>N</em> = &prod;<sub>p</sub> p<sup>f<sub>p</sub></sup> over bad primes. Recorded when a submission supplies the curve's bad primes.</p>
        ${scatterPlot(
          curves.filter((c) => c.conductor != null).map((c) => ({ id: c.id, rank: c.rank_lower_bound, x: logBigInt(c.conductor as string) })),
          'log conductor',
          (v) => v.toFixed(0),
        )}
      </section>

      <section class="submit">
        <h2>Submit a rank lower bound</h2>
        <p class="submit-help">Give the Weierstrass coefficients and a set of independent rational points.
        On submission we confirm the points lie on the curve and are linearly independent, then record
        the curve on the board.</p>
        <form method="post" action="/submit-form">
          <label class="field">
            <span>a-invariants <span class="muted">&mdash; [a<sub>4</sub>, a<sub>6</sub>] or [a<sub>1</sub>, a<sub>2</sub>, a<sub>3</sub>, a<sub>4</sub>, a<sub>6</sub>], comma- or space-separated</span></span>
            <input type="text" name="ainvs" ${user ? 'required' : 'disabled'} value="${escapeHtml(SAMPLE_AINVS)}" />
          </label>
          <label class="field">
            <span>points <span class="muted">&mdash; one per line, <code>x, y</code> (integers or rationals like <code>3/16</code>)</span></span>
            <textarea name="points" rows="12" ${user ? 'required' : 'disabled'}>${escapeHtml(SAMPLE_POINTS)}</textarea>
          </label>
          <label class="field">
            <span>bad primes <span class="muted">&mdash; optional; the primes dividing the discriminant, comma- or space-separated. If given, the conductor, minimal discriminant, and Faltings height are recorded.</span></span>
            <input type="text" name="primes" ${user ? '' : 'disabled'} placeholder="e.g. 2 3 389" />
          </label>
          <div class="submit-row">${
            user
              ? '<button type="submit">Submit</button>'
              : '<a class="login-to-submit" href="/auth/github">Log in to submit</a>'
          }</div>
        </form>
      </section>`
  return layout('Elliptic Rank', inner, user)
}

export interface CurveRow {
  id: number
  curve_key: string
  c4: string
  c6: string
  ainvs: string // JSON [a1..a6]
  discriminant: string
  naive_height: number
  rank_lower_bound: number
  regulator: string
  points: string // JSON [[x,y],...]
  conductor: string | null
  minimal_discriminant: string | null
  faltings_height: number | null
  submitter_name: string | null
  created_at: string
  updated_at: string
}

// Format the Weierstrass equation from a-invariants [a1,a2,a3,a4,a6], dropping
// zero terms, omitting a coefficient of 1, and using real +/- operators.
function weierstrassEq(ainvs: string[]): string {
  const [a1, a2, a3, a4, a6] = ainvs.length === 2 ? ['0', '0', '0', ...ainvs] : ainvs
  // A term with coefficient `coeff` multiplying `v` (HTML; '' for the constant).
  const term = (coeff: string, v: string): { neg: boolean; body: string } | null => {
    const neg = coeff.startsWith('-')
    const mag = coeff.replace(/^[+-]/, '')
    if (mag === '0') return null
    if (v === '') return { neg, body: escapeHtml(mag) } // constant: keep magnitude
    if (mag === '1') return { neg, body: v } // 1·v → v
    return { neg, body: escapeHtml(mag) + v }
  }
  const append = (base: string, t: ReturnType<typeof term>): string =>
    t ? `${base} ${t.neg ? '&minus;' : '+'} ${t.body}` : base
  let lhs = 'y<sup>2</sup>'
  lhs = append(lhs, term(a1, 'xy'))
  lhs = append(lhs, term(a3, 'y'))
  let rhs = 'x<sup>3</sup>'
  rhs = append(rhs, term(a2, 'x<sup>2</sup>'))
  rhs = append(rhs, term(a4, 'x'))
  rhs = append(rhs, term(a6, ''))
  return `${lhs} = ${rhs}`
}

// Escape commentary, turning `curve#<id>` tokens into links to that curve.
function renderCommentContent(content: string): string {
  let out = ''
  let last = 0
  for (const m of content.matchAll(/curve#(\d+)/g)) {
    out += escapeHtml(content.slice(last, m.index))
    out += `<a href="/curve/${m[1]}">curve#${m[1]}</a>`
    last = (m.index ?? 0) + m[0].length
  }
  return out + escapeHtml(content.slice(last))
}

function commentSection(curveId: number, comment: CommentView | null, user: User | null): string {
  const hasContent = !!comment && comment.content.length > 0
  const body = hasContent
    ? `<div class="comment-body">${renderCommentContent(comment!.content)}</div>`
    : `<p class="muted">No commentary yet.</p>`
  const meta = comment
    ? `<p class="comment-meta">last edited ${comment.author ? `by ${escapeHtml(comment.author)} ` : ''}at ${escapeHtml(comment.created_at)} &middot; <a href="/curve/${curveId}/commentary-history">history</a></p>`
    : ''
  const editor = user
    ? `<details class="comment-edit">
          <summary>edit</summary>
          <form method="post" action="/curve/${curveId}/commentary">
            <textarea name="content" rows="6" maxlength="${COMMENT_MAX}">${escapeHtml(comment?.content ?? '')}</textarea>
            <div><button type="submit">save</button> <span class="muted">submit empty to clear</span></div>
          </form>
        </details>`
    : `<p class="muted"><a href="/auth/github">Log in</a> to add commentary.</p>`
  return `<section class="comment-section">
        <h3>Commentary</h3>
        ${body}
        ${meta}
        ${editor}
      </section>`
}

export function curveDetailPage(
  curve: CurveRow,
  comment: CommentView | null = null,
  user: User | null = null,
): string {
  let ainvs: string[] = []
  let points: [string, string][] = []
  try {
    ainvs = JSON.parse(curve.ainvs)
    points = JSON.parse(curve.points)
  } catch {
    /* leave empty */
  }
  const eq = weierstrassEq(ainvs)
  const pointList = points
    .map(([x, y]) => `<li><code>(${escapeHtml(x)}, ${escapeHtml(y)})</code></li>`)
    .join('\n          ')
  const submitter = curve.submitter_name
    ? escapeHtml(curve.submitter_name)
    : '<span class="muted">anonymous</span>'
  const inner = `
      <p class="page-nav"><a href="/">&larr; the board</a></p>
      <h2>Rank &ge; ${curve.rank_lower_bound} curve</h2>
      <div class="curve-eq eq">${eq}</div>
      <dl class="result-meta">
        <dt>a-invariants</dt><dd><code>[${ainvs.map(escapeHtml).join(', ')}]</code></dd>
        <dt>rank (lower bound)</dt><dd>&ge; ${curve.rank_lower_bound}</dd>
        <dt>naive height</dt><dd>${curve.naive_height.toFixed(4)}</dd>
        ${curve.faltings_height != null ? `<dt>Faltings height</dt><dd>${curve.faltings_height.toFixed(4)}</dd>` : ''}
        ${curve.conductor ? `<dt>conductor</dt><dd><code class="break">${escapeHtml(curve.conductor)}</code></dd>` : ''}
        <dt>curve key</dt><dd><code>${escapeHtml(curve.curve_key)}</code> <span class="muted">(reduced c4:c6)</span></dd>
        <dt>discriminant</dt><dd><code class="break">${escapeHtml(curve.discriminant)}</code></dd>
        ${curve.minimal_discriminant ? `<dt>minimal discriminant</dt><dd><code class="break">${escapeHtml(curve.minimal_discriminant)}</code></dd>` : ''}
        <dt>regulator</dt><dd><code>${escapeHtml(curve.regulator)}</code></dd>
        <dt>submitted by</dt><dd>${submitter}</dd>
        <dt>last updated</dt><dd>${escapeHtml(curve.updated_at)}</dd>
      </dl>
      <section class="witness">
        <h3>Witness: ${points.length} independent points</h3>
        <ul class="point-list">
          ${pointList}
        </ul>
      </section>
      ${commentSection(curve.id, comment, user)}`
  return layout(`Rank ${curve.rank_lower_bound} curve — Elliptic Rank`, inner, user)
}

export function commentHistoryPage(
  curve: CurveRow,
  entries: CommentView[],
  user: User | null = null,
): string {
  const list = entries.length
    ? entries
        .map(
          (e) => `<li>
          <p class="comment-meta">${e.author ? escapeHtml(e.author) : '<span class="muted">(deleted user)</span>'} &middot; ${escapeHtml(e.created_at)}</p>
          ${e.content.length > 0 ? `<div class="comment-body">${renderCommentContent(e.content)}</div>` : `<p class="muted">(cleared)</p>`}
        </li>`,
        )
        .join('\n')
    : `<li class="muted">No commentary yet.</li>`
  const inner = `
      <p class="page-nav"><a href="/curve/${curve.id}">&larr; rank &ge; ${curve.rank_lower_bound} curve</a></p>
      <h2>Commentary history</h2>
      <p class="page-subtitle">${entries.length} edit${entries.length === 1 ? '' : 's'}.</p>
      <ul class="comment-history">${list}</ul>`
  return layout('Commentary history — Elliptic Rank', inner, user)
}

// Render a number-ish string, truncating very long values with an ellipsis.
function clip(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

// Outcome of recording a submitted curve on the leaderboard.
export interface SubmitInfo {
  status: 'created' | 'improved' | 'unchanged'
  rank: number
  previousRank?: number
  conductor?: boolean
}

function leaderboardStatus(submit: SubmitInfo | null): string {
  if (!submit) return ''
  let msg: string
  let added = true
  switch (submit.status) {
    case 'created':
      msg = 'Added to the leaderboard.'
      break
    case 'improved':
      msg = `Improved this curve's record from rank &ge; ${submit.previousRank} to rank &ge; ${submit.rank}.`
      break
    case 'unchanged':
      msg = `Already on the leaderboard at rank &ge; ${submit.rank}; this witness didn't improve it.`
      added = false
      break
  }
  const cond = submit.conductor ? ' Conductor, minimal discriminant &amp; Faltings height recorded.' : ''
  const tick = added || submit.conductor ? '&#10003; ' : ''
  const cls = added || submit.conductor ? 'leaderboard-status added' : 'leaderboard-status'
  return `<p class="${cls}">${tick}${msg}${cond}</p>`
}

export function submitResultPage(
  result: VerifyResult,
  user: User | null = null,
  submit: SubmitInfo | null = null,
): string {
  let inner: string
  if (result.ok && result.independence) {
    const ind = result.independence
    const c = result.curve!
    inner = `
      <p class="page-nav"><a href="/">&larr; submit another</a></p>
      <div class="result result-accepted">
        <h2>&#10003; Submitted: rank &ge; ${ind.rankLowerBound}</h2>
        <dl class="result-meta">
          <dt>points</dt><dd>${result.points.length}, all on the curve and independent</dd>
          <dt>curve key</dt><dd><code>${escapeHtml(clip(result.canonical?.key ?? '—', 60))}</code> <span class="muted">(reduced c4:c6)</span></dd>
          <dt>regulator</dt><dd><code>${escapeHtml(clip(ind.regulator))}</code></dd>
          <dt>min. eigenvalue</dt><dd><code>${escapeHtml(clip(ind.minEigenvalue))}</code></dd>
          <dt>naive height</dt><dd><code>${escapeHtml(clip(result.height!.naiveLogHeight))}</code></dd>
          ${result.faltingsHeight ? `<dt>Faltings height</dt><dd><code>${escapeHtml(clip(result.faltingsHeight))}</code></dd>` : ''}
          <dt>discriminant</dt><dd><code>${escapeHtml(clip(c.discriminant, 80))}</code></dd>
          ${result.conductor ? `<dt>conductor</dt><dd><code>${escapeHtml(clip(result.conductor, 80))}</code></dd>` : ''}
          ${result.minimalDiscriminant ? `<dt>minimal discriminant</dt><dd><code>${escapeHtml(clip(result.minimalDiscriminant, 80))}</code></dd>` : ''}
        </dl>
        <p class="result-method">${escapeHtml(ind.method)}.</p>
        ${result.conductorNote ? `<p class="muted">Conductor not recorded: ${escapeHtml(result.conductorNote)}.</p>` : ''}
        ${leaderboardStatus(submit)}
      </div>`
  } else {
    const offCurve = result.points.filter((p) => !p.onCurve).length
    const detail =
      result.points.length && offCurve
        ? `<p>${offCurve} of ${result.points.length} point(s) are not on the curve.</p>`
        : ''
    inner = `
      <p class="page-nav"><a href="/">&larr; back</a></p>
      <div class="result result-rejected">
        <h2>&#10007; Not accepted</h2>
        <ul class="result-errors">
          ${result.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('\n          ')}
        </ul>
        ${detail}
      </div>`
  }
  return layout('Submission result', inner, user)
}

export function apiDocsPage(user: User | null = null): string {
  const verifyReq = `curl -X POST https://elliptic-rank.icarm.cloud/api/submit \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer erank_...' \\
  -d '{
    "ainvs": ["0","0","1","-6349808647","193146346911036"],
    "points": [["49421","200114"], ["49493","333458"], ...],
    "primes": ["2","3","211",...]
  }'`
  const verifyResp = `{
  "ok": true,
  "curve":   { "ainvs": [...], "c4": "...", "c6": "...", "discriminant": "...", "nonsingular": true },
  "canonical": { "c4": "...", "c6": "...", "key": "304790815056:-166878443731135320" },
  "points":  [ { "point": ["49421","200114"], "onCurve": true }, ... ],
  "allPointsOnCurve": true,
  "independence": {
    "independent": true, "rankLowerBound": 12,
    "regulator": "...", "minEigenvalue": "...",
    "precisionDigits": 62, "stable": true, "method": "..."
  },
  "height": { "naiveLogHeight": "79.3286..." },
  "conductor": "...", "minimalDiscriminant": "...", "faltingsHeight": "...",  // if primes valid
  "leaderboard": { "status": "created", "rank": 12 }
}`
  const commentReq = `curl -X POST https://elliptic-rank.icarm.cloud/curve/123/commentary \\
  -H 'authorization: Bearer erank_...' \\
  --data-urlencode 'content=Found by Mestre (1982).'`
  const inner = `
      <p class="page-nav"><a href="/">&larr; home</a></p>
      <h2>API</h2>
      <p>All numbers are exact integers or rationals (e.g. <code>"49/4"</code>), passed
      <strong>as strings</strong> to avoid precision loss. <code>ainvs</code> may be the short
      <code>[a4, a6]</code> or full <code>[a1, a2, a3, a4, a6]</code> Weierstrass form. Every endpoint
      requires an <code>Authorization: Bearer &lt;token&gt;</code> header &mdash; create a token on
      your <a href="/profile">profile</a> page.</p>

      <h3>POST <code>/api/submit</code></h3>
      <p>Submits a curve with a set of witness points. The points are checked to lie on the curve, and
      their N&eacute;ron&ndash;Tate height-pairing matrix is checked to be positive definite (so they
      are independent in <em>E</em>(&#8474;), proving <code>rank &ge; #points</code>). On success the
      curve is <strong>recorded on the leaderboard</strong>, attributed to you. Body:
      <code>{ ainvs, points }</code>, where <code>points</code> is a list of <code>[x, y]</code>.</p>
      <p>Optionally include <code>primes</code>: the primes dividing the discriminant. If they check out
      (each prime, and together dividing the discriminant to a unit) the <strong>conductor</strong>,
      <strong>minimal discriminant</strong>, and <strong>Faltings height</strong> are computed and
      recorded &mdash; no factoring needed. Re-submitting an existing curve with <code>primes</code>
      backfills these even if the rank is unchanged.</p>
      <pre><code>${escapeHtml(verifyReq)}</code></pre>
      <p>Returns <code>200</code> with the result below, <code>422</code> if the submission is
      invalid (singular curve, point off curve, or not independent), <code>401</code> without a valid
      token, or <code>400</code> if the body isn't JSON. <code>independence.rankLowerBound</code> is
      the proven bound, <code>canonical.key</code> identifies the curve up to &#8474;-isomorphism, and
      the <code>leaderboard</code> field reports the outcome &mdash; <code>status</code> is
      <code>"created"</code>, <code>"improved"</code> (with <code>previousRank</code>), or
      <code>"unchanged"</code> (a curve's record only changes when a witness proves a strictly higher
      rank).</p>
      <pre><code>${escapeHtml(verifyResp)}</code></pre>

      <h3>GET <code>/database.json</code></h3>
      <p>The entire database as one JSON download: <code>{ count, curves }</code>, each curve with its
      a-invariants, witness points, rank lower bound, naive height, and (when recorded) conductor,
      minimal discriminant, Faltings height, submitter, and commentary. No auth required.</p>

      <h3>POST <code>/curve/:id/commentary</code></h3>
      <p>Edit a curve's commentary. Form-encoded <code>content</code>; an empty value clears it. Each
      edit is kept in the curve's commentary history.</p>
      <pre><code>${escapeHtml(commentReq)}</code></pre>`
  return layout('API — Elliptic Rank', inner, user)
}

export function profilePage(
  user: User,
  tokens: TokenRow[],
  newToken: { token: string; prefix: string } | null,
): string {
  const newTokenBlock = newToken
    ? `<div class="new-token">
        <p><strong>New token created.</strong> Copy it now &mdash; this is the only time it will be shown.</p>
        <pre class="token-secret">${escapeHtml(newToken.token)}</pre>
        <p class="muted">Send it as <code>Authorization: Bearer ${escapeHtml(newToken.token)}</code> when calling the API.</p>
      </div>`
    : ''
  const tokenRows = tokens.length
    ? tokens
        .map((t) => {
          const label = t.name ? escapeHtml(t.name) : '<span class="muted">(unnamed)</span>'
          const status = t.revoked_at
            ? `<span class="muted">revoked ${escapeHtml(t.revoked_at)}</span>`
            : `<form method="post" action="/profile/tokens/${t.id}/revoke" class="inline-form"><button type="submit" class="link-button">revoke</button></form>`
          const lastUsed = t.last_used_at
            ? escapeHtml(t.last_used_at)
            : '<span class="muted">never</span>'
          return `<tr>
            <td><code>${escapeHtml(t.prefix)}&hellip;</code></td>
            <td>${label}</td>
            <td>${escapeHtml(t.created_at)}</td>
            <td>${lastUsed}</td>
            <td>${status}</td>
          </tr>`
        })
        .join('\n')
    : `<tr><td colspan="5" class="muted">No tokens yet.</td></tr>`
  const inner = `
      <p class="page-nav"><a href="/">&larr; home</a></p>
      <h2>Profile</h2>
      <p class="page-subtitle">Signed in as ${escapeHtml(user.display_name || user.email || 'user')} (via ${escapeHtml(user.provider)}).</p>
      ${newTokenBlock}
      <section class="profile-name">
        <h3>Display name</h3>
        <form method="post" action="/profile/name" class="profile-name-form">
          <input type="text" name="name" value="${escapeHtml(user.display_name || '')}" maxlength="100" required />
          <button type="submit">save</button>
        </form>
      </section>
      <section class="tokens">
        <h3>API tokens</h3>
        <p>Send a token in the <code>Authorization: Bearer &hellip;</code> header to call the <a href="/api">API</a> as yourself.</p>
        <table class="tokens-table">
          <thead><tr><th>Prefix</th><th>Name</th><th>Created</th><th>Last used</th><th></th></tr></thead>
          <tbody>${tokenRows}</tbody>
        </table>
        <form method="post" action="/profile/tokens" class="new-token-form">
          <label>Name (optional) <input type="text" name="name" maxlength="100" placeholder="e.g. laptop CLI" /></label>
          <button type="submit">Generate new token</button>
        </form>
      </section>`
  return layout('Profile — Elliptic Rank', inner, user)
}

export function notFoundPage(user: User | null = null): string {
  return layout(
    'Not found',
    `<p class="page-nav"><a href="/">&larr; home</a></p><h2>Not found</h2><p>No such page.</p>`,
    user,
  )
}
