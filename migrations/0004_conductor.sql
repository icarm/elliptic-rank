-- Optional conductor, recorded when a submission supplies the primes dividing
-- the discriminant (so the server need not factor it). NULL until supplied.
ALTER TABLE curves ADD COLUMN conductor TEXT;
