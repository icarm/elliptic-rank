import { Hono } from 'hono'
import { getGp } from './pari'
import { verify, type VerifyInput } from './verify'

const app = new Hono()

app.get('/', (c) => c.text('elliptic-rank: high-rank, low-height elliptic curves'))

// Verify a submission: certify a rank lower bound from a curve + witness points.
// Body: { ainvs: [...], points: [[x,y], ...] }
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

export default app
