import { Hono } from 'hono'
import { getGp } from './pari'
import { verify, type VerifyInput } from './verify'
import { landingPage, verifyResultPage, apiDocsPage, notFoundPage } from './pages'

const app = new Hono()

// TODO: once GitHub OAuth + KV sessions land, resolve the current user here and
// pass it to the page renderers (the layout already renders an auth nav).
const currentUser = null

app.get('/', (c) => c.html(landingPage(currentUser)))

// Temporary production diagnostic. Logs each stage so that if the Worker hangs,
// the last log line (via `wrangler tail`) localizes where. Returns timings if
// it completes. Remove once the production hang is resolved.
app.get('/diag', async (c) => {
  const log = (m: string) => console.log(`[diag] ${m}`)
  const timings: Record<string, number> = {}
  const step = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
    log(`${name}: start`)
    const t = Date.now()
    const r = await fn()
    timings[name] = Date.now() - t
    log(`${name}: done in ${timings[name]}ms`)
    return r
  }
  try {
    const gp = await step('getGp (wasm init)', () => getGp())
    await step('eval 1+1', () => gp('1+1'))
    await step('ellinit 389a', () => gp('E=ellinit([0,1,1,-2,0])'))
    await step('heightmatrix 389a (2pts)', () =>
      gp('matdet(ellheightmatrix(E,[[0,0],[-1,1]]))'),
    )
    await step('qfjacobi 389a', () => gp('vecmin(qfjacobi(ellheightmatrix(E,[[0,0],[-1,1]]))[1])'))
    const v = await step('verify rank-12', () =>
      verify(gp, {
        ainvs: ['0', '0', '1', '-6349808647', '193146346911036'],
        points: [
          ['49421', '200114'], ['49493', '333458'], ['49513', '362258'],
          ['49632', '502899'], ['49667', '538049'], ['49797', '654674'],
          ['49899', '735713'], ['50012', '818375'], ['50165', '921837'],
          ['50215', '954017'], ['51108', '1454591'], ['-3659', '14708205'],
        ],
      }),
    )
    log('all stages complete')
    return c.json({ ok: true, timings, verifyOk: v.ok, rankLowerBound: v.independence?.rankLowerBound })
  } catch (e) {
    log(`ERROR: ${e instanceof Error ? e.message : String(e)}`)
    return c.json({ ok: false, timings, error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

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
