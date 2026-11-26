-- out46: redenominate credits *50 (₦500 → ₦10), plan credit columns, Pro/Business, sales leads.
-- Twin of src/features/wallet/migrations/20261126120000_credit_redenomination.sql
-- and src/features/billing/migrations/20261126121000_pro_business_sales_leads.sql

-- Wallet plan-credit columns (purchased balances stay in balance_units - plan_balance_units).
ALTER TABLE credit_wallets ADD COLUMN plan_balance_units INTEGER NOT NULL DEFAULT 0;
ALTER TABLE credit_wallets ADD COLUMN plan_grant_units INTEGER NOT NULL DEFAULT 0;
ALTER TABLE credit_wallets ADD COLUMN plan_period_start TEXT;
ALTER TABLE credit_wallets ADD COLUMN plan_period_end TEXT;
ALTER TABLE credit_wallets ADD COLUMN period_used_units INTEGER NOT NULL DEFAULT 0;

-- Rebuild the ledger so welcome can be any positive amount and new kinds are allowed.
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
       (kind='plan_expire' AND payment_id IS NULL AND billing_session_id IS NULL AND paid_entry_id IS NULL AND paid_transfer_id IS NULL AND paid_extension_id IS NULL AND delta_units<0))
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

-- Redenominate (naira value unchanged).
UPDATE credit_wallets SET balance_units = balance_units * 50 WHERE balance_units <> 0;
UPDATE credit_payments SET credit_units = credit_units * 50 WHERE credit_units IS NOT NULL;
UPDATE credit_ledger SET delta_units = delta_units * 50, balance_after_units = balance_after_units * 50;
UPDATE credit_billing_sessions SET charged_units = charged_units * 50 WHERE charged_units <> 0;
UPDATE events SET meeting_entry_units = meeting_entry_units * 50 WHERE meeting_entry_units IS NOT NULL AND meeting_entry_units <> 0;
UPDATE paid_meeting_sessions SET entry_units = entry_units * 50 WHERE entry_units IS NOT NULL AND entry_units <> 0;
UPDATE paid_meeting_entries SET entry_units = entry_units * 50, refund_units = refund_units * 50;
UPDATE paid_meeting_extensions SET units = units * 50 WHERE units IS NOT NULL AND units <> 0;
UPDATE paid_meeting_transfers SET units = units * 50 WHERE units IS NOT NULL AND units <> 0;
UPDATE paid_meeting_earnings SET gross_units = gross_units * 50, refund_units = refund_units * 50, host_units = host_units * 50, platform_units = platform_units * 50, transferred_units = transferred_units * 50;
UPDATE paid_usage_meters SET billed_units = billed_units * 50 WHERE billed_units IS NOT NULL AND billed_units <> 0;
UPDATE auto_topups SET threshold_credits = threshold_credits * 50, pack_credits = pack_credits * 50, monthly_cap_credits = monthly_cap_credits * 50;

-- Premium → Pro, allow Business.
UPDATE subscriptions SET plan = 'pro' WHERE plan = 'premium';
UPDATE subscriptions SET pending_plan = 'pro' WHERE pending_plan = 'premium';
UPDATE users SET plan = 'pro' WHERE plan = 'premium';
DROP INDEX IF EXISTS idx_subscriptions_due;
ALTER TABLE subscriptions RENAME TO subscriptions_old;
CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK(plan IN ('pro','business','organisation')),
  billing_interval TEXT NOT NULL DEFAULT 'month' CHECK(billing_interval IN ('month','year')),
  status TEXT NOT NULL CHECK(status IN ('active','past_due','cancelled','expired','comp')),
  source TEXT NOT NULL DEFAULT 'paystack' CHECK(source IN ('paystack','admin','grandfather')),
  current_period_start TEXT,
  current_period_end TEXT,
  grace_until TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  pending_plan TEXT CHECK(pending_plan IN ('free','pro','business','organisation')),
  pending_interval TEXT CHECK(pending_interval IN ('month','year')),
  authorization_code TEXT,
  auth_email TEXT,
  card_last4 TEXT,
  card_brand TEXT,
  card_exp TEXT,
  renew_attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO subscriptions(id,user_id,plan,billing_interval,status,source,current_period_start,current_period_end,grace_until,cancel_at_period_end,pending_plan,pending_interval,authorization_code,auth_email,card_last4,card_brand,card_exp,renew_attempts,last_attempt_at,locked_until,created_at,updated_at)
 SELECT id,user_id,plan,billing_interval,status,source,current_period_start,current_period_end,grace_until,cancel_at_period_end,pending_plan,pending_interval,authorization_code,auth_email,card_last4,card_brand,card_exp,renew_attempts,last_attempt_at,locked_until,created_at,updated_at FROM subscriptions_old;
DROP TABLE subscriptions_old;
CREATE INDEX idx_subscriptions_due ON subscriptions(status, current_period_end);

CREATE TABLE IF NOT EXISTS sales_leads (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  organisation TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  team_size TEXT,
  message TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','closed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_leads_created ON sales_leads(created_at DESC);
