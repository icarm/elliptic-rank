// Leaderboard storage. A verified submission is recorded into `curves`, deduped
// by the canonical key; the stored witness is replaced only when a new
// submission proves a strictly higher rank lower bound.

import type { Bindings } from './auth'
import type { VerifyResult } from './verify'

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

export type RecordStatus =
  | { status: 'created'; rank: number }
  | { status: 'improved'; rank: number; previousRank: number }
  | { status: 'unchanged'; rank: number }

// Parse a PARI real ("79.328...", "1.5 E-17") to a JS number for sorting.
function toFloat(s: string): number {
  return Number(s.replace(/\s+/g, '').replace(/E/i, 'e'))
}

// Record an accepted verification for `userId`. Returns how the leaderboard
// changed. Assumes result.ok (canonical/independence/height/curve are present).
export async function recordCurve(
  env: Bindings,
  userId: number,
  result: VerifyResult,
): Promise<RecordStatus> {
  const key = result.canonical!.key
  const rank = result.independence!.rankLowerBound
  const ainvs = JSON.stringify(result.curve!.ainvs)
  const points = JSON.stringify(result.points.map((p) => p.point))
  const height = toFloat(result.height!.naiveLogHeight)
  const regulator = result.independence!.regulator

  const existing = await env.DB.prepare(
    'SELECT id, rank_lower_bound FROM curves WHERE curve_key = ?',
  )
    .bind(key)
    .first<{ id: number; rank_lower_bound: number }>()

  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO curves
         (curve_key, c4, c6, ainvs, discriminant, naive_height, rank_lower_bound,
          regulator, points, submitter_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      )
      .run()
    return { status: 'created', rank }
  }

  if (rank > existing.rank_lower_bound) {
    await env.DB.prepare(
      `UPDATE curves SET rank_lower_bound = ?, regulator = ?, points = ?, ainvs = ?,
         submitter_user_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
      .bind(rank, regulator, points, ainvs, userId, existing.id)
      .run()
    return { status: 'improved', rank, previousRank: existing.rank_lower_bound }
  }

  return { status: 'unchanged', rank: existing.rank_lower_bound }
}
