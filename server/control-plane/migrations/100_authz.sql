-- Authorization policies contain only workload identity and non-secret metadata.
CREATE TABLE IF NOT EXISTS authz_policies (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  resource_pattern TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (subject, resource_pattern, actions_json, effect)
);

CREATE INDEX IF NOT EXISTS authz_policies_subject_idx ON authz_policies (subject);
