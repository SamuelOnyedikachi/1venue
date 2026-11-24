-- Marketplace opt-in + video/audio material kinds (SQLite).
ALTER TABLE materials ADD COLUMN listed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE materials ADD COLUMN category TEXT;
DROP TRIGGER IF EXISTS check_materials_insert;
DROP TRIGGER IF EXISTS check_materials_update;
CREATE TRIGGER check_materials_insert BEFORE INSERT ON materials
WHEN NOT (length(NEW.title) BETWEEN 1 AND 120 AND NEW.kind IN ('slides','image','youtube','pdf','pptx','doc','sheet','video','audio')) BEGIN
 SELECT RAISE(ABORT, 'CHECK constraint failed: materials');
END;
CREATE TRIGGER check_materials_update BEFORE UPDATE ON materials
WHEN NOT (length(NEW.title) BETWEEN 1 AND 120 AND NEW.kind IN ('slides','image','youtube','pdf','pptx','doc','sheet','video','audio')) BEGIN
 SELECT RAISE(ABORT, 'CHECK constraint failed: materials');
END;
CREATE INDEX IF NOT EXISTS idx_materials_listed ON materials(listed, updated_at DESC) WHERE listed = 1;
