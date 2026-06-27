import { Hono } from 'hono'
import { getGp } from './pari'
import { verify, type VerifyInput, type VerifyResult } from './verify'
import {
  checkSubmissionRateLimit,
  SUBMISSION_RATE_LIMIT,
  SUBMISSION_RATE_PERIOD_SEC,
} from './rateLimit'
import {
  landingPage,
  submitResultPage,
  apiDocsPage,
  notFoundPage,
  profilePage,
  curveDetailPage,
  commentHistoryPage,
  activityPage,
  curveTablePage,
  acknowledgePage,
  progressPage,
  type TokenRow,
  type SubmitInfo,
  type PlotCurve,
  type ProgressCurve,
  type TableCurve,
  type CurveRow,
} from './pages'
import { recordCurve, backfillPrimes, postComment, commentHistory, recentActivity, recordFlags, COMMENT_MAX, type CommentView } from './store'
import { notifyRecord, notifyBackfillRecord } from './zulip'
import {
  type AppEnv,
  type Bindings,
  loadCurrentUser,
  loadUserFromToken,
  startOAuth,
  handleCallback,
  logout,
  generateApiToken,
  updateSessionUser,
} from './auth'

const app = new Hono<AppEnv>()
const MAX_SUBMISSION_BODY_BYTES = 64 * 1024

// Resolve the current user (session cookie, else API bearer token) for every
// request. Both lookups short-circuit cheaply when their credential is absent.
app.use('*', async (c, next) => {
  const user = (await loadCurrentUser(c)) ?? (await loadUserFromToken(c))
  c.set('user', user)
  await next()
})

app.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, rank_lower_bound, naive_height, faltings_height, conductor, discriminant FROM curves',
  ).all<PlotCurve>()
  return c.html(landingPage(c.get('user'), results, c.req.query('metric')))
})

app.get('/curves', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, ainvs, rank_lower_bound, naive_height, faltings_height, conductor, discriminant
       FROM curves
       -- Default order matches the table's JS default: increasing conductor,
       -- curves with no recorded conductor last. Conductor is a big-integer
       -- decimal string, so numeric order = (length, then lexicographic).
       ORDER BY conductor IS NULL, LENGTH(conductor), conductor, naive_height ASC`,
  ).all<TableCurve>()
  return c.html(curveTablePage(results, c.get('user')))
})

app.get('/recent', async (c) => {
  const p = Math.max(0, Math.floor(Number(c.req.query('p')) || 0))
  const { items, page, hasOlder } = await recentActivity(c.env, p)
  return c.html(activityPage(items, page, hasOlder, c.get('user')))
})

app.get('/progress', async (c) => {
  const startParam = c.req.query('start')
    ?? c.req.query('startId')
    ?? c.req.query('starting')
    ?? c.req.query('startingId')
  const parsedStartId = startParam === undefined ? undefined : Math.floor(Number(startParam))
  const startId = parsedStartId !== undefined && Number.isFinite(parsedStartId) ? parsedStartId : undefined
  const metric = c.req.query('metric')
  const { results } = await c.env.DB.prepare(
    `SELECT id, rank_lower_bound, naive_height, faltings_height, conductor, discriminant FROM curves
       ORDER BY id ASC`,
  ).all<ProgressCurve>()
  return c.html(progressPage(results, c.get('user'), startId, metric))
})

// Single curve as downloadable JSON — the same shape as a database.json entry.
app.get('/curve/:file{[0-9]+\\.json}', async (c) => {
  const id = Number(c.req.param('file').replace(/\.json$/, ''))
  const row = await c.env.DB.prepare(`${CURVE_JSON_SELECT} WHERE c.id = ?`)
    .bind(id)
    .first<CurveJsonRow>()
  if (!row) return c.json({ error: 'no such curve' }, 404)
  return c.body(JSON.stringify(curveJson(row), null, 2), 200, {
    'content-type': 'application/json; charset=UTF-8',
    'content-disposition': `attachment; filename="elliptic-rank-curve-${id}.json"`,
    'cache-control': 'no-cache',
  })
})

// Load a curve with its submitter name and current commentary, or null if no
// such curve. Shared by the detail page (GET) and the bad-primes form (POST).
async function loadCurveWithComment(
  env: Bindings,
  id: number,
): Promise<{ row: CurveRow; comment: CommentView | null } | null> {
  const row = await env.DB.prepare(
    `SELECT c.*, u.display_name AS submitter_name,
            cl.id AS comment_id, cl.content AS comment_content,
            cl.created_at AS comment_at, cu.display_name AS comment_author
       FROM curves c
       LEFT JOIN users u ON u.id = c.submitter_user_id
       LEFT JOIN comments_log cl ON cl.id = c.current_comment_id
       LEFT JOIN users cu ON cu.id = cl.user_id
       WHERE c.id = ?`,
  )
    .bind(id)
    .first<
      CurveRow & {
        comment_id: number | null
        comment_content: string | null
        comment_at: string | null
        comment_author: string | null
      }
    >()
  if (!row) return null
  const comment: CommentView | null =
    row.comment_id != null
      ? {
          id: row.comment_id,
          content: row.comment_content ?? '',
          created_at: row.comment_at ?? '',
          author: row.comment_author,
        }
      : null
  return { row, comment }
}

app.get('/curve/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.html(notFoundPage(c.get('user')), 404)
  const loaded = await loadCurveWithComment(c.env, id)
  if (!loaded) return c.html(notFoundPage(c.get('user')), 404)
  const { row, comment } = loaded
  // A failed bad-primes submission redirects back here with the reason in the
  // query (and a #bad-primes fragment) so the page scrolls to the form.
  const primesError = c.req.query('primes_error') ?? null
  return c.html(curveDetailPage(row, comment, c.get('user'), await recordFlags(c.env, row), primesError))
})

// Supply the primes of bad reduction from the curve's detail page,
// backfilling the conductor and Faltings height (no factoring). Only meaningful
// when these are not yet recorded; otherwise it is a no-op.
app.post('/curve/:id/primes', async (c) => {
  const user = c.get('user')
  if (!user) return c.redirect('/auth/github', 302)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.html(notFoundPage(user), 404)
  const form = await c.req.parseBody()
  // "Compute automatically" attempts bounded trial division; otherwise use the
  // primes the submitter typed.
  const mode = String(form.mode ?? '') === 'auto' ? 'auto' : 'manual'
  const gp = await getGp()
  const outcome = await backfillPrimes(c.env, gp, id, mode, parseTokens(String(form.primes ?? '')))
  if (outcome.status === 'no-curve') return c.html(notFoundPage(user), 404)
  // Recorded or already-recorded: back to the curve page (Post/Redirect/Get). A
  // fresh backfill may have made the curve a conductor/Faltings record.
  if (outcome.status !== 'rejected') {
    if (outcome.status === 'recorded') {
      c.executionCtx.waitUntil(
        notifyBackfillRecord(c.env, id, user.display_name ?? null, new URL(c.req.url).origin),
      )
    }
    return c.redirect(`/curve/${id}`, 302)
  }
  // Failed: redirect back with the reason in the query and a fragment so the
  // browser scrolls to the form.
  const res = outcome.result
  const error = res.note ?? res.errors[0] ?? 'could not record the supplied primes of bad reduction'
  return c.redirect(`/curve/${id}?primes_error=${encodeURIComponent(error)}#bad-primes`, 303)
})

app.post('/curve/:id/commentary', async (c) => {
  const user = c.get('user')
  if (!user) return c.redirect('/auth/github', 302)
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.html(notFoundPage(user), 404)
  const exists = await c.env.DB.prepare('SELECT id FROM curves WHERE id = ?').bind(id).first()
  if (!exists) return c.html(notFoundPage(user), 404)
  const form = await c.req.parseBody()
  const content = (typeof form.content === 'string' ? form.content : '').slice(0, COMMENT_MAX)
  await postComment(c.env, id, user.id, content)
  return c.redirect(`/curve/${id}`, 302)
})

app.get('/curve/:id/commentary-history', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.html(notFoundPage(c.get('user')), 404)
  const curve = await c.env.DB.prepare('SELECT * FROM curves WHERE id = ?').bind(id).first<CurveRow>()
  if (!curve) return c.html(notFoundPage(c.get('user')), 404)
  return c.html(commentHistoryPage(curve, await commentHistory(c.env, id), c.get('user')))
})

app.get('/api', (c) => c.html(apiDocsPage(c.get('user'))))

app.get('/acknowledge', (c) => c.html(acknowledgePage(c.get('user'))))

// Shared SELECT + JSON shape for the database download and the per-curve JSON.
const CURVE_JSON_SELECT = `SELECT c.id, c.curve_key, c.ainvs, c.discriminant, c.naive_height, c.rank_lower_bound,
            c.regulator, c.points, c.conductor, c.faltings_height,
            c.created_at, c.updated_at, u.display_name AS submitter, cl.content AS commentary
       FROM curves c
       LEFT JOIN users u ON u.id = c.submitter_user_id
       LEFT JOIN comments_log cl ON cl.id = c.current_comment_id`

interface CurveJsonRow {
  id: number
  curve_key: string
  ainvs: string
  discriminant: string
  naive_height: number
  rank_lower_bound: number
  regulator: string
  points: string
  conductor: string | null
  faltings_height: number | null
  created_at: string
  updated_at: string
  submitter: string | null
  commentary: string | null
}

function curveJson(r: CurveJsonRow) {
  const parse = (s: string): unknown => {
    try {
      return JSON.parse(s)
    } catch {
      return s
    }
  }
  return {
    id: r.id,
    curve_key: r.curve_key,
    ainvs: parse(r.ainvs),
    rank_lower_bound: r.rank_lower_bound,
    naive_height: r.naive_height,
    faltings_height: r.faltings_height,
    conductor: r.conductor,
    discriminant: r.discriminant,
    regulator: r.regulator,
    points: parse(r.points),
    submitter: r.submitter,
    commentary: r.commentary || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

// Full database as downloadable JSON.
app.get('/database.json', async (c) => {
  const { results } = await c.env.DB.prepare(
    `${CURVE_JSON_SELECT} ORDER BY c.rank_lower_bound DESC, c.naive_height ASC`,
  ).all<CurveJsonRow>()
  const curves = results.map(curveJson)
  // Pretty-printed (2-space indent) so the download is readable line-by-line —
  // a single 60+ KB line is awkward for humans and tools alike.
  const payload = JSON.stringify({ count: curves.length, curves }, null, 2)
  // Strong ETag over the exact body so clients can revalidate cheaply: the body
  // changes only when a submission does, so unchanged downloads return a 304.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  const etag =
    '"' +
    [...new Uint8Array(digest)]
      .slice(0, 16)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('') +
    '"'
  const headers = {
    'content-type': 'application/json; charset=UTF-8',
    'content-disposition': 'attachment; filename="elliptic-rank-database.json"',
    // no-cache = clients may store but must revalidate every time; paired with
    // the ETag, a fresh request returns 304 (no body) when nothing changed.
    'cache-control': 'no-cache',
    etag,
  }
  if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers)
  return c.body(payload, 200, headers)
})

// JSON API: submit a curve + witness points. Requires a bearer token; the
// verified curve is recorded on the leaderboard. Body: { ainvs, points }.
app.post('/api/submit', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ ok: false, errors: ['authentication required'] }, 401)
  if (submissionBodyTooLarge(c.req.raw)) {
    return c.json({ ok: false, errors: [`request body too large (max ${MAX_SUBMISSION_BODY_BYTES} bytes)`] }, 413)
  }
  const rate = await checkSubmissionRateLimit(c.env, user.id)
  if (!rate.allowed) {
    c.header('Retry-After', String(rate.retryAfter))
    return c.json(
      {
        ...rejectedVerification(
          `submission rate limit exceeded: ${SUBMISSION_RATE_LIMIT} per ${SUBMISSION_RATE_PERIOD_SEC} seconds; retry in about ${rate.retryAfter} seconds`,
        ),
        rateLimit: {
          limit: SUBMISSION_RATE_LIMIT,
          period: SUBMISSION_RATE_PERIOD_SEC,
          retryAfter: rate.retryAfter,
        },
      },
      429,
    )
  }
  let body: VerifyInput & { commentary?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, errors: ['request body must be JSON'] }, 400)
  }
  // Optional initial commentary; recorded only for curves with none yet.
  const commentary =
    typeof body.commentary === 'string' ? body.commentary.slice(0, COMMENT_MAX) : undefined
  const gp = await getGp()
  const result = verify(gp, body)
  const leaderboard = result.ok ? await recordCurve(c.env, user.id, result, commentary) : undefined
  if (leaderboard) {
    c.executionCtx.waitUntil(
      notifyRecord(c.env, leaderboard, user.display_name ?? null, new URL(c.req.url).origin),
    )
  }
  return c.json({ ...result, leaderboard }, result.ok ? 200 : 422)
})

// JSON API: backfill the conductor and Faltings height of an already-recorded
// curve from its primes of bad reduction — the
// programmatic counterpart of the curve page's primes form. Requires a bearer
// token. Body: { primes: [...] } to use a supplied list, or { mode: "auto" }
// to attempt bounded trial division. No factoring of large discriminants.
app.post('/api/curve/:id/primes', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ ok: false, errors: ['authentication required'] }, 401)
  if (submissionBodyTooLarge(c.req.raw)) {
    return c.json({ ok: false, errors: [`request body too large (max ${MAX_SUBMISSION_BODY_BYTES} bytes)`] }, 413)
  }
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ ok: false, errors: ['curve id must be an integer'] }, 400)
  let body: { primes?: unknown; mode?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, errors: ['request body must be JSON'] }, 400)
  }
  const gp = await getGp()
  // "auto" attempts bounded trial division; otherwise use the supplied list.
  const mode = body.mode === 'auto' ? 'auto' : 'manual'
  const primes = Array.isArray(body.primes) ? (body.primes as (string | number)[]) : []
  const outcome = await backfillPrimes(c.env, gp, id, mode, primes)
  switch (outcome.status) {
    case 'no-curve':
      return c.json({ ok: false, errors: ['no such curve'] }, 404)
    // Already recorded: a no-op. Fetch /curve/:id.json for the stored values.
    case 'already-recorded':
      return c.json({ ok: true, id, alreadyRecorded: true })
    case 'recorded':
      // A fresh backfill may have made the curve a conductor/Faltings record.
      c.executionCtx.waitUntil(
        notifyBackfillRecord(c.env, id, user.display_name ?? null, new URL(c.req.url).origin),
      )
      return c.json({
        ok: true,
        id,
        alreadyRecorded: false,
        conductor: outcome.result.conductor,
        minimalDiscriminant: outcome.result.minimalDiscriminant,
        faltingsHeight: outcome.result.faltingsHeight,
      })
    case 'rejected': {
      const res = outcome.result
      const errors = res.errors.length ? res.errors : [res.note ?? 'could not record the supplied primes of bad reduction']
      return c.json({ ok: false, id, errors, note: res.note }, 422)
    }
  }
})

// HTML form on the landing page posts here; requires login, records, and
// renders a result page.
app.post('/submit-form', async (c) => {
  const user = c.get('user')
  if (!user) return c.redirect('/auth/github', 302)
  if (submissionBodyTooLarge(c.req.raw)) {
    return c.html(
      submitResultPage(
        rejectedVerification(`request body too large (max ${MAX_SUBMISSION_BODY_BYTES} bytes)`),
        user,
        null,
      ),
      413,
    )
  }
  const rate = await checkSubmissionRateLimit(c.env, user.id)
  if (!rate.allowed) {
    c.header('Retry-After', String(rate.retryAfter))
    return c.html(
      submitResultPage(
        rejectedVerification(
          `submission rate limit exceeded: ${SUBMISSION_RATE_LIMIT} per ${SUBMISSION_RATE_PERIOD_SEC} seconds; retry in about ${rate.retryAfter} seconds`,
        ),
        user,
        null,
      ),
      429,
    )
  }
  const form = await c.req.parseBody()
  const input: VerifyInput = {
    ainvs: parseTokens(String(form.ainvs ?? '')),
    points: parsePoints(String(form.points ?? '')),
    primes: parseTokens(String(form.primes ?? '')),
  }
  const gp = await getGp()
  const result = verify(gp, input)
  const submit: SubmitInfo | null = result.ok ? await recordCurve(c.env, user.id, result) : null
  if (submit) {
    c.executionCtx.waitUntil(
      notifyRecord(c.env, submit, user.display_name ?? null, new URL(c.req.url).origin),
    )
  }
  return c.html(submitResultPage(result, user, submit), result.ok ? 200 : 422)
})

// --- Auth ---
app.get('/auth/:provider', startOAuth)
app.get('/auth/:provider/callback', handleCallback)
app.post('/auth/logout', logout)

// --- Profile & API tokens ---
app.get('/profile', async (c) => {
  const user = c.get('user')
  if (!user) return c.redirect('/auth/github', 302)
  const [tokens, curves] = await Promise.all([listTokens(c.env, user.id), listUserCurves(c.env, user.id)])
  return c.html(profilePage(user, tokens, null, curves))
})

app.post('/profile/tokens', async (c) => {
  const user = c.get('user')
  if (!user) return c.redirect('/auth/github', 302)
  const form = await c.req.parseBody()
  const name = String(form.name ?? '').trim().slice(0, 100) || null
  const newToken = await generateApiToken(c.env, user.id, name)
  const [tokens, curves] = await Promise.all([listTokens(c.env, user.id), listUserCurves(c.env, user.id)])
  return c.html(profilePage(user, tokens, newToken, curves))
})

app.post('/profile/tokens/:id/revoke', async (c) => {
  const user = c.get('user')
  if (!user) return c.redirect('/auth/github', 302)
  const id = Number(c.req.param('id'))
  if (Number.isInteger(id)) {
    await c.env.DB.prepare(
      'UPDATE api_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    )
      .bind(id, user.id)
      .run()
  }
  return c.redirect('/profile', 302)
})

app.post('/profile/name', async (c) => {
  const user = c.get('user')
  if (!user) return c.redirect('/auth/github', 302)
  const form = await c.req.parseBody()
  const name = String(form.name ?? '').trim().slice(0, 100)
  if (name) {
    await c.env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(name, user.id).run()
    await updateSessionUser(c, { display_name: name })
  }
  return c.redirect('/profile', 302)
})

app.notFound((c) => c.html(notFoundPage(c.get('user') ?? null), 404))

function listTokens(env: Bindings, userId: number): Promise<TokenRow[]> {
  return env.DB.prepare(
    `SELECT id, name, prefix, created_at, last_used_at, revoked_at
       FROM api_tokens WHERE user_id = ? ORDER BY id DESC`,
  )
    .bind(userId)
    .all<TokenRow>()
    .then((r) => r.results)
}

// Curves currently attributed to this user as submitter (they proved the
// best-known rank). Highest rank first, then smallest naive height — the same
// "best curve" ordering the database download uses.
function listUserCurves(env: Bindings, userId: number): Promise<TableCurve[]> {
  return env.DB.prepare(
    `SELECT id, ainvs, rank_lower_bound, naive_height, faltings_height, conductor, discriminant
       FROM curves WHERE submitter_user_id = ?
       ORDER BY rank_lower_bound DESC, naive_height ASC`,
  )
    .bind(userId)
    .all<TableCurve>()
    .then((r) => r.results)
}

// Split free-form text into integer/rational tokens (commas or whitespace).
function parseTokens(s: string): string[] {
  return s.trim().split(/[\s,]+/).filter(Boolean)
}

// One point per line; each line "x, y" or "x y".
function parsePoints(s: string): [string, string][] {
  return s
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[\s,]+/).filter(Boolean)
      return [parts[0] ?? '', parts[1] ?? ''] as [string, string]
    })
}

function submissionBodyTooLarge(req: Request): boolean {
  const length = Number(req.headers.get('content-length') ?? '')
  return Number.isFinite(length) && length > MAX_SUBMISSION_BODY_BYTES
}

function rejectedVerification(message: string): VerifyResult {
  return {
    ok: false,
    errors: [message],
    curve: null,
    canonical: null,
    points: [],
    allPointsOnCurve: false,
    independence: null,
    height: null,
    conductor: null,
    minimalDiscriminant: null,
    faltingsHeight: null,
    conductorNote: null,
  }
}

export default app
