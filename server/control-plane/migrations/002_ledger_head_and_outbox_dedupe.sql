CREATE TABLE IF NOT EXISTS ledger_head (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0),
  last_hash TEXT NOT NULL
);

INSERT OR IGNORE INTO ledger_head (id, last_sequence, last_hash)
SELECT
  1,
  COALESCE((SELECT MAX(sequence) FROM audit_ledger), 0),
  COALESCE((SELECT hash FROM audit_ledger ORDER BY sequence DESC LIMIT 1), '0000000000000000000000000000000000000000000000000000000000000000');

DROP INDEX IF EXISTS idx_outbox_pending;
ALTER TABLE outbox_events RENAME TO outbox_events_legacy;

CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  resource TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'delivering', 'delivered', 'dead-letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  processing_until INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

INSERT INTO outbox_events
  (id, type, resource, correlation_id, data_json, dedupe_key, state, attempts, next_attempt_at,
   processing_until, last_error, created_at, delivered_at)
SELECT
  id, type, resource, correlation_id, data_json, dedupe_key, state, attempts, next_attempt_at,
  processing_until, last_error, created_at, delivered_at
FROM outbox_events_legacy;

DROP TABLE outbox_events_legacy;
CREATE INDEX idx_outbox_pending ON outbox_events(state, next_attempt_at);
CREATE INDEX idx_outbox_dedupe_key ON outbox_events(dedupe_key);
