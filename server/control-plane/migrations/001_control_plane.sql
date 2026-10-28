CREATE TABLE IF NOT EXISTS logical_secrets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  labels_json TEXT NOT NULL,
  imported_from TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secret_versions (
  secret_name TEXT NOT NULL REFERENCES logical_secrets(name) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK(version > 0),
  state TEXT NOT NULL CHECK(state IN ('ENABLED', 'DISABLED', 'DESTROYED')),
  payload_ref TEXT,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (secret_name, version)
);

CREATE TABLE IF NOT EXISTS secret_aliases (
  secret_name TEXT NOT NULL REFERENCES logical_secrets(name) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (secret_name, alias),
  FOREIGN KEY (secret_name, version) REFERENCES secret_versions(secret_name, version)
);

CREATE TABLE IF NOT EXISTS policy_references (
  id TEXT PRIMARY KEY,
  secret_name TEXT NOT NULL REFERENCES logical_secrets(name) ON DELETE CASCADE,
  policy_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(secret_name, policy_ref)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  resource TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'committed', 'reconcile-required')),
  correlation_id TEXT NOT NULL,
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reconciliation_records (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('open', 'resolved')),
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_ledger (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  outcome TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  resource TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('pending', 'delivering', 'delivered', 'dead-letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  processing_until INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_versions_secret_state ON secret_versions(secret_name, state);
CREATE INDEX IF NOT EXISTS idx_operations_state ON operations(state);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(state, next_attempt_at);
