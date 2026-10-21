// Leaderboard storage. A verified submission is recorded into `curves`, deduped
// by the canonical key. The verifier normalizes accepted witnesses to the
// global minimal model before they reach this layer; the stored witness is
// replaced only when a new submission proves a strictly higher rank lower bound.
// A curve new to the board is written only if it places in the top BOARD_TOP_K
// on some metric for its rank, overall, among curves with the same torsion
// subgroup or among those in one of its families (see judge/admitted);
// existing rows are never evicted.

import type { Bindings } from './auth'
import { verifyPrimes, autoPrimes, type VerifyResult, type PrimesResult } from './verify'
import type { Gp } from './pari'
import type { RecordFlags, PlotCurve, TableCurve } from './pages'
import { curveFamilies, legacyFamily } from './family'
import { BOARD_TOP_K, placement, qualifies, judge, admitted, admittedVia, recordsAmong, boardRecords, lessDecimal, lessAbsDecimal, type Metrics, type Placement } from './gate'

// The entry gate and the decimal comparators live in ./gate (dependency-free
// so they can be unit-tested without the verifier); re-exported for callers.
export { BOARD_TOP_K, placement, qualifies, judge, admitted, lessDecimal, lessAbsDecimal, type Metrics, type Placement }

export const COMMENT_MAX = 4000

// Columns every curve list reads: the landing and progress plots need the id,
// rank, metrics, torsion and c-invariants (for the families; PlotCurve); the
// /curves table and a profile's curve list also need the equation (TableCurve).
const PLOT_COLUMNS = 'id, rank_lower_bound, naive_height, faltings_height, conductor, discriminant, torsion, c4, c6'

// The rivals' columns the gate and the record badges judge by.
const RIVAL_COLUMNS = 'naive_height, faltings_height, conductor, discriminant, torsion, c4, c6'

// Rows with their c-invariants as gate Metrics, tagged with their families.
function withFamilies<T extends { c4: string; c6: string }>(rows: T[]): (T & { families: string[] })[] {
  return rows.map((r) => ({ ...r, families: curveFamilies(r.c4, r.c6) }))
}

// The families of a curve whose c-invariants may be absent (none then).
function familiesOf(c: { c4?: string; c6?: string }): string[] {
  return c.c4 != null && c.c6 != null ? curveFamilies(c.c4, c.c6) : []
}
const TABLE_COLUMNS = `${PLOT_COLUMNS}, ainvs`

// --- Curves snapshot ---
//
// Every page that plots, lists or badges curves needs (nearly) the whole
// `curves` table, and D1 bills each of those full scans per row. So the
// TABLE_COLUMNS of every curve are kept as one JSON value in KV and read from
// there instead; a write rebuilds it (refreshCurves). Staleness is bounded: a
// rebuilt snapshot reaches other locations within KV's ~60s edge cache, plus
// SNAPSHOT_MEMO_MS in an isolate that already holds the old one. The entry gate
// still reads D1, so a submission is always judged against the current board.
//
// Edits made outside the app (scripts/backfill-*.mjs, `wrangler d1 execute`)
// do not rebuild it: it expires after SNAPSHOT_TTL_S, or delete the key to
// pick them up at once:
//   wrangler kv key delete --binding CACHE --remote curves-snapshot
const SNAPSHOT_KEY = 'curves-snapshot'
const SNAPSHOT_TTL_S = 3600
const SNAPSHOT_MEMO_MS = 10_000

// The parsed snapshot this isolate last read or wrote, reused for
// SNAPSHOT_MEMO_MS. Callers must not mutate it.
let memo: { at: number; curves: TableCurve[] } | null = null

// Every curve, in id order, from the snapshot (rebuilt from D1 if absent).
async function allCurves(env: Bindings): Promise<TableCurve[]> {
  if (memo && Date.now() - memo.at < SNAPSHOT_MEMO_MS) return memo.curves
  const cached = await env.CACHE.get<TableCurve[]>(SNAPSHOT_KEY, 'json')
  if (cached) {
    memo = { at: Date.now(), curves: cached }
    return cached
  }
  return refreshCurves(env)
}

// Rebuild the snapshot from D1 (one full scan). Called after every write that
// changes a TABLE_COLUMNS value, and on a snapshot miss.
async function refreshCurves(env: Bindings): Promise<TableCurve[]> {
  const { results } = await env.DB.prepare(`SELECT ${TABLE_COLUMNS} FROM curves ORDER BY id ASC`).all<TableCurve>()
  await env.CACHE.put(SNAPSHOT_KEY, JSON.stringify(results), { expirationTtl: SNAPSHOT_TTL_S })
  memo = { at: Date.now(), curves: results }
  return results
}

// Every curve with its metrics, in submission (id) order, for the landing and
// progress plots.
export async function plotCurves(env: Bindings): Promise<PlotCurve[]> {
  return (await allCurves(env)).slice()
}

// Every curve for the /curves table, by increasing conductor (the table's
// tiebreak; curveTablePage re-sorts by the chosen column), curves with no
// recorded conductor last. Conductor is a big-integer decimal string, so
// numeric order = (length, then lexicographic).
export async function tableCurves(env: Bindings): Promise<TableCurve[]> {
  return (await allCurves(env)).slice().sort((a, b) => {
    if (a.conductor == null || b.conductor == null) {
      if (a.conductor != null) return -1
      if (b.conductor != null) return 1
    } else if (a.conductor !== b.conductor) {
      return a.conductor.length - b.conductor.length || (a.conductor < b.conductor ? -1 : 1)
    }
    return a.naive_height - b.naive_height
  })
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
// recorded). All carry the curve's current rank and metrics, for context and
// for judging its records; old_rank and new_rank are set only for
// 'rank_improved'.
export interface ActivityItem {
  kind: 'submission' | 'comment' | CurveEventKind
  ts: string
  curve_id: number
  rank: number
  naive_height: number
  faltings_height: number | null
  conductor: string | null
  discriminant: string
  torsion: string | null
  c4: string
  c6: string
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
    `SELECT kind, ts, curve_id, rank, naive_height, faltings_height, conductor, discriminant, torsion, c4, c6, user, user_id, content, old_rank, new_rank FROM (
         SELECT 'submission' AS kind, c.created_at AS ts, c.id AS curve_id,
                c.rank_lower_bound AS rank, c.naive_height, c.faltings_height, c.conductor, c.discriminant, c.torsion, c.c4, c.c6,
                u.display_name AS user, u.id AS user_id, NULL AS content,
                NULL AS old_rank, NULL AS new_rank
           FROM curves c LEFT JOIN users u ON u.id = c.submitter_user_id
         UNION ALL
         SELECT 'comment' AS kind, cl.created_at AS ts, cl.curve_id AS curve_id,
                cv.rank_lower_bound AS rank, cv.naive_height, cv.faltings_height, cv.conductor, cv.discriminant, cv.torsion, cv.c4, cv.c6,
                cu.display_name AS user, cu.id AS user_id, cl.content AS content,
                NULL AS old_rank, NULL AS new_rank
           FROM comments_log cl
           LEFT JOIN users cu ON cu.id = cl.user_id
           JOIN curves cv ON cv.id = cl.curve_id
         UNION ALL
         SELECT e.kind AS kind, e.created_at AS ts, e.curve_id AS curve_id,
                ce.rank_lower_bound AS rank, ce.naive_height, ce.faltings_height, ce.conductor, ce.discriminant, ce.torsion, ce.c4, ce.c6,
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

export type RecordStatus =
  | {
      id: number
      status: 'created' | 'improved' | 'unchanged'
      rank: number
      previousRank?: number
      // True when this submission newly recorded the conductor for the curve (i.e.
      // the conductor was not previously on record). Not the conductor value itself.
      conductorRecorded?: boolean
      // 'created' only: the curve missed the overall top BOARD_TOP_K and was
      // admitted on its placement among curves with the same torsion subgroup
      // (viaTorsion) and/or among those in some of its families (viaFamilies,
      // family keys from ./family; viaFamily: any). Each pool is judged on its
      // own, so several may have qualified; all are false or empty for a curve
      // that qualified overall (see gate.admittedVia).
      viaTorsion?: boolean
      viaFamily?: boolean
      viaFamilies?: string[]
    }
  | {
      // Verified, but not written: the curve is new and places outside the top
      // `limit` on every metric among curves of rank ≥ `rank`, overall
      // (`placement`), among those with its torsion subgroup
      // (`torsionPlacement`) and among those in each of its families
      // (`families`, keys from ./family; `familyPlacements`, keyed by family).
      // `family` and `familyPlacement` keep their meaning from before families
      // nested: "mordell" or "congruent" and the placement there, else null
      // (see family.legacyFamily). Nothing is stored, so there is no id.
      status: 'declined'
      rank: number
      placement: Placement
      torsionPlacement: Placement
      torsion: string
      families: string[]
      familyPlacements: Record<string, Placement>
      family: string | null
      familyPlacement: Placement | null
      limit: number
    }

// Parse a PARI real ("79.328...", "1.5 E-17") to a JS number for sorting.
function toFloat(s: string): number {
  return Number(s.replace(/\s+/g, '').replace(/E/i, 'e'))
}

// A curve's equation and stored witness, for prefilling the submission form
// ("improve this curve"). null if there is no such curve.
export async function loadWitness(env: Bindings, curveId: number): Promise<{ id: number; ainvs: string[]; points: [string, string][] } | null> {
  const row = await env.DB.prepare('SELECT id, ainvs, points FROM curves WHERE id = ?')
    .bind(curveId)
    .first<{ id: number; ainvs: string; points: string }>()
  if (!row) return null
  return { id: row.id, ainvs: JSON.parse(row.ainvs), points: JSON.parse(row.points) }
}

// Curve fields needed to decide which metrics are records.
export interface RecordCandidate {
  id: number
  rank_lower_bound: number
  naive_height: number
  faltings_height: number | null
  conductor: string | null
  discriminant: string
  torsion?: string | null
  // The c-invariants, for the curve's families; absent means no family records.
  c4?: string
  c6?: string
}

// One curve's id, rank and metrics (null if there is no such curve), enough to
// judge it with recordBadges or announcedRecords.
export function loadRecordCandidate(env: Bindings, curveId: number): Promise<RecordCandidate | null> {
  return env.DB.prepare(`SELECT ${PLOT_COLUMNS} FROM curves WHERE id = ?`)
    .bind(curveId)
    .first<RecordCandidate>()
}

// What the Zulip notifiers announce: the curve's records for its rank, judged
// against every other curve of equal or higher rank (see gate.recordsAmong),
// overall, within its torsion subgroup and within each of its families.
// Unlike the ★/☆ badges, these are strict: a tie doesn't count, the curve must
// be the sole holder. `rivals` counts the other curves of rank ≥ its own, so 0
// means it is the first curve on the board of its rank. `torsion` is null when
// the curve's torsion is not recorded; `families` has an entry per family the
// curve is in, in FAMILIES order. `torsionRivals` and each family's `rivals`
// count the rivals in those pools, so 0 means it is the first such curve on
// the board.
export async function announcedRecords(
  env: Bindings,
  curve: RecordCandidate,
): Promise<{
  overall: RecordFlags
  rivals: number
  torsion: RecordFlags | null
  torsionRivals: number
  families: { key: string; flags: RecordFlags; rivals: number }[]
}> {
  const rivals = await rivalsOf(env, curve)
  const t = curve.torsion ?? null
  const pool = t == null ? [] : rivals.filter((o) => o.torsion === t)
  return {
    overall: recordsAmong(curve, rivals, true),
    rivals: rivals.length,
    torsion: t == null ? null : recordsAmong(curve, pool, true),
    torsionRivals: pool.length,
    families: familiesOf(curve).map((key) => {
      const familyPool = rivals.filter((o) => o.families?.includes(key))
      return { key, flags: recordsAmong(curve, familyPool, true), rivals: familyPool.length }
    }),
  }
}

// The metrics, torsion and families of every other curve of rank ≥ the
// curve's own: the rivals its records are judged against.
async function rivalsOf(env: Bindings, curve: RecordCandidate): Promise<Metrics[]> {
  const curves = await allCurves(env)
  return withFamilies(curves.filter((c) => c.rank_lower_bound >= curve.rank_lower_bound && c.id !== curve.id))
}

// The curve page's badges: records overall, within the curve's torsion
// subgroup and within each of its families, all among curves of rank ≥ its
// own and with ties shared. The torsion and family pools are subsets of the
// overall one, so every overall record is also a record in them; the page
// shows their badges only where there is no overall one. `torsion` is null
// when the curve's torsion is not recorded; `families` is keyed by family, in
// FAMILIES order, with an entry per family the curve is in.
export async function recordBadges(
  env: Bindings,
  curve: RecordCandidate,
): Promise<{ overall: RecordFlags; torsion: RecordFlags | null; families: Record<string, RecordFlags> }> {
  const rivals = await rivalsOf(env, curve)
  const t = curve.torsion ?? null
  const families: Record<string, RecordFlags> = {}
  for (const key of familiesOf(curve)) families[key] = recordsAmong(curve, rivals.filter((o) => o.families?.includes(key)))
  return {
    overall: recordsAmong(curve, rivals),
    torsion: t == null ? null : recordsAmong(curve, rivals.filter((o) => o.torsion === t)),
    families,
  }
}

// Record flags for many curves at once — e.g. everything attributed to one
// user, or in recent activity — judged against the whole board, not just the
// given subset: overall, and within each curve's torsion subgroup and each of
// its families (as recordBadges, but for a batch). One query loads the metrics
// of every curve at rank ≥ the lowest rank in the batch, and gate.boardRecords
// judges them: the same rule as recordBadges and the /curves table. A curve
// with no recorded torsion has no entry in `torsion`; `families` holds, per
// curve, its records keyed by family (none for a curve in no family).
export interface BatchRecords {
  overall: Map<number, RecordFlags>
  torsion: Map<number, RecordFlags>
  families: Map<number, Record<string, RecordFlags>>
}

export async function recordBadgesForCurves(env: Bindings, curves: RecordCandidate[]): Promise<BatchRecords> {
  if (curves.length === 0) return { overall: new Map(), torsion: new Map(), families: new Map() }
  const board = await loadBoard(env, curves)
  const wanted = new Set(curves.map((c) => c.id))
  // Records within each pool of `board`: keysOf lists the pools a curve is in.
  const pooled = (keysOf: (c: RecordCandidate) => readonly string[]): Map<string, Map<number, RecordFlags>> => {
    const pools = new Map<string, RecordCandidate[]>()
    for (const c of board) {
      for (const k of keysOf(c)) {
        const g = pools.get(k)
        if (g) g.push(c)
        else pools.set(k, [c])
      }
    }
    return new Map([...pools].map(([k, group]) => [k, recordsFor(group, wanted)]))
  }
  const torsion = new Map<number, RecordFlags>()
  for (const flags of pooled((c) => (c.torsion != null ? [c.torsion] : [])).values()) {
    for (const [id, f] of flags) torsion.set(id, f)
  }
  const families = new Map<number, Record<string, RecordFlags>>()
  const byFamily = pooled(familiesOf)
  for (const c of curves) {
    const entry: Record<string, RecordFlags> = {}
    for (const key of familiesOf(c)) {
      const f = byFamily.get(key)?.get(c.id)
      if (f) entry[key] = f
    }
    families.set(c.id, entry)
  }
  return { overall: recordsFor(board, wanted), torsion, families }
}

// Every curve at rank ≥ the lowest rank among `curves`.
async function loadBoard(env: Bindings, curves: RecordCandidate[]): Promise<RecordCandidate[]> {
  const minRank = Math.min(...curves.map((c) => c.rank_lower_bound))
  return (await allCurves(env)).filter((c) => c.rank_lower_bound >= minRank)
}

// The `wanted` curves' entries of gate.boardRecords(board).
function recordsFor(board: RecordCandidate[], wanted: Set<number>): Map<number, RecordFlags> {
  const flags = new Map<number, RecordFlags>()
  for (const [id, f] of boardRecords(board)) if (wanted.has(id)) flags.set(id, f)
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
  await refreshCurves(env)
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
  // Computed in the certificate stage, which every verified submission passes
  // through (a zero-point one included), so it is always present.
  if (result.torsion == null) throw new Error('internal: verified curve without torsion structure')
  const torsion: string = result.torsion

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
    // Entry gate: a new curve must place in the top BOARD_TOP_K on some metric
    // among the curves of equal or higher rank already on the board, overall,
    // among those sharing its torsion subgroup or among those in one of its
    // families.
    const { results: rivals } = await env.DB.prepare(
      `SELECT ${RIVAL_COLUMNS} FROM curves
         WHERE rank_lower_bound >= ?`,
    )
      .bind(rank)
      .all<Metrics & { c4: string; c6: string }>()
    const { c4, c6 } = result.canonical!
    const families = curveFamilies(c4, c6)
    const verdict = judge(
      { naive_height: height, faltings_height: faltings, conductor, discriminant: result.curve!.discriminant, torsion, families },
      withFamilies(rivals),
    )
    if (!admitted(verdict)) {
      const family = legacyFamily(c4, c6)
      return {
        status: 'declined',
        rank,
        placement: verdict.placement,
        torsionPlacement: verdict.torsion,
        torsion,
        families,
        familyPlacements: verdict.families,
        family,
        familyPlacement: family == null ? null : verdict.families[family],
        limit: BOARD_TOP_K,
      }
    }
    const { viaTorsion, viaFamily, viaFamilies } = admittedVia(verdict)

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
    await refreshCurves(env)
    return { id, status: 'created', rank, conductorRecorded: !!conductor, viaTorsion, viaFamily, viaFamilies }
  }

  // Existing curve: attach the supplied commentary only if it has none yet.
  if (hasCommentary && existing.current_comment_id == null) {
    await postComment(env, existing.id, userId, commentary!)
  }

  // The naive height is computed from the verifier's minimal-model invariant
  // path, so a stored value that disagrees predates a height-rule fix. Correct it
  // in place. `repaired` notes a metadata repair, so the snapshot is rebuilt
  // even when nothing else changes.
  let repaired = false
  if (Math.abs(existing.naive_height - height) > 1e-9) {
    await env.DB.prepare('UPDATE curves SET naive_height = ? WHERE id = ?')
      .bind(height, existing.id)
      .run()
    repaired = true
  }

  // Torsion is intrinsic and computed on every verify, so a re-submission
  // backfills rows recorded before the column existed. Like the height
  // correction above, this is metadata repair: it does not bump updated_at.
  if (torsion != null && existing.torsion == null) {
    await env.DB.prepare('UPDATE curves SET torsion = ? WHERE id = ?')
      .bind(torsion, existing.id)
      .run()
    repaired = true
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
    await refreshCurves(env)
    return { id: existing.id, status: 'improved', rank, previousRank: existing.rank_lower_bound, conductorRecorded: setConductor }
  }

  // setCurveConductor rebuilds the snapshot itself.
  if (setConductor || setBadPrimes) {
    await setCurveConductor(env, existing.id, conductor!, badPrimes, setConductor ? userId : null)
  } else if (repaired) {
    await refreshCurves(env)
  }
  return { id: existing.id, status: 'unchanged', rank: existing.rank_lower_bound, conductorRecorded: setConductor }
}
