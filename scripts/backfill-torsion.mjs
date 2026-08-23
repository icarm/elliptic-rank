// One-off backfill (August 2026): record the torsion subgroup structure for
// every stored curve that predates the `torsion` column, by resubmitting its
// current witness to the live verifier. The server computes torsion exactly
// (elltors, part of the independence certificate) on every verify and
// COALESCE-backfills it for existing rows, so this script just replays each
// stored witness and then checks the database.
//
// Usage:  node scripts/backfill-torsion.mjs
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function jsonFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.headers ?? {}),
    },
  })
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`${url}: HTTP ${res.status}, non-JSON response: ${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    const err = new Error(`${url}: HTTP ${res.status}: ${JSON.stringify(body).slice(0, 500)}`)
    err.status = res.status
    err.retryAfter = Number(res.headers.get('retry-after')) || null
    throw err
  }
  return body
}

async function loadDatabase() {
  const db = await jsonFetch(`${SITE}/database.json`, {
    headers: { 'cache-control': 'no-cache' },
  })
  if (!db || !Array.isArray(db.curves)) {
    throw new Error('database.json did not contain a curves array')
  }
  return db.curves
}

// Resubmit a curve's stored witness, waiting out the submission rate limit.
async function submitCurve(c) {
  for (;;) {
    try {
      return await jsonFetch(`${SITE}/api/submit`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ainvs: c.ainvs, points: c.points }),
      })
    } catch (e) {
      if (e.status === 429) {
        const wait = (e.retryAfter ?? 15) + 1
        console.log(`  rate limited; retrying in ${wait}s`)
        await sleep(wait * 1000)
        continue
      }
      throw e
    }
  }
}

const before = await loadDatabase()
const todo = before.filter((c) => c.torsion == null)
console.log(
  `${before.length} curve(s) on ${SITE}; ${todo.length} missing torsion`,
)

let filled = 0
let failed = 0

for (const c of todo) {
  try {
    const r = await submitCurve(c)
    const ok =
      r.ok === true && r.leaderboard?.id === c.id && typeof r.torsion === 'string'
    console.log(
      `#${String(c.id).padEnd(3)} rank>=${String(c.rank_lower_bound).padEnd(2)} ` +
        `torsion=${r.torsion ?? '-'} ${ok ? 'OK' : 'FAILED'}`,
    )
    if (!ok) {
      failed++
      console.error(
        `  expected id=${c.id}; got id=${r.leaderboard?.id}, ok=${r.ok}, ` +
          `errors=${JSON.stringify(r.errors ?? [])}`,
      )
      continue
    }
    filled++
  } catch (e) {
    failed++
    console.error(`#${c.id} FAILED: ${e instanceof Error ? e.message : String(e)}`)
  }
}

const after = await loadDatabase()
const stillMissing = after.filter((c) => c.torsion == null)
for (const c of stillMissing) {
  console.error(`#${c.id} database check FAILED: torsion still null`)
}

console.log(
  `done: ${filled} filled, ${failed} failed, ${stillMissing.length} still missing in database`,
)

if (failed > 0 || stillMissing.length > 0) process.exitCode = 1
