// Server-rendered HTML pages. Plain template literals (like eq677), with a
// shared layout that already accommodates an authenticated user in the header
// so GitHub login / profiles can slot in later without reworking the chrome.

import type { VerifyResult } from './verify'
import { COMMENT_MAX, lessDecimal, lessAbsDecimal, type CommentView, type ActivityItem } from './store'

export const ABOUT_MAX = 1000

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

// Timestamps come from SQLite's CURRENT_TIMESTAMP, which is UTC; say so
// wherever one is displayed.
function utcTime(ts: string): string {
  return `${escapeHtml(ts)} UTC`
}

// A user's name, linked to their public page when we know who they are.
function userLink(id: number | null | undefined, name: string | null | undefined): string {
  if (id == null) return '<span class="muted">anonymous</span>'
  return `<a href="/user/${id}">${escapeHtml(name || `user #${id}`)}</a>`
}

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

const SITE_ORIGIN = 'https://elliptic-rank.icarm.cloud'
const SITE_DESCRIPTION =
  'Can we find small elliptic curves of high rank? A leaderboard of certified ' +
  'Mordell–Weil rank lower bounds, ordered by naive height, Faltings height, and conductor.'

export function layout(title: string, bodyInner: string, user: User | null = null): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(SITE_DESCRIPTION)}" />
    <meta property="og:site_name" content="Elliptic Curve Rank Leaderboard" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(SITE_DESCRIPTION)}" />
    <meta property="og:image" content="${SITE_ORIGIN}/og.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
    <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png" />
    <link rel="apple-touch-icon" sizes="180x180" href="/favicon-180.png" />
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <header>
      <div class="inner">
        <h1><a href="/">Elliptic Curve Rank Leaderboard</a></h1>
        <nav><span class="auth-nav">${authNav(user)}</span></nav>
      </div>
    </header>
    <main>${bodyInner}</main>
    <footer>
      <nav class="footer-links">
        <a href="/curves">all curves</a> &nbsp;&middot;&nbsp;
        <a href="/recent">recent activity</a> &nbsp;&middot;&nbsp;
        <a href="/api">API</a> &nbsp;&middot;&nbsp;
        <a class="external" href="https://github.com/icarm/elliptic-rank">source</a> &nbsp;&middot;&nbsp;
        <a class="external" href="https://icarm.zulipchat.com/#narrow/channel/519875-general/topic/Elliptic.20Curve.20Rank.20Leaderboard/near/603443505">zulip</a> &nbsp;&middot;&nbsp;
        <a class="external" href="https://icarm.io">icarm.io</a>
      </nav>
      <p class="acknowledgment">This website is maintained by the NSF Institute for Computer-Aided
      Reasoning in Mathematics <span class="nowrap">(<a class="external" href="https://icarm.io">ICARM</a>)</span>. Please <a href="/acknowledge">acknowledge</a> ICARM and NSF Grant DMS 2425401 in related publications,
      projects, or other scholarly work.</p>
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
  discriminant: string
}

export interface ProgressCurve {
  id: number
  rank_lower_bound: number
  naive_height: number
  faltings_height: number | null
  conductor: string | null
  discriminant: string
}

type ProgressMetric = 'conductor' | 'naive' | 'faltings' | 'disc'

// 'disc' matches the landing page's ?metric= values and the table's sort key;
// 'discriminant' is accepted as a legacy spelling from earlier /progress URLs.
function progressMetricKey(metric: string | undefined): ProgressMetric {
  if (metric === 'discriminant') return 'disc'
  return metric === 'naive' || metric === 'faltings' || metric === 'conductor' || metric === 'disc'
    ? metric
    : 'conductor'
}

// Natural log of |n| for a big integer given as a (possibly signed) decimal
// string.
export function logBigInt(s: string): number {
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
// `sort` is the table column key for this plot's quantity ('conductor',
// 'naive', or 'faltings'); the rank ticks link to the table filtered to that
// rank and sorted on it (ascending — smallest first, matching the frontier).
function scatterPlot(pts: PlotPoint[], qLabel: string, qFmt: (v: number) => string, sort: string): string {
  if (pts.length === 0) {
    return `<p class="muted plot-empty">No curves with a recorded ${qLabel} yet.</p>`
  }
  const W = 720, H = 440, L = 60, R = 18, T = 18, B = 46
  const plotW = W - L - R, plotH = H - T - B
  // A point is on the frontier (a record) when no curve of equal or higher rank
  // has a smaller value — the same rule that earns the star badge on curve pages.
  const minByRank = new Map<number, number>()
  for (const p of pts) {
    const prev = minByRank.get(p.rank)
    if (prev == null || p.x < prev) minByRank.set(p.rank, p.x)
  }
  const frontierValueByRank = new Map<number, number>()
  let bestAtHigherRank = Infinity
  const ranks = [...minByRank.keys()].sort((a, b) => b - a)
  for (const rank of ranks) {
    const rankMin = minByRank.get(rank)!
    frontierValueByRank.set(rank, Math.min(rankMin, bestAtHigherRank))
    if (rankMin < bestAtHigherRank) bestAtHigherRank = rankMin
  }
  const isRecord = (p: PlotPoint): boolean => p.x <= frontierValueByRank.get(p.rank)!
  // Best in its rank column (ties included) — unlike isRecord, every rank that
  // has any point has a best, even when a higher rank beats its minimum. The
  // default plot view shows only these.
  const isBest = (p: PlotPoint): boolean => p.x <= minByRank.get(p.rank)!
  // Scale to the best curve per rank — the dots the default view shows — so a
  // deliberately huge low-rank submission cannot stretch the axis for everyone.
  // (The global minimum is always a per-rank best, so nothing falls below the
  // scale; dots above it are skipped when drawing, with a note.)
  const scaleQs = pts.filter(isBest).map((p) => p.x)
  let qmin = Math.min(...scaleQs), qmax = Math.max(...scaleQs)
  if (qmin === qmax) { qmin -= 1; qmax += 1 }
  const qpad = (qmax - qmin) * 0.05
  qmin -= qpad
  qmax += qpad
  const rankMax = Math.max(...pts.map((p) => p.rank)) + 1
  const X = (r: number) => L + (r / rankMax) * plotW
  const Y = (q: number) => T + plotH - ((q - qmin) / (qmax - qmin)) * plotH

  let grid = ''
  // Gridlines and numeric labels are spaced out for readability, but every
  // integer rank is clickable: labeled ranks use their number as the target,
  // unlabeled ones get a small tick mark, and each owns a full-width hit column.
  const rStep = rankMax <= 16 ? 1 : Math.ceil(rankMax / 12)
  const dx = plotW / rankMax // x-distance between adjacent integer ranks
  for (let r = 0; r <= rankMax; r++) {
    const x = X(r)
    const labeled = r % rStep === 0
    if (labeled) {
      grid += `<line class="grid" x1="${x.toFixed(1)}" y1="${T}" x2="${x.toFixed(1)}" y2="${T + plotH}"/>`
    }
    const label = labeled
      ? `<text class="tick" x="${x.toFixed(1)}" y="${T + plotH + 18}" text-anchor="middle">${r}</text>`
      : ''
    // r = 0 is the axis origin (rank ≥ 0 = everything) and rankMax is empty
    // padding past the data, so link only the real ranks 1..rankMax-1. Every
    // rank gets a tick mark: a short one under the numbered ranks, a taller one
    // for the in-between ranks that have no label.
    if (r >= 1 && r < rankMax) {
      const tickLen = labeled ? 5 : 10
      const mark = `<line class="tick-mark" x1="${x.toFixed(1)}" y1="${T + plotH}" x2="${x.toFixed(1)}" y2="${T + plotH + tickLen}"/>`
      const hit = `<rect class="tick-hit" x="${(x - dx / 2).toFixed(1)}" y="${T + plotH}" width="${dx.toFixed(1)}" height="22"/>`
      grid += `<a class="tick-link" href="/curves?sort=${sort}&amp;minrank=${r}&amp;rankmode=eq"><title>curves with rank lower bound = ${r}</title>${hit}${mark}${label}</a>`
    } else {
      grid += label
    }
  }
  for (let i = 0; i <= 5; i++) {
    const q = qmin + (i / 5) * (qmax - qmin)
    const y = Y(q).toFixed(1)
    grid += `<line class="grid" x1="${L}" y1="${y}" x2="${W - R}" y2="${y}"/><text class="tick" x="${L - 8}" y="${(Y(q) + 4).toFixed(1)}" text-anchor="end">${qFmt(q)}</text>`
  }
  const dot = (p: PlotPoint): string => {
    const x = X(p.rank).toFixed(1)
    const y = Y(p.x).toFixed(1)
    return `<a href="/curve/${p.id}"><circle class="dot${isBest(p) ? ' best' : ''}" cx="${x}" cy="${y}" r="4"><title>curve #${p.id}: rank &ge; ${p.rank}, ${qLabel} ${qFmt(p.x)}</title></circle></a>`
  }
  // Non-records first, records last so they paint on top of any overlapping dot
  // and are therefore the easiest to click.
  const visible = pts.filter((p) => p.x <= qmax)
  const dots = visible.filter((p) => !isRecord(p)).map(dot).join('')
  const records = visible.filter(isRecord).map(dot).join('')
  return `<svg class="rank-plot" viewBox="0 0 ${W} ${H}" role="img" aria-label="${qLabel} versus rank scatter plot">
      ${grid}
      <line class="axis" x1="${L}" y1="${T}" x2="${L}" y2="${T + plotH}"/>
      <line class="axis" x1="${L}" y1="${T + plotH}" x2="${W - R}" y2="${T + plotH}"/>
      <text class="axis-title" x="${L + plotW / 2}" y="${H - 6}" text-anchor="middle">rank (lower bound) &rarr;</text>
      <text class="axis-title" transform="rotate(-90)" x="${-(T + plotH / 2)}" y="15" text-anchor="middle">size (${qLabel}) &rarr;</text>
      ${dots}
      ${records}
    </svg>`
}

export function progressPage(
  curves: ProgressCurve[],
  user: User | null = null,
  requestedStartId?: number,
  requestedMetric?: string,
): string {
  if (curves.length === 0) {
    return layout(
      'Progress — Elliptic Curve Rank Leaderboard',
      `<p class="page-nav"><a href="/">&larr; home</a></p>
      <h2>Progress</h2>
      <p class="muted">No curves recorded yet.</p>`,
      user,
    )
  }

  const selectedMetric = progressMetricKey(requestedMetric)
  const metricLabels: Record<ProgressMetric, string> = {
    conductor: 'log conductor',
    naive: 'naive height',
    faltings: 'Faltings height',
    disc: 'log |discriminant|',
  }
  const referenceCurves = [
    {
      key: 'c1',
      c: 1,
      label: 'c = 1',
      equation: 'r = 1 * (log N) / (log (log N))',
      className: 'progress-ref-c1',
    },
    {
      key: 'c0865',
      c: 0.865,
      label: 'c = 0.865',
      equation: 'r = 0.865 * (log N) / (log (log N))',
      className: 'progress-ref-c0865',
    },
    {
      key: 'c05',
      c: 0.5,
      label: 'c = 0.5',
      equation: 'r = 0.5 * (log N) / (log (log N))',
      className: 'progress-ref-c05',
    },
  ] as const
  const fmtMetric = (metric: ProgressMetric, value: number): string =>
    metric === 'faltings' ? value.toFixed(2) : value.toFixed(0)
  const pts = curves
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((c) => ({
      id: c.id,
      rank: c.rank_lower_bound,
      conductor: c.conductor == null ? null : logBigInt(c.conductor),
      naive: c.naive_height,
      faltings: c.faltings_height,
      disc: logBigInt(c.discriminant),
    }))
  const W = 900, H = 540, L = 68, R = 28, T = 22, B = 54
  const plotW = W - L - R, plotH = H - T - B
  const rankMax = Math.max(...pts.map((p) => p.rank)) + 1
  const X = (r: number) => L + (r / rankMax) * plotW
  const scaleForMetric = (metric: ProgressMetric): { qmin: number; qmax: number } => {
    const qs = pts
      .map((p) => p[metric])
      .filter((v): v is number => v != null)
    if (qs.length === 0) return { qmin: 0, qmax: 1 }
    let qmin = Math.min(...qs), qmax = Math.max(...qs)
    if (qmin === qmax) { qmin -= 1; qmax += 1 }
    const qpad = (qmax - qmin) * 0.05
    return { qmin: qmin - qpad, qmax: qmax + qpad }
  }
  const initialScale = scaleForMetric(selectedMetric)
  const Y = (q: number, scale = initialScale) => T + plotH - ((q - scale.qmin) / (scale.qmax - scale.qmin)) * plotH
  const conductorScale = scaleForMetric('conductor')
  const referenceGeometry = (c: number, scale: { qmin: number; qmax: number }) => {
    const qStart = Math.max(scale.qmin, 1.000001)
    const qEnd = scale.qmax
    if (qEnd <= qStart) return { d: '', label: null as null | { x: number; y: number; anchor: string } }
    let d = ''
    let drawing = false
    let last: null | { x: number; y: number } = null
    for (let i = 0; i <= 180; i++) {
      const q = qStart + (i / 180) * (qEnd - qStart)
      const denom = Math.log(q)
      const rank = c * q / denom
      if (!Number.isFinite(rank) || rank < 0 || rank > rankMax) {
        drawing = false
        continue
      }
      const x = X(rank)
      const y = Y(q, scale)
      d += `${drawing ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
      drawing = true
      last = { x, y }
    }
    if (last == null) return { d, label: null }
    const nearRight = last.x > W - R - 80
    return {
      d,
      label: {
        x: nearRight ? Math.max(L + 8, last.x - 8) : Math.min(W - R - 8, last.x + 8),
        y: Math.max(T + 16, Math.min(T + plotH - 8, last.y - 6)),
        anchor: nearRight ? 'end' : 'start',
      },
    }
  }
  const maxId = pts[pts.length - 1].id
  const initialStartId = requestedStartId === undefined
    ? 0
    : Math.min(maxId, Math.max(0, requestedStartId))
  const initialId = initialStartId

  let grid = ''
  const rStep = rankMax <= 16 ? 1 : Math.ceil(rankMax / 12)
  for (let r = 0; r <= rankMax; r++) {
    const x = X(r).toFixed(1)
    if (r % rStep === 0) {
      grid += `<line class="grid" x1="${x}" y1="${T}" x2="${x}" y2="${T + plotH}"/><text class="tick" x="${x}" y="${T + plotH + 20}" text-anchor="middle">${r}</text>`
    }
  }
  for (let i = 0; i <= 5; i++) {
    const q = initialScale.qmin + (i / 5) * (initialScale.qmax - initialScale.qmin)
    const y = (T + plotH - (i / 5) * plotH).toFixed(1)
    grid += `<line class="grid" x1="${L}" y1="${y}" x2="${W - R}" y2="${y}"/><text class="tick progress-y-tick" data-tick="${i}" x="${L - 8}" y="${(Number(y) + 4).toFixed(1)}" text-anchor="end">${fmtMetric(selectedMetric, q)}</text>`
  }

  const dots = pts
    .map((p) => {
      const value = p[selectedMetric]
      const baseline = value != null && p.id <= initialStartId
      const active = value != null && p.id > initialStartId && p.id <= initialId
      const title = value == null
        ? `curve #${p.id}: ${metricLabels[selectedMetric]} not recorded`
        : `curve #${p.id}: rank >= ${p.rank}, ${metricLabels[selectedMetric]} ${fmtMetric(selectedMetric, value)}`
      return `<a href="/curve/${p.id}" class="progress-link" data-id="${p.id}">
          <circle class="progress-dot${baseline ? ' is-baseline' : ''}${active ? ' is-visible' : ''}" cx="${X(p.rank).toFixed(1)}" cy="${value == null ? (T + plotH).toFixed(1) : Y(value).toFixed(1)}" r="${baseline ? '3.5' : active ? '5' : '0'}">
            <title>${title}</title>
          </circle>
        </a>`
    })
    .join('\n')
  const ids = JSON.stringify(pts.map((p) => p.id)).replace(/</g, '\\u003c')
  const progressData = JSON.stringify(pts).replace(/</g, '\\u003c')
  const referenceData = JSON.stringify(referenceCurves.map(({ key, c, label, equation }) => ({ key, c, label, equation }))).replace(/</g, '\\u003c')
  const metricControls = (['conductor', 'naive', 'faltings', 'disc'] as const)
    .map((key) => `<label><input type="radio" name="progress-metric" value="${key}"${key === selectedMetric ? ' checked' : ''} /><span>${metricLabels[key]}</span></label>`)
    .join('\n')
  const referenceControls = referenceCurves
    .map((curve) => `<label title="${curve.equation}"><input class="progress-reference-toggle" type="checkbox" value="${curve.key}"${selectedMetric === 'conductor' ? '' : ' disabled'} /><span class="progress-ref-swatch ${curve.className}"></span><span>${curve.label.replace('c = ', 'c=')}</span></label>`)
    .join('\n')
  const referenceCurvesMarkup = referenceCurves
    .map((curve) => {
      const geom = referenceGeometry(curve.c, conductorScale)
      return `<path class="progress-reference-line ${curve.className}" data-ref="${curve.key}" d="${geom.d}">
            <title>${curve.equation}</title>
          </path>
          <text class="progress-reference-label ${curve.className}" data-ref-label="${curve.key}" x="${geom.label?.x.toFixed(1) ?? 0}" y="${geom.label?.y.toFixed(1) ?? 0}" text-anchor="${geom.label?.anchor ?? 'start'}"${geom.label == null ? ' style="display:none"' : ''}>${curve.label}</text>`
    })
    .join('\n')
  const referenceHiddenClass = selectedMetric === 'conductor' ? '' : ' is-hidden'
  const referenceControlsDisabledClass = selectedMetric === 'conductor' ? '' : ' is-disabled'

  const inner = `
      <p class="page-nav"><a href="/">&larr; home</a></p>
      <h2>Progress</h2>
      <section class="progress-tool">
        <div class="progress-controls">
          <div class="progress-metric" role="radiogroup" aria-label="plot measure">
            <span class="progress-control-label">measure</span>
            ${metricControls}
          </div>
          <div id="progress-reference-controls" class="progress-reference-controls${referenceControlsDisabledClass}">
            <span class="progress-control-label">reference curves</span>
            <span class="progress-reference-formula">r = c * log N / log log N</span>
            <span class="progress-reference-separator" aria-hidden="true"></span>
            ${referenceControls}
          </div>
          <label for="progress-start">starting id</label>
          <input id="progress-start" type="range" min="0" max="${maxId}" value="${initialStartId}" step="1" />
          <output id="progress-start-current" for="progress-start">#${initialStartId}</output>
          <label class="progress-row-start" for="progress-id">curve id</label>
          <input id="progress-id" type="range" min="0" max="${maxId}" value="${initialId}" step="1" />
          <output id="progress-current" for="progress-id">#${initialId}</output>
          <button id="progress-play" type="button">Play</button>
          <span id="progress-count" class="muted">0 / ${pts.length}</span>
        </div>
        <svg class="rank-plot progress-plot" viewBox="0 0 ${W} ${H}" role="img" aria-label="${metricLabels[selectedMetric]} versus rank over time">
          <defs>
            <clipPath id="progress-plot-clip">
              <rect x="${L}" y="${T}" width="${plotW}" height="${plotH}"/>
            </clipPath>
          </defs>
          ${grid}
          <line class="axis" x1="${L}" y1="${T}" x2="${L}" y2="${T + plotH}"/>
          <line class="axis" x1="${L}" y1="${T + plotH}" x2="${W - R}" y2="${T + plotH}"/>
          <text class="axis-title" x="${L + plotW / 2}" y="${H - 8}" text-anchor="middle">rank (lower bound) &rarr;</text>
          <text id="progress-y-title" class="axis-title" transform="rotate(-90)" x="${-(T + plotH / 2)}" y="16" text-anchor="middle">${metricLabels[selectedMetric]} &rarr;</text>
          <g id="progress-reference-curves" class="progress-reference-curves${referenceHiddenClass}" clip-path="url(#progress-plot-clip)">
            ${referenceCurvesMarkup}
          </g>
          ${dots}
        </svg>
      </section>
      <script>
      (() => {
        const ids = ${ids};
        const points = ${progressData};
        const referenceCurves = ${referenceData};
        const metrics = {
          conductor: { label: 'log conductor', format: (v) => v.toFixed(0) },
          naive: { label: 'naive height', format: (v) => v.toFixed(0) },
          faltings: { label: 'Faltings height', format: (v) => v.toFixed(2) },
          disc: { label: 'log |discriminant|', format: (v) => v.toFixed(0) },
        };
        const T = ${T}, plotH = ${plotH}, L = ${L}, RANK_MAX = ${rankMax}, PLOT_W = ${plotW}, PLOT_RIGHT = ${W - R};
        const startSlider = document.getElementById('progress-start');
        const startCurrent = document.getElementById('progress-start-current');
        const slider = document.getElementById('progress-id');
        const current = document.getElementById('progress-current');
        const count = document.getElementById('progress-count');
        const play = document.getElementById('progress-play');
        const dots = Array.from(document.querySelectorAll('.progress-link'));
        const metricInputs = Array.from(document.querySelectorAll('input[name="progress-metric"]'));
        const yTicks = Array.from(document.querySelectorAll('.progress-y-tick'));
        const yTitle = document.getElementById('progress-y-title');
        const svg = document.querySelector('.progress-plot');
        const referenceControls = document.getElementById('progress-reference-controls');
        const referenceGroup = document.getElementById('progress-reference-curves');
        const referenceToggles = Array.from(document.querySelectorAll('.progress-reference-toggle'));
        let timer = null;

        function visibleCount(cutoff) {
          let lo = 0, hi = ids.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (ids[mid] <= cutoff) lo = mid + 1;
            else hi = mid;
          }
          return lo;
        }

        function currentMetric() {
          const checked = metricInputs.find((input) => input.checked);
          return checked ? checked.value : 'conductor';
        }

        function scaleFor(metric) {
          let min = Infinity, max = -Infinity, count = 0;
          points.forEach((p) => {
            const value = p[metric];
            if (value == null) return;
            if (value < min) min = value;
            if (value > max) max = value;
            count += 1;
          });
          if (count === 0) return { min: 0, max: 1 };
          if (min === max) { min -= 1; max += 1; }
          const pad = (max - min) * 0.05;
          return { min: min - pad, max: max + pad };
        }

        function yFor(value, scale) {
          return T + plotH - ((value - scale.min) / (scale.max - scale.min)) * plotH;
        }

        function xForRank(rank) {
          return L + (rank / RANK_MAX) * PLOT_W;
        }

        function referenceGeometry(c, scale) {
          const qStart = Math.max(scale.min, 1.000001);
          const qEnd = scale.max;
          if (qEnd <= qStart) return { d: '', label: null };
          let d = '';
          let drawing = false;
          let last = null;
          for (let i = 0; i <= 180; i++) {
            const q = qStart + (i / 180) * (qEnd - qStart);
            const denom = Math.log(q);
            const rank = c * q / denom;
            if (!Number.isFinite(rank) || rank < 0 || rank > RANK_MAX) {
              drawing = false;
              continue;
            }
            const x = xForRank(rank);
            const y = yFor(q, scale);
            d += (drawing ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1);
            drawing = true;
            last = { x, y };
          }
          if (last == null) return { d, label: null };
          const nearRight = last.x > PLOT_RIGHT - 80;
          return {
            d,
            label: {
              x: nearRight ? Math.max(L + 8, last.x - 8) : Math.min(PLOT_RIGHT - 8, last.x + 8),
              y: Math.max(T + 16, Math.min(T + plotH - 8, last.y - 6)),
              anchor: nearRight ? 'end' : 'start',
            },
          };
        }

        function referenceToggle(key) {
          return referenceToggles.find((input) => input.value === key);
        }

        function renderReferenceCurves(metric, scale) {
          const conductorMode = metric === 'conductor';
          referenceControls.classList.toggle('is-disabled', !conductorMode);
          referenceGroup.classList.toggle('is-hidden', !conductorMode);
          referenceToggles.forEach((input) => { input.disabled = !conductorMode; });
          referenceCurves.forEach((curve) => {
            const toggle = referenceToggle(curve.key);
            const path = referenceGroup.querySelector('[data-ref="' + curve.key + '"]');
            const label = referenceGroup.querySelector('[data-ref-label="' + curve.key + '"]');
            const enabled = conductorMode && toggle && toggle.checked;
            const geom = enabled ? referenceGeometry(curve.c, scale) : { d: '', label: null };
            path.setAttribute('d', geom.d);
            path.style.display = enabled && geom.d ? '' : 'none';
            label.style.display = enabled && geom.label ? '' : 'none';
            if (geom.label) {
              label.setAttribute('x', geom.label.x.toFixed(1));
              label.setAttribute('y', geom.label.y.toFixed(1));
              label.setAttribute('text-anchor', geom.label.anchor);
            }
          });
        }

        function render() {
          const metric = currentMetric();
          const cfg = metrics[metric];
          const scale = scaleFor(metric);
          const start = Number(startSlider.value);
          if (Number(slider.value) < start) slider.value = String(start);
          const cutoff = Number(slider.value);
          let baseline = 0;
          let shown = 0;
          startCurrent.value = '#' + start;
          current.value = '#' + cutoff;
          yTicks.forEach((tick) => {
            const i = Number(tick.dataset.tick);
            const value = scale.min + (i / 5) * (scale.max - scale.min);
            tick.textContent = cfg.format(value);
          });
          yTitle.textContent = cfg.label + ' \\u2192';
          svg.setAttribute('aria-label', cfg.label + ' versus rank over time');
          renderReferenceCurves(metric, scale);
          dots.forEach((a, i) => {
            const p = points[i];
            const value = p[metric];
            const hasValue = value != null;
            const gray = hasValue && p.id <= start;
            const on = hasValue && p.id > start && p.id <= cutoff;
            if (gray) baseline += 1;
            if (on) shown += 1;
            const c = a.querySelector('circle');
            const title = c.querySelector('title');
            c.classList.toggle('is-baseline', gray);
            c.classList.toggle('is-visible', on);
            c.setAttribute('r', gray ? '3.5' : on ? '5' : '0');
            c.setAttribute('cy', hasValue ? yFor(value, scale).toFixed(1) : String(T + plotH));
            title.textContent = hasValue
              ? 'curve #' + p.id + ': rank >= ' + p.rank + ', ' + cfg.label + ' ' + cfg.format(value)
              : 'curve #' + p.id + ': ' + cfg.label + ' not recorded';
          });
          count.textContent = shown + ' new; ' + baseline + ' gray';
        }

        function stop() {
          if (timer) clearInterval(timer);
          timer = null;
          play.textContent = 'Play';
        }

        function updateStartUrl() {
          const url = new URL(window.location.href);
          url.searchParams.set('start', startSlider.value);
          window.history.replaceState(null, '', url);
        }

        function updateMetricUrl() {
          const url = new URL(window.location.href);
          url.searchParams.set('metric', currentMetric());
          window.history.replaceState(null, '', url);
        }

        startSlider.addEventListener('input', () => { stop(); updateStartUrl(); render(); });
        slider.addEventListener('input', () => { stop(); render(); });
        metricInputs.forEach((input) => {
          input.addEventListener('change', () => { stop(); updateMetricUrl(); render(); });
        });
        referenceToggles.forEach((input) => {
          input.addEventListener('change', render);
        });
        play.addEventListener('click', () => {
          if (timer) { stop(); return; }
          if (Number(slider.value) >= Number(slider.max)) slider.value = startSlider.value;
          play.textContent = 'Pause';
          timer = setInterval(() => {
            const next = ids[visibleCount(Number(slider.value))];
            if (next == null) { slider.value = slider.max; render(); stop(); return; }
            slider.value = String(next);
            render();
          }, 90);
          render();
        });
        render();
      })();
      </script>`
  return layout('Progress — Elliptic Curve Rank Leaderboard', inner, user)
}

export function landingPage(user: User | null = null, curves: PlotCurve[] = [], metric?: string, show?: string): string {
  // Which plot the switcher shows first; honored from ?metric= so the view is
  // shareable and renders without a flash. Defaults to the conductor plot.
  const sel: 'conductor' | 'naive' | 'faltings' | 'disc' =
    metric === 'naive' || metric === 'faltings' || metric === 'disc' ? metric : 'conductor'
  // ?show=all plots every curve; the default shows only the best (lowest)
  // curve at each rank bound — the frontier.
  const showAll = show === 'all'
  const inner = `
      <section class="hero">
        <p class="lede">Can we find <em>small</em> elliptic curves of <em>high rank</em>?</p>
      </section>
      <section class="board${showAll ? '' : ' best-only'}">
        <div class="plot-tabs">
          <span class="plot-metrics" role="radiogroup" aria-label="plot measure">
            <label title="Natural log of the conductor. Recorded when a submission supplies the primes of bad reduction."><input type="radio" name="plot-metric" value="conductor"${sel === 'conductor' ? ' checked' : ''} /><span>log conductor</span></label>
            <label title="log max(|c4|^3, |c6|^2) of the global minimal model. Recorded for every curve."><input type="radio" name="plot-metric" value="naive"${sel === 'naive' ? ' checked' : ''} /><span>naive height</span></label>
            <label title="Stable Faltings height (LMFDB normalization). Recorded for every curve."><input type="radio" name="plot-metric" value="faltings"${sel === 'faltings' ? ' checked' : ''} /><span>Faltings height</span></label>
            <label title="Natural log of the absolute discriminant of the global minimal model. Recorded for every curve."><input type="radio" name="plot-metric" value="disc"${sel === 'disc' ? ' checked' : ''} /><span>log |&Delta;|</span></label>
          </span>
          <label class="plot-filter" title="Plot every submitted curve, not just the best (lowest) curve at each rank bound."><input type="checkbox" id="plot-show-all"${showAll ? ' checked' : ''} /><span>show all curves</span></label>
        </div>
        <div class="plot-panel" data-metric="conductor"${sel === 'conductor' ? '' : ' hidden'}>
          ${scatterPlot(
            curves.filter((c) => c.conductor != null).map((c) => ({ id: c.id, rank: c.rank_lower_bound, x: logBigInt(c.conductor as string) })),
            'log conductor',
            (v) => v.toFixed(0),
            'conductor',
          )}
        </div>
        <div class="plot-panel" data-metric="naive"${sel === 'naive' ? '' : ' hidden'}>
          ${scatterPlot(
            curves.map((c) => ({ id: c.id, rank: c.rank_lower_bound, x: c.naive_height })),
            'naive height',
            (v) => v.toFixed(0),
            'naive',
          )}
        </div>
        <div class="plot-panel" data-metric="faltings"${sel === 'faltings' ? '' : ' hidden'}>
          ${scatterPlot(
            curves.filter((c) => c.faltings_height != null).map((c) => ({ id: c.id, rank: c.rank_lower_bound, x: c.faltings_height as number })),
            'Faltings height',
            (v) => v.toFixed(1),
            'faltings',
          )}
        </div>
        <div class="plot-panel" data-metric="disc"${sel === 'disc' ? '' : ' hidden'}>
          ${scatterPlot(
            curves.map((c) => ({ id: c.id, rank: c.rank_lower_bound, x: logBigInt(c.discriminant) })),
            'log |Δ|',
            (v) => v.toFixed(0),
            'disc',
          )}
        </div>
        <noscript><style>.plot-tabs { display: none; } .board .plot-panel[hidden] { display: block; }</style></noscript>
        <script>
        (function () {
          var tabs = Array.prototype.slice.call(document.querySelectorAll('input[name="plot-metric"]'));
          var panels = Array.prototype.slice.call(document.querySelectorAll('.board .plot-panel'));
          // The server renders the selected panel already; we only handle switches.
          tabs.forEach(function (t) {
            t.addEventListener('change', function () {
              if (!t.checked) return;
              panels.forEach(function (p) { p.hidden = p.dataset.metric !== t.value; });
              var q = new URLSearchParams(location.search);
              q.set('metric', t.value);
              history.replaceState(null, '', location.pathname + '?' + q.toString());
            });
          });
          var showAll = document.getElementById('plot-show-all');
          var board = document.querySelector('.board');
          showAll.addEventListener('change', function () {
            board.classList.toggle('best-only', !showAll.checked);
            var q = new URLSearchParams(location.search);
            if (showAll.checked) q.set('show', 'all'); else q.delete('show');
            var qs = q.toString();
            history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
          });
        })();
        </script>
      </section>

      <p>
      Inspired by <a class="external" href="https://web.math.pmf.unizg.hr/~duje/tors/rankhist.html">Dujella's rank tables</a>,
      this site tracks elliptic curves <span class="eqi">E/&#8474;</span> of high
      <a class="external" href="https://en.wikipedia.org/wiki/Rank_of_an_elliptic_curve">Mordell&ndash;Weil rank</a>
      relative to their size &mdash; measured by
      <a class="external" href="https://en.wikipedia.org/wiki/Conductor_of_an_elliptic_curve">conductor</a>, height, or discriminant.</p>
      <p class="browse-cta"><a href="/database.json" download>Download the database (JSON) &darr;</a> <span class="cta-sep">|</span> <a href="/curves">Browse all curves as a table &rarr;</a> <span class="cta-sep">|</span> <a href="/recent">See recent activity &rarr;</a> <span class="cta-sep">|</span> <a class="external" href="https://icarm.zulipchat.com/#narrow/channel/519875-general/topic/Elliptic.20Curve.20Rank.20Leaderboard/near/603443505">Discuss on Zulip</a></p>

      <section class="submit">
        <h2>Submit a curve</h2>
        <p class="submit-help">Give the Weierstrass coefficients and a set of independent rational points.
        Each point is checked to lie on the curve, and independence is certified by an exact 2-descent
        computation (quadratic characters at good primes, after
        <a href="https://johncremona.github.io/papers/filter.pdf">Cremona</a>/Brumer) &mdash; the points
        are proven independent in <span class="eqi">E(&#8474;)</span> modulo torsion, so
        rank &ge; the number of points, with no floating-point arithmetic in the decision. Supplying the
        primes of bad reduction additionally records its conductor.</p>
        <div class="eq-line">
          <span class="eq">y<sup>2</sup> + a<sub>1</sub>xy + a<sub>3</sub>y = x<sup>3</sup> + a<sub>2</sub>x<sup>2</sup> + a<sub>4</sub>x + a<sub>6</sub></span>
        </div>
        <form method="post" action="/submit-form">
          <label class="field">
            <span>a-invariants <span class="muted">&mdash; [a<sub>4</sub>, a<sub>6</sub>] or [a<sub>1</sub>, a<sub>2</sub>, a<sub>3</sub>, a<sub>4</sub>, a<sub>6</sub>], comma- or space-separated</span></span>
            <input type="text" name="ainvs" ${user ? 'required' : 'disabled'} placeholder="${escapeHtml(SAMPLE_AINVS)}" />
          </label>
          <label class="field">
            <span>points <span class="muted">&mdash; one per line, <code>x, y</code> (integers or rationals like <code>3/16</code>)</span></span>
            <textarea name="points" rows="12" ${user ? 'required' : 'disabled'} placeholder="${escapeHtml(SAMPLE_POINTS)}"></textarea>
          </label>
          <label class="field">
            <span>primes of bad reduction <span class="muted">&mdash; optional; equivalently, primes dividing the minimal discriminant. If given, the conductor is recorded.</span></span>
            <input type="text" name="primes" ${user ? '' : 'disabled'} />
          </label>
          <label class="field">
            <span>commentary <span class="muted">&mdash; optional; how the curve was found, references, etc.</span></span>
            <textarea name="commentary" rows="3" ${user ? '' : 'disabled'}></textarea>
          </label>
          <div class="submit-row">${
            user
              ? '<button type="submit">Submit</button>'
              : '<a class="login-to-submit" href="/auth/github">Log in to submit</a>'
          }</div>
        </form>
      </section>`
  return layout('Elliptic Curve Rank Leaderboard', inner, user)
}

export interface TableCurve extends PlotCurve {
  ainvs: string // JSON [a1..a6]
}

// One leaderboard table row. Carries the numeric sort keys in data attributes so
// the curve-table page's inline sorter can use them; the (static) profile list
// shares the same markup and simply ignores them.
type MetricRecords = Partial<Record<'conductor' | 'naive' | 'faltings' | 'disc', boolean>>

function curveTableRow(c: TableCurve, hidden = false, records: MetricRecords = {}): string {
  const unknown = '<span class="muted">?</span>'
  let ainvs: string[] = []
  try {
    ainvs = JSON.parse(c.ainvs)
  } catch {
    /* leave empty */
  }
  const logCond = c.conductor != null ? logBigInt(c.conductor) : null
  const logDisc = logBigInt(c.discriminant)
  // A record cell (smallest value among curves of equal or higher rank — the
  // same rule as the curve page's ★ badge) gets a highlight class.
  const metricTd = (isRecord: boolean | undefined, content: string): string =>
    `<td class="num${isRecord ? ' record' : ''}"${isRecord ? ` title="record: smallest among curves of rank &ge; ${c.rank_lower_bound}"` : ''}>${content}</td>`
  return `<tr${hidden ? ' hidden' : ''} data-id="${c.id}" data-rank="${c.rank_lower_bound}" data-naive="${c.naive_height}" data-faltings="${c.faltings_height ?? ''}" data-conductor="${logCond ?? ''}" data-disc="${logDisc}">
            <td><a href="/curve/${c.id}">#${c.id}</a></td>
            <td><code>[${ainvs.map((a) => escapeHtml(clip(a, 14))).join(', ')}]</code></td>
            <td class="num"><a class="rank-link" href="/curves?minrank=${c.rank_lower_bound}&amp;rankmode=eq" title="show only curves with rank lower bound = ${c.rank_lower_bound}">&ge; ${c.rank_lower_bound}</a></td>
            ${metricTd(records.conductor, logCond != null ? logCond.toFixed(2) : unknown)}
            ${metricTd(records.naive, c.naive_height.toFixed(2))}
            ${metricTd(records.faltings, c.faltings_height != null ? c.faltings_height.toFixed(2) : unknown)}
            ${metricTd(records.disc, logDisc.toFixed(2))}
          </tr>`
}

// Sortable/filterable table of all curves. The server renders the rows already
// sorted and filtered per the query string, so views are shareable and work
// without JS: the controls are a real GET form (with an "apply" button shown
// only when JS is off) and the column headers are links. The inline script
// takes over both — re-sorting/filtering in place and mirroring the state back
// into the query string — so with JS nothing round-trips to the server.
export function curveTablePage(
  curves: TableCurve[],
  user: User | null = null,
  query: { sort?: string; dir?: string; minrank?: string; rankmode?: string } = {},
): string {
  const KEYS = ['id', 'rank', 'naive', 'faltings', 'conductor', 'disc'] as const
  type SortKey = (typeof KEYS)[number]
  const sortKey: SortKey = (KEYS as readonly string[]).includes(query.sort ?? '') ? (query.sort as SortKey) : 'conductor'
  const sortDir = query.dir === 'desc' ? -1 : 1
  // Numeric sort values, matching the rows' data attributes that the inline
  // script sorts by; null = missing, sorts last in either direction.
  const sortVal = (c: TableCurve): number | null => {
    switch (sortKey) {
      case 'id': return c.id
      case 'rank': return c.rank_lower_bound
      case 'naive': return c.naive_height
      case 'faltings': return c.faltings_height
      case 'conductor': return c.conductor != null ? logBigInt(c.conductor) : null
      case 'disc': return logBigInt(c.discriminant)
    }
  }
  const sorted = [...curves].sort((a, b) => {
    const av = sortVal(a), bv = sortVal(b)
    if (av == null) return bv == null ? 0 : 1
    if (bv == null) return -1
    return (av - bv) * sortDir
  })
  const hasFilter = /^[0-9]+$/.test(query.minrank ?? '')
  const n = Number(query.minrank)
  const eq = query.rankmode === 'eq'
  const rowHidden = (c: TableCurve): boolean => hasFilter && (eq ? c.rank_lower_bound !== n : c.rank_lower_bound < n)
  const shown = sorted.filter((c) => !rowHidden(c)).length
  const restricted = hasFilter && (eq || n > 1)
  const heading = restricted ? `Curves with rank lower bound ${eq ? '=' : '&ge;'} ${n}` : 'All curves'
  const pageTitle = restricted ? `Curves with rank lower bound ${eq ? '=' : '≥'} ${n}` : 'All curves'
  // Record cells: for each metric, a curve is a record when no curve of equal
  // or higher rank has a strictly smaller value (ties share it) — the same
  // Pareto rule as store.recordFlags and the curve page's ★ badge, computed
  // for all rows in one rank-descending sweep with exact decimal comparisons.
  const byRankDesc = [...curves].sort((a, b) => b.rank_lower_bound - a.rank_lower_bound)
  const recordIds = <T,>(get: (c: TableCurve) => T | null, less: (a: T, b: T) => boolean): Set<number> => {
    const recs = new Set<number>()
    let frontier: T | null = null // smallest value at any rank ≥ the current group's
    for (let i = 0; i < byRankDesc.length; ) {
      let j = i
      for (; j < byRankDesc.length && byRankDesc[j].rank_lower_bound === byRankDesc[i].rank_lower_bound; j++) {
        const v = get(byRankDesc[j])
        if (v != null && (frontier == null || less(v, frontier))) frontier = v
      }
      for (let k = i; k < j; k++) {
        const v = get(byRankDesc[k])
        if (v != null && frontier != null && !less(frontier, v)) recs.add(byRankDesc[k].id)
      }
      i = j
    }
    return recs
  }
  const records = {
    conductor: recordIds((c) => c.conductor, lessDecimal),
    naive: recordIds((c): number | null => c.naive_height, (a, b) => a < b),
    faltings: recordIds((c) => c.faltings_height, (a, b) => a < b),
    disc: recordIds((c): string | null => c.discriminant, lessAbsDecimal),
  }
  const rows = sorted
    .map((c) =>
      curveTableRow(c, rowHidden(c), {
        conductor: records.conductor.has(c.id),
        naive: records.naive.has(c.id),
        faltings: records.faltings.has(c.id),
        disc: records.disc.has(c.id),
      }),
    )
    .join('\n')
  // Query string for the state where `key` is the sort column — clicking the
  // active column reverses it, a new column gets its default direction; the
  // rank filter is carried along. Mirrors the inline script's apply().
  const headerHref = (key: string): string => {
    const dir = key === sortKey ? -sortDir : key === 'rank' ? -1 : 1
    const q = new URLSearchParams()
    if (key !== 'conductor' || dir !== 1) {
      q.set('sort', key)
      if (dir === -1) q.set('dir', 'desc')
    }
    if (restricted) q.set('minrank', String(n))
    if (eq) q.set('rankmode', 'eq')
    const qs = q.toString()
    return '/curves' + (qs ? '?' + qs.replace(/&/g, '&amp;') : '')
  }
  const sortHeader = (key: string, label: string, extraClass = 'num', title = ''): string =>
    `<th class="${extraClass}"><a class="sort${key === sortKey ? (sortDir === 1 ? ' asc' : ' desc') : ''}" data-key="${key}" href="${headerHref(key)}"${title ? ` title="${title}"` : ''}>${label}</a></th>`
  const inner = `
      <p class="page-nav"><a href="/">&larr; home</a></p>
      <h2 id="table-title">${heading}</h2>
      <p class="page-subtitle">Click a column header to sort; click again to reverse. Curves missing a
      value (no primes of bad reduction supplied yet) sort last.</p>
      <form class="table-controls" method="get" action="/curves">
        <label class="rank-filter">rank lower bound
          <select id="rank-op" name="rankmode" aria-label="rank lower bound comparison">
            <option value="gte">&ge;</option>
            <option value="eq"${eq ? ' selected' : ''}>=</option>
          </select>
          <input id="rank-filter" name="minrank" type="number" min="1" step="1" placeholder="${eq ? 'any' : '1'}" value="${hasFilter ? n : ''}" />
        </label>${
          sortKey !== 'conductor' || sortDir !== 1
            ? `
        <input type="hidden" name="sort" value="${sortKey}" />${sortDir === -1 ? '\n        <input type="hidden" name="dir" value="desc" />' : ''}`
            : ''
        }
        <noscript><button type="submit">apply</button></noscript>
        <span class="muted">showing <span id="curve-count">${shown}</span> of ${curves.length} curves</span>
        <a href="/database.json" download>Download the database (JSON) &darr;</a>
      </form>
      <div class="table-scroll">
      <table class="curves-table" id="curves-table">
        <thead>
          <tr>
            ${sortHeader('id', 'curve', '')}
            <th>a-invariants</th>
            ${sortHeader('rank', 'rank')}
            ${sortHeader('conductor', 'log N', 'num', 'log conductor')}
            ${sortHeader('naive', 'naive height')}
            ${sortHeader('faltings', 'Faltings height')}
            ${sortHeader('disc', 'log |&Delta;|')}
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
      </div>
      <script>
      (function () {
        var KEYS = ['id', 'rank', 'naive', 'faltings', 'conductor', 'disc'];
        var tbody = document.getElementById('curves-table').tBodies[0];
        var rows = Array.prototype.slice.call(tbody.rows);
        var rankInput = document.getElementById('rank-filter');
        var rankOp = document.getElementById('rank-op');
        var count = document.getElementById('curve-count');
        var heading = document.getElementById('table-title');
        var buttons = document.querySelectorAll('a.sort');
        var sortKey = 'conductor';
        var sortDir = 1; // 1 = ascending, -1 = descending; default: smallest conductor first

        var params = new URLSearchParams(location.search);
        if (KEYS.indexOf(params.get('sort')) >= 0) {
          sortKey = params.get('sort');
          sortDir = params.get('dir') === 'desc' ? -1 : 1;
        }
        if (/^[0-9]+$/.test(params.get('minrank') || '')) rankInput.value = params.get('minrank');
        if (params.get('rankmode') === 'eq') rankOp.value = 'eq';

        function apply() {
          rows.sort(function (a, b) {
            var av = a.dataset[sortKey], bv = b.dataset[sortKey];
            if (av === '') return bv === '' ? 0 : 1; // missing values last either way
            if (bv === '') return -1;
            return (Number(av) - Number(bv)) * sortDir;
          });
          // Rank values are proven lower bounds. Empty input = no filter;
          // otherwise restrict to lower bound == n ("=") or lower bound >= n (">=").
          var hasFilter = /^[0-9]+$/.test(rankInput.value);
          var n = Number(rankInput.value);
          var eq = rankOp.value === 'eq';
          // "=" with an empty box means no filter (any rank); ">=" defaults to 1.
          rankInput.placeholder = eq ? 'any' : '1';
          var shown = 0;
          rows.forEach(function (r) {
            var rk = Number(r.dataset.rank);
            r.hidden = hasFilter && (eq ? rk !== n : rk < n);
            if (!r.hidden) shown++;
            tbody.appendChild(r);
          });
          count.textContent = shown;
          buttons.forEach(function (b) {
            b.className = 'sort' + (b.dataset.key === sortKey ? (sortDir === 1 ? ' asc' : ' desc') : '');
          });
          // The heading names the current view: "All curves" when unfiltered
          // (including ">= 1", which every curve satisfies), the rank
          // restriction otherwise — same condition as the query string below.
          var restricted = hasFilter && (eq || n > 1);
          var title = restricted
            ? 'Curves with rank lower bound ' + (eq ? '= ' : '\\u2265 ') + n
            : 'All curves';
          heading.textContent = title;
          document.title = title + ' \\u2014 Elliptic Curve Rank Leaderboard';
          var q = new URLSearchParams();
          if (sortKey !== 'conductor' || sortDir !== 1) {
            q.set('sort', sortKey);
            if (sortDir === -1) q.set('dir', 'desc');
          }
          // Persist the value whenever it filters: any value in "=" mode, or >1 in ">=" mode.
          if (restricted) q.set('minrank', String(n));
          if (eq) q.set('rankmode', 'eq');
          var qs = q.toString();
          history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
        }

        buttons.forEach(function (b) {
          b.addEventListener('click', function (e) {
            // Modified clicks fall through to the href (open sorted view in a
            // new tab); the href is also the no-JS fallback.
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            if (sortKey === b.dataset.key) {
              sortDir = -sortDir;
            } else {
              sortKey = b.dataset.key;
              sortDir = sortKey === 'rank' ? -1 : 1; // high rank first; small heights first
            }
            apply();
          });
        });
        rankInput.addEventListener('input', apply);
        rankOp.addEventListener('change', apply);
        // The controls form is the no-JS fallback; here everything is already
        // applied live, so Enter in the rank box must not reload the page.
        document.querySelector('form.table-controls').addEventListener('submit', function (e) {
          e.preventDefault();
        });
        // Clicking a row's "≥ N" restricts the view to exactly that lower bound,
        // in place (preserving the current sort). Modified clicks fall through to
        // the link's href so the filtered view can still open in a new tab.
        tbody.addEventListener('click', function (e) {
          var a = e.target.closest('a.rank-link');
          if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          rankInput.value = a.closest('tr').dataset.rank;
          rankOp.value = 'eq';
          apply();
        });
        apply();
      })();
      </script>`
  return layout(`${pageTitle} — Elliptic Curve Rank Leaderboard`, inner, user)
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
  bad_primes: string | null // JSON array of decimal strings
  faltings_height: number | null
  torsion: string | null // JSON array of invariant factors, e.g. "[2,2]"
  submitter_user_id: number | null
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

// Render a stored torsion structure (JSON array of invariant factors, e.g.
// "[2,2]") as the group it names: &#8484;/2&#8484; &times; &#8484;/2&#8484;, or
// "trivial" for "[]". Null when the stored value doesn't parse.
function torsionGroupHtml(torsion: string): string | null {
  let factors: unknown
  try {
    factors = JSON.parse(torsion)
  } catch {
    return null
  }
  if (!Array.isArray(factors) || !factors.every((n) => Number.isInteger(n) && n > 1)) return null
  if (factors.length === 0) return 'trivial'
  return `<span class="eqi">${factors.map((n) => `&#8484;/${n}&#8484;`).join(' &times; ')}</span>`
}

// Record badge for a curve-page metric: shown when no curve of equal or higher
// rank has a smaller value. Links to the table filtered to that rank and sorted
// by the metric, so the curve appears at the top among its rivals.
function badge(isRecord: boolean, rank: number, sort: string): string {
  if (!isRecord) return ''
  return ` <a class="record-badge" href="/curves?sort=${sort}&minrank=${rank}" title="smallest on the board among curves of rank &ge; ${rank}">&#9733; record for rank &ge; ${rank}</a>`
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
    ? `<p class="comment-meta">last edited ${comment.author_id != null ? `by ${userLink(comment.author_id, comment.author)} ` : ''}at ${utcTime(comment.created_at)} &middot; <a href="/curve/${curveId}/commentary-history">history</a></p>`
    : ''
  const editor = user
    ? `<details class="comment-edit">
          <summary>edit</summary>
          <form method="post" action="/curve/${curveId}/commentary">
            <textarea name="content" rows="6" maxlength="${COMMENT_MAX}">${escapeHtml(comment?.content ?? '')}</textarea>
            <div><button type="submit">save</button> <span class="muted">submit empty to clear</span></div>
          </form>
        </details>`
    : `<p class="muted"><a href="/auth/github">Log in</a> to ${hasContent ? 'edit' : 'add'} commentary.</p>`
  return `<section class="comment-section">
        <h3>Commentary</h3>
        ${body}
        ${meta}
        ${editor}
      </section>`
}

// Which of a curve's metrics are records for its rank (no curve of equal or
// higher rank does better). Computed by the route; rendered as badges.
export interface RecordFlags {
  naive: boolean
  faltings: boolean
  conductor: boolean
  discriminant: boolean
}

// Form (on the curve page) for supplying the primes of bad reduction
// when they are
// not yet recorded, backfilling the conductor. `error` is
// shown when a prior submission was rejected.
function badPrimesSection(curveId: number, user: User | null, error: string | null): string {
  const err = error ? `<p class="result-errors primes-error">${escapeHtml(error)}</p>` : ''
  const body = user
    ? `<form method="post" action="/curve/${curveId}/primes" class="primes-form">
          ${err}
          <label class="field">
            <span>primes of bad reduction <span class="muted">&mdash; comma- or space-separated. Equivalently, primes dividing the minimal discriminant.</span></span>
            <input type="text" name="primes" autocomplete="off" />
          </label>
          <div class="submit-row">
            <button type="submit" name="mode" value="manual">Record</button>
            <button type="submit" name="mode" value="auto" class="secondary">Compute automatically</button>
            <span class="muted">&mdash; or let it find them by bounded trial division (gives up on hard cases)</span>
          </div>
        </form>`
    : `<p class="muted"><a href="/auth/github">Log in</a> to supply the primes of bad reduction.</p>`
  return `<section class="primes-section" id="bad-primes">
        <h3>Primes of bad reduction not yet recorded</h3>
        <p class="muted">Supplying the primes of bad reduction records this curve's conductor.</p>
        ${body}
      </section>`
}

export function curveDetailPage(
  curve: CurveRow,
  comment: CommentView | null = null,
  user: User | null = null,
  records: RecordFlags = { naive: false, faltings: false, conductor: false, discriminant: false },
  primesError: string | null = null,
): string {
  let ainvs: string[] = []
  let points: [string, string][] = []
  let badPrimes: string[] = []
  try {
    ainvs = JSON.parse(curve.ainvs)
    points = JSON.parse(curve.points)
    if (curve.bad_primes) badPrimes = JSON.parse(curve.bad_primes)
  } catch {
    /* leave empty */
  }
  const eq = weierstrassEq(ainvs)
  const torsionHtml = curve.torsion != null ? torsionGroupHtml(curve.torsion) : null
  const pointList = points
    .map(([x, y]) => `<li><code>(${escapeHtml(x)}, ${escapeHtml(y)})</code></li>`)
    .join('\n          ')
  const submitter = userLink(curve.submitter_user_id, curve.submitter_name)
  const inner = `
      <p class="page-nav"><a href="/">&larr; home</a> &nbsp;&middot;&nbsp; <a href="/curves">all curves</a> &nbsp;&middot;&nbsp; <a href="/curve/${curve.id}.json" download>JSON &darr;</a></p>
      <h2>curve #${curve.id}</h2>
      <div class="curve-eq eq">${eq}</div>
      <dl class="result-meta curve-meta">
        <dt>a-invariants</dt><dd><code>[${ainvs.map(escapeHtml).join(', ')}]</code></dd>
        <dt>rank (lower bound)</dt><dd><a href="/curves?sort=conductor&amp;minrank=${curve.rank_lower_bound}&amp;rankmode=eq" title="all curves with rank lower bound = ${curve.rank_lower_bound}, by increasing conductor">&ge; ${curve.rank_lower_bound}</a></dd>
        ${torsionHtml ? `<dt>torsion subgroup</dt><dd>${torsionHtml}</dd>` : ''}
        ${curve.conductor ? `<dt>conductor (N)</dt><dd><code class="break">${escapeHtml(curve.conductor)}</code>${badge(records.conductor, curve.rank_lower_bound, 'conductor')}</dd>` : ''}
        <dt>naive height</dt><dd>${curve.naive_height.toFixed(4)}${badge(records.naive, curve.rank_lower_bound, 'naive')}</dd>
        ${curve.faltings_height != null ? `<dt>Faltings height</dt><dd>${curve.faltings_height.toFixed(4)}${badge(records.faltings, curve.rank_lower_bound, 'faltings')}</dd>` : ''}
        <dt>discriminant (&Delta;)</dt><dd><code class="break">${escapeHtml(curve.discriminant)}</code>${badge(records.discriminant, curve.rank_lower_bound, 'disc')}</dd>
        ${badPrimes.length ? `<dt>primes of bad reduction</dt><dd><code class="break">${badPrimes.map(escapeHtml).join(', ')}</code></dd>` : ''}
        <dt>regulator</dt><dd><code>${escapeHtml(curve.regulator)}</code></dd>
        <dt>submitted by</dt><dd>${submitter}</dd>
        <dt>submitted at</dt><dd>${utcTime(curve.created_at)}</dd>
        <dt>last updated</dt><dd>${utcTime(curve.updated_at)}</dd>
      </dl>
      <section class="witness">
        <h3>Witness: ${points.length} independent points</h3>
        <ul class="point-list">
          ${pointList}
        </ul>
      </section>
      ${curve.conductor == null ? badPrimesSection(curve.id, user, primesError) : ''}
      ${commentSection(curve.id, comment, user)}`
  return layout(`curve #${curve.id} — Elliptic Curve Rank Leaderboard`, inner, user)
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
          <p class="comment-meta">${e.author_id != null ? userLink(e.author_id, e.author) : '<span class="muted">(deleted user)</span>'} &middot; ${utcTime(e.created_at)}</p>
          ${e.content.length > 0 ? `<div class="comment-body">${renderCommentContent(e.content)}</div>` : `<p class="muted">(cleared)</p>`}
        </li>`,
        )
        .join('\n')
    : `<li class="muted">No commentary yet.</li>`
  const inner = `
      <p class="page-nav"><a href="/curve/${curve.id}">&larr; curve #${curve.id}</a></p>
      <h2>Commentary history</h2>
      <p class="page-subtitle">${entries.length} edit${entries.length === 1 ? '' : 's'}.</p>
      <ul class="comment-history">${list}</ul>`
  return layout('Commentary history — Elliptic Curve Rank Leaderboard', inner, user)
}

// Recent-activity feed: submissions and commentary edits, newest first.
export function activityPage(
  items: ActivityItem[],
  page: number,
  hasOlder: boolean,
  user: User | null = null,
): string {
  const entry = (a: ActivityItem): string => {
    const link = `<a href="/curve/${a.curve_id}">curve #${a.curve_id}</a>`
    const meta = `<p class="activity-meta">${utcTime(a.ts)} &middot; ${userLink(a.user_id, a.user)}</p>`
    if (a.kind === 'submission') {
      return `<li>
          ${meta}
          <p class="activity-line">submitted ${link} &mdash; rank &ge; ${a.rank}, naive height ${a.height.toFixed(2)}</p>
        </li>`
    }
    const cleared = !a.content || a.content.length === 0
    return `<li>
          ${meta}
          <p class="activity-line">${cleared ? `cleared commentary on ${link}` : `commented on ${link}`}</p>
          ${cleared ? '' : `<div class="comment-body">${renderCommentContent(clip(a.content!, 280))}</div>`}
        </li>`
  }
  const list = items.length
    ? `<ul class="activity">${items.map(entry).join('\n')}</ul>`
    : `<p class="muted">No activity yet.</p>`
  const newer =
    page > 0
      ? `<a href="/recent${page - 1 === 0 ? '' : `?p=${page - 1}`}">&larr; newer</a>`
      : `<span class="muted">&larr; newer</span>`
  const older = hasOlder
    ? `<a href="/recent?p=${page + 1}">older &rarr;</a>`
    : `<span class="muted">older &rarr;</span>`
  const inner = `
      <p class="page-nav"><a href="/">&larr; home</a></p>
      <h2>Recent activity</h2>
      <p class="page-subtitle">New submissions and commentary edits, newest first.</p>
      ${list}
      <nav class="pager">${newer} <span class="muted">page ${page + 1}</span> ${older}</nav>`
  return layout('Recent activity — Elliptic Curve Rank Leaderboard', inner, user)
}

// Render a number-ish string, truncating very long values with an ellipsis.
function clip(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

// Outcome of recording a submitted curve on the leaderboard.
export interface SubmitInfo {
  id: number
  status: 'created' | 'improved' | 'unchanged'
  rank: number
  previousRank?: number
  conductorRecorded?: boolean
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
  const cond = submit.conductorRecorded ? ' Conductor recorded.' : ''
  const tick = added || submit.conductorRecorded ? '&#10003; ' : ''
  const cls = added || submit.conductorRecorded ? 'leaderboard-status added' : 'leaderboard-status'
  const link = ` <a href="/curve/${submit.id}">view the curve &rarr;</a>`
  return `<p class="${cls}">${tick}${msg}${cond}${link}</p>`
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
          ${
            ind.certificate
              ? `<dt>certificate</dt><dd>quadratic characters at ${ind.certificate.primes.length} good primes (2-descent, exact)</dd>`
              : ''
          }
          <dt>regulator</dt><dd><code>${escapeHtml(clip(ind.regulator))}</code></dd>
          <dt>naive height</dt><dd><code>${escapeHtml(clip(result.height!.naiveLogHeight))}</code></dd>
          ${result.faltingsHeight ? `<dt>Faltings height</dt><dd><code>${escapeHtml(clip(result.faltingsHeight))}</code></dd>` : ''}
          <dt>minimal discriminant</dt><dd><code>${escapeHtml(clip(c.discriminant, 80))}</code></dd>
          ${result.conductor ? `<dt>conductor</dt><dd><code>${escapeHtml(clip(result.conductor, 80))}</code></dd>` : ''}
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
    "primes": ["2","3","211",...],
    "commentary": "Found by Mestre (1982)."
  }'`
  const verifyResp = `{
  "ok": true,
  "curve":   { "ainvs": [...], "c4": "...", "c6": "...", "discriminant": "...", "nonsingular": true },
  "canonical": { "c4": "...", "c6": "...", "key": "304790815056:-166878443731135320" },
  "points":  [ { "point": ["49421","200114"], "onCurve": true }, ... ],
  "allPointsOnCurve": true,
  "independence": {
    "independent": true, "rankLowerBound": 12,
    "certificate": {            // the exact independence proof
      "primes": ["7","11","17", ...], "matrixRank": 12, "torsionRank": 0,
      "halvings": 0, "torsion": "[]"
    },
    "regulator": "...", "precisionDigits": 62,    // informational diagnostic
    "method": "..."
  },
  "height": { "naiveLogHeight": "79.3286..." },
  "faltingsHeight": "...",
  "conductor": "...",           // only if primes were supplied/recovered
  "badPrimes": ["2","3","211", ...],  // ditto: the verified primes, sorted
  "torsion": "[]",              // torsion structure (JSON invariant factors)
  "leaderboard": { "status": "created", "rank": 12 }
}`
  const primesReq = `curl -X POST https://elliptic-rank.icarm.cloud/api/curve/123/primes \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer erank_...' \\
  -d '{ "primes": ["2","3","211"] }'   # or: { "mode": "auto" }`
  const primesResp = `{
  "ok": true,
  "id": 123,
  "alreadyRecorded": false,
  "conductor": "...",
  "badPrimes": ["2","3","211"]
}`
  const commentReq = `curl -X POST https://elliptic-rank.icarm.cloud/curve/123/commentary \\
  -H 'authorization: Bearer erank_...' \\
  --data-urlencode 'content=Found by Mestre (1982).'`
  const inner = `
      <p class="page-nav"><a href="/">&larr; home</a></p>
      <h2>API</h2>
      <p>All numbers are exact integers or rationals (e.g. <code>"49/4"</code>), passed
      <strong>as strings</strong> to avoid precision loss. <code>ainvs</code> may be the short
      <code>[a4, a6]</code> or full <code>[a1, a2, a3, a4, a6]</code> Weierstrass form. The
      <code>POST</code> endpoints require an <code>Authorization: Bearer &lt;token&gt;</code> header
      &mdash; create a token on your <a href="/profile">profile</a> page. The JSON downloads are
      public.</p>

      <h3>POST <code>/api/submit</code></h3>
      <p>Submits a curve with a set of witness points. The points are checked to lie on the curve, and
      their independence is certified exactly by 2-descent quadratic characters at good primes
      (Cremona/Brumer; torsion handled via exact torsion generators), proving
      <code>rank &ge; #points</code> in <span class="eqi">E(&#8474;)</span> modulo torsion with no
      floating-point arithmetic in the decision. The response's <code>independence.certificate</code>
      lists the primes used and the F<sub>2</sub> matrix ranks; the N&eacute;ron&ndash;Tate regulator is
      still reported as an informational diagnostic. On success the
      curve is <strong>recorded on the leaderboard</strong>; a new curve is attributed to you, while
      improving an already-recorded curve's rank bound updates its witness points but leaves the
      original submitter's credit in place. Accepted curves and
      witness points are stored in the curve's global minimal model. Body:
      <code>{ ainvs, points }</code>, where <code>points</code> is a list of <code>[x, y]</code>.</p>
      <p>The <strong>discriminant</strong> and <strong>Faltings height</strong> are recorded for every
      curve (neither needs the primes). Optionally include <code>primes</code>: the primes of bad
      reduction, equivalently the primes dividing the minimal discriminant. If they check out, the
      <strong>conductor</strong> is computed and recorded &mdash; no factoring needed &mdash; along
      with the verified prime list itself (deduplicated, sorted, extraneous good primes dropped).
      Re-submitting an existing curve with <code>primes</code> backfills the conductor even if the
      rank is unchanged.</p>
      <p>Optionally include <code>commentary</code>: a string recorded as the curve's initial
      commentary, attributed to you. It is applied only when the curve has no commentary yet
      &mdash; if the curve already exists and already has commentary, this field is
      <strong>ignored</strong> (use <code>POST /curve/:id/commentary</code> to edit existing
      commentary).</p>
      <pre><code>${escapeHtml(verifyReq)}</code></pre>
      <p>Returns <code>200</code> with the result below, <code>422</code> if the submission is
      invalid (singular curve, point off curve, or not independent), <code>401</code> without a valid
      token, <code>413</code> if the request body is too large, <code>429</code> if your account is
      submitting too quickly, or <code>400</code> if the body isn't JSON. <code>independence.rankLowerBound</code> is
      the proven bound, <code>canonical.key</code> identifies the curve up to <span class="eqi">&#8474;</span>-isomorphism, and
      the <code>leaderboard</code> field reports the outcome &mdash; <code>status</code> is
      <code>"created"</code>, <code>"improved"</code> (with <code>previousRank</code>), or
      <code>"unchanged"</code> (a curve's record only changes when a witness proves a strictly higher
      rank).</p>
      <pre><code>${escapeHtml(verifyResp)}</code></pre>

      <h3>POST <code>/api/curve/:id/primes</code></h3>
      <p>Backfill the <strong>conductor</strong> of an
      already-recorded curve from its primes of bad reduction &mdash; the programmatic equivalent of
      the primes form on a curve's page, and an alternative to re-submitting through
      <code>/api/submit</code>. (The discriminant and Faltings height are already recorded at
      submission.) Send <code>{ primes: [...] }</code>
      with the primes of bad reduction (each a prime, together dividing the minimal discriminant to a
      unit), or <code>{ "mode": "auto" }</code> to attempt bounded trial division (which gives up on
      hard factorizations). No factoring of large discriminants is performed otherwise.</p>
      <pre><code>${escapeHtml(primesReq)}</code></pre>
      <p>Returns <code>200</code> with the computed invariants below. If the conductor is already
      recorded it is a no-op &mdash; <code>{ "ok": true, "alreadyRecorded": true }</code> (fetch
      <code>/curve/:id.json</code> for the stored values). Returns <code>422</code> if the primes are
      invalid or incomplete (with <code>errors</code> and <code>note</code>), <code>404</code> if there
      is no such curve, <code>401</code> without a valid token, <code>413</code> if the body is too
      large, or <code>400</code> if the body isn't JSON or the id isn't an integer.</p>
      <pre><code>${escapeHtml(primesResp)}</code></pre>

      <h3>GET <code>/database.json</code></h3>
      <p>The entire database as one JSON download: <code>{ count, curves }</code>, each curve with its
      global-minimal a-invariants, transformed witness points, <code>discriminant</code> (the minimal
      discriminant), rank lower bound, naive height, Faltings height, and (when recorded) conductor,
      <code>bad_primes</code> (the verified primes of bad reduction &mdash; the factorization of the
      conductor's support), submitter, and commentary. No auth required.</p>

      <h3>GET <code>/curve/:id.json</code></h3>
      <p>A single curve as JSON &mdash; the same shape as one entry of the
      <code>database.json</code> <code>curves</code> array. No auth required.</p>

      <h3>POST <code>/curve/:id/commentary</code></h3>
      <p>Edit a curve's commentary. Form-encoded <code>content</code>; an empty value clears it. Each
      edit is kept in the curve's commentary history.</p>
      <pre><code>${escapeHtml(commentReq)}</code></pre>`
  return layout('API — Elliptic Curve Rank Leaderboard', inner, user)
}

// The curves attributed to the signed-in user (they were the first to record
// each curve; later rank improvements by others leave that credit in place).
// Best rank first, so a contributor's strongest results lead. A static table —
// no client-side sorting needed here.
function submittedCurvesSection(curves: TableCurve[]): string {
  const heading = `<h3>Curves <span class="muted">(${curves.length})</span></h3>`
  if (curves.length === 0) {
    return `<section class="my-curves">
        ${heading}
        <p class="muted">No curves currently attributed to this user.</p>
      </section>`
  }
  const rows = curves.map((c) => curveTableRow(c)).join('\n')
  return `<section class="my-curves">
        ${heading}
        <p class="muted">Curves currently attributed to this user, highest rank first. Click one for its witness.</p>
        <div class="table-scroll">
        <table class="curves-table">
          <thead>
            <tr>
              <th>curve</th>
              <th>a-invariants</th>
              <th class="num">rank</th>
              <th class="num" title="log conductor">log N</th>
              <th class="num">naive height</th>
              <th class="num">Faltings height</th>
              <th class="num">log |&Delta;|</th>
            </tr>
          </thead>
          <tbody>
          ${rows}
          </tbody>
        </table>
        </div>
      </section>`
}

export function profilePage(
  user: User,
  tokens: TokenRow[],
  newToken: { token: string; prefix: string } | null,
  about: string | null = null,
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
            ? `<span class="muted">revoked ${utcTime(t.revoked_at)}</span>`
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
      <p class="page-subtitle">Signed in as ${escapeHtml(user.display_name || user.email || 'user')} (via ${escapeHtml(user.provider)}). &nbsp;&middot;&nbsp; <a href="/user/${user.id}">view your public page</a></p>
      ${newTokenBlock}
      <section class="profile-name">
        <h3>Display name</h3>
        <form method="post" action="/profile/name" class="profile-name-form">
          <input type="text" name="name" value="${escapeHtml(user.display_name || '')}" maxlength="100" required />
          <button type="submit">save</button>
        </form>
      </section>
      <section class="profile-about">
        <h3>About</h3>
        <form method="post" action="/profile/about" class="profile-about-form">
          <textarea name="about" rows="4" maxlength="${ABOUT_MAX}" placeholder="A sentence or two about yourself.">${escapeHtml(about ?? '')}</textarea>
          <button type="submit">save</button>
        </form>
      </section>
      <section class="tokens">
        <h3>API tokens</h3>
        <p>Send a token in the <code>Authorization: Bearer &hellip;</code> header to call the <a href="/api">API</a> as yourself.</p>
        <table class="tokens-table">
          <thead><tr><th>Prefix</th><th>Name</th><th>Created (UTC)</th><th>Last used (UTC)</th><th></th></tr></thead>
          <tbody>${tokenRows}</tbody>
        </table>
        <form method="post" action="/profile/tokens" class="new-token-form">
          <label>Name (optional) <input type="text" name="name" maxlength="100" placeholder="e.g. laptop CLI" /></label>
          <button type="submit">Generate new token</button>
        </form>
      </section>`
  return layout('Profile — Elliptic Curve Rank Leaderboard', inner, user)
}

// The public profile shown at /user/:id. Deliberately excludes email and
// anything else not already visible elsewhere on the site.
export interface PublicUser {
  id: number
  display_name: string | null
  avatar_url: string | null
  about: string | null
  created_at: string
}

export function userPage(profile: PublicUser, curves: TableCurve[], viewer: User | null = null): string {
  const name = escapeHtml(profile.display_name || `user #${profile.id}`)
  const avatar = profile.avatar_url
    ? `<img class="user-avatar" src="${escapeHtml(profile.avatar_url)}" alt="" width="64" height="64" />`
    : ''
  const about = profile.about
    ? `<section class="user-about"><h3>About</h3><div class="comment-body">${renderCommentContent(profile.about)}</div></section>`
    : ''
  const editHint =
    viewer && viewer.id === profile.id
      ? ` &nbsp;&middot;&nbsp; <a href="/profile">edit your profile</a>`
      : ''
  const inner = `
      <p class="page-nav"><a href="/">&larr; home</a></p>
      <div class="user-header">
        ${avatar}
        <div>
          <h2>${name}</h2>
          <p class="page-subtitle">Member since ${utcTime(profile.created_at)}.${editHint}</p>
        </div>
      </div>
      ${about}
      ${submittedCurvesSection(curves)}`
  return layout(`${profile.display_name || `user #${profile.id}`} — Elliptic Curve Rank Leaderboard`, inner, viewer)
}

export function notFoundPage(user: User | null = null): string {
  return layout(
    'Not found',
    `<p class="page-nav"><a href="/">&larr; home</a></p><h2>Not found</h2><p>No such page.</p>`,
    user,
  )
}

export function acknowledgePage(user: User | null = null): string {
  const inner = `
      <p class="page-nav"><a href="/">&larr; home</a></p>
      <h2>Acknowledgement</h2>
      <p>The Institute for Computer-Aided Reasoning in Mathematics
      <span class="nowrap">(<a class="external" href="https://icarm.io">ICARM</a>)</span> is supported by
      U.S. National Science Foundation Grant DMS 2425401. The views expressed on these pages do not
      necessarily reflect those of the NSF.</p>
      <p>If any ICARM meetings, resources, or innovation engineers are helpful to you, you can indicate
      that in associated publications with a brief acknowledgment, such as the following:</p>
      <ul>
        <li>&ldquo;Part of this research has been carried out at the Institute for Computer-Aided
        Reasoning (ICARM), which is supported by NSF Grant DMS 2425401.&rdquo;</li>
        <li>&ldquo;This research made use of the Elliptic Curve Rank Leaderboard, maintained by the
        Institute for Computer-Aided Reasoning (ICARM) under NSF Grant DMS 2425401.&rdquo;</li>
        <li>&ldquo;We are grateful to the Institute for Computer-Aided Reasoning (ICARM) for technical
        support provided under NSF Grant DMS 2425401.&rdquo;</li>
      </ul>`
  return layout('Acknowledgement — Elliptic Curve Rank Leaderboard', inner, user)
}
