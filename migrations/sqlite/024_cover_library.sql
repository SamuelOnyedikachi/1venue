CREATE TABLE IF NOT EXISTS cover_library (
  id INTEGER PRIMARY KEY,
  file_id TEXT,
  url TEXT NOT NULL,
  scene_text TEXT NOT NULL,
  category TEXT,
  accent TEXT,
  accent2 TEXT,
  embedding TEXT NOT NULL DEFAULT '[]',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_cover_library_category ON cover_library(category, created_at DESC);

CREATE TABLE IF NOT EXISTS cover_library_uses (
  id INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL REFERENCES cover_library(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_cover_library_uses_user ON cover_library_uses(user_id, library_id);
CREATE INDEX IF NOT EXISTS idx_cover_library_uses_recent ON cover_library_uses(used_at DESC);
