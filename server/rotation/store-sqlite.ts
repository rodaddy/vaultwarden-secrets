/**
 * server/rotation/store-sqlite.ts
 *
 * Durable persistence for rotation jobs, checkpoints, and leases, backed by
 * bun:sqlite. Accepts an INJECTED Database handle so tests use a temp/in-memory
 * db and the integration pass can hand in the shared control-plane db.
 *
 * Never stores secret material -- only identifiers, hashes, counts, stages.
 */

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { RotationStage } from "./states";
import type { RotationStrategy } from "./deps";

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "control-plane",
  "migrations",
  "200_rotation.sql",
);

/** Apply the rotation migration to an injected db handle (idempotent). */
export function applyRotationMigration(db: Database): void {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  db.run(sql);
}

export interface JobRow {
  id: string;
  secret: string;
  connector: string;
  strategy: RotationStrategy;
  subject: string;
  idempotencyKey: string;
  stage: RotationStage;
  consumers: string[];
  newVersion: number | null;
  newPayloadRef: string | null;
  newChecksum: string | null;
  oldPayloadRef: string | null;
  newProviderRef: string | null;
  oldProviderRef: string | null;
  alias: string;
  expectedFromVersion: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CheckpointRow {
  id: number;
  jobId: string;
  stage: RotationStage;
  status: "entered" | "ok" | "error";
  attempt: number;
  detail: string | null;
  at: number;
}

interface RawJob {
  id: string;
  secret: string;
  connector: string;
  strategy: string;
  subject: string;
  idempotency_key: string;
  stage: string;
  consumers: string;
  new_version: number | null;
  new_payload_ref: string | null;
  new_checksum: string | null;
  old_payload_ref: string | null;
  new_provider_ref: string | null;
  old_provider_ref: string | null;
  alias: string;
  expected_from_ver: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function hydrate(r: RawJob): JobRow {
  return {
    id: r.id,
    secret: r.secret,
    connector: r.connector,
    strategy: r.strategy as RotationStrategy,
    subject: r.subject,
    idempotencyKey: r.idempotency_key,
    stage: r.stage as RotationStage,
    consumers: JSON.parse(r.consumers) as string[],
    newVersion: r.new_version,
    newPayloadRef: r.new_payload_ref,
    newChecksum: r.new_checksum,
    oldPayloadRef: r.old_payload_ref,
    newProviderRef: r.new_provider_ref,
    oldProviderRef: r.old_provider_ref,
    alias: r.alias,
    expectedFromVersion: r.expected_from_ver,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface NewJobInput {
  id: string;
  secret: string;
  connector: string;
  strategy: RotationStrategy;
  subject: string;
  idempotencyKey: string;
  consumers: string[];
  alias: string;
}

export class RotationStore {
  constructor(
    private db: Database,
    autoMigrate = true,
  ) {
    if (autoMigrate) applyRotationMigration(db);
  }

  // -- jobs ---------------------------------------------------------------

  /** Insert a new job at stage 'requested'. Returns the row. */
  insertJob(input: NewJobInput, now: number): JobRow {
    this.db
      .query(
        `INSERT INTO rotation_jobs
          (id, secret, connector, strategy, subject, idempotency_key, stage,
           consumers, alias, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.secret,
        input.connector,
        input.strategy,
        input.subject,
        input.idempotencyKey,
        JSON.stringify(input.consumers),
        input.alias,
        now,
        now,
      );
    return this.getJob(input.id)!;
  }

  getJob(id: string): JobRow | null {
    const r = this.db
      .query("SELECT * FROM rotation_jobs WHERE id = ?")
      .get(id) as RawJob | null;
    return r ? hydrate(r) : null;
  }

  getJobByIdempotencyKey(key: string): JobRow | null {
    const r = this.db
      .query("SELECT * FROM rotation_jobs WHERE idempotency_key = ?")
      .get(key) as RawJob | null;
    return r ? hydrate(r) : null;
  }

  /** All jobs not in a terminal stage (for resumePending). */
  listPending(): JobRow[] {
    const rows = this.db
      .query(
        `SELECT * FROM rotation_jobs
         WHERE stage NOT IN ('done','rolled-back','reconcile-required')
         ORDER BY created_at ASC`,
      )
      .all() as RawJob[];
    return rows.map(hydrate);
  }

  /** Partial update of a job's mutable fields + stage. */
  updateJob(id: string, patch: Partial<JobRow>, now: number): void {
    const cols: string[] = [];
    const vals: unknown[] = [];
    const map: Record<string, string> = {
      stage: "stage",
      consumers: "consumers",
      newVersion: "new_version",
      newPayloadRef: "new_payload_ref",
      newChecksum: "new_checksum",
      oldPayloadRef: "old_payload_ref",
      newProviderRef: "new_provider_ref",
      oldProviderRef: "old_provider_ref",
      alias: "alias",
      expectedFromVersion: "expected_from_ver",
      error: "error",
    };
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        cols.push(`${col} = ?`);
        const v = (patch as Record<string, unknown>)[k];
        vals.push(k === "consumers" ? JSON.stringify(v) : (v as unknown));
      }
    }
    cols.push("updated_at = ?");
    vals.push(now, id);
    this.db
      .query(`UPDATE rotation_jobs SET ${cols.join(", ")} WHERE id = ?`)
      .run(...(vals as never[]));
  }

  // -- checkpoints --------------------------------------------------------

  appendCheckpoint(
    jobId: string,
    stage: RotationStage,
    status: "entered" | "ok" | "error",
    attempt: number,
    detail: string | null,
    now: number,
  ): void {
    this.db
      .query(
        `INSERT INTO rotation_checkpoints (job_id, stage, status, attempt, detail, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(jobId, stage, status, attempt, detail, now);
  }

  listCheckpoints(jobId: string): CheckpointRow[] {
    const rows = this.db
      .query(
        "SELECT * FROM rotation_checkpoints WHERE job_id = ? ORDER BY id ASC",
      )
      .all(jobId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      jobId: r.job_id as string,
      stage: r.stage as RotationStage,
      status: r.status as "entered" | "ok" | "error",
      attempt: r.attempt as number,
      detail: (r.detail as string) ?? null,
      at: r.at as number,
    }));
  }

  /**
   * Number of FAILED attempts already recorded for a stage on this job. Only
   * 'error' checkpoints count -- the initial 'entered' marker and 'ok'
   * transitions are not attempts against the retry budget.
   */
  attemptsFor(jobId: string, stage: RotationStage): number {
    const r = this.db
      .query(
        `SELECT COUNT(*) AS n
         FROM rotation_checkpoints
         WHERE job_id = ? AND stage = ? AND status = 'error'`,
      )
      .get(jobId, stage) as { n: number };
    return r.n;
  }

  // -- leases -------------------------------------------------------------

  /**
   * Acquire the lease for `secret` owned by `owner`. Reclaims an expired
   * lease. Re-acquisition by the same owner refreshes expiry. Returns true if
   * held by `owner` after the call; false if another live owner holds it.
   */
  acquireLease(
    secret: string,
    owner: string,
    now: number,
    ttlMs: number,
  ): boolean {
    const existing = this.db
      .query("SELECT owner, expires_at FROM rotation_leases WHERE secret = ?")
      .get(secret) as { owner: string; expires_at: number } | null;

    if (existing && existing.expires_at > now && existing.owner !== owner) {
      return false; // live lease held by someone else
    }

    const expires = now + ttlMs;
    this.db
      .query(
        `INSERT INTO rotation_leases (secret, owner, expires_at, acquired_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(secret) DO UPDATE SET
           owner = excluded.owner,
           expires_at = excluded.expires_at,
           acquired_at = excluded.acquired_at`,
      )
      .run(secret, owner, expires, now);
    return true;
  }

  releaseLease(secret: string, owner: string): void {
    this.db
      .query("DELETE FROM rotation_leases WHERE secret = ? AND owner = ?")
      .run(secret, owner);
  }

  getLeaseOwner(secret: string, now: number): string | null {
    const r = this.db
      .query("SELECT owner, expires_at FROM rotation_leases WHERE secret = ?")
      .get(secret) as { owner: string; expires_at: number } | null;
    if (!r || r.expires_at <= now) return null;
    return r.owner;
  }
}
