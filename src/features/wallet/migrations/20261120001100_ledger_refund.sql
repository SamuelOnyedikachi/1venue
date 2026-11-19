-- Allow kind='refund' on credit_ledger (post-deploy usage refunds).
-- Also narrow the usage checkpoint unique index so a refund can use the same through_ms (the cutoff).
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_check;
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_check1;
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_kind_check;
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_delta_units_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_kind_check CHECK(kind IN ('purchase','usage','welcome','entry','entry_refund','earning_transfer','extension','refund'));
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_delta_units_check CHECK(
  (kind='purchase' AND payment_id IS NOT NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units>0) OR
  (kind='usage' AND payment_id IS NULL AND billing_session_id IS NOT NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<0 AND through_ms IS NOT NULL) OR
  (kind='welcome' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units=3600000) OR
  (kind='entry' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NOT NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<0) OR
  (kind='entry_refund' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NOT NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units>0) OR
  (kind='earning_transfer' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NOT NULL AND paid_extension_id IS NULL AND delta_units>0) OR
  (kind='extension' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NOT NULL AND delta_units<0) OR
  (kind='refund' AND payment_id IS NULL AND billing_session_id IS NOT NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units>0 AND through_ms IS NOT NULL)
);
DROP INDEX IF EXISTS credit_ledger_usage_checkpoint;
CREATE UNIQUE INDEX credit_ledger_usage_checkpoint ON credit_ledger(billing_session_id, through_ms) WHERE kind='usage';
CREATE UNIQUE INDEX credit_ledger_deploy_refund ON credit_ledger(billing_session_id, through_ms) WHERE kind='refund';
