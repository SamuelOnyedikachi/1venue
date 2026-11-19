ALTER TABLE events ADD COLUMN meeting_access_mode TEXT NOT NULL DEFAULT 'host_funded'
  CHECK (meeting_access_mode IN ('host_funded','paid_entry'));
ALTER TABLE events ADD COLUMN meeting_duration_min SMALLINT
  CHECK (meeting_duration_min IS NULL OR meeting_duration_min BETWEEN 1 AND 720);
ALTER TABLE events ADD COLUMN meeting_entry_units BIGINT
  CHECK (meeting_entry_units IS NULL OR meeting_entry_units BETWEEN 1 AND 9007199254740991);

CREATE TABLE paid_meeting_sessions (
  code TEXT PRIMARY KEY,
  history_id INTEGER NOT NULL UNIQUE REFERENCES meeting_history(id) ON DELETE CASCADE,
  host_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  entry_units BIGINT NOT NULL CHECK (entry_units > 0),
  duration_min SMALLINT NOT NULL CHECK (duration_min BETWEEN 1 AND 720),
  started_ms BIGINT NOT NULL,
  advertised_end_ms BIGINT NOT NULL,
  runtime_end_ms BIGINT NOT NULL,
  ended_ms BIGINT,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','settled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_paid_meeting_sessions_host ON paid_meeting_sessions(host_user_id, state);
CREATE UNIQUE INDEX paid_meeting_one_active_host ON paid_meeting_sessions(host_user_id) WHERE state='active';

CREATE TABLE paid_meeting_entries (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL REFERENCES paid_meeting_sessions(code) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  participant_id TEXT NOT NULL,
  entry_units BIGINT NOT NULL CHECK (entry_units > 0),
  accepted_at_ms BIGINT NOT NULL,
  last_kicked_at_ms BIGINT,
  refund_units BIGINT NOT NULL DEFAULT 0 CHECK (refund_units >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (code, user_id)
);
CREATE INDEX idx_paid_meeting_entries_user ON paid_meeting_entries(user_id, id DESC);

CREATE TABLE paid_meeting_extensions (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL REFERENCES paid_meeting_sessions(code) ON DELETE CASCADE,
  host_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  minutes SMALLINT NOT NULL CHECK (minutes BETWEEN 1 AND 120),
  units BIGINT NOT NULL CHECK (units > 0),
  created_ms BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE paid_meeting_earnings (
  id BIGSERIAL PRIMARY KEY,
  entry_id BIGINT NOT NULL UNIQUE REFERENCES paid_meeting_entries(id) ON DELETE CASCADE,
  code TEXT NOT NULL REFERENCES paid_meeting_sessions(code) ON DELETE CASCADE,
  host_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  gross_units BIGINT NOT NULL CHECK (gross_units > 0),
  refund_units BIGINT NOT NULL DEFAULT 0 CHECK (refund_units >= 0),
  host_units BIGINT NOT NULL DEFAULT 0 CHECK (host_units >= 0),
  platform_units BIGINT NOT NULL DEFAULT 0 CHECK (platform_units >= 0),
  transferred_units BIGINT NOT NULL DEFAULT 0 CHECK (transferred_units >= 0),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','available')),
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_paid_meeting_earnings_host ON paid_meeting_earnings(host_user_id, state, id);

CREATE TABLE paid_meeting_transfers (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  units BIGINT NOT NULL CHECK (units > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE credit_ledger ADD COLUMN paid_entry_id BIGINT REFERENCES paid_meeting_entries(id) ON DELETE RESTRICT;
ALTER TABLE credit_ledger ADD COLUMN paid_transfer_id BIGINT REFERENCES paid_meeting_transfers(id) ON DELETE RESTRICT;
ALTER TABLE credit_ledger ADD COLUMN paid_extension_id BIGINT REFERENCES paid_meeting_extensions(id) ON DELETE RESTRICT;
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_check;
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_check1;
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_kind_check;
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_delta_units_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_kind_check CHECK(kind IN ('purchase','usage','welcome','entry','entry_refund','earning_transfer','extension'));
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_delta_units_check CHECK(
  (kind='purchase' AND payment_id IS NOT NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units>0) OR
  (kind='usage' AND payment_id IS NULL AND billing_session_id IS NOT NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<0 AND through_ms IS NOT NULL) OR
  (kind='welcome' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units=3600000) OR
  (kind='entry' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NOT NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<0) OR
  (kind='entry_refund' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NOT NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units>0) OR
  (kind='earning_transfer' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NOT NULL AND paid_extension_id IS NULL AND delta_units>0) OR
  (kind='extension' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NOT NULL AND delta_units<0)
);
CREATE UNIQUE INDEX credit_ledger_paid_entry_charge ON credit_ledger(paid_entry_id) WHERE kind='entry';
CREATE UNIQUE INDEX credit_ledger_paid_entry_refund ON credit_ledger(paid_entry_id) WHERE kind='entry_refund';
CREATE UNIQUE INDEX credit_ledger_paid_transfer ON credit_ledger(paid_transfer_id) WHERE kind='earning_transfer';
CREATE UNIQUE INDEX credit_ledger_paid_extension ON credit_ledger(paid_extension_id) WHERE kind='extension';
