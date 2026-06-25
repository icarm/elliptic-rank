// Leaderboard storage. A verified submission is recorded into `curves`, deduped
// by the canonical key; the stored witness is replaced only when a new
// submission proves a strictly higher rank lower bound.

import type { Bindings } from './auth'
import { verifyPrimes, autoPrimes, type VerifyResult, type PrimesResult } from './verify'
import type { Gp } from './pari'
import type { RecordFlags } from './pages'

export const COMMENT_MAX = 4000

export interface CommentView {
  id: number
  content: string
  created_at: string
  author: string | null
}

// Record an edit to a curve's commentary and point the curve at it.
export async function postComment(
  env: Bindings,
  curveId: number,
  userId: number,
  content: string,
): Promise<void> {
  const ins = await env.DB.prepare(
    'INSERT INTO comments_log (curve_id, user_id, content) VALUES (?, ?, ?)',
  )
    .bind(curveId, userId, content)
    .run()
  await env.DB.prepare('UPDATE curves SET current_comment_id = ? WHERE id = ?')
    .bind(ins.meta.last_row_id, curveId)
    .run()
}

// Full edit history for a curve, newest first.
export function commentHistory(env: Bindings, curveId: number): Promise<CommentView[]> {
  return env.DB.prepare(
    `SELECT cl.id, cl.content, cl.created_at, u.display_name AS author
       FROM comments_log cl LEFT JOIN users u ON u.id = cl.user_id
       WHERE cl.curve_id = ? ORDER BY cl.id DESC`,
  )
    .bind(curveId)
    .all<CommentView>()
    .then((r) => r.results)
}

// One row in the recent-activity feed: either a curve submission (its creation)
// or a commentary edit. Both carry the curve's current rank/height for context.
export interface ActivityItem {
  kind: 'submission' | 'comment'
  ts: string
  curve_id: number
  rank: number
  height: number
  user: string | null
  content: string | null
}

export const ACTIVITY_PAGE_SIZE = 30

// Recent activity, newest first, paginated. Merges curve creations and
// commentary edits in one timeline. `hasOlder` reports whether a further page
// exists (we fetch one extra row to find out).
export async function recentActivity(
  env: Bindings,
  page = 0,
): Promise<{ items: ActivityItem[]; page: number; hasOlder: boolean }> {
  const size = ACTIVITY_PAGE_SIZE
  const { results } = await env.DB.prepare(
    `SELECT kind, ts, curve_id, rank, height, user, content FROM (
         SELECT 'submission' AS kind, c.created_at AS ts, c.id AS curve_id,
                c.rank_lower_bound AS rank, c.naive_height AS height,
                u.display_name AS user, NULL AS content
           FROM curves c LEFT JOIN users u ON u.id = c.submitter_user_id
         UNION ALL
         SELECT 'comment' AS kind, cl.created_at AS ts, cl.curve_id AS curve_id,
                cv.rank_lower_bound AS rank, cv.naive_height AS height,
                cu.display_name AS user, cl.content AS content
           FROM comments_log cl
           LEFT JOIN users cu ON cu.id = cl.user_id
           JOIN curves cv ON cv.id = cl.curve_id
       )
       -- kind ASC tiebreak: a submission with initial commentary writes both
       -- rows at the same second-precision timestamp; the comment ('comment' <
       -- 'submission') must sort first, i.e. display above = after, in this
       -- newest-first feed, since the commentary logically follows the curve.
       ORDER BY ts DESC, kind ASC
       LIMIT ? OFFSET ?`,
  )
    .bind(size + 1, page * size)
    .all<ActivityItem>()
  return { items: results.slice(0, size), page, hasOlder: results.length > size }
}

export interface RecordStatus {
  id: number
  status: 'created' | 'improved' | 'unchanged'
  rank: number
  previousRank?: number
  // True when this submission newly recorded the conductor for the curve.
  conductor?: boolean
}

// Parse a PARI real ("79.328...", "1.5 E-17") to a JS number for sorting.
function toFloat(s: string): number {
  return Number(s.replace(/\s+/g, '').replace(/E/i, 'e'))
}

// a < b for non-negative decimal integer strings of any size.
function lessDecimal(a: string, b: string): boolean {
  return a.length !== b.length ? a.length < b.length : a < b
}

// Curve fields needed to decide which metrics are records.
export interface RecordCandidate {
  id: number
  rank_lower_bound: number
  naive_height: number
  faltings_height: number | null
  conductor: string | null
}

// Which of the curve's metrics are records for its rank: a metric is a record
// when no curve of equal or higher rank has a strictly smaller value (i.e. the
// curve is on the rank-vs-metric Pareto frontier).
export async function recordFlags(env: Bindings, curve: RecordCandidate): Promise<RecordFlags> {
  const { results: rivals } = await env.DB.prepare(
    `SELECT naive_height, faltings_height, conductor FROM curves
       WHERE rank_lower_bound >= ? AND id != ?`,
  )
    .bind(curve.rank_lower_bound, curve.id)
    .all<{ naive_height: number; faltings_height: number | null; conductor: string | null }>()
  return {
    naive: !rivals.some((o) => o.naive_height < curve.naive_height),
    faltings:
      curve.faltings_height != null &&
      !rivals.some((o) => o.faltings_height != null && o.faltings_height < curve.faltings_height!),
    conductor:
      curve.conductor != null &&
      !rivals.some((o) => o.conductor != null && lessDecimal(o.conductor, curve.conductor!)),
  }
}

// Backfill the factoring-gated invariants (conductor, minimal discriminant,
// Faltings height) for an existing curve from supplied primes dividing the
// discriminant. Only fills
// fields that are currently missing, so it never overwrites recorded values.
export async function setCurveInvariants(
  env: Bindings,
  curveId: number,
  conductor: string,
  minDisc: string | null,
  faltings: string | null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE curves SET conductor = COALESCE(conductor, ?),
       minimal_discriminant = COALESCE(minimal_discriminant, ?),
       faltings_height = COALESCE(faltings_height, ?),
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  )
    .bind(conductor, minDisc, faltings != null ? toFloat(faltings) : null, curveId)
    .run()
}

// Outcome of backfilling a curve's factoring-gated invariants from the primes
// dividing its discriminant. 'rejected' carries the failed PrimesResult so the
// caller can surface `note`/`errors`.
export type PrimesBackfill =
  | { status: 'no-curve' }
  | { status: 'already-recorded' }
  | { status: 'recorded'; result: PrimesResult }
  | { status: 'rejected'; result: PrimesResult }

// Backfill the conductor, minimal discriminant, and Faltings height of a curve
// from the primes dividing its discriminant: `mode: 'auto'` attempts bounded
// trial division, otherwise the supplied `primes` are used. A no-op when the
// curve already has these recorded. Shared by the curve-page form and the JSON
// API, which differ only in how they present this outcome.
export async function backfillPrimes(
  env: Bindings,
  gp: Gp,
  curveId: number,
  mode: 'auto' | 'manual',
  primes: (string | number)[],
): Promise<PrimesBackfill> {
  const row = await env.DB.prepare('SELECT ainvs, conductor FROM curves WHERE id = ?')
    .bind(curveId)
    .first<{ ainvs: string; conductor: string | null }>()
  if (!row) return { status: 'no-curve' }
  if (row.conductor != null) return { status: 'already-recorded' }
  let ainvs: (string | number)[] = []
  try {
    ainvs = JSON.parse(row.ainvs)
  } catch {
    /* leave empty; verifyPrimes will reject */
  }
  const result = mode === 'auto' ? autoPrimes(gp, ainvs) : verifyPrimes(gp, ainvs, primes)
  if (result.ok && result.conductor != null) {
    await setCurveInvariants(env, curveId, result.conductor, result.minimalDiscriminant, result.faltingsHeight)
    return { status: 'recorded', result }
  }
  return { status: 'rejected', result }
}

// Record an accepted verification for `userId`. Returns how the leaderboard
// changed. Assumes result.ok (canonical/independence/height/curve are present).
export async function recordCurve(
  env: Bindings,
  userId: number,
  result: VerifyResult,
  // Optional initial commentary. Applied only when the curve has no commentary
  // yet (a fresh curve, or an existing one nobody has annotated) — never
  // overwrites commentary that already exists.
  commentary?: string,
): Promise<RecordStatus> {
  const key = result.canonical!.key
  const rank = result.independence!.rankLowerBound
  const ainvs = JSON.stringify(result.curve!.ainvs)
  const points = JSON.stringify(result.points.map((p) => p.point))
  const height = toFloat(result.height!.naiveLogHeight)
  const regulator = result.independence!.regulator
  // Factoring-gated invariants, present together iff valid primes were supplied.
  const conductor = result.conductor // string | null
  const minDisc = result.minimalDiscriminant // string | null
  const faltings = result.faltingsHeight != null ? toFloat(result.faltingsHeight) : null

  const hasCommentary = !!commentary && commentary.trim().length > 0

  const existing = await env.DB.prepare(
    `SELECT id, rank_lower_bound, naive_height, conductor, minimal_discriminant, faltings_height, current_comment_id
       FROM curves WHERE curve_key = ?`,
  )
    .bind(key)
    .first<{
      id: number
      rank_lower_bound: number
      naive_height: number
      conductor: string | null
      minimal_discriminant: string | null
      faltings_height: number | null
      current_comment_id: number | null
    }>()

  if (!existing) {
    const ins = await env.DB.prepare(
      `INSERT INTO curves
         (curve_key, c4, c6, ainvs, discriminant, naive_height, rank_lower_bound,
          regulator, points, submitter_user_id, conductor, minimal_discriminant, faltings_height)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        key,
        result.canonical!.c4,
        result.canonical!.c6,
        ainvs,
        result.curve!.discriminant,
        height,
        rank,
        regulator,
        points,
        userId,
        conductor,
        minDisc,
        faltings,
      )
      .run()
    const id = ins.meta.last_row_id as number
    if (hasCommentary) await postComment(env, id, userId, commentary!)
    return { id, status: 'created', rank, conductor: !!conductor }
  }

  // Existing curve: attach the supplied commentary only if it has none yet.
  if (hasCommentary && existing.current_comment_id == null) {
    await postComment(env, existing.id, userId, commentary!)
  }

  // The naive height is computed from the verifier's minimal-model invariant
  // path, so a stored value that disagrees predates a height-rule fix. Correct it
  // in place.
  if (Math.abs(existing.naive_height - height) > 1e-9) {
    await env.DB.prepare('UPDATE curves SET naive_height = ? WHERE id = ?')
      .bind(height, existing.id)
      .run()
  }

  // Backfill the factoring-gated invariants whenever we now have them and the
  // curve is missing any of them, independent of whether the rank improves.
  const setInvariants =
    !!conductor &&
    (existing.conductor == null ||
      existing.minimal_discriminant == null ||
      existing.faltings_height == null)

  if (rank > existing.rank_lower_bound) {
    await env.DB.prepare(
      `UPDATE curves SET rank_lower_bound = ?, regulator = ?, points = ?, ainvs = ?,
         submitter_user_id = ?, conductor = COALESCE(conductor, ?),
         minimal_discriminant = COALESCE(minimal_discriminant, ?),
         faltings_height = COALESCE(faltings_height, ?), updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
      .bind(rank, regulator, points, ainvs, userId, conductor, minDisc, faltings, existing.id)
      .run()
    return { id: existing.id, status: 'improved', rank, previousRank: existing.rank_lower_bound, conductor: setInvariants }
  }

  if (setInvariants) {
    await env.DB.prepare(
      `UPDATE curves SET conductor = ?, minimal_discriminant = ?, faltings_height = ?,
         updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    )
      .bind(conductor, minDisc, faltings, existing.id)
      .run()
  }
  return { id: existing.id, status: 'unchanged', rank: existing.rank_lower_bound, conductor: setInvariants }
}
