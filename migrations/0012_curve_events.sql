-- Contributions to a curve after its first submission. The original submitter
-- keeps "submitted by" credit for the life of the curve; this log credits the
-- two other things a later contributor can do to it:
--   'rank_improved'   a witness proving a higher rank lower bound replaced the
--                     stored points (old_rank < new_rank),
--   'primes_recorded' the primes of bad reduction were supplied, recording
--                     the conductor (old_rank/new_rank NULL).
-- Append-only, like comments_log. Metadata repairs (height/torsion backfills)
-- are not contributions and are not logged. Rows predate nothing: history
-- before this table existed is unrecoverable and simply absent.

CREATE TABLE IF NOT EXISTS curve_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  curve_id INTEGER NOT NULL REFERENCES curves(id) ON DELETE CASCADE,
  -- Submissions require login, so this is set at insert; NULL only after the
  -- account is deleted (SET NULL keeps the history row, as for comments_log).
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('rank_improved', 'primes_recorded')),
  old_rank INTEGER,
  new_rank INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_curve_events_curve ON curve_events(curve_id, id);
CREATE INDEX IF NOT EXISTS idx_curve_events_user ON curve_events(user_id, id);
