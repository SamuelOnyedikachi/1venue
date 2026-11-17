CREATE TABLE credit_billing_sessions_new (
 id INTEGER PRIMARY KEY,
 history_id INTEGER UNIQUE REFERENCES meeting_history(id) ON DELETE SET NULL,
 user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 code TEXT NOT NULL,
 media_room TEXT NOT NULL UNIQUE,
 media_rooms TEXT NOT NULL DEFAULT '[]',
 media_issued INTEGER NOT NULL DEFAULT 0,
 owner_id TEXT NOT NULL,
 started_ms INTEGER NOT NULL,
 accounted_ms INTEGER NOT NULL,
 free_until_ms INTEGER NOT NULL,
 charged_units INTEGER NOT NULL DEFAULT 0 CHECK(charged_units>=0),
 state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','closing','closed')),
 low_credit INTEGER NOT NULL DEFAULT 0,
 ended_ms INTEGER,
 end_reason TEXT,
 cleanup_until_ms INTEGER,
 last_cleanup_ms INTEGER,
 CHECK(state='closed' OR user_id IS NOT NULL OR free_until_ms IS NOT NULL)
);
INSERT INTO credit_billing_sessions_new(id,history_id,user_id,code,media_room,media_rooms,media_issued,owner_id,started_ms,accounted_ms,free_until_ms,charged_units,state,low_credit,ended_ms,end_reason,cleanup_until_ms,last_cleanup_ms)
 SELECT id,history_id,user_id,code,media_room,media_rooms,media_issued,owner_id,started_ms,accounted_ms,started_ms,charged_units,state,low_credit,ended_ms,end_reason,cleanup_until_ms,last_cleanup_ms FROM credit_billing_sessions;

CREATE TABLE credit_ledger_new (
 id INTEGER PRIMARY KEY,
 user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 payment_id INTEGER UNIQUE REFERENCES credit_payments(id),
 billing_session_id INTEGER REFERENCES credit_billing_sessions_new(id),
 through_ms INTEGER,
 kind TEXT NOT NULL,
 delta_units INTEGER NOT NULL,
 balance_after_units INTEGER NOT NULL CHECK(balance_after_units BETWEEN 0 AND 9007199254740991),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 CHECK((kind='purchase' AND payment_id IS NOT NULL AND billing_session_id IS NULL AND delta_units>0) OR
       (kind='usage' AND payment_id IS NULL AND billing_session_id IS NOT NULL AND delta_units<0 AND through_ms IS NOT NULL) OR
       (kind='welcome' AND payment_id IS NULL AND billing_session_id IS NULL AND delta_units=3600000))
);
INSERT INTO credit_ledger_new SELECT * FROM credit_ledger;
DROP TABLE credit_ledger;
DROP TABLE credit_billing_sessions;
ALTER TABLE credit_billing_sessions_new RENAME TO credit_billing_sessions;
ALTER TABLE credit_ledger_new RENAME TO credit_ledger;
CREATE UNIQUE INDEX credit_billing_one_host ON credit_billing_sessions(user_id) WHERE state<>'closed';
CREATE UNIQUE INDEX credit_billing_one_code ON credit_billing_sessions(code) WHERE state<>'closed';
CREATE INDEX idx_credit_ledger_user ON credit_ledger(user_id,id DESC);
CREATE UNIQUE INDEX credit_ledger_usage_checkpoint ON credit_ledger(billing_session_id,through_ms) WHERE billing_session_id IS NOT NULL;
CREATE UNIQUE INDEX credit_ledger_one_welcome ON credit_ledger(user_id) WHERE kind='welcome';
