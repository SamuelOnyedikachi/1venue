-- out46: rename Premium → Pro, add Business, Enterprise sales leads.
-- Existing 'premium' subscriptions and user plan caches become 'pro'.

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_pending_plan_check;
UPDATE subscriptions SET plan = 'pro' WHERE plan = 'premium';
UPDATE subscriptions SET pending_plan = 'pro' WHERE pending_plan = 'premium';
UPDATE users SET plan = 'pro' WHERE plan = 'premium';
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_plan_check
  CHECK(plan IN ('pro','business','organisation'));
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_pending_plan_check
  CHECK(pending_plan IN ('free','pro','business','organisation'));

CREATE TABLE IF NOT EXISTS sales_leads (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  organisation TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  team_size TEXT,
  message TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sales_leads_created ON sales_leads(created_at DESC);
