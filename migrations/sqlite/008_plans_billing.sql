-- SQLite twin of src/features/billing/migrations/20261117090000_plans_billing.sql
-- Plans, subscriptions and billing (Phase 1). users.plan becomes a cache of the effective
-- subscription plan (free | premium | organisation); short-link add-ons move to venues.slug_tier.
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE users ADD COLUMN plan_overrides TEXT;
ALTER TABLE venues ADD COLUMN slug_tier TEXT NOT NULL DEFAULT 'none' CHECK(slug_tier IN ('none','slug3','slug2'));
ALTER TABLE venues ADD COLUMN reserved_slug TEXT;
ALTER TABLE venues ADD COLUMN archived_at TEXT;
CREATE INDEX idx_venues_reserved_slug ON venues(lower(reserved_slug)) WHERE reserved_slug IS NOT NULL;

CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK(plan IN ('premium','organisation')),
  billing_interval TEXT NOT NULL DEFAULT 'month' CHECK(billing_interval IN ('month','year')),
  status TEXT NOT NULL CHECK(status IN ('active','past_due','cancelled','expired','comp')),
  source TEXT NOT NULL DEFAULT 'paystack' CHECK(source IN ('paystack','admin','grandfather')),
  current_period_start TEXT,
  current_period_end TEXT,
  grace_until TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  pending_plan TEXT CHECK(pending_plan IN ('free','premium','organisation')),
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
CREATE INDEX idx_subscriptions_due ON subscriptions(status, current_period_end);

CREATE TABLE billing_payments (
  id INTEGER PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK(kind IN ('subscription','renewal','slug_addon')),
  plan TEXT,
  billing_interval TEXT,
  venue_id INTEGER REFERENCES venues(id) ON DELETE SET NULL,
  slug_tier TEXT,
  payer_email TEXT NOT NULL,
  price_kobo INTEGER NOT NULL CHECK(price_kobo BETWEEN 1 AND 9007199254740991),
  currency TEXT NOT NULL DEFAULT 'NGN' CHECK(currency='NGN'),
  provider_mode TEXT NOT NULL CHECK(provider_mode IN ('test','live')),
  provider_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','failed','review')),
  authorization_url TEXT,
  amount_paid_kobo INTEGER,
  fee_paid_kobo INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at TEXT
);
CREATE INDEX idx_billing_payments_user ON billing_payments(user_id, id DESC);

CREATE TABLE plan_audit (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_plan_audit_user ON plan_audit(user_id, id DESC);

-- Existing short-link packages become per-venue add-ons on the owner's current venues.
UPDATE venues SET slug_tier = u.plan FROM users u WHERE u.id = venues.owner_user_id AND u.plan IN ('slug3','slug2');
-- Grandfathering: anyone on premium (or a paid short-link package) gets Premium free for 3 months.
INSERT INTO subscriptions (user_id, plan, billing_interval, status, source, current_period_start, current_period_end)
  SELECT id, 'premium', 'month', 'active', 'grandfather', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+3 months') FROM users WHERE plan IN ('premium','slug3','slug2');
UPDATE users SET plan = 'premium' WHERE plan IN ('slug3','slug2');
UPDATE users SET plan = 'free' WHERE plan NOT IN ('free','premium','organisation');
