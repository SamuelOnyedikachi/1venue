-- Messages power-ups: replies, pinned messages, Cooby-style inbox state (star, follow up, snooze,
-- close, labels), private contact notes, scheduled messages, quick replies, cached voice-note
-- transcripts and file analyses, and material Q&A. Additive only: new tables and nullable /
-- defaulted columns. No existing data is changed.
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER;

ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS follow_up BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS closed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;
ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS labels TEXT;

CREATE TABLE IF NOT EXISTS message_pins (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL,
  pinned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, message_id)
);

CREATE TABLE IF NOT EXISTS contact_notes (
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_id, subject_user_id)
);

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL DEFAULT '',
  attachments TEXT,
  reply_to_id INTEGER,
  send_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','cancelled','failed')),
  sent_message_id INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due ON scheduled_messages(status, send_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_user ON scheduled_messages(user_id, conversation_id);

CREATE TABLE IF NOT EXISTS quick_replies (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shortcut TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_quick_replies_user ON quick_replies(user_id);

CREATE TABLE IF NOT EXISTS audio_transcripts (
  url_key TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  model TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS message_file_analyses (
  url_key TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  model TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS material_queries (
  id SERIAL PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  model TEXT,
  cost INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_material_queries_material ON material_queries(material_id, id);
