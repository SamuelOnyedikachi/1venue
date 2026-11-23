-- Recreate paid_usage_meters so entry_id points at paid_meeting_entries.
-- 026 originally created the table before that table was rebuilt, which left
-- a dangling REFERENCES paid_meeting_entries_old on already-migrated databases.
DROP INDEX IF EXISTS idx_paid_usage_meters_code;
DROP INDEX IF EXISTS paid_usage_one_open_user;
ALTER TABLE paid_usage_meters RENAME TO paid_usage_meters_old;
CREATE TABLE paid_usage_meters (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL REFERENCES paid_meeting_sessions(code) ON DELETE CASCADE,
  entry_id INTEGER REFERENCES paid_meeting_entries(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  participant_id TEXT NOT NULL,
  is_host INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active','paused','grace','closed')),
  accepted_ms INTEGER,
  connected_since_ms INTEGER,
  last_seen_ms INTEGER,
  disconnected_ms INTEGER,
  accounted_ms INTEGER NOT NULL DEFAULT 0,
  billed_units INTEGER NOT NULL DEFAULT 0,
  grace_until_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO paid_usage_meters SELECT * FROM paid_usage_meters_old;
DROP TABLE paid_usage_meters_old;
CREATE INDEX idx_paid_usage_meters_code ON paid_usage_meters(code, state);
CREATE UNIQUE INDEX paid_usage_one_open_user ON paid_usage_meters(code, user_id) WHERE user_id IS NOT NULL AND state <> 'closed';
