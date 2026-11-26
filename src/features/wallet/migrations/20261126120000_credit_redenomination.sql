-- out46: 1 credit is now ₦10 (was ₦500). Multiply stored credit *units* by 50 so
-- existing balances keep the same naira value (10 old credits = ₦5,000 = 500 new credits).
-- This file runs once (schema_migrations); safe to deploy on a fresh or existing database.
-- Also: monthly plan-credit columns, and ledger kinds for AI / plan grant / expire.
-- Welcome grants may now be any positive amount (default 100 credits = 6,000,000 units).

ALTER TABLE credit_wallets ADD COLUMN IF NOT EXISTS plan_balance_units BIGINT NOT NULL DEFAULT 0
  CHECK(plan_balance_units BETWEEN 0 AND 9007199254740991);
ALTER TABLE credit_wallets ADD COLUMN IF NOT EXISTS plan_grant_units BIGINT NOT NULL DEFAULT 0
  CHECK(plan_grant_units BETWEEN 0 AND 9007199254740991);
ALTER TABLE credit_wallets ADD COLUMN IF NOT EXISTS plan_period_start TIMESTAMPTZ;
ALTER TABLE credit_wallets ADD COLUMN IF NOT EXISTS plan_period_end TIMESTAMPTZ;
ALTER TABLE credit_wallets ADD COLUMN IF NOT EXISTS period_used_units BIGINT NOT NULL DEFAULT 0
  CHECK(period_used_units BETWEEN 0 AND 9007199254740991);

ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_kind_check;
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_delta_units_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_kind_check
  CHECK(kind IN ('purchase','usage','welcome','entry','entry_refund','earning_transfer','extension','refund','participant_usage','material','gift','ai','plan_grant','plan_expire'));
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_delta_units_check CHECK(
  (kind='purchase' AND payment_id IS NOT NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units>0) OR
  (kind='usage' AND payment_id IS NULL AND billing_session_id IS NOT NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<0 AND through_ms IS NOT NULL) OR
  (kind='welcome' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units>0) OR
  (kind='entry' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NOT NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<0) OR
  (kind='entry_refund' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NOT NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units>0) OR
  (kind='earning_transfer' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NOT NULL AND paid_extension_id IS NULL AND delta_units>0) OR
  (kind='extension' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NOT NULL AND delta_units<0) OR
  (kind='refund' AND payment_id IS NULL AND billing_session_id IS NOT NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units>0 AND through_ms IS NOT NULL) OR
  (kind='participant_usage' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NOT NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<0 AND through_ms IS NOT NULL) OR
  (kind='material' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<0) OR
  (kind='gift' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<>0) OR
  (kind='ai' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<>0) OR
  (kind='plan_grant' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units>0) OR
  (kind='plan_expire' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<0)
);

-- Relax auto top-up caps so *50 still fits.
ALTER TABLE auto_topups DROP CONSTRAINT IF EXISTS auto_topups_threshold_credits_check;
ALTER TABLE auto_topups DROP CONSTRAINT IF EXISTS auto_topups_pack_credits_check;
ALTER TABLE auto_topups DROP CONSTRAINT IF EXISTS auto_topups_monthly_cap_credits_check;
ALTER TABLE auto_topups ADD CONSTRAINT auto_topups_threshold_credits_check CHECK (threshold_credits BETWEEN 1 AND 10000000);
ALTER TABLE auto_topups ADD CONSTRAINT auto_topups_pack_credits_check CHECK (pack_credits BETWEEN 1 AND 10000000);
ALTER TABLE auto_topups ADD CONSTRAINT auto_topups_monthly_cap_credits_check CHECK (monthly_cap_credits BETWEEN 1 AND 100000000);

UPDATE credit_wallets SET balance_units = balance_units * 50 WHERE balance_units <> 0;
UPDATE credit_payments SET credit_units = credit_units * 50 WHERE credit_units IS NOT NULL;
UPDATE credit_ledger SET delta_units = delta_units * 50, balance_after_units = balance_after_units * 50;
UPDATE credit_billing_sessions SET charged_units = charged_units * 50 WHERE charged_units <> 0;
UPDATE events SET meeting_entry_units = meeting_entry_units * 50 WHERE meeting_entry_units IS NOT NULL AND meeting_entry_units <> 0;
UPDATE paid_meeting_sessions SET entry_units = entry_units * 50 WHERE entry_units IS NOT NULL AND entry_units <> 0;
UPDATE paid_meeting_entries SET entry_units = entry_units * 50 WHERE entry_units IS NOT NULL AND entry_units <> 0;
UPDATE paid_meeting_entries SET refund_units = refund_units * 50 WHERE refund_units IS NOT NULL AND refund_units <> 0;
UPDATE paid_meeting_extensions SET units = units * 50 WHERE units IS NOT NULL AND units <> 0;
UPDATE paid_meeting_transfers SET units = units * 50 WHERE units IS NOT NULL AND units <> 0;
UPDATE paid_meeting_earnings SET
  gross_units = gross_units * 50,
  refund_units = refund_units * 50,
  host_units = host_units * 50,
  platform_units = platform_units * 50,
  transferred_units = transferred_units * 50;
UPDATE paid_usage_meters SET billed_units = billed_units * 50 WHERE billed_units IS NOT NULL AND billed_units <> 0;
UPDATE auto_topups SET
  threshold_credits = threshold_credits * 50,
  pack_credits = pack_credits * 50,
  monthly_cap_credits = monthly_cap_credits * 50;
