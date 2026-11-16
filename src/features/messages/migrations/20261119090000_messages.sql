-- Messages (M1-M5): an inbox index over the existing chat stores, blocking, reports, reactions,
-- web push and ephemeral calls. Additive: new tables and nullable/defaulted columns only. The one
-- data step merges exact duplicate signed-in DM threads (messages are moved, never deleted) so the
-- new unique index can be created.
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS attachments JSONB;
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS payload JSONB;
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS conversation_id INTEGER;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS payload JSONB;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_group ON chat_messages(group_id, id);
CREATE INDEX IF NOT EXISTS idx_dm_messages_thread_id ON dm_messages(thread_id, id);

UPDATE dm_messages SET thread_id = (
  SELECT MIN(t2.id) FROM dm_threads t1 JOIN dm_threads t2 ON t2.user_a_id = t1.user_a_id AND t2.user_b_id = t1.user_b_id AND t2.peer_is_guest = FALSE
  WHERE t1.id = dm_messages.thread_id)
WHERE thread_id IN (SELECT t.id FROM dm_threads t WHERE t.peer_is_guest = FALSE AND EXISTS (
  SELECT 1 FROM dm_threads o WHERE o.peer_is_guest = FALSE AND o.user_a_id = t.user_a_id AND o.user_b_id = t.user_b_id AND o.id < t.id));
DELETE FROM dm_threads WHERE peer_is_guest = FALSE AND EXISTS (
  SELECT 1 FROM dm_threads o WHERE o.peer_is_guest = FALSE AND o.user_a_id = dm_threads.user_a_id AND o.user_b_id = dm_threads.user_b_id AND o.id < dm_threads.id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dm_threads_pair ON dm_threads(user_a_id, user_b_id) WHERE peer_is_guest = FALSE;

CREATE TABLE conversations (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('dm','group','meeting')),
  dm_thread_id INTEGER UNIQUE REFERENCES dm_threads(id) ON DELETE CASCADE,
  group_id TEXT UNIQUE REFERENCES chat_groups(id) ON DELETE CASCADE,
  meeting_history_id INTEGER UNIQUE REFERENCES meeting_history(id) ON DELETE CASCADE,
  org_id INTEGER UNIQUE REFERENCES organisations(id) ON DELETE CASCADE,
  title TEXT,
  last_message_at TIMESTAMPTZ,
  last_preview TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_conversations_created_by ON conversations(created_by, created_at);
CREATE TABLE conversation_members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  last_read_at TIMESTAMPTZ,
  muted BOOLEAN NOT NULL DEFAULT FALSE,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  cleared_before INTEGER NOT NULL DEFAULT 0,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX idx_conversation_members_user ON conversation_members(user_id);
-- Backfill: every signed-in DM thread gets an inbox row; guest threads stay meeting-scoped.
INSERT INTO conversations (type, dm_thread_id, last_message_at, created_at)
  SELECT 'dm', id, COALESCE(last_message_at, created_at), created_at FROM dm_threads WHERE peer_is_guest = FALSE AND user_a_id IS NOT NULL AND user_b_id IS NOT NULL;
INSERT INTO conversation_members (conversation_id, user_id)
  SELECT c.id, t.user_a_id FROM conversations c JOIN dm_threads t ON t.id = c.dm_thread_id JOIN users u ON u.id = t.user_a_id;
INSERT INTO conversation_members (conversation_id, user_id)
  SELECT c.id, t.user_b_id FROM conversations c JOIN dm_threads t ON t.id = c.dm_thread_id JOIN users u ON u.id = t.user_b_id;

CREATE TABLE user_blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX idx_user_blocks_blocked ON user_blocks(blocked_id);
CREATE TABLE message_reports (
  id SERIAL PRIMARY KEY,
  reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reported_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  message_source TEXT,
  message_id INTEGER,
  reason TEXT NOT NULL,
  snapshot_text TEXT,
  snapshot_attachment TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','actioned')),
  admin_note TEXT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_message_reports_status ON message_reports(status, id);
CREATE TABLE message_reactions (
  message_source TEXT NOT NULL CHECK (message_source IN ('dm','chat')),
  message_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_source, message_id, user_id, emoji)
);
CREATE TABLE push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);
CREATE TABLE user_presence (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'audio' CHECK (kind IN ('audio','video')),
  livekit_room TEXT NOT NULL UNIQUE,
  started_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'ringing' CHECK (state IN ('ringing','active','ended')),
  end_reason TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ
);
CREATE INDEX idx_calls_state ON calls(state);
CREATE TABLE call_participants (
  call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'invited' CHECK (state IN ('invited','joined','left','declined')),
  joined_at TIMESTAMPTZ,
  left_at TIMESTAMPTZ,
  PRIMARY KEY (call_id, user_id)
);
CREATE INDEX idx_call_participants_user ON call_participants(user_id, state);
