-- Settings + wallet round: processing fee and display currency on every payment, billing profile
-- (address + preferred currency) and credit auto top-up. Additive only.
ALTER TABLE credit_payments ADD COLUMN IF NOT EXISTS subtotal_kobo BIGINT;
ALTER TABLE credit_payments ADD COLUMN IF NOT EXISTS processing_fee_kobo BIGINT NOT NULL DEFAULT 0;
ALTER TABLE credit_payments ADD COLUMN IF NOT EXISTS fee_percent NUMERIC(7,4);
ALTER TABLE credit_payments ADD COLUMN IF NOT EXISTS display_currency TEXT;
ALTER TABLE credit_payments ADD COLUMN IF NOT EXISTS display_total_minor BIGINT;
ALTER TABLE credit_payments ADD COLUMN IF NOT EXISTS fx_rate TEXT;
ALTER TABLE credit_payments ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'checkout';

ALTER TABLE billing_payments ADD COLUMN IF NOT EXISTS subtotal_kobo BIGINT;
ALTER TABLE billing_payments ADD COLUMN IF NOT EXISTS processing_fee_kobo BIGINT NOT NULL DEFAULT 0;
ALTER TABLE billing_payments ADD COLUMN IF NOT EXISTS fee_percent NUMERIC(7,4);
ALTER TABLE billing_payments ADD COLUMN IF NOT EXISTS display_currency TEXT;
ALTER TABLE billing_payments ADD COLUMN IF NOT EXISTS display_total_minor BIGINT;
ALTER TABLE billing_payments ADD COLUMN IF NOT EXISTS fx_rate TEXT;

ALTER TABLE commerce_payments ADD COLUMN IF NOT EXISTS subtotal_kobo BIGINT;
ALTER TABLE commerce_payments ADD COLUMN IF NOT EXISTS processing_fee_kobo BIGINT NOT NULL DEFAULT 0;
ALTER TABLE commerce_payments ADD COLUMN IF NOT EXISTS fee_percent NUMERIC(7,4);
ALTER TABLE commerce_payments ADD COLUMN IF NOT EXISTS display_currency TEXT;
ALTER TABLE commerce_payments ADD COLUMN IF NOT EXISTS display_total_minor BIGINT;
ALTER TABLE commerce_payments ADD COLUMN IF NOT EXISTS fx_rate TEXT;

CREATE TABLE IF NOT EXISTS billing_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  country TEXT,
  line1 TEXT,
  line2 TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  currency TEXT NOT NULL DEFAULT 'NGN',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per user. running_ref is the claim that makes a top-up single-flight across workers.
CREATE TABLE IF NOT EXISTS auto_topups (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  threshold_credits INTEGER NOT NULL DEFAULT 20 CHECK (threshold_credits BETWEEN 1 AND 100000),
  pack_credits INTEGER NOT NULL DEFAULT 60 CHECK (pack_credits BETWEEN 1 AND 100000),
  monthly_cap_credits INTEGER NOT NULL DEFAULT 240 CHECK (monthly_cap_credits BETWEEN 1 AND 1000000),
  authorization_code TEXT,
  card_last4 TEXT,
  card_brand TEXT,
  card_exp TEXT,
  auth_email TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  running_ref TEXT,
  running_since_ms BIGINT,
  last_run_at TIMESTAMPTZ,
  last_status TEXT,
  last_error TEXT,
  last_reference TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Short-link add-ons are now 4-character (slug4) and 3-character (slug3). venues.slug_tier keeps its original
-- CHECK, so the tier lives in this column (validated by the app); NULL falls back to slug_tier.
ALTER TABLE venues ADD COLUMN slug_addon TEXT;
UPDATE venues SET slug_addon = 'slug3' WHERE slug_tier <> 'none';

-- Short links are released SHORT_LINK_RELEASE_DAYS (60) after the owner's paid plan lapses.
-- link_parked_at: when the link was parked; link_notice_days: the last advance notice sent (14, 3).
ALTER TABLE venues ADD COLUMN link_parked_at TIMESTAMPTZ;
ALTER TABLE venues ADD COLUMN link_notice_days INTEGER;
UPDATE venues SET link_parked_at = NOW() WHERE reserved_slug IS NOT NULL;
