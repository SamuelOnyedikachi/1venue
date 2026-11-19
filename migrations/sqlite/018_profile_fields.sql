-- Public profile: location, website, and social links.
ALTER TABLE users ADD COLUMN location TEXT;
ALTER TABLE users ADD COLUMN website TEXT;
ALTER TABLE users ADD COLUMN socials TEXT NOT NULL DEFAULT '{}';
