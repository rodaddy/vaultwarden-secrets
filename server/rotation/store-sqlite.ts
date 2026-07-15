/**
 * server/rotation/store-sqlite.ts
 *
 * Durable persistence for rotation jobs, checkpoints, leases, and fencing
 * tokens, backed by bun:sqlite. Accepts an INJECTED Database handle so tests
 * use a temp/in-memory db and the integration pass can hand in the shared
 * control-plane db.
 *
 * Never stores secret material -- only identifiers, hashes, counts, stages,
 * and fencing tokens.
 *
 * Concurrency correctness:
 *  - acquireLease() is a SINGLE atomic conditional write (inside an IMMEDIATE
 *    transaction) that only succeeds when no live lease is held by another
 *    owner. It mints a monotonic fencing token and returns it. There is no
 *    SELECT-then-UPSERT race window.
 *  - Every mutation (checkpoint append, job update) is fenced: a caller that
 *    lost the lease (fence advanced) is rejected, so a stale executor cannot
 *    mutate a job another executor now owns.
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

/**
 * Set per-connection pragmas that make two connections to the SAME file db
 * serialize writers gracefully instead of erroring with SQLITE_BUSY. Must run
 * on EVERY connection (WAL is a db property, but busy_timeout is per-connection),
 * so this is separate from the migration and called from the constructor
 * regardless of autoMigrate. No-op / harmless for :memory: databases.
 */
export function applyConnectionPragmas(db: Database): void {
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 5000");
  } catch {
    // Some handles (e.g. shared-cache :memory:) reject WAL; ignore.
  }
}

/** Apply the rotation migration to an injected db handle (idempotent). */
export function applyRotationMigration(db: Database): void {
  applyConnectionPragmas(db);
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  db.run(sql);
}

/** True if `err` is a SQLite BUSY / "database is locked" contention signal. */
function isBusy(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string })?.code ?? "";
  return (
    /database is locked/i.test(msg) ||
    /database table is locked/i.test(msg) ||
    code === "SQLITE_BUSY" ||
    code === "SQLITE_BUSY_SNAPSHOT" ||
    code === "SQLITE_LOCKED"
  );
}

/**
 * Bounded synchronous backoff for BUSY retries. Uses Atomics.wait on a
 * throwaway buffer so it blocks this thread briefly WITHOUT an event-loop turn
 * (acquireLease is synchronous). Backoff grows with the attempt, with a little
 * jitter so two contending processes don't lock-step.
 */
function busySleep(attempt: number): void {
  const base = Math.min(2 + attempt * 3, 25); // ms, capped
  const jitter = Math.floor(Math.random() * 4);
  const ms = base + jitter;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer unavailable: fall back to a tight spin for `ms`.
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

/** Thrown when a fenced-off (stale) executor tries to mutate a job. */
export class FencedOutError extends Error {
  constructor(secret: string, expected: number, actual: number) {
    super(
      `executor fenced out for ${secret}: had fence ${expected}, live fence ${actual}`,
    );
    this.name = "FencedOutError";
  }
}

export interface LeaseHandle {
  secret: string;
  owner: string;
  fence: number;
  expiresAt: number;
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
  consumersDone: string[];
  createIntent: boolean;
  newVersion: number | null;
  newPayloadRef: string | null;
  newChecksum: string | null;
  oldPayloadRef: string | null;
  newProviderRef: string | null;
  oldProviderRef: string | null;
  alias: string;
  expectedFromVersion: number | null;
  firstIssuance: boolean;
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
  fence: number;
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
  consumers_done: string;
  create_intent: number;
  new_version: number | null;
  new_payload_ref: string | null;
  new_checksum: string | null;
  old_payload_ref: string | null;
  new_provider_ref: string | null;
  old_provider_ref: string | null;
  alias: string;
  expected_from_ver: number | null;
  first_issuance: number;
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
    consumersDone: JSON.parse(r.consumers_done) as string[],
    createIntent: r.create_intent === 1,
    newVersion: r.new_version,
    newPayloadRef: r.new_payload_ref,
    newChecksum: r.new_checksum,
    oldPayloadRef: r.old_payload_ref,
    newProviderRef: r.new_provider_ref,
    oldProviderRef: r.old_provider_ref,
    alias: r.alias,
    expectedFromVersion: r.expected_from_ver,
    firstIssuance: r.first_issuance === 1,
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
  oldProviderRef?: string | null;
  oldPayloadRef?: string | null;
  firstIssuance?: boolean;
}

export class RotationStore {
  constructor(
    private db: Database,
    autoMigrate = true,
  ) {
    // Per-connection pragmas ALWAYS (even when the schema is already migrated by
    // another connection) so cross-connection contention serializes, not errors.
    applyConnectionPragmas(db);
    if (autoMigrate) applyRotationMigration(db);
  }

  // -- jobs ---------------------------------------------------------------

  /** Insert a new job at stage 'requested'. Returns the row. */
  insertJob(input: NewJobInput, now: number): JobRow {
    this.db
      .query(
        `INSERT INTO rotation_jobs
          (id, secret, connector, strategy, subject, idempotency_key, stage,
           consumers, consumers_done, alias, old_provider_ref, old_payload_ref,
           first_issuance, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, '[]', ?, ?, ?, ?, ?, ?)`,
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
        input.oldProviderRef ?? null,
        input.oldPayloadRef ?? null,
        input.firstIssuance ? 1 : 0,
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

  /**
   * The most-recent PUBLISHED rotation job for a secret whose provider handle
   * is recorded, or null. "Published" means the job moved the alias to its new
   * version, i.e. stage is past `alias-moved`: `done`, `old-revoked`, or
   * `reconcile-required`. Used to derive the superseded credential's TRUSTED
   * provider handle / payload ref server-side -- so a revoke target is never
   * taken from a request parameter. Identifiers only; no material.
   *
   * Selecting the newest PUBLISHED job (not merely the newest `done` one) is a
   * correctness fix (F1): a rotation that published then failed its revoke ends
   * in `reconcile-required`, and ITS new_provider_ref is the actually-live
   * superseded credential. Picking an older `done` job would revoke an
   * already-dead handle and leave the real stale credential un-revoked.
   */
  getLastPublishedJob(secret: string): JobRow | null {
    const r = this.db
      .query(
        `SELECT * FROM rotation_jobs
         WHERE secret = ?
           AND stage IN ('done','old-revoked','reconcile-required')
           AND new_provider_ref IS NOT NULL
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1`,
      )
      .get(secret) as RawJob | null;
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

  /**
   * Fenced partial update. If `fence` is provided, the write only lands while
   * the executor still holds the live lease at that fence; otherwise it throws
   * FencedOutError. Pass fence = null only for lease-free bookkeeping.
   */
  updateJob(
    id: string,
    patch: Partial<JobRow>,
    now: number,
    fence: number | null,
  ): void {
    const cols: string[] = [];
    const vals: unknown[] = [];
    const map: Record<string, string> = {
      stage: "stage",
      consumers: "consumers",
      consumersDone: "consumers_done",
      createIntent: "create_intent",
      newVersion: "new_version",
      newPayloadRef: "new_payload_ref",
      newChecksum: "new_checksum",
      oldPayloadRef: "old_payload_ref",
      newProviderRef: "new_provider_ref",
      oldProviderRef: "old_provider_ref",
      alias: "alias",
      expectedFromVersion: "expected_from_ver",
      firstIssuance: "first_issuance",
      error: "error",
    };
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        cols.push(`${col} = ?`);
        const v = (patch as Record<string, unknown>)[k];
        if (k === "consumers" || k === "consumersDone") {
          vals.push(JSON.stringify(v));
        } else if (k === "createIntent" || k === "firstIssuance") {
          vals.push(v ? 1 : 0);
        } else {
          vals.push(v as unknown);
        }
      }
    }
    cols.push("updated_at = ?");
    vals.push(now, id);
    const run = () => {
      this.db
        .query(`UPDATE rotation_jobs SET ${cols.join(", ")} WHERE id = ?`)
        .run(...(vals as never[]));
    };
    if (fence == null) {
      run();
      return;
    }
    this.withFence(id, fence, now, run);
  }

  // -- checkpoints --------------------------------------------------------

  /**
   * Fenced checkpoint append. Rejects a write from an executor whose fence has
   * been superseded, so a stale holder cannot record progress on a job another
   * executor now owns.
   */
  appendCheckpoint(
    jobId: string,
    stage: RotationStage,
    status: "entered" | "ok" | "error",
    attempt: number,
    detail: string | null,
    now: number,
    fence: number | null,
  ): void {
    const run = () => {
      this.db
        .query(
          `INSERT INTO rotation_checkpoints
             (job_id, stage, status, attempt, fence, detail, at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(jobId, stage, status, attempt, fence ?? 0, detail, now);
    };
    if (fence == null) {
      run();
      return;
    }
    this.withFence(jobId, fence, now, run);
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
      fence: r.fence as number,
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

  // -- leases (atomic, fenced) --------------------------------------------

  /**
   * Atomically acquire the lease for `secret` owned by `owner` (a per-execution
   * uuid). ONE conditional statement -- no SELECT-then-decide window:
   *
   *   INSERT ... ON CONFLICT(secret) DO UPDATE SET
   *     owner = excluded.owner,
   *     fence = rotation_leases.fence + 1,   -- only on a real ownership change
   *     expires_at = excluded.expires_at
   *   WHERE rotation_leases.expires_at <= excluded.acquired_at
   *      OR rotation_leases.owner = excluded.owner
   *   RETURNING owner, fence;
   *
   * Acquisition SUCCEEDED iff the RETURNING row's owner == my executorId.
   * The ON CONFLICT guard guarantees at most one owner even if two writers
   * interleave. SQLITE_BUSY / "database is locked" is treated as a LOSS of the
   * attempt (a normal outcome), retried with bounded backoff, and NEVER thrown
   * out of the engine.
   *
   * Fresh insert (no prior row) mints fence from the monotonic sequence so
   * fences stay globally monotonic across secrets and takeovers.
   */
  acquireLease(
    secret: string,
    owner: string,
    now: number,
    ttlMs: number,
  ): LeaseHandle | null {
    const expires = now + ttlMs;
    // Bounded retry: on BUSY (two file connections contending) back off and
    // retry a few times, then report "not acquired" -- never throw.
    const MAX_TRIES = 12;
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      try {
        return this.acquireOnce(secret, owner, now, expires);
      } catch (err) {
        if (isBusy(err) && attempt < MAX_TRIES - 1) {
          busySleep(attempt);
          continue;
        }
        if (isBusy(err)) return null; // exhausted: a normal loss, not an error
        throw err; // a genuine (non-busy) error
      }
    }
    return null;
  }

  /** Single-statement conditional acquire under BEGIN IMMEDIATE. */
  private acquireOnce(
    secret: string,
    owner: string,
    now: number,
    expires: number,
  ): LeaseHandle | null {
    const txn = this.db.transaction((): LeaseHandle | null => {
      // Fresh-insert fence comes from the monotonic sequence; a takeover on
      // conflict increments the row's own fence by 1 (only when ownership
      // actually changes -- a same-owner renew keeps the fence unchanged, see
      // the CASE below).
      this.db
        .query("UPDATE rotation_fence_seq SET value = value + 1 WHERE id = 0")
        .run();
      const seqFence = (
        this.db
          .query("SELECT value FROM rotation_fence_seq WHERE id = 0")
          .get() as { value: number }
      ).value;

      const row = this.db
        .query(
          `INSERT INTO rotation_leases (secret, owner, fence, expires_at, acquired_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(secret) DO UPDATE SET
             owner = excluded.owner,
             fence = CASE
               WHEN rotation_leases.owner = excluded.owner THEN rotation_leases.fence
               ELSE rotation_leases.fence + 1
             END,
             expires_at = excluded.expires_at,
             acquired_at = excluded.acquired_at
           WHERE rotation_leases.expires_at <= excluded.acquired_at
              OR rotation_leases.owner = excluded.owner
           RETURNING owner, fence, expires_at`,
        )
        .get(secret, owner, seqFence, expires, now) as {
        owner: string;
        fence: number;
        expires_at: number;
      } | null;

      // No RETURNING row => the ON CONFLICT WHERE guard rejected us: a live
      // foreign lease holds the secret. We did not acquire.
      if (!row) return null;
      // RETURNING row whose owner is not us can only happen on a lost race that
      // committed another owner first; treat as not acquired.
      if (row.owner !== owner) return null;
      return { secret, owner, fence: row.fence, expiresAt: row.expires_at };
    });
    return txn.immediate();
  }

  /**
   * Renew (extend expiry) the lease iff still held by owner at fence. Returns
   * true on success; false if the lease was lost/stolen. Fence is unchanged.
   */
  renewLease(handle: LeaseHandle, now: number, ttlMs: number): boolean {
    const info = this.db
      .query(
        `UPDATE rotation_leases SET expires_at = ?
         WHERE secret = ? AND owner = ? AND fence = ? AND expires_at > ?`,
      )
      .run(now + ttlMs, handle.secret, handle.owner, handle.fence, now);
    if (info.changes === 1) {
      handle.expiresAt = now + ttlMs;
      return true;
    }
    return false;
  }

  /** True iff the lease is still held by owner at fence and not expired. */
  validateLease(handle: LeaseHandle, now: number): boolean {
    const r = this.db
      .query(
        `SELECT 1 FROM rotation_leases
         WHERE secret = ? AND owner = ? AND fence = ? AND expires_at > ?`,
      )
      .get(handle.secret, handle.owner, handle.fence, now);
    return !!r;
  }

  /** Release the lease iff still held by this owner+fence (no theft). */
  releaseLease(handle: LeaseHandle): void {
    this.db
      .query(
        "DELETE FROM rotation_leases WHERE secret = ? AND owner = ? AND fence = ?",
      )
      .run(handle.secret, handle.owner, handle.fence);
  }

  /** Current live fence for a secret, or null if no live lease. */
  liveFence(secret: string, now: number): number | null {
    const r = this.db
      .query(
        "SELECT fence FROM rotation_leases WHERE secret = ? AND expires_at > ?",
      )
      .get(secret, now) as { fence: number } | null;
    return r ? r.fence : null;
  }

  // -- internal -----------------------------------------------------------

  /**
   * Run `fn` inside a transaction that first asserts the executor's fence is
   * still the live lease fence for the job's secret. If the lease was stolen
   * (live fence advanced past `fence`), throws FencedOutError and the mutation
   * does not land.
   */
  private withFence(
    jobId: string,
    fence: number,
    now: number,
    fn: () => void,
  ): void {
    const txn = this.db.transaction(() => {
      const job = this.db
        .query("SELECT secret FROM rotation_jobs WHERE id = ?")
        .get(jobId) as { secret: string } | null;
      if (!job) throw new Error(`no such job ${jobId}`);
      const live = this.db
        .query(
          "SELECT fence FROM rotation_leases WHERE secret = ? AND expires_at > ?",
        )
        .get(job.secret, now) as { fence: number } | null;
      const liveFence = live ? live.fence : 0;
      if (liveFence !== fence) {
        throw new FencedOutError(job.secret, fence, liveFence);
      }
      fn();
    });
    txn();
  }
}
