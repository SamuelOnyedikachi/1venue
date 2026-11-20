ALTER TABLE meeting_history ADD COLUMN end_warning_deadline_ms INTEGER;
ALTER TABLE meeting_history ADD COLUMN end_warning_kept_at TEXT;
ALTER TABLE meeting_history ADD COLUMN end_warning_requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
