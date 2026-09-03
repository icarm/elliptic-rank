// Posts a Zulip message when a curve newly holds a leaderboard record — either
// from a submission or from a primes backfill that records its conductor.
//
// Delivery uses Zulip's Slack-compatible incoming webhook
// (`/api/v1/external/slack_incoming`): a single secret URL with the api_key,
// stream, and topic baked in, to which we POST `{ "text": <markdown> }`. The
// URL lives in the ZULIP_WEBHOOK_URL secret; when it is unset (e.g. local dev)
// notification is silently skipped.

import type { Bindings } from './auth'
import { recordFlags, loadRecordCandidate, type RecordCandidate, type RecordStatus } from './store'
import { logBigInt, type RecordFlags } from './pages'

// Send `text` as a Zulip message via the incoming webhook. Returns true on a 2xx
// response. Never throws: delivery is best-effort and runs off the request path.
async function send(url: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) {
      console.error(`Zulip webhook returned ${res.status}: ${await res.text()}`)
      return false
    }
    return true
  } catch (err) {
    console.error('Zulip webhook request failed:', err)
    return false
  }
}

type Metric = 'naive' | 'faltings' | 'conductor' | 'disc'

// "smallest **X** (value)" phrases for the curve's metrics that are records,
// limited to the metrics in `consider`.
function recordPhrases(curve: RecordCandidate, flags: RecordFlags, consider: Metric[]): string[] {
  const out: string[] = []
  if (consider.includes('naive') && flags.naive) {
    out.push(`smallest **naive height** (${curve.naive_height.toFixed(4)})`)
  }
  if (consider.includes('faltings') && flags.faltings && curve.faltings_height != null) {
    out.push(`smallest **Faltings height** (${curve.faltings_height.toFixed(4)})`)
  }
  if (consider.includes('conductor') && flags.conductor && curve.conductor != null) {
    out.push(`smallest **conductor** (${curve.conductor})`)
  }
  if (consider.includes('disc') && flags.discriminant) {
    out.push(`smallest **log |Δ|** (${logBigInt(curve.discriminant).toFixed(2)})`)
  }
  return out
}

// "a", "a and b", or "a, b, and c".
function joinRecords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

// Notify Zulip if the just-recorded submission newly holds a record. Only fresh
// frontier entries ('created' or 'improved') are considered: an 'unchanged'
// submission did not change the board. No-op when the webhook is unconfigured or
// the curve holds no record for its rank.
//
// Intended to be called via `ctx.waitUntil(...)` so delivery does not block the
// response to the submitter.
export async function notifyRecord(
  env: Bindings,
  status: RecordStatus,
  submitter: string | null,
  baseUrl: string,
): Promise<void> {
  const url = env.ZULIP_WEBHOOK_URL
  if (!url) return
  // An 'unchanged' submission didn't move the board — but re-submitting an
  // existing curve with its primes of bad reduction backfills the conductor and
  // Faltings height, which can newly make it a record just like the dedicated
  // primes-backfill endpoints. Hand those off to the backfill notifier.
  if (status.status === 'unchanged') {
    if (status.conductorRecorded) await notifyBackfillRecord(env, status.id, submitter, baseUrl)
    return
  }

  const curve = await loadRecordCandidate(env, status.id)
  if (!curve) return
  const flags = await recordFlags(env, curve)
  const records = recordPhrases(curve, flags, ['naive', 'faltings', 'conductor', 'disc'])
  if (records.length === 0) return

  const link = `${baseUrl}/curve/${curve.id}`
  const who = submitter ? ` by ${submitter}` : ''
  const verb = status.status === 'created' ? 'New curve' : 'Improved curve'
  const text =
    `:trophy: **New record!** ${verb} [#${curve.id}](${link}) at rank ≥ ${curve.rank_lower_bound}` +
    `, submitted${who}.\n` +
    `Now holds the record for ${joinRecords(records)} among curves of rank ≥ ${curve.rank_lower_bound}.`

  await send(url, text)
}

// Notify Zulip if a primes backfill newly made the curve a record. The conductor
// is the only invariant a backfill records (naive height, discriminant, and
// Faltings height are all fixed at submission), so only a new smallest-conductor
// record can result. No-op when the webhook is unconfigured or it isn't a record.
//
// Intended to be called via `ctx.waitUntil(...)` after a successful backfill.
export async function notifyBackfillRecord(
  env: Bindings,
  curveId: number,
  submitter: string | null,
  baseUrl: string,
): Promise<void> {
  const url = env.ZULIP_WEBHOOK_URL
  if (!url) return

  const curve = await loadRecordCandidate(env, curveId)
  if (!curve) return
  const flags = await recordFlags(env, curve)
  const records = recordPhrases(curve, flags, ['conductor'])
  if (records.length === 0) return

  const link = `${baseUrl}/curve/${curve.id}`
  const who = submitter ? ` by ${submitter}` : ''
  const text =
    `:trophy: **New record!** Curve [#${curve.id}](${link}) at rank ≥ ${curve.rank_lower_bound} ` +
    `now holds the record for ${joinRecords(records)} among curves of rank ≥ ${curve.rank_lower_bound}` +
    ` — after its conductor was recorded${who}.`

  await send(url, text)
}
