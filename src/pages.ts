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
}

// Server-rendered SVG scatter of rank (y) vs naive height (x). Each dot is an
// anchor to the curve's page, so the plot is fully clickable without any JS.
function rankHeightPlot(curves: PlotCurve[]): string {
  if (curves.length === 0) {
    return `<p class="muted plot-empty">No curves on the board yet &mdash; verify one below to be the first.</p>`
  }
  const W = 720, H = 440, L = 54, R = 18, T = 18, B = 46
  const plotW = W - L - R, plotH = H - T - B
  const heights = curves.map((c) => c.naive_height)
  let xmin = Math.min(...heights), xmax = Math.max(...heights)
  if (xmin === xmax) { xmin -= 1; xmax += 1 }
  const xpad = (xmax - xmin) * 0.05
  xmin -= xpad
  xmax += xpad
  const ymax = Math.max(...curves.map((c) => c.rank_lower_bound)) + 1
  const X = (h: number) => L + ((h - xmin) / (xmax - xmin)) * plotW
  const Y = (r: number) => T + plotH - (r / ymax) * plotH

  let grid = ''
  const yStep = ymax <= 14 ? 1 : Math.ceil(ymax / 10)
  for (let r = 0; r <= ymax; r += yStep) {
    const y = Y(r).toFixed(1)
    grid += `<line class="grid" x1="${L}" y1="${y}" x2="${W - R}" y2="${y}"/><text class="tick" x="${L - 8}" y="${(Y(r) + 4).toFixed(1)}" text-anchor="end">${r}</text>`
  }
  for (let i = 0; i <= 5; i++) {
    const h = xmin + (i / 5) * (xmax - xmin)
    const x = X(h).toFixed(1)
    grid += `<line class="grid" x1="${x}" y1="${T}" x2="${x}" y2="${T + plotH}"/><text class="tick" x="${x}" y="${T + plotH + 18}" text-anchor="middle">${h.toFixed(0)}</text>`
  }
  const dots = curves
    .map((c) => {
      const x = X(c.naive_height).toFixed(1)
      const y = Y(c.rank_lower_bound).toFixed(1)
      return `<a href="/curve/${c.id}"><circle class="dot" cx="${x}" cy="${y}" r="4"><title>rank &ge; ${c.rank_lower_bound}, height ${c.naive_height.toFixed(2)}</title></circle></a>`
    })
    .join('')
  return `<svg class="rank-plot" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rank versus height scatter plot of all curves">
      ${grid}
      <line class="axis" x1="${L}" y1="${T}" x2="${L}" y2="${T + plotH}"/>
      <line class="axis" x1="${L}" y1="${T + plotH}" x2="${W - R}" y2="${T + plotH}"/>
      <text class="axis-title" x="${L + plotW / 2}" y="${H - 6}" text-anchor="middle">naive height &rarr;</text>
      <text class="axis-title" transform="rotate(-90)" x="${-(T + plotH / 2)}" y="15" text-anchor="middle">rank (lower bound) &rarr;</text>
      ${dots}
    </svg>`
}

export function landingPage(user: User | null = null, curves: PlotCurve[] = []): string {
  const inner = `
      <section class="hero">
        <p class="lede">Can we find elliptic curves of <em>high rank</em> and <em>low height</em>?</p>
        <div class="eq-line">
          <span class="eq">y<sup>2</sup> + a<sub>1</sub>xy + a<sub>3</sub>y = x<sup>3</sup> + a<sub>2</sub>x<sup>2</sup> + a<sub>4</sub>x + a<sub>6</sub></span>
        </div>
      </section>
      <p>This site tracks elliptic curves <em>E</em>/&#8474; of high Mordell&ndash;Weil rank relative to their
      height &mdash; a leaderboard in the spirit of <a class="external" href="https://web.math.pmf.unizg.hr/~duje/tors/rankhist.html">Dujella's rank tables</a>,
      but ranking by height as well.</p>
      <p>Every entry is backed by an explicit list of rational points. We certify a <strong>rank lower bound</strong>
      without computing the exact rank: each point is checked to lie on the curve, and their
      N&eacute;ron&ndash;Tate height-pairing matrix is verified to be positive definite &mdash; so the points are
      independent in <em>E</em>(&#8474;), proving rank &ge; the number of points.</p>
      <p>Height is the naive height <span class="eq">log&#8201;max(|c<sub>4</sub>|<sup>3</sup>, |c<sub>6</sub>|<sup>2</sup>)</span>.</p>
      <section class="board">
        <h2>The board</h2>
        ${rankHeightPlot(curves)}
        <p class="muted board-caption">Each dot is a curve &mdash; click one for its witness. The frontier is up and to the left: high rank, low height.</p>
      </section>

      <section class="submit">
        <h2>Submit a rank lower bound</h2>
        <p class="submit-help">Give the Weierstrass coefficients and a set of independent rational points.
        We confirm the points lie on the curve and are linearly independent.</p>
        <form method="post" action="/verify-form">
          <label class="field">
            <span>a-invariants <span class="muted">&mdash; [a<sub>4</sub>, a<sub>6</sub>] or [a<sub>1</sub>, a<sub>2</sub>, a<sub>3</sub>, a<sub>4</sub>, a<sub>6</sub>], comma- or space-separated</span></span>
            <input type="text" name="ainvs" required value="${escapeHtml(SAMPLE_AINVS)}" />
          </label>
          <label class="field">
            <span>points <span class="muted">&mdash; one per line, <code>x, y</code> (integers or rationals like <code>3/16</code>)</span></span>
            <textarea name="points" rows="12" required>${escapeHtml(SAMPLE_POINTS)}</textarea>
          </label>
          <div class="submit-row"><button type="submit">Submit</button></div>
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
        <dt>curve key</dt><dd><code>${escapeHtml(curve.curve_key)}</code> <span class="muted">(reduced c4:c6)</span></dd>
        <dt>discriminant</dt><dd><code class="break">${escapeHtml(curve.discriminant)}</code></dd>
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

// Outcome of recording the verified curve to the leaderboard (or a prompt to
// log in when the verifier was anonymous).
export type SubmitInfo =
  | { status: 'anonymous' }
  | { status: 'created'; rank: number }
  | { status: 'improved'; rank: number; previousRank: number }
  | { status: 'unchanged'; rank: number }

function leaderboardStatus(submit: SubmitInfo | null): string {
  if (!submit) return ''
  switch (submit.status) {
    case 'anonymous':
      return `<p class="leaderboard-status"><a href="/auth/github">Log in with GitHub</a> to add this curve to the leaderboard.</p>`
    case 'created':
      return `<p class="leaderboard-status added">&#10003; Added to the leaderboard.</p>`
    case 'improved':
      return `<p class="leaderboard-status added">&#10003; Improved this curve's record from rank &ge; ${submit.previousRank} to rank &ge; ${submit.rank}.</p>`
    case 'unchanged':
      return `<p class="leaderboard-status">Already on the leaderboard at rank &ge; ${submit.rank}; this witness didn't improve it.</p>`
  }
}

export function verifyResultPage(
  result: VerifyResult,
  user: User | null = null,
  submit: SubmitInfo | null = null,
): string {
  let inner: string
  if (result.ok && result.independence) {
    const ind = result.independence
    const c = result.curve!
    inner = `
      <p class="page-nav"><a href="/">&larr; verify another</a></p>
      <div class="result result-accepted">
        <h2>&#10003; Verified: rank &ge; ${ind.rankLowerBound}</h2>
        <dl class="result-meta">
          <dt>points</dt><dd>${result.points.length}, all on the curve and independent</dd>
          <dt>curve key</dt><dd><code>${escapeHtml(clip(result.canonical?.key ?? '—', 60))}</code> <span class="muted">(reduced c4:c6)</span></dd>
          <dt>regulator</dt><dd><code>${escapeHtml(clip(ind.regulator))}</code></dd>
          <dt>min. eigenvalue</dt><dd><code>${escapeHtml(clip(ind.minEigenvalue))}</code></dd>
          <dt>naive height</dt><dd><code>${escapeHtml(clip(result.height!.naiveLogHeight))}</code></dd>
          <dt>discriminant</dt><dd><code>${escapeHtml(clip(c.discriminant, 80))}</code></dd>
        </dl>
        <p class="result-method">${escapeHtml(ind.method)}.</p>
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
        <h2>&#10007; Not verified</h2>
        <ul class="result-errors">
          ${result.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('\n          ')}
        </ul>
        ${detail}
      </div>`
  }
  return layout('Verification result', inner, user)
}

export function apiDocsPage(user: User | null = null): string {
  const example = `curl -X POST https://elliptic-rank.icarm.cloud/api/verify \\
  -H 'content-type: application/json' \\
  -d '{
    "ainvs": ["0","0","1","-6349808647","193146346911036"],
    "points": [["49421","200114"], ["49493","333458"]]
  }'`
  const inner = `
      <p class="page-nav"><a href="/">&larr; home</a></p>
      <h2>API</h2>
      <p>One endpoint certifies a rank lower bound from a curve and witness points.</p>
      <h3>POST <code>/api/verify</code></h3>
      <p>Body: JSON <code>{ ainvs, points }</code>. <code>ainvs</code> is <code>[a4,a6]</code> or
      <code>[a1,a2,a3,a4,a6]</code>; <code>points</code> is a list of <code>[x,y]</code>. All values are
      integers or rationals, given as strings. Returns <code>200</code> with the verification result, or
      <code>422</code> if the submission is invalid.</p>
      <pre><code>${escapeHtml(example)}</code></pre>
      <h3>Authentication</h3>
      <p>Verification is open and needs no auth. To act as yourself (e.g. for attribution),
      add an <code>Authorization: Bearer &lt;token&gt;</code> header. Create a token on your
      <a href="/profile">profile</a> page.</p>`
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
