// Posts a Zulip message when a curve newly holds a leaderboard record — either
// from a submission or from a primes backfill that records its conductor. As on
// the site's badges, ★ marks a record overall and ☆ one held only among curves
// with the same torsion subgroup.
//
// Delivery uses Zulip's Slack-compatible incoming webhook
// (`/api/v1/external/slack_incoming`): a single secret URL with the api_key,
// stream, and topic baked in, to which we POST `{ "text": <markdown> }`. The
// URL lives in the ZULIP_WEBHOOK_URL secret; when it is unset (e.g. local dev)
// notification is silently skipped.

import type { Bindings } from './auth'
import { announcedRecords, loadRecordCandidate, type RecordCandidate, type RecordStatus } from './store'
import { logBigInt, torsionText, type RecordFlags } from './pages'

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
    out.push(`smallest **log conductor** (${logBigInt(curve.conductor).toFixed(4)})`)
  }
  if (consider.includes('disc') && flags.discriminant) {
    out.push(`smallest **log |Δ|** (${logBigInt(curve.discriminant).toFixed(4)})`)
  }
  return out
}

// Metrics that are records within the torsion pool but not overall — the
// torsion records an overall record doesn't already imply.
function torsionOnly(overall: RecordFlags, torsion: RecordFlags): RecordFlags {
  return {
    naive: torsion.naive && !overall.naive,
    faltings: torsion.faltings && !overall.faltings,
    conductor: torsion.conductor && !overall.conductor,
    discriminant: torsion.discriminant && !overall.discriminant,
  }
}

// "with trivial torsion" or "with torsion ℤ/5ℤ". Null when the curve's torsion
// is not recorded or doesn't parse.
function withTorsion(curve: RecordCandidate): string | null {
  const t = curve.torsion == null ? null : torsionText(curve.torsion)
  if (t == null) return null
  return t === 'trivial' ? 'with trivial torsion' : `with torsion ${t}`
}

// "a", "a and b", or "a, b, and c".
function joinRecords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

// Notify Zulip if the just-recorded submission newly holds a record — strictly:
// merely tying the existing record holder isn't announced. Only fresh
// frontier entries ('created' or 'improved') are considered: an 'unchanged'
// submission did not change the board, and a 'declined' one was never written.
//
// A record overall gets a ★ message, which also mentions any further records
// the curve holds within its torsion subgroup. Otherwise, a record within the
// torsion subgroup gets a ☆ message. A curve that is the first on the board
// with its torsion subgroup at its rank trivially holds every record in that
// pool, so its ☆ message says just that. No-op when the webhook is
// unconfigured or the curve holds no record for its rank.
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
  if (status.status === 'declined') return
  if (status.status === 'unchanged') {
    if (status.conductorRecorded) await notifyBackfillRecord(env, status.id, submitter, baseUrl)
    return
  }

  const curve = await loadRecordCandidate(env, status.id)
  if (!curve) return
  const flags = await announcedRecords(env, curve)
  const all: Metric[] = ['naive', 'faltings', 'conductor', 'disc']
  const rank = curve.rank_lower_bound
  const overall = recordPhrases(curve, flags.overall, all)
  const group = withTorsion(curve)
  const first = group != null && flags.torsion != null && flags.torsionRivals === 0
  const inGroup =
    group == null || flags.torsion == null
      ? []
      : recordPhrases(curve, torsionOnly(flags.overall, flags.torsion), all)
  if (overall.length === 0 && !first && inGroup.length === 0) return

  const link = `${baseUrl}/curve/${curve.id}`
  const who = submitter ? ` by ${submitter}` : ''
  const verb = status.status === 'created' ? 'New curve' : 'Improved curve'
  const lines = [
    `${overall.length > 0 ? '★' : '☆'} **New record!** ${verb} [#${curve.id}](${link}) at rank ≥ ${rank}` +
      `, submitted${who}.`,
  ]
  if (overall.length > 0) {
    lines.push(`Now holds the record for ${joinRecords(overall)} among curves of rank ≥ ${rank}.`)
    if (first) lines.push(`It is also the first curve on the board of rank ≥ ${rank} ${group}.`)
    else if (inGroup.length > 0) {
      lines.push(`It also holds the record for ${joinRecords(inGroup)} among curves of rank ≥ ${rank} ${group}.`)
    }
  } else if (first) {
    lines.push(`It is the first curve on the board of rank ≥ ${rank} ${group}.`)
  } else {
    lines.push(`Now holds the record for ${joinRecords(inGroup)} among curves of rank ≥ ${rank} ${group}.`)
  }

  await send(url, lines.join('\n'))
}

// Notify Zulip if a primes backfill newly made the curve a record. The conductor
// is the only invariant a backfill records (naive height, discriminant, and
// Faltings height are all fixed at submission), so only a new smallest-conductor
// record can result, and as above only a strict one (not a tie) is announced:
// with ★ if overall, else with ☆ if within the curve's torsion subgroup. A
// curve alone in its torsion pool is skipped there: its record is trivial, and
// being first was news at submission, not now. No-op when the webhook is
// unconfigured or it isn't a record.
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
  const flags = await announcedRecords(env, curve)
  const rank = curve.rank_lower_bound
  const overall = recordPhrases(curve, flags.overall, ['conductor'])
  const group = withTorsion(curve)
  const inGroup =
    group == null || flags.torsion == null || flags.torsionRivals === 0
      ? []
      : recordPhrases(curve, flags.torsion, ['conductor'])
  const [star, held, among] =
    overall.length > 0 ? ['★', overall, `rank ≥ ${rank}`] : ['☆', inGroup, `rank ≥ ${rank} ${group}`]
  if (held.length === 0) return

  const link = `${baseUrl}/curve/${curve.id}`
  const who = submitter ? ` by ${submitter}` : ''
  const text =
    `${star} **New record!** Curve [#${curve.id}](${link}) at rank ≥ ${rank} ` +
    `now holds the record for ${joinRecords(held)} among curves of ${among} — after its conductor was recorded${who}.`

  await send(url, text)
}
