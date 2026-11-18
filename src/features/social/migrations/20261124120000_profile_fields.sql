-- Public profile: location, website, and social links (JSON object of network → https URL).
ALTER TABLE users ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS socials JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_location_len;
ALTER TABLE users ADD CONSTRAINT chk_users_location_len CHECK (location IS NULL OR char_length(location) <= 80);
ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_website_len;
ALTER TABLE users ADD CONSTRAINT chk_users_website_len CHECK (website IS NULL OR char_length(website) <= 200);
