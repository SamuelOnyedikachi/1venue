-- Public/private profile visibility, manual (no-account) certificates, and persisted meeting cert settings.
ALTER TABLE certificates ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS recipient_email TEXT;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'attendance';
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE meeting_history ADD COLUMN IF NOT EXISTS settings JSONB;
CREATE INDEX IF NOT EXISTS idx_certificates_user ON certificates(user_id);
CREATE INDEX IF NOT EXISTS idx_certificates_user_public ON certificates(user_id, is_public);
