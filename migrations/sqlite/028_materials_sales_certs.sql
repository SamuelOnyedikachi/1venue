-- Materials for sale, ticket perks, certificates, material kind on commerce + credit ledgers, Q&A priority.
ALTER TABLE materials ADD COLUMN for_sale INTEGER NOT NULL DEFAULT 0;
ALTER TABLE materials ADD COLUMN price_kobo INTEGER;
ALTER TABLE materials ADD COLUMN call_discount_pct INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS material_purchases (
  id INTEGER PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payment_id INTEGER REFERENCES commerce_payments(id) ON DELETE SET NULL,
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  paid_with TEXT NOT NULL CHECK (paid_with IN ('paystack','credits')),
  price_kobo INTEGER NOT NULL,
  fee_kobo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(material_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_material_purchases_user ON material_purchases(user_id, id DESC);

ALTER TABLE ticket_tiers ADD COLUMN perks TEXT;

CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  history_id INTEGER NOT NULL REFERENCES meeting_history(id) ON DELETE CASCADE,
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attendee_name TEXT NOT NULL,
  event_title TEXT NOT NULL,
  host_name TEXT,
  design TEXT NOT NULL DEFAULT 'classic',
  accent TEXT,
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(history_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_certificates_code ON certificates(code);

ALTER TABLE questions ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

-- commerce_payments: allow kind=material
PRAGMA foreign_keys=OFF;
CREATE TABLE commerce_payments_new (
  id INTEGER PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('promotion','ticket','donation','material')),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  host_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  tier_id INTEGER REFERENCES ticket_tiers(id) ON DELETE SET NULL,
  promotion_id INTEGER REFERENCES promotions(id) ON DELETE SET NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100),
  detail TEXT,
  payer_email TEXT NOT NULL,
  price_kobo INTEGER NOT NULL CHECK (price_kobo BETWEEN 1 AND 9007199254740991),
  fee_bps INTEGER NOT NULL DEFAULT 0,
  fee_kobo INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  provider_mode TEXT NOT NULL CHECK (provider_mode IN ('test','live')),
  provider_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','review')),
  refund_status TEXT CHECK (refund_status IS NULL OR refund_status = 'refunded'),
  refunded_at TEXT,
  refunded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  authorization_url TEXT,
  amount_paid_kobo INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at TEXT,
  subtotal_kobo INTEGER,
  processing_fee_kobo INTEGER NOT NULL DEFAULT 0,
  fee_percent REAL,
  display_currency TEXT,
  display_total_minor INTEGER,
  fx_rate TEXT
);
INSERT INTO commerce_payments_new(
  id, reference, kind, user_id, host_user_id, event_id, tier_id, promotion_id, quantity, detail, payer_email,
  price_kobo, fee_bps, fee_kobo, currency, provider_mode, provider_id, status, refund_status, refunded_at, refunded_by,
  authorization_url, amount_paid_kobo, last_error, created_at, paid_at, subtotal_kobo, processing_fee_kobo, fee_percent,
  display_currency, display_total_minor, fx_rate)
SELECT id, reference, kind, user_id, host_user_id, event_id, tier_id, promotion_id, quantity, detail, payer_email,
  price_kobo, fee_bps, fee_kobo, currency, provider_mode, provider_id, status, refund_status, refunded_at, refunded_by,
  authorization_url, amount_paid_kobo, last_error, created_at, paid_at, subtotal_kobo, processing_fee_kobo, fee_percent,
  display_currency, display_total_minor, fx_rate
FROM commerce_payments;
DROP TABLE commerce_payments;
ALTER TABLE commerce_payments_new RENAME TO commerce_payments;
CREATE INDEX idx_commerce_payments_user ON commerce_payments(user_id, id DESC);
CREATE INDEX idx_commerce_payments_host ON commerce_payments(host_user_id, id DESC);
PRAGMA foreign_keys=ON;

-- credit_ledger: allow kind=material (credits spent on a material)
DROP INDEX IF EXISTS idx_credit_ledger_user;
DROP INDEX IF EXISTS credit_ledger_usage_checkpoint;
DROP INDEX IF EXISTS credit_ledger_deploy_refund;
DROP INDEX IF EXISTS credit_ledger_one_welcome;
DROP INDEX IF EXISTS credit_ledger_paid_entry_charge;
DROP INDEX IF EXISTS credit_ledger_paid_entry_refund;
DROP INDEX IF EXISTS credit_ledger_paid_transfer;
DROP INDEX IF EXISTS credit_ledger_paid_extension;
DROP INDEX IF EXISTS credit_ledger_participant_usage_checkpoint;
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
       (kind='participant_usage' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NOT NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<0 AND through_ms IS NOT NULL) OR
       (kind='material' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<0))
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
