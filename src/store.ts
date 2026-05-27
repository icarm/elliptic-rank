// Leaderboard storage. A verified submission is recorded into `curves`, deduped
// by the canonical key; the stored witness is replaced only when a new
// submission proves a strictly higher rank lower bound.

import type { Bindings } from './auth'
import type { VerifyResult } from './verify'

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
