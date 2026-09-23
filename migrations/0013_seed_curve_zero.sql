-- Curve #0: 11a3, y^2 + y = x^3 - x^2 (X_1(11)), the board's rank-0 anchor.
-- It is the smallest elliptic curve over Q on all four metrics the site
-- tracks (naive height, Faltings height, conductor, |minimal discriminant|),
-- and its Mordell-Weil rank is exactly 0, so no witness can ever improve it.
--
-- The values are exactly what verify() and recordCurve() store for a
-- zero-point submission of [0, -1, 1, 0, 0] (the global minimal model). They
-- are intrinsic to the curve, so hard-coding them here is safe. The submitter
-- is the site's first user, its maintainer. On a database without users (a
-- fresh local one) that is NULL.
--
-- AUTOINCREMENT accepts the explicit id 0 without moving its counter. If 11a3
-- is somehow already on the board under another id, this does nothing.

INSERT INTO curves
  (id, curve_key, c4, c6, ainvs, discriminant, naive_height, rank_lower_bound,
   regulator, points, submitter_user_id, conductor, bad_primes, faltings_height, torsion)
VALUES
  (0, '16:-152', '16', '-152', '["0","-1","1","0","0"]', '-11', 10.047761041692553, 0,
   '1', '[]', (SELECT MIN(id) FROM users), '11', '["11"]', -1.1127287973354532, '[5]')
ON CONFLICT (curve_key) DO NOTHING;
