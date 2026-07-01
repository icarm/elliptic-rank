-- The verified primes of bad reduction: a JSON array of decimal strings,
-- sorted ascending, recorded alongside the conductor. A submission proves the
-- set complete (the supplied primes divide the minimal discriminant to a
-- unit), so keep it: it is the factorization of the conductor's support,
-- which future audits and downstream users cannot cheaply recompute. NULL
-- until primes are supplied or recovered (same gating as the conductor).
ALTER TABLE curves ADD COLUMN bad_primes TEXT;
