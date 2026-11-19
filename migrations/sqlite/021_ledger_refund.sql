DROP INDEX IF EXISTS idx_credit_ledger_user;
DROP INDEX IF EXISTS credit_ledger_usage_checkpoint;
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
       (kind='refund' AND payment_id IS NULL AND billing_session_id IS NOT NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units>0 AND through_ms IS NOT NULL))
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
