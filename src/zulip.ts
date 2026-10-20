// Posts a Zulip message when a curve newly holds a leaderboard record — either
// from a submission or from a primes backfill that records its conductor. As on
// the site's badges, ★ marks a record overall and ☆ one held only among curves
// with the same torsion subgroup or in the same family.
//
// Delivery uses Zulip's Slack-compatible incoming webhook
// (`/api/v1/external/slack_incoming`): a single secret URL with the api_key,
// stream, and topic baked in, to which we POST `{ "text": <markdown> }`. The
// URL lives in the ZULIP_WEBHOOK_URL secret; when it is unset (e.g. local dev)
// notification is silently skipped.

import type { Bindings } from './auth'
import { announcedRecords, loadRecordCandidate, type RecordCandidate, type RecordStatus } from './store'
import { logBigInt, torsionText, type RecordFlags } from './pages'
import { familyByKey } from './family'

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

type Metric = 'conductor' | 'disc' | 'faltings' | 'naive'

// "smallest **X** (value)" phrases for the curve's metrics that are records,
// limited to the metrics in `consider`.
function recordPhrases(curve: RecordCandidate, flags: RecordFlags, consider: Metric[]): string[] {
  const out: string[] = []
  if (consider.includes('conductor') && flags.conductor && curve.conductor != null) {
    out.push(`smallest **log conductor** (${logBigInt(curve.conductor).toFixed(4)})`)
  }
  if (consider.includes('disc') && flags.discriminant) {
    out.push(`smallest **log |Δ|** (${logBigInt(curve.discriminant).toFixed(4)})`)
  }
  if (consider.includes('faltings') && flags.faltings && curve.faltings_height != null) {
    out.push(`smallest **Faltings height** (${curve.faltings_height.toFixed(4)})`)
  }
  if (consider.includes('naive') && flags.naive) {
    out.push(`smallest **naive height** (${curve.naive_height.toFixed(4)})`)
  }
  return out
}

// Metrics that are records within a pool but not overall — the pool's
// records an overall record doesn't already imply.
function poolOnly(overall: RecordFlags, pool: RecordFlags): RecordFlags {
  return {
    naive: pool.naive && !overall.naive,
    faltings: pool.faltings && !overall.faltings,
    conductor: pool.conductor && !overall.conductor,
    discriminant: pool.discriminant && !overall.discriminant,
  }
}

// A record pool the curve is in, besides the whole board: its torsion subgroup
// or one of its families. `name` is the record's name, as on the site's ☆ badges ("ℤ/5ℤ
// torsion", "trivial torsion", "Mordell curves"); `among` qualifies the curves
// it is judged among ("with torsion ℤ/5ℤ", "of the form y² = x³ + k"); and
// `first` heads the message for the first such curve at a rank ("First curve
// with ℤ/5ℤ torsion", "First Mordell curve"). `flags` and `rivals` are the
// curve's strict records and rival count there (see store.announcedRecords).
interface Pool {
  name: string
  among: string
  first: string
  flags: RecordFlags
  rivals: number
}

// The curve's pools: its torsion subgroup (unless not recorded or unparseable),
// then its families, in FAMILIES order (a family before its special case).
function poolsOf(curve: RecordCandidate, flags: Awaited<ReturnType<typeof announcedRecords>>): Pool[] {
  const pools: Pool[] = []
  const t = curve.torsion == null ? null : torsionText(curve.torsion)
  if (t != null && flags.torsion != null) {
    const name = t === 'trivial' ? 'trivial torsion' : `${t} torsion`
    pools.push({
      name,
      among: t === 'trivial' ? 'with trivial torsion' : `with torsion ${t}`,
      first: `First curve with ${name}`,
      flags: flags.torsion,
      rivals: flags.torsionRivals,
    })
  }
  for (const f of flags.families) {
    const family = familyByKey(f.key)
    if (family == null) continue
    pools.push({
      name: family.name,
      among: `of the form ${family.label}`,
      first: `First ${family.name.replace(/s$/, '')}`,
      flags: f.flags,
      rivals: f.rivals,
    })
  }
  return pools
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
// the curve holds within its torsion subgroup and families. Otherwise, a
// record within one of those pools gets a ☆ message naming the first such pool
// up front (torsion, then families in FAMILIES order), and mentions the
// others. A curve that is the
// first on the board in a pool at its rank trivially holds every record in
// that pool, so its line says just that. The first curve on the board of its
// rank at all gets a ★ message saying so, with no pool lines (being first in
// them goes without saying). No-op when the webhook is unconfigured or the
// curve holds no record for its rank.
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
  const all: Metric[] = ['conductor', 'disc', 'faltings', 'naive']
  const rank = curve.rank_lower_bound
  const overall = recordPhrases(curve, flags.overall, all)
  // The pools with news: the curve is the first in them at its rank, or holds
  // records there that its overall records don't imply.
  const news = poolsOf(curve, flags)
    .map((p) => ({ ...p, isFirst: p.rivals === 0, held: recordPhrases(curve, poolOnly(flags.overall, p.flags), all) }))
    .filter((p) => p.isFirst || p.held.length > 0)
  if (overall.length === 0 && news.length === 0) return

  const link = `[#${curve.id}](${baseUrl}/curve/${curve.id})`
  const who = submitter ? ` by ${submitter}` : ''
  const verb = status.status === 'created' ? 'New curve' : 'Improved curve'
  // A further pool's line, after the message's headline.
  const also = (p: (typeof news)[number]): string =>
    p.isFirst
      ? `It is also the first curve on the board of rank ≥ ${rank} ${p.among}.`
      : `It also holds the record for ${joinRecords(p.held)} among curves of rank ≥ ${rank} ${p.among}.`
  const lines: string[] = []
  if (flags.rivals === 0) {
    lines.push(`★ **First curve of rank ≥ ${rank}!** ${verb} ${link}, submitted${who}.`)
    lines.push(`Now holds the record for ${joinRecords(overall)} among curves of rank ≥ ${rank}.`)
  } else if (overall.length > 0) {
    lines.push(`★ **New record!** ${verb} ${link} at rank ≥ ${rank}, submitted${who}.`)
    lines.push(`Now holds the record for ${joinRecords(overall)} among curves of rank ≥ ${rank}.`)
    for (const p of news) lines.push(also(p))
  } else {
    const [lead, ...rest] = news
    if (lead.isFirst) {
      lines.push(`☆ **${lead.first} at rank ≥ ${rank}!** ${verb} ${link}, submitted${who}.`)
    } else {
      lines.push(`☆ **New record for ${lead.name}!** ${verb} ${link} at rank ≥ ${rank}, submitted${who}.`)
      lines.push(`Now holds the record for ${joinRecords(lead.held)} among curves of rank ≥ ${rank} ${lead.among}.`)
    }
    for (const p of rest) lines.push(also(p))
  }

  await send(url, lines.join('\n'))
}

// Notify Zulip if a primes backfill newly made the curve a record. The conductor
// is the only invariant a backfill records (naive height, discriminant, and
// Faltings height are all fixed at submission), so only a new smallest-conductor
// record can result, and as above only a strict one (not a tie) is announced:
// with ★ if overall, else with ☆ if within the curve's torsion subgroup or one
// of its families (naming the first such pool, torsion before families, and
// mentioning the others). A curve alone at its rank is skipped, and one alone in a pool is
// skipped there: its record is trivial, and being first was news at
// submission, not now. No-op when the webhook is unconfigured or it isn't a
// record.
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
  if (flags.rivals === 0) return
  const rank = curve.rank_lower_bound
  const overall = recordPhrases(curve, flags.overall, ['conductor'])
  const inPools = poolsOf(curve, flags).filter(
    (p) => p.rivals > 0 && recordPhrases(curve, p.flags, ['conductor']).length > 0,
  )
  if (overall.length === 0 && inPools.length === 0) return
  const [lead, ...rest] = inPools
  const [headline, among] =
    overall.length > 0 ? ['★ **New record!**', `rank ≥ ${rank}`] : [`☆ **New record for ${lead.name}!**`, `rank ≥ ${rank} ${lead.among}`]
  // With an overall record, the pools' records go without saying.
  const others = overall.length > 0 ? [] : rest

  const link = `${baseUrl}/curve/${curve.id}`
  const who = submitter ? ` by ${submitter}` : ''
  const text =
    `${headline} Curve [#${curve.id}](${link}) at rank ≥ ${rank} ` +
    `now holds the record for ${joinRecords(overall.length > 0 ? overall : recordPhrases(curve, lead.flags, ['conductor']))} ` +
    `among curves of ${among} — after its conductor was recorded${who}.` +
    others.map((p) => ` It is also the record among curves of rank ≥ ${rank} ${p.among}.`).join('')

  await send(url, text)
}
