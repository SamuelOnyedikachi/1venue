-- Marketplace opt-in + video/audio material kinds.
ALTER TABLE materials ADD COLUMN IF NOT EXISTS listed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE materials DROP CONSTRAINT IF EXISTS materials_kind_check;
ALTER TABLE materials ADD CONSTRAINT materials_kind_check
  CHECK (kind IN ('slides', 'image', 'youtube', 'pdf', 'pptx', 'doc', 'sheet', 'video', 'audio'));
CREATE INDEX IF NOT EXISTS idx_materials_listed ON materials(listed, updated_at DESC) WHERE listed IS TRUE;
