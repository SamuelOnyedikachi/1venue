-- Materials for sale, ticket perks, certificates, material kind on commerce + credit ledgers, Q&A priority.
ALTER TABLE materials ADD COLUMN IF NOT EXISTS for_sale BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS price_kobo BIGINT;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS call_discount_pct INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS material_purchases (
  id BIGSERIAL PRIMARY KEY,
  material_id BIGINT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payment_id BIGINT REFERENCES commerce_payments(id) ON DELETE SET NULL,
  event_id BIGINT REFERENCES events(id) ON DELETE SET NULL,
  paid_with TEXT NOT NULL CHECK (paid_with IN ('paystack','credits')),
  price_kobo BIGINT NOT NULL,
  fee_kobo BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(material_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_material_purchases_user ON material_purchases(user_id, id DESC);

ALTER TABLE ticket_tiers ADD COLUMN IF NOT EXISTS perks JSONB;

CREATE TABLE IF NOT EXISTS certificates (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  history_id BIGINT NOT NULL REFERENCES meeting_history(id) ON DELETE CASCADE,
  event_id BIGINT REFERENCES events(id) ON DELETE SET NULL,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attendee_name TEXT NOT NULL,
  event_title TEXT NOT NULL,
  host_name TEXT,
  design TEXT NOT NULL DEFAULT 'classic',
  accent TEXT,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(history_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_certificates_code ON certificates(code);

ALTER TABLE questions ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'commerce_payments' AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%promotion%ticket%donation%'
  LOOP
    EXECUTE format('ALTER TABLE commerce_payments DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE commerce_payments DROP CONSTRAINT IF EXISTS commerce_payments_kind_check;
ALTER TABLE commerce_payments ADD CONSTRAINT commerce_payments_kind_check
  CHECK (kind IN ('promotion','ticket','donation','material'));

ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_kind_check;
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_delta_units_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_kind_check
  CHECK(kind IN ('purchase','usage','welcome','entry','entry_refund','earning_transfer','extension','refund','participant_usage','material'));
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_delta_units_check CHECK(
  (kind='purchase' AND payment_id IS NOT NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units>0) OR
  (kind='usage' AND payment_id IS NULL AND billing_session_id IS NOT NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<0 AND through_ms IS NOT NULL) OR
  (kind='welcome' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units=3600000) OR
  (kind='entry' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NOT NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<0) OR
  (kind='entry_refund' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NOT NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units>0) OR
  (kind='earning_transfer' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NOT NULL AND paid_extension_id IS NULL AND delta_units>0) OR
  (kind='extension' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NOT NULL AND delta_units<0) OR
  (kind='refund' AND payment_id IS NULL AND billing_session_id IS NOT NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units>0 AND through_ms IS NOT NULL) OR
  (kind='participant_usage' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NOT NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<0 AND through_ms IS NOT NULL) OR
  (kind='material' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<0)
);
