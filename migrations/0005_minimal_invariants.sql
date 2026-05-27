-- Minimal discriminant and Faltings height, recorded alongside the conductor
-- when a submission supplies the primes dividing the discriminant. NULL until
-- supplied.
ALTER TABLE curves ADD COLUMN minimal_discriminant TEXT;
ALTER TABLE curves ADD COLUMN faltings_height REAL;
