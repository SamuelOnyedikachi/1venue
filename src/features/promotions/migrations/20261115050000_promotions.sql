-- Promoted events / posts for the Discover, Feed, Venues and Books sidebars (admin-picked).
CREATE TABLE IF NOT EXISTS promotions (
  id          BIGSERIAL PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('event','post')),
  event_id    BIGINT REFERENCES events(id) ON DELETE CASCADE,
  post_id     BIGINT REFERENCES posts(id) ON DELETE CASCADE,
  placements  TEXT[] NOT NULL DEFAULT '{discover,feed,venues,books}',
  starts_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at     TIMESTAMPTZ,
  active      BOOLEAN NOT NULL DEFAULT true,
  weight      SMALLINT NOT NULL DEFAULT 0 CHECK (weight BETWEEN 0 AND 100),
  note        TEXT CHECK (note IS NULL OR char_length(note) <= 200),
  views       INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0),
  clicks      INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((target_type = 'event' AND event_id IS NOT NULL AND post_id IS NULL)
      OR (target_type = 'post' AND post_id IS NOT NULL AND event_id IS NULL)),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK (placements <@ ARRAY['discover','feed','venues','books']::TEXT[])
);
CREATE INDEX IF NOT EXISTS idx_promotions_live ON promotions (active, starts_at, ends_at);
