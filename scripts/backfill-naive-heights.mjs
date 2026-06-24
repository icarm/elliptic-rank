// One-off backfill (June 2026): recompute naive heights for every stored curve
// by resubmitting its current witness to the live verifier. This intentionally
// does not derive height from curve_key: the current convention is minimal-model
// height, while curve_key is the bounded orbit-reduced dedup key.
//
// Usage:  node scripts/backfill-naive-heights.mjs
// Token:  read from ~/.erank-token.txt
// Site:   override with ERANK_SITE (e.g. http://localhost:8787 for a dry run).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SITE = (process.env.ERANK_SITE ?? 'https://elliptic-rank.icarm.cloud').replace(/\/+$/, '')
const tokenPath = process.env.ERANK_TOKEN_FILE ?? path.join(os.homedir(), '.erank-token.txt')
const token = fs.readFileSync(tokenPath, 'utf8').trim()
const EPS = 1e-6

if (!token) {
  console.error(`empty API token in ${tokenPath}`)
  process.exit(1)
}

function parsePariFloat(s) {
  return Number(String(s).replace(/\s+/g, '').replace(/E/i, 'e'))
}

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
    throw new Error(`${url}: HTTP ${res.status}: ${JSON.stringify(body).slice(0, 500)}`)
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

async function submitCurve(c) {
  return jsonFetch(`${SITE}/api/submit`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ainvs: c.ainvs, points: c.points }),
  })
}

const before = await loadDatabase()
console.log(`recomputing naive heights for ${before.length} curve(s) on ${SITE}`)

const expected = new Map()
let changed = 0
let unchanged = 0
let failed = 0

for (const c of before) {
  try {
    const r = await submitCurve(c)
    const got = parsePariFloat(r.height?.naiveLogHeight)
    const sameId = r.leaderboard?.id === c.id
    const sameRank = r.independence?.rankLowerBound === c.rank_lower_bound
    const ok = r.ok === true && Number.isFinite(got) && sameId && sameRank
    const delta = got - c.naive_height
    const didChange = Math.abs(delta) > EPS

    console.log(
      `#${String(c.id).padEnd(3)} rank>=${String(c.rank_lower_bound).padEnd(2)} ` +
        `${c.naive_height.toFixed(6)} -> ${Number.isFinite(got) ? got.toFixed(6) : 'NaN'} ` +
        `${didChange ? `delta=${delta.toFixed(6)} UPDATED` : 'unchanged'} ` +
        `${ok ? 'OK' : 'FAILED'}`,
    )

    if (!ok) {
      failed++
      console.error(
        `  expected id=${c.id}, rank=${c.rank_lower_bound}; got ` +
          `id=${r.leaderboard?.id}, rank=${r.independence?.rankLowerBound}, ` +
          `ok=${r.ok}, errors=${JSON.stringify(r.errors ?? [])}`,
      )
      continue
    }

    expected.set(c.id, got)
    if (didChange) changed++
    else unchanged++
  } catch (e) {
    failed++
    console.error(`#${c.id} FAILED: ${e instanceof Error ? e.message : String(e)}`)
  }
}

const after = await loadDatabase()
const afterById = new Map(after.map((c) => [c.id, c]))
let stillStale = 0

for (const [id, want] of expected) {
  const row = afterById.get(id)
  if (!row || Math.abs(row.naive_height - want) > EPS) {
    stillStale++
    console.error(
      `#${id} database check FAILED: expected ${want.toFixed(6)}, ` +
        `stored ${row ? row.naive_height.toFixed(6) : 'missing'}`,
    )
  }
}

console.log(
  `done: ${changed} updated, ${unchanged} unchanged, ${failed} failed, ` +
    `${stillStale} failed database check`,
)

if (failed > 0 || stillStale > 0) process.exitCode = 1
