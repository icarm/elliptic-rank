// One-off backfill (June 2026): naive heights recorded before the
// canonical-height fix were computed from the submitted model, so curves
// submitted in a non-minimal model (e.g. #61, Elkies' rank-13 Mordell curve,
// submitted as y^2 = x^3 + 16m) carry an inflated height. With the fix
// deployed, resubmitting a curve's own stored witness recomputes the height
// canonically and recordCurve corrects the stored value in place — full
// verification, no manual SQL.
//
// Historical note: this audits the orbit-reduced key height used by the earlier
// canonical-height rule. The current verifier records minimal-model height, so
// do not use this script for the later p=2,3 minimal-height backfill.
//
// Usage:  node scripts/backfill-naive-heights.mjs
// Token:  read from ~/.erank-token.txt
// Site:   override with ERANK_SITE (e.g. http://localhost:8787 for a dry run).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SITE = process.env.ERANK_SITE ?? 'https://elliptic-rank.icarm.cloud'
const token = fs.readFileSync(path.join(os.homedir(), '.erank-token.txt'), 'utf8').trim()

// Natural log of |big integer decimal string| (same method as pages.ts).
function logBig(s) {
  const t = s.replace('-', '')
  if (t === '0') return -Infinity
  const k = Math.min(15, t.length)
  return Math.log(Number(t.slice(0, k))) + (t.length - k) * Math.LN10
}

// Naive height recomputed from the canonical key "c4:c6".
function canonicalHeight(key) {
  const [c4, c6] = key.split(':')
  return Math.max(3 * logBig(c4), 2 * logBig(c6))
}

async function staleCurves() {
  const db = await (await fetch(`${SITE}/database.json`)).json()
  return db.curves.filter((c) => Math.abs(canonicalHeight(c.curve_key) - c.naive_height) > 1e-6)
}

const stale = await staleCurves()
console.log(`${stale.length} curve(s) with stale naive height on ${SITE}`)

for (const c of stale) {
  const want = canonicalHeight(c.curve_key)
  const res = await fetch(`${SITE}/api/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ ainvs: c.ainvs, points: c.points }),
  })
  const r = await res.json()
  const got = r.height ? Number(r.height.naiveLogHeight.replace(/\s+/g, '').replace(/E/i, 'e')) : NaN
  const ok = r.ok && r.leaderboard?.id === c.id && Math.abs(got - want) < 1e-6
  console.log(
    `#${String(c.id).padEnd(3)} rank>=${String(c.rank_lower_bound).padEnd(2)} ` +
      `${c.naive_height.toFixed(4)} -> ${want.toFixed(4)} ${ok ? 'OK' : 'FAILED: ' + JSON.stringify(r.errors ?? r)}`,
  )
  if (!ok) process.exitCode = 1
}

const remaining = await staleCurves()
console.log(remaining.length === 0 ? 'audit clean: all stored heights canonical' : `STILL STALE: ${remaining.map((c) => c.id).join(', ')}`)
if (remaining.length > 0) process.exitCode = 1
