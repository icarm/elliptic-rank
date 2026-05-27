import { Hono } from 'hono'
import { getGp } from './pari'
import { verify, type VerifyInput } from './verify'
import { landingPage, verifyResultPage, apiDocsPage, notFoundPage } from './pages'

const app = new Hono()

// TODO: once GitHub OAuth + KV sessions land, resolve the current user here and
// pass it to the page renderers (the layout already renders an auth nav).
const currentUser = null

app.get('/', (c) => c.html(landingPage(currentUser)))

app.get('/api', (c) => c.html(apiDocsPage(currentUser)))

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
  return c.json(result, result.ok ? 200 : 422)
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
  return c.html(verifyResultPage(result, currentUser), result.ok ? 200 : 422)
})

app.notFound((c) => c.html(notFoundPage(currentUser), 404))

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
