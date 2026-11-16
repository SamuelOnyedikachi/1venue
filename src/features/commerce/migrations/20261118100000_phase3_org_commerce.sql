-- Phase 3 (Organisation + add-ons): organisations, self-serve promotions, tickets, donations,
-- host earnings ledger, payout requests and cloud replays. Additive only.
CREATE TABLE organisations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE org_members (
  org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','moderator')),
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX idx_org_members_user ON org_members(user_id);
CREATE TABLE org_invites (
  id BIGSERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','moderator')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_org_invites_org ON org_invites(org_id);
ALTER TABLE venues ADD COLUMN org_id INTEGER REFERENCES organisations(id) ON DELETE SET NULL;
ALTER TABLE materials ADD COLUMN org_id INTEGER REFERENCES organisations(id) ON DELETE SET NULL;

-- Self-serve promotions reuse the promotions table. Existing (admin) rows stay approved.
ALTER TABLE promotions ADD COLUMN owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE promotions ADD COLUMN review_status TEXT NOT NULL DEFAULT 'approved' CHECK (review_status IN ('approved','pending','rejected'));
ALTER TABLE promotions ADD COLUMN days INTEGER;
ALTER TABLE promotions ADD COLUMN payment_reference TEXT;

CREATE TABLE ticket_tiers (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price_kobo BIGINT NOT NULL DEFAULT 0 CHECK (price_kobo >= 0),
  quantity INTEGER CHECK (quantity IS NULL OR quantity >= 0),
  sold INTEGER NOT NULL DEFAULT 0 CHECK (sold >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ticket_tiers_event ON ticket_tiers(event_id);

CREATE TABLE commerce_payments (
  id BIGSERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('promotion','ticket','donation')),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  host_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_id BIGINT REFERENCES events(id) ON DELETE SET NULL,
  tier_id BIGINT REFERENCES ticket_tiers(id) ON DELETE SET NULL,
  promotion_id BIGINT REFERENCES promotions(id) ON DELETE SET NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100),
  detail TEXT,
  payer_email TEXT NOT NULL,
  price_kobo BIGINT NOT NULL CHECK (price_kobo BETWEEN 1 AND 9007199254740991),
  fee_bps INTEGER NOT NULL DEFAULT 0,
  fee_kobo BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  provider_mode TEXT NOT NULL CHECK (provider_mode IN ('test','live')),
  provider_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','review')),
  refund_status TEXT CHECK (refund_status IS NULL OR refund_status = 'refunded'),
  refunded_at TIMESTAMPTZ,
  refunded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  authorization_url TEXT,
  amount_paid_kobo BIGINT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX idx_commerce_payments_user ON commerce_payments(user_id, id DESC);
CREATE INDEX idx_commerce_payments_host ON commerce_payments(host_user_id, id DESC);

CREATE TABLE tickets (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  tier_id BIGINT REFERENCES ticket_tiers(id) ON DELETE SET NULL,
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  payment_id BIGINT REFERENCES commerce_payments(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','refunded','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tickets_event_user ON tickets(event_id, user_id);

CREATE TABLE payout_requests (
  id BIGSERIAL PRIMARY KEY,
  host_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','paid','rejected')),
  bank_details TEXT,
  note TEXT,
  admin_note TEXT,
  paid_reference TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_payout_requests_host ON payout_requests(host_user_id, id DESC);

-- Host earnings. Balance = SUM(net_kobo). Unique (kind, payment/payout) makes settlement idempotent.
CREATE TABLE host_ledger (
  id BIGSERIAL PRIMARY KEY,
  host_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('sale','donation','refund','payout','payout_reversal')),
  payment_id BIGINT REFERENCES commerce_payments(id) ON DELETE SET NULL,
  payout_id BIGINT REFERENCES payout_requests(id) ON DELETE SET NULL,
  gross_kobo BIGINT NOT NULL DEFAULT 0,
  fee_kobo BIGINT NOT NULL DEFAULT 0,
  net_kobo BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kind, payment_id),
  UNIQUE (kind, payout_id)
);
CREATE INDEX idx_host_ledger_host ON host_ledger(host_user_id, id DESC);

CREATE TABLE replays (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  event_id BIGINT REFERENCES events(id) ON DELETE SET NULL,
  meeting_history_id INTEGER REFERENCES meeting_history(id) ON DELETE SET NULL,
  room_code TEXT,
  title TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('egress','upload','url')),
  egress_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('recording','processing','ready','failed')),
  driver TEXT,
  object_key TEXT,
  file_id TEXT,
  url TEXT,
  mime TEXT,
  size_bytes BIGINT,
  duration_sec INTEGER,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','unlisted','private')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);
CREATE INDEX idx_replays_owner ON replays(owner_user_id, id DESC);
CREATE INDEX idx_replays_event ON replays(event_id);
