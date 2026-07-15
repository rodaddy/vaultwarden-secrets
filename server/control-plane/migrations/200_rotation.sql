-- 200_rotation.sql
-- Durable rotation engine tables: jobs, per-stage checkpoints, and leases.
-- Applied against an injected bun:sqlite Database handle by
-- server/rotation/store-sqlite.ts. Idempotent (IF NOT EXISTS) so re-applying
-- on resume is safe.
--
-- Invariant: no column in these tables ever holds secret material. Only
-- identifiers (secret name, payload refs, provider refs), checksums/hashes,
-- stage names, counts, and timestamps are persisted. This is enforced at
-- write time by server/rotation/guard.ts (LeakGuard).

PRAGMA foreign_keys = ON;

-- One row per rotation job. `stage` is the durable state-machine position;
-- resumePending() replays from here. `idempotency_key` is UNIQUE so a
-- duplicate request returns the existing job instead of rotating twice.
CREATE TABLE IF NOT EXISTS rotation_jobs (
  id                  TEXT PRIMARY KEY,             -- job id (uuid/opaque)
  secret              TEXT NOT NULL,                -- credential identifier
  connector           TEXT NOT NULL,                -- connector name
  strategy            TEXT NOT NULL,                -- 'dual' | 'single'
  subject             TEXT NOT NULL,                -- authorization subject
  idempotency_key     TEXT NOT NULL UNIQUE,         -- dedupe key
  stage               TEXT NOT NULL,                -- current RotationStage
  consumers           TEXT NOT NULL DEFAULT '[]',   -- JSON array of names
  -- Identifiers only (never material):
  new_version         INTEGER,                      -- staged version number
  new_payload_ref     TEXT,                         -- vault ref of new material
  new_checksum        TEXT,                         -- hash of new material
  old_payload_ref     TEXT,                         -- vault ref of superseded
  new_provider_ref    TEXT,                         -- provider handle (new)
  old_provider_ref    TEXT,                         -- provider handle (old)
  alias               TEXT NOT NULL DEFAULT 'current',
  expected_from_ver   INTEGER,                      -- CAS guard for alias move
  error               TEXT,                         -- redacted failure reason
  created_at          INTEGER NOT NULL,             -- epoch ms
  updated_at          INTEGER NOT NULL              -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_rotation_jobs_stage ON rotation_jobs(stage);

-- One row per stage attempt. Durable proof of progress + retry bookkeeping.
-- resumePending() reads the latest checkpoint to know where to continue.
CREATE TABLE IF NOT EXISTS rotation_checkpoints (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL REFERENCES rotation_jobs(id) ON DELETE CASCADE,
  stage       TEXT NOT NULL,                        -- RotationStage recorded
  status      TEXT NOT NULL,                        -- 'entered'|'ok'|'error'
  attempt     INTEGER NOT NULL DEFAULT 1,           -- bounded retry counter
  detail      TEXT,                                 -- redacted JSON (no material)
  at          INTEGER NOT NULL                      -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_rotation_checkpoints_job
  ON rotation_checkpoints(job_id, id);

-- Advisory lease: serializes concurrent rotation of the SAME credential.
-- One live lease per secret (PRIMARY KEY on secret). Expiry lets a crashed
-- owner's lease be reclaimed after leaseTtl.
CREATE TABLE IF NOT EXISTS rotation_leases (
  secret      TEXT PRIMARY KEY,                     -- credential identifier
  owner       TEXT NOT NULL,                        -- job id holding the lease
  expires_at  INTEGER NOT NULL,                     -- epoch ms
  acquired_at INTEGER NOT NULL                      -- epoch ms
);
