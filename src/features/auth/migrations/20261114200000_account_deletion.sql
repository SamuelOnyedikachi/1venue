-- In-app account deletion: step 1 password, step 2 a 6-digit code sent by email.
-- One pending request per user. Only a hash of the code is stored.
CREATE TABLE IF NOT EXISTS account_deletion_codes (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  email       TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
