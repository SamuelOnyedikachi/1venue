-- SQLite equivalents of the new feature migrations on main.
ALTER TABLE users ADD COLUMN is_seed INTEGER NOT NULL DEFAULT false;
CREATE INDEX idx_users_is_seed ON users(is_seed) WHERE is_seed;
CREATE TABLE seed_rows (
  tbl TEXT NOT NULL,
  row_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tbl,row_id)
);
CREATE TABLE account_deletion_codes (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  email TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE ai_daily_usage (
  key TEXT NOT NULL,
  day TEXT NOT NULL DEFAULT CURRENT_DATE,
  kind TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0 CHECK (units>=0),
  PRIMARY KEY (key,day,kind)
);
CREATE INDEX idx_ai_daily_usage_day ON ai_daily_usage(day);
CREATE TABLE promotions (
  id INTEGER PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('event','post')),
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  placements TEXT NOT NULL DEFAULT '["discover","feed","venues","books"]' CHECK(json_valid(placements) AND json_type(placements)='array'),
  starts_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ends_at TEXT,
  active INTEGER NOT NULL DEFAULT true,
  weight INTEGER NOT NULL DEFAULT 0 CHECK(weight BETWEEN 0 AND 100),
  note TEXT CHECK(note IS NULL OR length(note)<=200),
  views INTEGER NOT NULL DEFAULT 0 CHECK(views>=0),
  clicks INTEGER NOT NULL DEFAULT 0 CHECK(clicks>=0),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((target_type='event' AND event_id IS NOT NULL AND post_id IS NULL) OR (target_type='post' AND post_id IS NOT NULL AND event_id IS NULL)),
  CHECK(ends_at IS NULL OR julianday(ends_at)>julianday(starts_at))
);
CREATE INDEX idx_promotions_live ON promotions(active,starts_at,ends_at);
CREATE TRIGGER promotions_placements_insert BEFORE INSERT ON promotions
WHEN EXISTS(SELECT 1 FROM json_each(NEW.placements) WHERE value NOT IN ('discover','feed','venues','books')) BEGIN
 SELECT RAISE(ABORT,'CHECK constraint failed: placements');
END;
CREATE TRIGGER promotions_placements_update BEFORE UPDATE ON promotions
WHEN EXISTS(SELECT 1 FROM json_each(NEW.placements) WHERE value NOT IN ('discover','feed','venues','books')) BEGIN
 SELECT RAISE(ABORT,'CHECK constraint failed: placements');
END;
