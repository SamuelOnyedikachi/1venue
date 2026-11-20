ALTER TABLE meeting_history ADD COLUMN IF NOT EXISTS end_warning_deadline_ms BIGINT;
ALTER TABLE meeting_history ADD COLUMN IF NOT EXISTS end_warning_kept_at TIMESTAMPTZ;
ALTER TABLE meeting_history ADD COLUMN IF NOT EXISTS end_warning_requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
