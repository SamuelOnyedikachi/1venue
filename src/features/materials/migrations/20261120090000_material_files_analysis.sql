-- Materials: Word documents ('doc') and spreadsheets ('sheet') join PDF / PPTX / images / YouTube,
-- and AI analysis results are stored so a file is analysed (and charged) once.
-- Additive only: widens a CHECK constraint and creates one new table. No data is changed.
ALTER TABLE materials DROP CONSTRAINT IF EXISTS materials_kind_check;
ALTER TABLE materials ADD CONSTRAINT materials_kind_check
  CHECK (kind IN ('slides', 'image', 'youtube', 'pdf', 'pptx', 'doc', 'sheet'));

CREATE TABLE IF NOT EXISTS material_analyses (
  material_id INTEGER PRIMARY KEY REFERENCES materials(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  result JSONB NOT NULL,
  model TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
