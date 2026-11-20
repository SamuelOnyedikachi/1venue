-- notifications (feature: events)
-- Speaker invites, system Notification user, invite reports, reminder target types, ai_calls.

ALTER TABLE event_speakers ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE event_speakers ADD COLUMN IF NOT EXISTS invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE event_speakers ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ;
ALTER TABLE event_speakers ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ;
ALTER TABLE event_speakers ADD COLUMN IF NOT EXISTS decline_comment TEXT;
ALTER TABLE event_speakers ADD COLUMN IF NOT EXISTS invite_mode TEXT;
UPDATE event_speakers SET status='active' WHERE status IS NULL OR status='';
ALTER TABLE event_speakers DROP CONSTRAINT IF EXISTS event_speakers_status_check;
ALTER TABLE event_speakers ADD CONSTRAINT event_speakers_status_check CHECK (status IN ('pending','active','declined'));

ALTER TABLE reminder_sends DROP CONSTRAINT IF EXISTS reminder_sends_target_type_check;
ALTER TABLE reminder_sends ADD CONSTRAINT reminder_sends_target_type_check
  CHECK (target_type IN ('event','meeting','speaker_invite','event_live'));

ALTER TABLE reminder_sends DROP CONSTRAINT IF EXISTS reminder_sends_channel_check;
ALTER TABLE reminder_sends ADD CONSTRAINT reminder_sends_channel_check
  CHECK (channel IN ('email','whatsapp','inapp'));

CREATE TABLE IF NOT EXISTS speaker_invite_reports (
  id BIGSERIAL PRIMARY KEY,
  speaker_id BIGINT REFERENCES event_speakers(id) ON DELETE SET NULL,
  event_id BIGINT REFERENCES events(id) ON DELETE SET NULL,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','actioned')),
  admin_note TEXT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_speaker_invite_reports_status ON speaker_invite_reports(status, created_at DESC);

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO users (username, email, password_hash, display_name, email_verified_at, verified_active, is_system, handle)
SELECT 'notification', 'notification@system.1venue.invalid', '$disabled$', 'Notification', NOW(), TRUE, TRUE, 'notification'
WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE lower(username)='notification' OR lower(email)='notification@system.1venue.invalid'
);

CREATE TABLE IF NOT EXISTS ai_calls (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id BIGINT REFERENCES conversations(id) ON DELETE SET NULL,
  call_id TEXT,
  reason TEXT,
  prompt TEXT,
  state TEXT NOT NULL DEFAULT 'ringing' CHECK (state IN ('ringing','active','ended','missed','declined','failed')),
  requested BOOLEAN NOT NULL DEFAULT FALSE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  transcript JSONB,
  summary TEXT,
  actions JSONB,
  error TEXT,
  owner_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_user ON ai_calls(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_calls_call ON ai_calls(call_id);
CREATE INDEX IF NOT EXISTS idx_ai_calls_state ON ai_calls(state) WHERE state IN ('ringing','active');
