import { Hono } from 'hono'
import { getGp } from './pari'
import { verify, type VerifyInput } from './verify'
import {
  landingPage,
  submitResultPage,
  apiDocsPage,
  notFoundPage,
  profilePage,
  curveDetailPage,
  commentHistoryPage,
  type TokenRow,
  type SubmitInfo,
  type PlotCurve,
  type CurveRow,
} from './pages'
import { recordCurve, postComment, commentHistory, COMMENT_MAX, type CommentView } from './store'
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

// Resolve the current user (session cookie, else API bearer token) for every
// request. Both lookups short-circuit cheaply when their credential is absent.
app.use('*', async (c, next) => {
  const user = (await loadCurrentUser(c)) ?? (await loadUserFromToken(c))
  c.set('user', user)
  await next()
})

app.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, rank_lower_bound, naive_height, faltings_height, conductor FROM curves',
  ).all<PlotCurve>()
  return c.html(landingPage(c.get('user'), results))
})

app.get('/curve/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.html(notFoundPage(c.get('user')), 404)
  const row = await c.env.DB.prepare(
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
  if (!row) return c.html(notFoundPage(c.get('user')), 404)
  const comment: CommentView | null =
    row.comment_id != null
      ? {
          id: row.comment_id,
          content: row.comment_content ?? '',
          created_at: row.comment_at ?? '',
          author: row.comment_author,
        }
      : null
  return c.html(curveDetailPage(row, comment, c.get('user')))
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

// Full database as downloadable JSON.
app.get('/database.json', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.curve_key, c.ainvs, c.discriminant, c.naive_height, c.rank_lower_bound,
            c.regulator, c.points, c.conductor, c.minimal_discriminant, c.faltings_height,
            c.created_at, c.updated_at, u.display_name AS submitter, cl.content AS commentary
       FROM curves c
       LEFT JOIN users u ON u.id = c.submitter_user_id
       LEFT JOIN comments_log cl ON cl.id = c.current_comment_id
       ORDER BY c.rank_lower_bound DESC, c.naive_height ASC`,
  ).all<{
    id: number
    curve_key: string
    ainvs: string
    discriminant: string
    naive_height: number
    rank_lower_bound: number
    regulator: string
    points: string
    conductor: string | null
    minimal_discriminant: string | null
    faltings_height: number | null
    created_at: string
    updated_at: string
    submitter: string | null
    commentary: string | null
  }>()
  const parse = (s: string): unknown => {
    try {
      return JSON.parse(s)
    } catch {
      return s
    }
  }
  const curves = results.map((r) => ({
    id: r.id,
    curve_key: r.curve_key,
    ainvs: parse(r.ainvs),
    rank_lower_bound: r.rank_lower_bound,
    naive_height: r.naive_height,
    faltings_height: r.faltings_height,
    conductor: r.conductor,
    discriminant: r.discriminant,
    minimal_discriminant: r.minimal_discriminant,
    regulator: r.regulator,
    points: parse(r.points),
    submitter: r.submitter,
    commentary: r.commentary || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }))
  return c.json({ count: curves.length, curves }, 200, {
    'content-disposition': 'attachment; filename="elliptic-rank-database.json"',
    'cache-control': 'public, max-age=300',
  })
})

// JSON API: submit a curve + witness points. Requires a bearer token; the
// verified curve is recorded on the leaderboard. Body: { ainvs, points }.
app.post('/api/submit', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ ok: false, errors: ['authentication required'] }, 401)
  let body: VerifyInput
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, errors: ['request body must be JSON'] }, 400)
  }
  const gp = await getGp()
  const result = verify(gp, body)
  const leaderboard = result.ok ? await recordCurve(c.env, user.id, result) : undefined
  return c.json({ ...result, leaderboard }, result.ok ? 200 : 422)
})

// HTML form on the landing page posts here; requires login, records, and
// renders a result page.
app.post('/submit-form', async (c) => {
  const user = c.get('user')
  if (!user) return c.redirect('/auth/github', 302)
  const form = await c.req.parseBody()
  const input: VerifyInput = {
    ainvs: parseTokens(String(form.ainvs ?? '')),
    points: parsePoints(String(form.points ?? '')),
    primes: parseTokens(String(form.primes ?? '')),
  }
  const gp = await getGp()
  const result = verify(gp, input)
  const submit: SubmitInfo | null = result.ok ? await recordCurve(c.env, user.id, result) : null
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
  return c.html(profilePage(user, await listTokens(c.env, user.id), null))
})

app.post('/profile/tokens', async (c) => {
  const user = c.get('user')
  if (!user) return c.redirect('/auth/github', 302)
  const form = await c.req.parseBody()
  const name = String(form.name ?? '').trim().slice(0, 100) || null
  const newToken = await generateApiToken(c.env, user.id, name)
  return c.html(profilePage(user, await listTokens(c.env, user.id), newToken))
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

export default app
