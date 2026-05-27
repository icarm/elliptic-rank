import { Hono } from 'hono'
import { getGp } from './pari'
import { verify, type VerifyInput } from './verify'
import {
  landingPage,
  verifyResultPage,
  apiDocsPage,
  notFoundPage,
  profilePage,
  curveDetailPage,
  type TokenRow,
  type SubmitInfo,
  type PlotCurve,
  type CurveRow,
} from './pages'
import { recordCurve } from './store'
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
    'SELECT id, rank_lower_bound, naive_height FROM curves',
  ).all<PlotCurve>()
  return c.html(landingPage(c.get('user'), results))
})

app.get('/curve/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.html(notFoundPage(c.get('user')), 404)
  const row = await c.env.DB.prepare(
    `SELECT c.*, u.display_name AS submitter_name
       FROM curves c LEFT JOIN users u ON u.id = c.submitter_user_id
       WHERE c.id = ?`,
  )
    .bind(id)
    .first<CurveRow>()
  if (!row) return c.html(notFoundPage(c.get('user')), 404)
  return c.html(curveDetailPage(row, c.get('user')))
})

app.get('/api', (c) => c.html(apiDocsPage(c.get('user'))))

// JSON API: certify a rank lower bound. Body: { ainvs, points }.
app.post('/api/verify', async (c) => {
  let body: VerifyInput
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, errors: ['request body must be JSON'] }, 400)
  }
  const gp = await getGp()
  const result = verify(gp, body)
  // Authenticated requests (bearer token) record to the leaderboard.
  const user = c.get('user')
  const leaderboard = result.ok && user ? await recordCurve(c.env, user.id, result) : undefined
  return c.json({ ...result, leaderboard }, result.ok ? 200 : 422)
})

// HTML form on the landing page posts here; renders a result page.
app.post('/verify-form', async (c) => {
  const form = await c.req.parseBody()
  const input: VerifyInput = {
    ainvs: parseTokens(String(form.ainvs ?? '')),
    points: parsePoints(String(form.points ?? '')),
  }
  const gp = await getGp()
  const result = verify(gp, input)
  // Logged-in users record to the leaderboard; anonymous users get a prompt.
  const user = c.get('user')
  let submit: SubmitInfo | null = null
  if (result.ok) submit = user ? await recordCurve(c.env, user.id, result) : { status: 'anonymous' }
  return c.html(verifyResultPage(result, user, submit), result.ok ? 200 : 422)
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
