// The leaderboard's entry gate: where a candidate curve places among the curves
// of equal or higher rank, per metric, and whether that earns it a row. Pure
// functions over plain values (no DB, no PARI) so test/gate.mjs can drive them.

// a < b for non-negative decimal integer strings of any size.
export function lessDecimal(a: string, b: string): boolean {
  return a.length !== b.length ? a.length < b.length : a < b
}

// |a| < |b| for signed decimal integer strings (compares magnitude).
export function lessAbsDecimal(a: string, b: string): boolean {
  return lessDecimal(a.replace('-', ''), b.replace('-', ''))
}

// How many curves per metric each rank admits. A curve new to the board is
// written only if, for some metric, fewer than this many curves of equal or
// higher rank have a strictly smaller value — i.e. it places in the top K
// (ties on the Kth place qualify). Curves already on the board are never
// re-judged: a rank improvement or primes backfill always goes through, and
// nothing is ever evicted, so the board only grows when a top-K list changes.
export const BOARD_TOP_K = 10

// 1-based place of a candidate among curves of rank ≥ its own, per metric:
// one more than the number of rivals with a strictly smaller value. null when
// the candidate has no value for the metric (conductor without primes), so it
// cannot qualify on it.
export interface Placement {
  naive: number
  faltings: number | null
  conductor: number | null
  disc: number
}

// Metrics of a curve being judged for entry (a subset of store.RecordCandidate:
// it has no id yet) and of the rivals it is judged against.
export interface Metrics {
  naive_height: number
  faltings_height: number | null
  conductor: string | null
  discriminant: string
}

// Where a candidate would place among `rivals` (every curve of rank ≥ the
// candidate's; the candidate itself must not be among them). Same "strictly
// smaller" comparison as recordFlags, so place 1 is exactly a record.
export function placement(candidate: Metrics, rivals: Metrics[]): Placement {
  const count = <T,>(get: (c: Metrics) => T | null, less: (a: T, b: T) => boolean): number | null => {
    const v = get(candidate)
    if (v == null) return null
    let n = 0
    for (const o of rivals) {
      const w = get(o)
      if (w != null && less(w, v)) n++
    }
    return n + 1
  }
  return {
    naive: count((c): number | null => c.naive_height, (a, b) => a < b)!,
    faltings: count((c) => c.faltings_height, (a, b) => a < b),
    conductor: count((c) => c.conductor, lessDecimal),
    disc: count((c): string | null => c.discriminant, lessAbsDecimal)!,
  }
}

// Whether a placement earns a spot on the board: top `limit` on some metric.
export function qualifies(p: Placement, limit = BOARD_TOP_K): boolean {
  return [p.naive, p.faltings, p.conductor, p.disc].some((place) => place != null && place <= limit)
}
