// Leaderboard storage. A verified submission is recorded into `curves`, deduped
// by the canonical key. The verifier normalizes accepted witnesses to the
// global minimal model before they reach this layer; the stored witness is
// replaced only when a new submission proves a strictly higher rank lower bound.

import type { Bindings } from './auth'
import { verifyPrimes, autoPrimes, type VerifyResult, type PrimesResult } from './verify'
import type { Gp } from './pari'
import type { RecordFlags, PlotCurve, TableCurve } from './pages'

export const COMMENT_MAX = 4000

// Columns every curve list reads: the landing and progress plots need the id,
// rank and metrics (PlotCurve); the /curves table and a profile's curve list
// also need the equation (TableCurve).
const PLOT_COLUMNS = 'id, rank_lower_bound, naive_height, faltings_height, conductor, discriminant'
const TABLE_COLUMNS = `${PLOT_COLUMNS}, ainvs`

// Every curve with its metrics, in submission (id) order, for the landing and
// progress plots.
export function plotCurves(env: Bindings): Promise<PlotCurve[]> {
  return env.DB.prepare(`SELECT ${PLOT_COLUMNS} FROM curves ORDER BY id ASC`)
    .all<PlotCurve>()
    .then((r) => r.results)
}

// Every curve for the /curves table. Default order matches the table's JS
// default: increasing conductor, curves with no recorded conductor last.
// Conductor is a big-integer decimal string, so numeric order = (length, then
// lexicographic).
export function tableCurves(env: Bindings): Promise<TableCurve[]> {
  return env.DB.prepare(
    `SELECT ${TABLE_COLUMNS} FROM curves
       ORDER BY conductor IS NULL, LENGTH(conductor), conductor, naive_height ASC`,
  )
    .all<TableCurve>()
    .then((r) => r.results)
}

// Curves attributed to this user as original submitter (a later rank
// improvement by someone else does not reassign credit). Highest rank first,
// then smallest naive height — the same "best curve" ordering the database
// download uses.
export function userCurves(env: Bindings, userId: number): Promise<TableCurve[]> {
  return env.DB.prepare(
    `SELECT ${TABLE_COLUMNS} FROM curves WHERE submitter_user_id = ?
       ORDER BY rank_lower_bound DESC, naive_height ASC`,
  )
    .bind(userId)
    .all<TableCurve>()
    .then((r) => r.results)
}

export interface CommentView {
  id: number
  content: string
  created_at: string
  author: string | null
  author_id: number | null
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
    `SELECT cl.id, cl.content, cl.created_at, u.display_name AS author, u.id AS author_id
       FROM comments_log cl LEFT JOIN users u ON u.id = cl.user_id
       WHERE cl.curve_id = ? ORDER BY cl.id DESC`,
  )
    .bind(curveId)
    .all<CommentView>()
    .then((r) => r.results)
}

// A contribution to a curve after its first submission: a rank improvement
// (new witness) or the recording of its primes of bad reduction. Logged in
// curve_events so later contributors get credit alongside the original
// submitter, who keeps "submitted by". See migrations/0012_curve_events.sql.
export type CurveEventKind = 'rank_improved' | 'primes_recorded'

export interface CurveEvent {
  id: number
  kind: CurveEventKind
  old_rank: number | null
  new_rank: number | null
  created_at: string
  user: string | null
  user_id: number | null
}

async function logCurveEvent(
  env: Bindings,
  curveId: number,
  userId: number,
  kind: CurveEventKind,
  ranks: { oldRank: number; newRank: number } | null = null,
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO curve_events (curve_id, user_id, kind, old_rank, new_rank) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(curveId, userId, kind, ranks?.oldRank ?? null, ranks?.newRank ?? null)
    .run()
}

// A curve's contribution history, oldest first (it reads as a timeline under
// the "submitted by" line).
export function curveEvents(env: Bindings, curveId: number): Promise<CurveEvent[]> {
  return env.DB.prepare(
    `SELECT e.id, e.kind, e.old_rank, e.new_rank, e.created_at, u.display_name AS user, u.id AS user_id
       FROM curve_events e LEFT JOIN users u ON u.id = e.user_id
       WHERE e.curve_id = ? ORDER BY e.id ASC`,
  )
    .bind(curveId)
    .all<CurveEvent>()
    .then((r) => r.results)
}

// Contribution history for every curve at once (for the database download),
// keyed by curve id, each list oldest first.
export async function allCurveEvents(env: Bindings): Promise<Map<number, CurveEvent[]>> {
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.curve_id, e.kind, e.old_rank, e.new_rank, e.created_at, u.display_name AS user, u.id AS user_id
       FROM curve_events e LEFT JOIN users u ON u.id = e.user_id
       ORDER BY e.id ASC`,
  ).all<CurveEvent & { curve_id: number }>()
  const out = new Map<number, CurveEvent[]>()
  for (const { curve_id, ...e } of results) {
    const list = out.get(curve_id)
    if (list) list.push(e)
    else out.set(curve_id, [e])
  }
  return out
}

// A user's contributions to curves they did not originally submit, newest
// first, for their public page. (Improving one's own curve is not listed: the
// curve already appears under their submissions.)
export interface Contribution {
  id: number
  kind: CurveEventKind
  old_rank: number | null
  new_rank: number | null
  created_at: string
  curve_id: number
  ainvs: string
  rank_lower_bound: number
}

export function userContributions(env: Bindings, userId: number): Promise<Contribution[]> {
  return env.DB.prepare(
    `SELECT e.id, e.kind, e.old_rank, e.new_rank, e.created_at,
            c.id AS curve_id, c.ainvs, c.rank_lower_bound
       FROM curve_events e JOIN curves c ON c.id = e.curve_id
       WHERE e.user_id = ? AND (c.submitter_user_id IS NULL OR c.submitter_user_id != e.user_id)
       ORDER BY e.id DESC`,
  )
    .bind(userId)
    .all<Contribution>()
    .then((r) => r.results)
}

// One row in the recent-activity feed: a curve submission (its creation), a
// commentary edit, or a later contribution (rank improvement / primes
// recorded). All carry the curve's current rank/height for context; old_rank
// and new_rank are set only for 'rank_improved'.
export interface ActivityItem {
  kind: 'submission' | 'comment' | CurveEventKind
  ts: string
  curve_id: number
  rank: number
  height: number
  user: string | null
  user_id: number | null
  content: string | null
  old_rank: number | null
  new_rank: number | null
}

export const ACTIVITY_PAGE_SIZE = 30

// Recent activity, newest first, paginated. Merges curve creations, commentary
// edits, and later contributions in one timeline. `hasOlder` reports whether a further page
// exists (we fetch one extra row to find out).
export async function recentActivity(
  env: Bindings,
  page = 0,
): Promise<{ items: ActivityItem[]; page: number; hasOlder: boolean }> {
  const size = ACTIVITY_PAGE_SIZE
  const { results } = await env.DB.prepare(
    `SELECT kind, ts, curve_id, rank, height, user, user_id, content, old_rank, new_rank FROM (
         SELECT 'submission' AS kind, c.created_at AS ts, c.id AS curve_id,
                c.rank_lower_bound AS rank, c.naive_height AS height,
                u.display_name AS user, u.id AS user_id, NULL AS content,
                NULL AS old_rank, NULL AS new_rank
           FROM curves c LEFT JOIN users u ON u.id = c.submitter_user_id
         UNION ALL
         SELECT 'comment' AS kind, cl.created_at AS ts, cl.curve_id AS curve_id,
                cv.rank_lower_bound AS rank, cv.naive_height AS height,
                cu.display_name AS user, cu.id AS user_id, cl.content AS content,
                NULL AS old_rank, NULL AS new_rank
           FROM comments_log cl
           LEFT JOIN users cu ON cu.id = cl.user_id
           JOIN curves cv ON cv.id = cl.curve_id
         UNION ALL
         SELECT e.kind AS kind, e.created_at AS ts, e.curve_id AS curve_id,
                ce.rank_lower_bound AS rank, ce.naive_height AS height,
                eu.display_name AS user, eu.id AS user_id, NULL AS content,
                e.old_rank, e.new_rank
           FROM curve_events e
           LEFT JOIN users eu ON eu.id = e.user_id
           JOIN curves ce ON ce.id = e.curve_id
       )
       -- kind ASC tiebreak: a submission with initial commentary writes both
       -- rows at the same second-precision timestamp; the comment ('comment' <
       -- 'submission') must sort first, i.e. display above = after, in this
       -- newest-first feed, since the commentary logically follows the curve.
       -- 'comment' likewise sorts before the contribution kinds, so commentary
       -- attached to an improving re-submission displays above the improvement.
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
  // True when this submission newly recorded the conductor for the curve (i.e.
  // the conductor was not previously on record). Not the conductor value itself.
  conductorRecorded?: boolean
}

// Parse a PARI real ("79.328...", "1.5 E-17") to a JS number for sorting.
function toFloat(s: string): number {
  return Number(s.replace(/\s+/g, '').replace(/E/i, 'e'))
}

// a < b for non-negative decimal integer strings of any size.
export function lessDecimal(a: string, b: string): boolean {
  return a.length !== b.length ? a.length < b.length : a < b
}

// |a| < |b| for signed decimal integer strings (compares magnitude).
export function lessAbsDecimal(a: string, b: string): boolean {
  return lessDecimal(a.replace('-', ''), b.replace('-', ''))
}

// Curve fields needed to decide which metrics are records.
export interface RecordCandidate {
  id: number
  rank_lower_bound: number
  naive_height: number
  faltings_height: number | null
  conductor: string | null
  discriminant: string
}

// One curve's id, rank and metrics (null if there is no such curve), enough to
// judge it with recordFlags.
export function loadRecordCandidate(env: Bindings, curveId: number): Promise<RecordCandidate | null> {
  return env.DB.prepare(`SELECT ${PLOT_COLUMNS} FROM curves WHERE id = ?`)
    .bind(curveId)
    .first<RecordCandidate>()
}

// Which of the curve's metrics are records for its rank: a metric is a record
// when no curve of equal or higher rank has a strictly smaller value (i.e. the
// curve is on the rank-vs-metric Pareto frontier).
export async function recordFlags(env: Bindings, curve: RecordCandidate): Promise<RecordFlags> {
  const { results: rivals } = await env.DB.prepare(
    `SELECT naive_height, faltings_height, conductor, discriminant FROM curves
       WHERE rank_lower_bound >= ? AND id != ?`,
  )
    .bind(curve.rank_lower_bound, curve.id)
    .all<{ naive_height: number; faltings_height: number | null; conductor: string | null; discriminant: string }>()
  return {
    naive: !rivals.some((o) => o.naive_height < curve.naive_height),
    faltings:
      curve.faltings_height != null &&
      !rivals.some((o) => o.faltings_height != null && o.faltings_height < curve.faltings_height!),
    conductor:
      curve.conductor != null &&
      !rivals.some((o) => o.conductor != null && lessDecimal(o.conductor, curve.conductor!)),
    // |Δ| is recorded for every curve (no factoring), so it is always comparable.
    discriminant: !rivals.some((o) => lessAbsDecimal(o.discriminant, curve.discriminant)),
  }
}

// Record flags for many curves at once — e.g. everything attributed to one
// user — judged against the whole board, not just the given subset. One query
// loads the metrics of every curve at rank ≥ the lowest rank in the batch; a
// rank-descending sweep then tracks, per metric, the smallest value seen at
// any rank ≥ the current one (the Pareto frontier), and a curve is a record
// when its value is not exceeded by that frontier (ties share it). Same rule
// as recordFlags and the /curves table.
export async function recordFlagsForCurves(env: Bindings, curves: RecordCandidate[]): Promise<Map<number, RecordFlags>> {
  const flags = new Map<number, RecordFlags>()
  if (curves.length === 0) return flags
  const minRank = Math.min(...curves.map((c) => c.rank_lower_bound))
  const { results: board } = await env.DB.prepare(
    `SELECT ${PLOT_COLUMNS} FROM curves
       WHERE rank_lower_bound >= ? ORDER BY rank_lower_bound DESC`,
  )
    .bind(minRank)
    .all<RecordCandidate>()
  const wanted = new Set(curves.map((c) => c.id))
  const isRecord = <T,>(get: (c: RecordCandidate) => T | null, less: (a: T, b: T) => boolean): Set<number> => {
    const recs = new Set<number>()
    let frontier: T | null = null
    for (let i = 0; i < board.length; ) {
      let j = i
      for (; j < board.length && board[j].rank_lower_bound === board[i].rank_lower_bound; j++) {
        const v = get(board[j])
        if (v != null && (frontier == null || less(v, frontier))) frontier = v
      }
      for (let k = i; k < j; k++) {
        const v = get(board[k])
        if (v != null && frontier != null && !less(frontier, v)) recs.add(board[k].id)
      }
      i = j
    }
    return recs
  }
  const naive = isRecord((c): number | null => c.naive_height, (a, b) => a < b)
  const faltings = isRecord((c) => c.faltings_height, (a, b) => a < b)
  const conductor = isRecord((c) => c.conductor, lessDecimal)
  const discriminant = isRecord((c): string | null => c.discriminant, lessAbsDecimal)
  for (const c of board) {
    if (!wanted.has(c.id)) continue
    flags.set(c.id, {
      naive: naive.has(c.id),
      faltings: faltings.has(c.id),
      conductor: conductor.has(c.id),
      discriminant: discriminant.has(c.id),
    })
  }
  return flags
}

// Backfill the conductor — the one prime-gated invariant — and its verified
// bad primes (JSON array string) for an existing curve. COALESCE so an
// already-recorded value is never overwritten. (Discriminant and Faltings
// height are set at submission.) `creditUserId` logs a 'primes_recorded'
// contribution; callers pass it only when the conductor is genuinely new
// (filling bad_primes on a row whose conductor was already known is metadata
// repair, not a contribution).
export async function setCurveConductor(
  env: Bindings,
  curveId: number,
  conductor: string,
  badPrimes: string | null,
  creditUserId: number | null = null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE curves SET conductor = COALESCE(conductor, ?), bad_primes = COALESCE(bad_primes, ?),
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  )
    .bind(conductor, badPrimes, curveId)
    .run()
  if (creditUserId != null) await logCurveEvent(env, curveId, creditUserId, 'primes_recorded')
}

// Outcome of backfilling a curve's prime-gated invariants from the primes
// of bad reduction. 'rejected' carries the failed PrimesResult so the
// caller can surface `note`/`errors`.
export type PrimesBackfill =
  | { status: 'no-curve' }
  | { status: 'already-recorded' }
  | { status: 'recorded'; result: PrimesResult }
  | { status: 'rejected'; result: PrimesResult }

// Backfill the conductor of a curve from its primes of bad reduction:
// `mode: 'auto'` attempts bounded trial division, otherwise the supplied
// `primes` are used. A no-op when the conductor is already recorded. Shared by
// the curve-page form and the JSON API, which differ only in how they present
// this outcome. `userId` is credited in the curve's history.
export async function backfillPrimes(
  env: Bindings,
  gp: Gp,
  userId: number,
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
    await setCurveConductor(
      env,
      curveId,
      result.conductor,
      result.badPrimes ? JSON.stringify(result.badPrimes) : null,
      userId,
    )
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
  // Faltings height is computed from the minimal model at submission (no primes
  // needed), so it is always present. The conductor is the one prime-gated value;
  // its verified bad primes (stored as a JSON array) travel with it.
  const conductor = result.conductor // string | null
  const badPrimes = result.badPrimes ? JSON.stringify(result.badPrimes) : null
  const faltings = result.faltingsHeight != null ? toFloat(result.faltingsHeight) : null
  // Torsion structure (JSON array string) — intrinsic to the curve, write-once.
  const torsion = result.torsion

  const hasCommentary = !!commentary && commentary.trim().length > 0

  const existing = await env.DB.prepare(
    `SELECT id, rank_lower_bound, naive_height, conductor, bad_primes, torsion, current_comment_id
       FROM curves WHERE curve_key = ?`,
  )
    .bind(key)
    .first<{
      id: number
      rank_lower_bound: number
      naive_height: number
      conductor: string | null
      bad_primes: string | null
      torsion: string | null
      current_comment_id: number | null
    }>()

  if (!existing) {
    const ins = await env.DB.prepare(
      `INSERT INTO curves
         (curve_key, c4, c6, ainvs, discriminant, naive_height, rank_lower_bound,
          regulator, points, submitter_user_id, conductor, bad_primes, faltings_height, torsion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        badPrimes,
        faltings,
        torsion,
      )
      .run()
    const id = ins.meta.last_row_id as number
    if (hasCommentary) await postComment(env, id, userId, commentary!)
    return { id, status: 'created', rank, conductorRecorded: !!conductor }
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

  // Torsion is intrinsic and computed on every verify, so a re-submission
  // backfills rows recorded before the column existed. Like the height
  // correction above, this is metadata repair: it does not bump updated_at.
  if (torsion != null && existing.torsion == null) {
    await env.DB.prepare('UPDATE curves SET torsion = ? WHERE id = ?')
      .bind(torsion, existing.id)
      .run()
  }

  // The conductor (with its bad primes) is the only prime-gated value, so it's
  // the only thing a re-submission can backfill (Faltings height was set at the
  // first submission). Bad primes can also lag the conductor on rows recorded
  // before they were stored, so a re-submission may fill just them.
  const setConductor = conductor != null && existing.conductor == null
  const setBadPrimes = badPrimes != null && existing.bad_primes == null

  // An improved rank bound updates the witness data but NOT submitter_user_id:
  // "submitted by" credits whoever first put the curve on the board. The
  // improver is credited in the curve's history (curve_events) instead.
  if (rank > existing.rank_lower_bound) {
    await env.DB.prepare(
      `UPDATE curves SET rank_lower_bound = ?, regulator = ?, points = ?, ainvs = ?,
         conductor = COALESCE(conductor, ?),
         bad_primes = COALESCE(bad_primes, ?),
         faltings_height = COALESCE(faltings_height, ?), updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
      .bind(rank, regulator, points, ainvs, conductor, badPrimes, faltings, existing.id)
      .run()
    await logCurveEvent(env, existing.id, userId, 'rank_improved', { oldRank: existing.rank_lower_bound, newRank: rank })
    if (setConductor) await logCurveEvent(env, existing.id, userId, 'primes_recorded')
    return { id: existing.id, status: 'improved', rank, previousRank: existing.rank_lower_bound, conductorRecorded: setConductor }
  }

  if (setConductor || setBadPrimes) {
    await setCurveConductor(env, existing.id, conductor!, badPrimes, setConductor ? userId : null)
  }
  return { id: existing.id, status: 'unchanged', rank: existing.rank_lower_bound, conductorRecorded: setConductor }
}
