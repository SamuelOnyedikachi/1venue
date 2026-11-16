CREATE TABLE credit_wallets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_units INTEGER NOT NULL DEFAULT 0 CHECK(balance_units BETWEEN 0 AND 9007199254740991),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE credit_payments (
  id INTEGER PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  payer_email TEXT NOT NULL,
  credit_units INTEGER NOT NULL CHECK(credit_units BETWEEN 1 AND 9007199254740991),
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
CREATE INDEX idx_credit_payments_user ON credit_payments(user_id,id DESC);
CREATE TABLE credit_ledger (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  payment_id INTEGER NOT NULL UNIQUE REFERENCES credit_payments(id),
  kind TEXT NOT NULL CHECK(kind='purchase'),
  delta_units INTEGER NOT NULL CHECK(delta_units>0),
  balance_after_units INTEGER NOT NULL CHECK(balance_after_units BETWEEN 0 AND 9007199254740991),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_credit_ledger_user ON credit_ledger(user_id,id DESC);
