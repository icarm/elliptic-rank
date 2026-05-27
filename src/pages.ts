// Server-rendered HTML pages. Plain template literals (like eq677), with a
// shared layout that already accommodates an authenticated user in the header
// so GitHub login / profiles can slot in later without reworking the chrome.

import type { VerifyResult } from './verify'

export interface User {
  display_name?: string
  email?: string
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

export function landingPage(user: User | null = null): string {
  const inner = `
      <section class="hero">
        <p class="lede">Which elliptic curves over &#8474; pack the most <em>rank</em> into the least <em>height</em>?</p>
        <div class="eq-line">
          <span class="eq">y<sup>2</sup> + a<sub>1</sub>xy + a<sub>3</sub>y = x<sup>3</sup> + a<sub>2</sub>x<sup>2</sup> + a<sub>4</sub>x + a<sub>6</sub></span>
        </div>
      </section>
      <p>This site tracks elliptic curves <em>E</em>/&#8474; of high Mordell&ndash;Weil rank relative to their
      height &mdash; a leaderboard in the spirit of <a class="external" href="https://web.math.pmf.unizg.hr/~duje/tors/tors.html">Dujella's rank tables</a>,
      but ranking by height as well.</p>
      <p>Every entry is backed by an explicit list of rational points. We certify a <strong>rank lower bound</strong>
      without computing the exact rank: each point is checked to lie on the curve, and their
      N&eacute;ron&ndash;Tate height-pairing matrix is verified to be positive definite &mdash; so the points are
      independent in <em>E</em>(&#8474;), proving rank &ge; the number of points.</p>
      <p>Height is the naive height <span class="eq">log&#8201;max(|c<sub>4</sub>|<sup>3</sup>, |c<sub>6</sub>|<sup>2</sup>)</span>.</p>
      <p class="browse-cta"><span class="muted">Leaderboard coming soon &mdash;</span> for now, verify a curve below.</p>

      <section class="submit">
        <h2>Verify a rank lower bound</h2>
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
          <div class="submit-row"><button type="submit">Verify</button></div>
        </form>
      </section>`
  return layout('Elliptic Rank', inner, user)
}

// Render a number-ish string, truncating very long values with an ellipsis.
function clip(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

export function verifyResultPage(result: VerifyResult, user: User | null = null): string {
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
          <dt>regulator</dt><dd><code>${escapeHtml(clip(ind.regulator))}</code></dd>
          <dt>min. eigenvalue</dt><dd><code>${escapeHtml(clip(ind.minEigenvalue))}</code></dd>
          <dt>naive height</dt><dd><code>${escapeHtml(clip(result.height!.naiveLogHeight))}</code></dd>
          <dt>discriminant</dt><dd><code>${escapeHtml(clip(c.discriminant, 80))}</code></dd>
        </dl>
        <p class="result-method">${escapeHtml(ind.method)}.</p>
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
      <pre><code>${escapeHtml(example)}</code></pre>`
  return layout('API — Elliptic Rank', inner, user)
}

export function notFoundPage(user: User | null = null): string {
  return layout(
    'Not found',
    `<p class="page-nav"><a href="/">&larr; home</a></p><h2>Not found</h2><p>No such page.</p>`,
    user,
  )
}
