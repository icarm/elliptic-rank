-- Indexes for the /recent feed, which pages through curves, comments_log and
-- curve_events by creation time with a keyset cursor (store.recentActivity):
-- each branch seeks to the cursor and reads one page's worth of rows, instead
-- of the whole history being merged and sorted for every page. The rowid (the
-- id column) is implicitly the last index column, which serves the id
-- tiebreak.
CREATE INDEX IF NOT EXISTS idx_curves_created ON curves(created_at);
CREATE INDEX IF NOT EXISTS idx_comments_log_created ON comments_log(created_at);
CREATE INDEX IF NOT EXISTS idx_curve_events_created ON curve_events(created_at);

-- A user page lists the curves they submitted (store.userCurves); without this
-- every visit scans the whole table.
CREATE INDEX IF NOT EXISTS idx_curves_submitter ON curves(submitter_user_id);
