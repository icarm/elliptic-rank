-- The leaderboard: one row per Q-isomorphism class (keyed by canonical c4:c6).
-- A curve's height is intrinsic and fixed; only rank_lower_bound can improve,
-- when a witness with more independent points is submitted.

CREATE TABLE IF NOT EXISTS curves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  curve_key TEXT UNIQUE NOT NULL,        -- canonical "c4:c6"
  c4 TEXT NOT NULL,
  c6 TEXT NOT NULL,
  ainvs TEXT NOT NULL,                   -- JSON [a1,a2,a3,a4,a6] of the display model
  discriminant TEXT NOT NULL,
  naive_height REAL NOT NULL,            -- log max(|c4|^3, |c6|^2), for ordering
  rank_lower_bound INTEGER NOT NULL,
  regulator TEXT NOT NULL,               -- regulator of the current best witness
  points TEXT NOT NULL,                  -- JSON [[x,y],...] current best witness
  submitter_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_curves_rank ON curves(rank_lower_bound DESC);
CREATE INDEX IF NOT EXISTS idx_curves_height ON curves(naive_height);
