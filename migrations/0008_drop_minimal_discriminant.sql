-- Drop the redundant minimal_discriminant column. The `discriminant` column
-- already stores the global minimal model's discriminant (NOT NULL, set at
-- submission), and minimal_discriminant always equalled it: it was computed as
-- E.disc / Umin^12 with E already the global minimal model, so Umin = 1. No
-- information is lost — the value lives on in `discriminant`.
ALTER TABLE curves DROP COLUMN minimal_discriminant;
