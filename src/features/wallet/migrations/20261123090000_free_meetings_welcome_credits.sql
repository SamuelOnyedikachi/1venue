ALTER TABLE credit_billing_sessions DROP CONSTRAINT credit_billing_sessions_check;
ALTER TABLE credit_billing_sessions ADD COLUMN free_until_ms BIGINT;
UPDATE credit_billing_sessions SET free_until_ms=started_ms WHERE free_until_ms IS NULL;
ALTER TABLE credit_billing_sessions ALTER COLUMN free_until_ms SET NOT NULL;
ALTER TABLE credit_billing_sessions ADD CONSTRAINT credit_billing_sessions_check CHECK(state='closed' OR user_id IS NOT NULL OR free_until_ms IS NOT NULL);

ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_check;
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_check1;
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_kind_check;
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_delta_units_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_kind_check CHECK(kind IN ('purchase','usage','welcome'));
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_delta_units_check CHECK(
  (kind='purchase' AND payment_id IS NOT NULL AND billing_session_id IS NULL AND delta_units>0) OR
  (kind='usage' AND payment_id IS NULL AND billing_session_id IS NOT NULL AND delta_units<0 AND through_ms IS NOT NULL) OR
  (kind='welcome' AND payment_id IS NULL AND billing_session_id IS NULL AND delta_units=3600000)
);
CREATE UNIQUE INDEX credit_ledger_one_welcome ON credit_ledger(user_id) WHERE kind='welcome';
