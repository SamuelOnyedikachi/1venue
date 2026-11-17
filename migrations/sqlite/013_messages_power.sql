-- SQLite twin of src/features/messages/migrations/20261121090000_messages_power.sql
ALTER TABLE dm_messages ADD COLUMN reply_to_id INTEGER;
ALTER TABLE chat_messages ADD COLUMN reply_to_id INTEGER;

ALTER TABLE conversation_members ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_members ADD COLUMN follow_up INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_members ADD COLUMN closed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_members ADD COLUMN snoozed_until TEXT;
ALTER TABLE conversation_members ADD COLUMN labels TEXT;

CREATE TABLE IF NOT EXISTS message_pins (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL,
  pinned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (conversation_id, message_id)
);

CREATE TABLE IF NOT EXISTS contact_notes (
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (owner_id, subject_user_id)
);

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL DEFAULT '',
  attachments TEXT,
  reply_to_id INTEGER,
  send_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','cancelled','failed')),
  sent_message_id INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due ON scheduled_messages(status, send_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_user ON scheduled_messages(user_id, conversation_id);

CREATE TABLE IF NOT EXISTS quick_replies (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shortcut TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_quick_replies_user ON quick_replies(user_id);

CREATE TABLE IF NOT EXISTS audio_transcripts (
  url_key TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  model TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS message_file_analyses (
  url_key TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  model TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS material_queries (
  id INTEGER PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  model TEXT,
  cost INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_material_queries_material ON material_queries(material_id, id);
