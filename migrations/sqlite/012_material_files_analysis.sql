-- Materials: Word documents ('doc') and spreadsheets ('sheet'), plus stored AI analysis results.
DROP TRIGGER IF EXISTS check_materials_insert;
DROP TRIGGER IF EXISTS check_materials_update;
CREATE TRIGGER IF NOT EXISTS check_materials_insert BEFORE INSERT ON materials
WHEN NOT (length(NEW.title) BETWEEN 1 AND 120 AND NEW.kind IN ('slides','image','youtube','pdf','pptx','doc','sheet')) BEGIN
 SELECT RAISE(ABORT, 'CHECK constraint failed: materials');
END;
CREATE TRIGGER IF NOT EXISTS check_materials_update BEFORE UPDATE ON materials
WHEN NOT (length(NEW.title) BETWEEN 1 AND 120 AND NEW.kind IN ('slides','image','youtube','pdf','pptx','doc','sheet')) BEGIN
 SELECT RAISE(ABORT, 'CHECK constraint failed: materials');
END;

CREATE TABLE IF NOT EXISTS material_analyses (
  material_id INTEGER PRIMARY KEY REFERENCES materials(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  result TEXT NOT NULL,
  model TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
