CREATE TABLE credit_wallets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_units BIGINT NOT NULL DEFAULT 0 CHECK(balance_units BETWEEN 0 AND 9007199254740991),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE credit_payments (
  id BIGSERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  payer_email TEXT NOT NULL,
  credit_units BIGINT NOT NULL CHECK(credit_units BETWEEN 1 AND 9007199254740991),
  price_kobo BIGINT NOT NULL CHECK(price_kobo BETWEEN 1 AND 9007199254740991),
  currency TEXT NOT NULL DEFAULT 'NGN' CHECK(currency='NGN'),
  provider_mode TEXT NOT NULL CHECK(provider_mode IN ('test','live')),
  provider_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','failed','review')),
  authorization_url TEXT,
  amount_paid_kobo BIGINT,
  fee_paid_kobo BIGINT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX idx_credit_payments_user ON credit_payments(user_id,id DESC);
CREATE TABLE credit_ledger (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  payment_id BIGINT NOT NULL UNIQUE REFERENCES credit_payments(id),
  kind TEXT NOT NULL CHECK(kind='purchase'),
  delta_units BIGINT NOT NULL CHECK(delta_units>0),
  balance_after_units BIGINT NOT NULL CHECK(balance_after_units BETWEEN 0 AND 9007199254740991),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_credit_ledger_user ON credit_ledger(user_id,id DESC);
