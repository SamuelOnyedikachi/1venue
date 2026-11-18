-- Allow the self-serve "profile" placement on promotions. The old CHECK listed the four
-- original placements by name; drop any placements-containment check and add a new one.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE t.relname = 'promotions' AND n.nspname = 'public' AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%placements%'
      AND pg_get_constraintdef(c.oid) ILIKE '%discover%'
  LOOP
    EXECUTE format('ALTER TABLE promotions DROP CONSTRAINT %I', r.conname);
  END LOOP;
END$$;

ALTER TABLE promotions DROP CONSTRAINT IF EXISTS promotions_placements_allowed;
ALTER TABLE promotions ADD CONSTRAINT promotions_placements_allowed
  CHECK (placements <@ ARRAY['discover','feed','venues','books','profile']::TEXT[]);
