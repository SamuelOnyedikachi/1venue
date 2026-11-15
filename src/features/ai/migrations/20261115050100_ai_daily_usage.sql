-- Daily usage counters for paid AI calls (speech-to-text seconds, cover generations), per key per day.
-- key: "u:<userId>" for accounts, "p:<participantId>" for room guests, "*" for the whole server.
CREATE TABLE IF NOT EXISTS ai_daily_usage (
  key   TEXT NOT NULL,
  day   DATE NOT NULL DEFAULT CURRENT_DATE,
  kind  TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0 CHECK (units >= 0),
  PRIMARY KEY (key, day, kind)
);
CREATE INDEX IF NOT EXISTS idx_ai_daily_usage_day ON ai_daily_usage (day);
