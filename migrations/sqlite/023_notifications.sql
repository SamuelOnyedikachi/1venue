-- notifications: speaker invites, system Notification user, reports, reminder types, ai_calls.

ALTER TABLE event_speakers ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE event_speakers ADD COLUMN invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE event_speakers ADD COLUMN invited_at TEXT;
ALTER TABLE event_speakers ADD COLUMN responded_at TEXT;
ALTER TABLE event_speakers ADD COLUMN decline_comment TEXT;
ALTER TABLE event_speakers ADD COLUMN invite_mode TEXT;
UPDATE event_speakers SET status='active' WHERE status IS NULL OR status='';

CREATE TABLE IF NOT EXISTS reminder_sends_new (
  id INTEGER PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('event','meeting','speaker_invite','event_live')),
  target_id INTEGER NOT NULL,
  lead_min INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp','inapp')),
  recipient TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed','sent','failed','skipped')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT,
  UNIQUE (target_type, target_id, lead_min, channel, recipient)
);
INSERT INTO reminder_sends_new (id, target_type, target_id, lead_min, channel, recipient, user_id, status, error, created_at, sent_at)
  SELECT id, target_type, target_id, lead_min, channel, recipient, user_id, status, error, created_at, sent_at FROM reminder_sends;
DROP TABLE reminder_sends;
ALTER TABLE reminder_sends_new RENAME TO reminder_sends;

CREATE TABLE IF NOT EXISTS speaker_invite_reports (
  id INTEGER PRIMARY KEY,
  speaker_id INTEGER REFERENCES event_speakers(id) ON DELETE SET NULL,
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','actioned')),
  admin_note TEXT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_speaker_invite_reports_status ON speaker_invite_reports(status, created_at DESC);

ALTER TABLE users ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0;

INSERT INTO users (username, email, password_hash, display_name, email_verified_at, verified_active, is_system, handle)
SELECT 'notification', 'notification@system.1venue.invalid', '$disabled$', 'Notification', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1, 1, 'notification'
WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE lower(username)='notification' OR lower(email)='notification@system.1venue.invalid'
);

CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER,
  call_id TEXT,
  reason TEXT,
  prompt TEXT,
  state TEXT NOT NULL DEFAULT 'ringing' CHECK (state IN ('ringing','active','ended','missed','declined','failed')),
  requested INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  answered_at TEXT,
  ended_at TEXT,
  transcript TEXT,
  summary TEXT,
  actions TEXT,
  error TEXT,
  owner_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_user ON ai_calls(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_calls_call ON ai_calls(call_id);
