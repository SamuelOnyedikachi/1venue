-- SQLite twin of src/features/branding/migrations/20261118090000_phase2_premium.sql
-- Phase 2 (Premium): venue branding, verified badge, recurring series, reminder send log.
-- Additive only: new columns are nullable or defaulted, new tables are new.
ALTER TABLE venues ADD COLUMN brand_logo_url TEXT;
ALTER TABLE venues ADD COLUMN brand_cover_url TEXT;
ALTER TABLE venues ADD COLUMN brand_accent TEXT;
ALTER TABLE venues ADD COLUMN brand_accent2 TEXT;
ALTER TABLE venues ADD COLUMN brand_about TEXT;
ALTER TABLE users ADD COLUMN verified_at TEXT;
ALTER TABLE users ADD COLUMN verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN verified_note TEXT;
-- verified_at is the admin grant; verified_active is the grant while the plan includes the badge.
ALTER TABLE users ADD COLUMN verified_active INTEGER NOT NULL DEFAULT 0;

CREATE TABLE recurring_series (
  id INTEGER PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('event','meeting')),
  title TEXT NOT NULL,
  pattern TEXT NOT NULL CHECK (pattern IN ('weekly','biweekly','monthly')),
  first_start TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 60,
  until_at TEXT,
  occurrences INTEGER,
  template TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_recurring_series_owner ON recurring_series(owner_user_id);
ALTER TABLE events ADD COLUMN series_id INTEGER REFERENCES recurring_series(id) ON DELETE SET NULL;
ALTER TABLE scheduled_meetings ADD COLUMN series_id INTEGER REFERENCES recurring_series(id) ON DELETE SET NULL;
ALTER TABLE scheduled_meetings ADD COLUMN invitees TEXT;
ALTER TABLE scheduled_meetings ADD COLUMN reminders INTEGER NOT NULL DEFAULT 1;

-- One row per (target, lead, channel, recipient). The row is claimed BEFORE sending, so a restart
-- or a second replica can never send the same reminder twice.
CREATE TABLE reminder_sends (
  id INTEGER PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('event','meeting')),
  target_id INTEGER NOT NULL,
  lead_min INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp')),
  recipient TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed','sent','failed','skipped')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT,
  UNIQUE (target_type, target_id, lead_min, channel, recipient)
);
CREATE INDEX idx_events_scheduled_start ON events(starts_at) WHERE status = 'scheduled';
CREATE INDEX idx_scheduled_meetings_start ON scheduled_meetings(scheduled_start) WHERE status = 'scheduled';
