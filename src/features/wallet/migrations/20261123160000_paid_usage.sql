-- Usage-based Paid Entry: per-connected-time billing. Legacy prepaid sessions stay on billing_model='entry'.

ALTER TABLE paid_meeting_sessions ADD COLUMN IF NOT EXISTS billing_model TEXT NOT NULL DEFAULT 'entry';
ALTER TABLE paid_meeting_sessions ADD COLUMN IF NOT EXISTS owner_id TEXT;
ALTER TABLE paid_meeting_sessions ADD COLUMN IF NOT EXISTS owner_heartbeat_ms BIGINT;
ALTER TABLE paid_meeting_sessions ADD COLUMN IF NOT EXISTS switch_deadline_ms BIGINT;

ALTER TABLE paid_meeting_sessions DROP CONSTRAINT IF EXISTS paid_meeting_sessions_entry_units_check;
ALTER TABLE paid_meeting_sessions DROP CONSTRAINT IF EXISTS paid_meeting_sessions_duration_min_check;
ALTER TABLE paid_meeting_sessions ADD CONSTRAINT paid_meeting_sessions_billing_model_check
  CHECK (billing_model IN ('entry','usage'));
ALTER TABLE paid_meeting_sessions ADD CONSTRAINT paid_meeting_sessions_entry_shape_check
  CHECK (
    (billing_model = 'entry' AND entry_units > 0 AND duration_min BETWEEN 1 AND 720)
    OR (billing_model = 'usage' AND entry_units >= 0 AND duration_min >= 0)
  );

ALTER TABLE paid_meeting_entries DROP CONSTRAINT IF EXISTS paid_meeting_entries_entry_units_check;
ALTER TABLE paid_meeting_entries ADD CONSTRAINT paid_meeting_entries_entry_units_check CHECK (entry_units >= 0);

ALTER TABLE paid_meeting_earnings DROP CONSTRAINT IF EXISTS paid_meeting_earnings_gross_units_check;
ALTER TABLE paid_meeting_earnings ADD CONSTRAINT paid_meeting_earnings_gross_units_check CHECK (gross_units >= 0);

ALTER TABLE credit_billing_sessions ADD COLUMN IF NOT EXISTS deferred SMALLINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS paid_usage_meters (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL REFERENCES paid_meeting_sessions(code) ON DELETE CASCADE,
  entry_id BIGINT REFERENCES paid_meeting_entries(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  participant_id TEXT NOT NULL,
  is_host BOOLEAN NOT NULL DEFAULT FALSE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active','paused','grace','closed')),
  accepted_ms BIGINT,
  connected_since_ms BIGINT,
  last_seen_ms BIGINT,
  disconnected_ms BIGINT,
  accounted_ms BIGINT NOT NULL DEFAULT 0,
  billed_units BIGINT NOT NULL DEFAULT 0,
  grace_until_ms BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_paid_usage_meters_code ON paid_usage_meters(code, state);
CREATE UNIQUE INDEX IF NOT EXISTS paid_usage_one_open_user ON paid_usage_meters(code, user_id) WHERE user_id IS NOT NULL AND state <> 'closed';

ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_kind_check;
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_delta_units_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_kind_check CHECK(kind IN ('purchase','usage','welcome','entry','entry_refund','earning_transfer','extension','refund','participant_usage'));
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_delta_units_check CHECK(
  (kind='purchase' AND payment_id IS NOT NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units>0) OR
  (kind='usage' AND payment_id IS NULL AND billing_session_id IS NOT NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<0 AND through_ms IS NOT NULL) OR
  (kind='welcome' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units=3600000) OR
  (kind='entry' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NOT NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<0) OR
  (kind='entry_refund' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NOT NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units>0) OR
  (kind='earning_transfer' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NOT NULL AND paid_extension_id IS NULL AND delta_units>0) OR
  (kind='extension' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NOT NULL AND delta_units<0) OR
  (kind='refund' AND payment_id IS NULL AND billing_session_id IS NOT NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units>0 AND through_ms IS NOT NULL) OR
  (kind='participant_usage' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NOT NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<0 AND through_ms IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_participant_usage_checkpoint ON credit_ledger(paid_entry_id, through_ms) WHERE kind='participant_usage';
