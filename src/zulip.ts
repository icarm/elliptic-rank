// Posts a Zulip message when a submission newly holds a leaderboard record.
//
// Delivery uses Zulip's Slack-compatible incoming webhook
// (`/api/v1/external/slack_incoming`): a single secret URL with the api_key,
// stream, and topic baked in, to which we POST `{ "text": <markdown> }`. The
// URL lives in the ZULIP_WEBHOOK_URL secret; when it is unset (e.g. local dev)
// notification is silently skipped.

import type { Bindings } from './auth'
import { recordFlags, type RecordStatus } from './store'

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
  if (status.status === 'unchanged') return

  const curve = await env.DB.prepare(
    `SELECT id, rank_lower_bound, naive_height, faltings_height, conductor
       FROM curves WHERE id = ?`,
  )
    .bind(status.id)
    .first<{
      id: number
      rank_lower_bound: number
      naive_height: number
      faltings_height: number | null
      conductor: string | null
    }>()
  if (!curve) return

  const flags = await recordFlags(env, curve)
  const records: string[] = []
  if (flags.naive) records.push(`smallest **naive height** (${curve.naive_height.toFixed(4)})`)
  if (flags.faltings && curve.faltings_height != null) {
    records.push(`smallest **Faltings height** (${curve.faltings_height.toFixed(4)})`)
  }
  if (flags.conductor && curve.conductor != null) {
    records.push(`smallest **conductor** (${curve.conductor})`)
  }
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

// "a", "a and b", or "a, b, and c".
function joinRecords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}
