-- Editable per-curve commentary. Append-only log of edits; the curve points at
-- its latest entry via current_comment_id. Empty content represents a "clear".

CREATE TABLE IF NOT EXISTS comments_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  curve_id INTEGER NOT NULL REFERENCES curves(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  content TEXT NOT NULL,            -- '' represents a "clear" edit
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_comments_log_curve ON comments_log(curve_id, id);

ALTER TABLE curves ADD COLUMN current_comment_id INTEGER REFERENCES comments_log(id);
