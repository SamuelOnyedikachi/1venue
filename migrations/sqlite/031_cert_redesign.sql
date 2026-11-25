-- Certificate wording, issuer, signatories, and issued snapshots.
ALTER TABLE certificates ADD COLUMN snapshot TEXT;

CREATE TABLE IF NOT EXISTS user_signatures (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS cert_sign_requests (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT,
  role TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  signature_url TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  signed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cert_sign_requests_token ON cert_sign_requests(token);
CREATE INDEX IF NOT EXISTS idx_cert_sign_requests_event ON cert_sign_requests(event_id);
CREATE INDEX IF NOT EXISTS idx_user_signatures_user ON user_signatures(user_id);
