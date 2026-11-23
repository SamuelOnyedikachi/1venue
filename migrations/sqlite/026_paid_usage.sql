ALTER TABLE paid_meeting_sessions ADD COLUMN billing_model TEXT NOT NULL DEFAULT 'entry';
ALTER TABLE paid_meeting_sessions ADD COLUMN owner_id TEXT;
ALTER TABLE paid_meeting_sessions ADD COLUMN owner_heartbeat_ms INTEGER;
ALTER TABLE paid_meeting_sessions ADD COLUMN switch_deadline_ms INTEGER;

ALTER TABLE credit_billing_sessions ADD COLUMN deferred INTEGER NOT NULL DEFAULT 0;

-- Relax entry_units > 0 on entries and gross_units > 0 on earnings by rebuilding those tables.
DROP INDEX IF EXISTS idx_paid_meeting_entries_user;
ALTER TABLE paid_meeting_entries RENAME TO paid_meeting_entries_old;
CREATE TABLE paid_meeting_entries (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL REFERENCES paid_meeting_sessions(code) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  participant_id TEXT NOT NULL,
  entry_units INTEGER NOT NULL CHECK (entry_units >= 0),
  accepted_at_ms INTEGER NOT NULL,
  last_kicked_at_ms INTEGER,
  refund_units INTEGER NOT NULL DEFAULT 0 CHECK (refund_units >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (code, user_id)
);
INSERT INTO paid_meeting_entries SELECT * FROM paid_meeting_entries_old;
DROP TABLE paid_meeting_entries_old;
CREATE INDEX idx_paid_meeting_entries_user ON paid_meeting_entries(user_id, id DESC);

CREATE TABLE IF NOT EXISTS paid_usage_meters (
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
CREATE INDEX IF NOT EXISTS idx_paid_usage_meters_code ON paid_usage_meters(code, state);
CREATE UNIQUE INDEX IF NOT EXISTS paid_usage_one_open_user ON paid_usage_meters(code, user_id) WHERE user_id IS NOT NULL AND state <> 'closed';

DROP INDEX IF EXISTS idx_paid_meeting_earnings_host;
ALTER TABLE paid_meeting_earnings RENAME TO paid_meeting_earnings_old;
CREATE TABLE paid_meeting_earnings (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL UNIQUE REFERENCES paid_meeting_entries(id) ON DELETE CASCADE,
  code TEXT NOT NULL REFERENCES paid_meeting_sessions(code) ON DELETE CASCADE,
  host_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  gross_units INTEGER NOT NULL DEFAULT 0 CHECK (gross_units >= 0),
  refund_units INTEGER NOT NULL DEFAULT 0 CHECK (refund_units >= 0),
  host_units INTEGER NOT NULL DEFAULT 0 CHECK (host_units >= 0),
  platform_units INTEGER NOT NULL DEFAULT 0 CHECK (platform_units >= 0),
  transferred_units INTEGER NOT NULL DEFAULT 0 CHECK (transferred_units >= 0),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','available')),
  settled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO paid_meeting_earnings SELECT * FROM paid_meeting_earnings_old;
DROP TABLE paid_meeting_earnings_old;
CREATE INDEX idx_paid_meeting_earnings_host ON paid_meeting_earnings(host_user_id, state, id);

-- Rebuild ledger to allow participant_usage ticks.
DROP INDEX IF EXISTS idx_credit_ledger_user;
DROP INDEX IF EXISTS credit_ledger_usage_checkpoint;
DROP INDEX IF EXISTS credit_ledger_deploy_refund;
DROP INDEX IF EXISTS credit_ledger_one_welcome;
DROP INDEX IF EXISTS credit_ledger_paid_entry_charge;
DROP INDEX IF EXISTS credit_ledger_paid_entry_refund;
DROP INDEX IF EXISTS credit_ledger_paid_transfer;
DROP INDEX IF EXISTS credit_ledger_paid_extension;
ALTER TABLE credit_ledger RENAME TO credit_ledger_old;
CREATE TABLE credit_ledger (
 id INTEGER PRIMARY KEY,
 user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 payment_id INTEGER UNIQUE REFERENCES credit_payments(id),
 billing_session_id INTEGER REFERENCES credit_billing_sessions(id),
 through_ms INTEGER,
 paid_entry_id INTEGER REFERENCES paid_meeting_entries(id) ON DELETE RESTRICT,
 paid_transfer_id INTEGER REFERENCES paid_meeting_transfers(id) ON DELETE RESTRICT,
 paid_extension_id INTEGER REFERENCES paid_meeting_extensions(id) ON DELETE RESTRICT,
 kind TEXT NOT NULL,
 delta_units INTEGER NOT NULL,
 balance_after_units INTEGER NOT NULL CHECK(balance_after_units BETWEEN 0 AND 9007199254740991),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 CHECK((kind='purchase' AND payment_id IS NOT NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units>0) OR
       (kind='usage' AND payment_id IS NULL AND billing_session_id IS NOT NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<0 AND through_ms IS NOT NULL) OR
       (kind='welcome' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units=3600000) OR
       (kind='entry' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NOT NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<0) OR
       (kind='entry_refund' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NOT NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units>0) OR
       (kind='earning_transfer' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NOT NULL AND paid_extension_id IS NULL AND delta_units>0) OR
       (kind='extension' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NOT NULL AND delta_units<0) OR
       (kind='refund' AND payment_id IS NULL AND billing_session_id IS NOT NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units>0 AND through_ms IS NOT NULL) OR
       (kind='participant_usage' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NOT NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<0 AND through_ms IS NOT NULL))
);
INSERT INTO credit_ledger(id,user_id,payment_id,billing_session_id,through_ms,paid_entry_id,paid_transfer_id,paid_extension_id,kind,delta_units,balance_after_units,created_at)
 SELECT id,user_id,payment_id,billing_session_id,through_ms,paid_entry_id,paid_transfer_id,paid_extension_id,kind,delta_units,balance_after_units,created_at FROM credit_ledger_old;
DROP TABLE credit_ledger_old;
CREATE INDEX idx_credit_ledger_user ON credit_ledger(user_id,id DESC);
CREATE UNIQUE INDEX credit_ledger_usage_checkpoint ON credit_ledger(billing_session_id,through_ms) WHERE kind='usage';
CREATE UNIQUE INDEX credit_ledger_deploy_refund ON credit_ledger(billing_session_id,through_ms) WHERE kind='refund';
CREATE UNIQUE INDEX credit_ledger_one_welcome ON credit_ledger(user_id) WHERE kind='welcome';
CREATE UNIQUE INDEX credit_ledger_paid_entry_charge ON credit_ledger(paid_entry_id) WHERE kind='entry';
CREATE UNIQUE INDEX credit_ledger_paid_entry_refund ON credit_ledger(paid_entry_id) WHERE kind='entry_refund';
CREATE UNIQUE INDEX credit_ledger_paid_transfer ON credit_ledger(paid_transfer_id) WHERE kind='earning_transfer';
CREATE UNIQUE INDEX credit_ledger_paid_extension ON credit_ledger(paid_extension_id) WHERE kind='extension';
CREATE UNIQUE INDEX credit_ledger_participant_usage_checkpoint ON credit_ledger(paid_entry_id,through_ms) WHERE kind='participant_usage';
