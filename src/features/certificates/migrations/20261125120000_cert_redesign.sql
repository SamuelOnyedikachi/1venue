-- Certificate wording, issuer, signatories, and issued snapshots.
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS snapshot JSONB;

CREATE TABLE IF NOT EXISTS user_signatures (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cert_sign_requests (
  id BIGSERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  event_id BIGINT REFERENCES events(id) ON DELETE CASCADE,
  requested_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT,
  role TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  signature_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cert_sign_requests_token ON cert_sign_requests(token);
CREATE INDEX IF NOT EXISTS idx_cert_sign_requests_event ON cert_sign_requests(event_id);
CREATE INDEX IF NOT EXISTS idx_user_signatures_user ON user_signatures(user_id);
