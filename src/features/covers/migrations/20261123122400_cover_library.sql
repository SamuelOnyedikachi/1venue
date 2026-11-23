-- AI-generated cover library (embeddings as JSON; pgvector column added at runtime when available).
CREATE TABLE IF NOT EXISTS cover_library (
  id BIGSERIAL PRIMARY KEY,
  file_id TEXT,
  url TEXT NOT NULL,
  scene_text TEXT NOT NULL,
  category TEXT,
  accent TEXT,
  accent2 TEXT,
  embedding JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cover_library_category ON cover_library(category, created_at DESC);

CREATE TABLE IF NOT EXISTS cover_library_uses (
  id BIGSERIAL PRIMARY KEY,
  library_id BIGINT NOT NULL REFERENCES cover_library(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_id BIGINT REFERENCES events(id) ON DELETE SET NULL,
  used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cover_library_uses_user ON cover_library_uses(user_id, library_id);
CREATE INDEX IF NOT EXISTS idx_cover_library_uses_recent ON cover_library_uses(used_at DESC);
