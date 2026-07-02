// One-off backfill (July 2026): populate the bad_primes column for curves
// recorded before it existed, by resubmitting each curve's current witness
// together with its primes of bad reduction. The resubmission is 'unchanged'
// (same witness, same rank), which fills bad_primes without touching the
// rank, witness, or submitter attribution — and the verifier re-validates the
// primes (each prime, together dividing the minimal discriminant to a unit)
// rather than trusting this script.
//
// The primes come from scripts/bad-primes.json (id -> [primes]), produced by
// factoring every recorded conductor during the July 2026 conductor audit.
// Curves missing from that file (conductor factorization still unknown) are
// reported and skipped.
//
// Usage:  node scripts/backfill-bad-primes.mjs
// Token:  read from ~/.erank-token.txt
// Site:   override with ERANK_SITE (e.g. http://localhost:8787 for a dry run).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SITE = (process.env.ERANK_SITE ?? 'https://elliptic-rank.icarm.cloud').replace(/\/+$/, '')
const tokenPath = process.env.ERANK_TOKEN_FILE ?? path.join(os.homedir(), '.erank-token.txt')
const token = fs.readFileSync(tokenPath, 'utf8').trim()

if (!token) {
  console.error(`empty API token in ${tokenPath}`)
  process.exit(1)
}

const primesPath = new URL('./bad-primes.json', import.meta.url)
const primesById = new Map(
  Object.entries(JSON.parse(fs.readFileSync(primesPath, 'utf8'))).map(([id, ps]) => [Number(id), ps]),
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// POST and parse JSON; on 429 wait out the advertised Retry-After and retry.
async function jsonFetch(url, options = {}) {
  for (;;) {
    const res = await fetch(url, {
      ...options,
      headers: { accept: 'application/json', ...(options.headers ?? {}) },
    })
    const text = await res.text()
    let body
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      throw new Error(`${url}: HTTP ${res.status}, non-JSON response: ${text.slice(0, 200)}`)
    }
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') ?? body?.rateLimit?.retryAfter ?? 60)
      console.log(`  rate limited; waiting ${wait}s`)
      await sleep((wait + 1) * 1000)
      continue
    }
    if (!res.ok) {
      throw new Error(`${url}: HTTP ${res.status}: ${JSON.stringify(body).slice(0, 500)}`)
    }
    return body
  }
}

async function loadDatabase() {
  const db = await jsonFetch(`${SITE}/database.json`, { headers: { 'cache-control': 'no-cache' } })
  if (!db || !Array.isArray(db.curves)) {
    throw new Error('database.json did not contain a curves array')
  }
  return db.curves
}

const before = await loadDatabase()
const targets = before.filter((c) => c.conductor != null && c.bad_primes == null)
const skipped = targets.filter((c) => !primesById.has(c.id))
const todo = targets.filter((c) => primesById.has(c.id))
console.log(
  `${before.length} curve(s) on ${SITE}: ${targets.length} missing bad_primes, ` +
    `${todo.length} to backfill, ${skipped.length} without a known factorization` +
    (skipped.length ? ` (${skipped.map((c) => `#${c.id}`).join(', ')})` : ''),
)

let filled = 0
let failed = 0

for (const c of todo) {
  const primes = primesById.get(c.id)
  try {
    const r = await jsonFetch(`${SITE}/api/submit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ainvs: c.ainvs, points: c.points, primes }),
    })
    // The resubmission must be a no-op apart from bad_primes: same curve, same
    // rank, and the verifier's conductor must agree with the stored one.
    const ok =
      r.ok === true &&
      r.leaderboard?.id === c.id &&
      r.leaderboard?.status === 'unchanged' &&
      r.conductor === c.conductor &&
      Array.isArray(r.badPrimes) &&
      r.badPrimes.length > 0
    console.log(
      `#${String(c.id).padEnd(3)} rank>=${String(c.rank_lower_bound).padEnd(2)} ` +
        `${primes.length} prime(s) ${ok ? 'OK' : 'FAILED'}`,
    )
    if (!ok) {
      failed++
      console.error(
        `  expected id=${c.id} unchanged with conductor ${c.conductor.slice(0, 40)}…; got ` +
          `id=${r.leaderboard?.id}, status=${r.leaderboard?.status}, ok=${r.ok}, ` +
          `conductorMatch=${r.conductor === c.conductor}, errors=${JSON.stringify(r.errors ?? [])}`,
      )
      continue
    }
    filled++
  } catch (e) {
    failed++
    console.error(`#${c.id} FAILED: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// Re-download and confirm every targeted curve now stores its primes.
const after = await loadDatabase()
const afterById = new Map(after.map((c) => [c.id, c]))
let stillMissing = 0
for (const c of todo) {
  const row = afterById.get(c.id)
  const want = JSON.stringify(primesById.get(c.id))
  const got = JSON.stringify(row?.bad_primes ?? null)
  if (got !== want) {
    stillMissing++
    console.error(`#${c.id} database check FAILED: expected ${want.slice(0, 80)}, stored ${got.slice(0, 80)}`)
  }
}

console.log(
  `done: ${filled} filled, ${failed} failed, ${skipped.length} skipped (no factorization), ` +
    `${stillMissing} failed database check`,
)
if (failed > 0 || stillMissing > 0) process.exitCode = 1
