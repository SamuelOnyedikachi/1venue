-- Public profile cover image (theme gradient is used when this is null).
ALTER TABLE users ADD COLUMN IF NOT EXISTS cover_url TEXT;

ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_cover_url_len;
ALTER TABLE users ADD CONSTRAINT chk_users_cover_url_len CHECK (cover_url IS NULL OR char_length(cover_url) <= 500);
