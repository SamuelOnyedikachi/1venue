ALTER TABLE meeting_history ADD COLUMN settings TEXT;

PRAGMA foreign_keys=OFF;
CREATE TABLE certificates_new (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  history_id INTEGER NOT NULL REFERENCES meeting_history(id) ON DELETE CASCADE,
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  attendee_name TEXT NOT NULL,
  event_title TEXT NOT NULL,
  host_name TEXT,
  design TEXT NOT NULL DEFAULT 'classic',
  accent TEXT,
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  snapshot TEXT,
  recipient_email TEXT,
  source TEXT NOT NULL DEFAULT 'attendance',
  is_public INTEGER NOT NULL DEFAULT 0,
  UNIQUE(history_id, user_id)
);
INSERT INTO certificates_new (id, code, history_id, event_id, user_id, attendee_name, event_title, host_name, design, accent, issued_at, snapshot, recipient_email, source, is_public)
SELECT id, code, history_id, event_id, user_id, attendee_name, event_title, host_name, design, accent, issued_at, snapshot, NULL, 'attendance', 0
FROM certificates;
DROP TABLE certificates;
ALTER TABLE certificates_new RENAME TO certificates;
CREATE INDEX IF NOT EXISTS idx_certificates_code ON certificates(code);
CREATE INDEX IF NOT EXISTS idx_certificates_user ON certificates(user_id);
PRAGMA foreign_keys=ON;
