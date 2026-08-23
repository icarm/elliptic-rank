-- Torsion subgroup structure of the curve: invariant factors as a JSON array,
-- e.g. '[]' (trivial), '[2]', '[2,2]', '[12]'. Intrinsic to the Q-isomorphism
-- class (like naive_height), so write-once. Computed exactly by elltors during
-- every verification; NULL only on rows recorded before this column existed
-- and not yet backfilled.

ALTER TABLE curves ADD COLUMN torsion TEXT;
