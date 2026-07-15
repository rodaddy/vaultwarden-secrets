/**
 * server/rotation/engine.ts
 *
 * Durable rotation job state machine. Drives a rotation through the
 * GCP/#10-shaped stages, persisting a checkpoint at every transition so an
 * interrupted process resumes exactly where it left off. Concurrency on a
 * single credential is serialized by a lease; duplicate idempotency keys
 * return the existing job instead of rotating twice.
 *
 * Security posture:
 *  - Generated material never enters engine state. Connectors write material
 *    through the injected VaultWriter and hand back only refs + checksums.
 *  - A LeakGuard scans every persisted row / audit entry / outbox event and
 *    throws (fail closed) if a sentinel value would leak.
 *  - Old credential is revoked ONLY after verify() passes. A failed verify
 *    leaves the old credential valid and triggers bounded rollback.
 *  - Alias move is CAS-guarded (expectedFromVersion) so a retry can never
 *    publish a stale alias.
 */

import type { Database } from "bun:sqlite";
import {
  type EngineDeps,
  type RotationStrategy,
  type ConnectorContext,
  type ConsumerHook,
} from "./deps";
import {
  type RotationStage,
  canTransition,
  isTerminal,
  nextHappyStage,
  InvalidTransitionError,
} from "./states";
import { LeakGuard } from "./guard";
import { RotationStore, type JobRow } from "./store-sqlite";

export interface RotateRequest {
  credential: string; // secret identifier
  connector: string; // connector name (for the record; instance is injected)
  strategy: RotationStrategy;
  consumers: string[];
  idempotencyKey: string;
  subject: string; // authorization subject
  alias?: string; // defaults to 'current'
  jobId?: string; // optional explicit id (else generated)
}

/** Redacted receipt: proves progress, contains identifiers/hashes only. */
export interface RotationReceipt {
  jobId: string;
  secret: string;
  stage: RotationStage;
  strategy: RotationStrategy;
  newVersion: number | null;
  newChecksum: string | null;
  newPayloadRef: string | null;
  error: string | null;
  checkpoints: Array<{
    stage: RotationStage;
    status: string;
    attempt: number;
    at: number;
  }>;
}

const DEFAULT_LEASE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;

export class UnauthorizedRotationError extends Error {
  constructor(action: string, resource: string, reason?: string) {
    super(
      `unauthorized: ${action} on ${resource}${reason ? ` (${reason})` : ""}`,
    );
    this.name = "UnauthorizedRotationError";
  }
}

export class LeaseHeldError extends Error {
  constructor(secret: string, owner: string) {
    super(`rotation lease for ${secret} held by ${owner}`);
    this.name = "LeaseHeldError";
  }
}

export class ConsumerNotAllowlistedError extends Error {
  constructor(consumer: string) {
    super(`consumer not allowlisted: ${consumer}`);
    this.name = "ConsumerNotAllowlistedError";
  }
}

export class RotationEngine {
  private store: RotationStore;
  private leaseTtlMs: number;
  private maxAttempts: number;

  constructor(
    db: Database,
    private deps: EngineDeps,
  ) {
    this.store = new RotationStore(db);
    this.leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  private now(): number {
    return this.deps.clock ? this.deps.clock.now() : Date.now();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Start (or resume, on duplicate key) a rotation and drive it to a terminal
   * stage. Serialized per credential by a lease.
   */
  async rotate(req: RotateRequest): Promise<RotationReceipt> {
    // Authorization is fail-closed and happens before anything is persisted.
    await this.assertAuthorized(req.subject, "rotate", req.credential);

    // Idempotency: a duplicate key returns the existing job untouched.
    const existing = this.store.getJobByIdempotencyKey(req.idempotencyKey);
    if (existing) {
      return this.receipt(existing.id);
    }

    // Validate consumers up front against the allowlist (fail closed).
    for (const c of req.consumers) {
      if (!this.deps.consumerAllowlist[c]) {
        throw new ConsumerNotAllowlistedError(c);
      }
    }

    const jobId = req.jobId ?? crypto.randomUUID();
    const now = this.now();

    // Acquire the lease before creating the job so contention fails clean.
    if (!this.store.acquireLease(req.credential, jobId, now, this.leaseTtlMs)) {
      const owner = this.store.getLeaseOwner(req.credential, now) ?? "unknown";
      throw new LeaseHeldError(req.credential, owner);
    }

    this.store.insertJob(
      {
        id: jobId,
        secret: req.credential,
        connector: req.connector,
        strategy: req.strategy,
        subject: req.subject,
        idempotencyKey: req.idempotencyKey,
        consumers: req.consumers,
        alias: req.alias ?? "current",
      },
      now,
    );
    this.store.appendCheckpoint(jobId, "requested", "entered", 1, null, now);

    try {
      return await this.drive(jobId);
    } finally {
      this.store.releaseLease(req.credential, jobId);
    }
  }

  /**
   * Resume every non-terminal job. Called at startup after a crash. Each job
   * re-acquires its lease (expired leases are reclaimable) and continues from
   * its persisted stage.
   */
  async resumePending(): Promise<RotationReceipt[]> {
    const out: RotationReceipt[] = [];
    for (const job of this.store.listPending()) {
      const now = this.now();
      if (!this.store.acquireLease(job.secret, job.id, now, this.leaseTtlMs)) {
        // Another live owner is already driving it; skip.
        continue;
      }
      try {
        out.push(await this.drive(job.id));
      } finally {
        this.store.releaseLease(job.secret, job.id);
      }
    }
    return out;
  }

  /**
   * Seed a job (authorize + validate consumers + acquire lease + persist at
   * 'requested') WITHOUT driving it. Used to simulate step-wise execution /
   * crash recovery: the caller advances with step() and can stop at any point,
   * leaving a durable resumable job. The lease is released immediately so a
   * later resumePending() (a new "process") can reclaim it.
   */
  async startJob(req: RotateRequest): Promise<JobRow> {
    await this.assertAuthorized(req.subject, "rotate", req.credential);
    const existing = this.store.getJobByIdempotencyKey(req.idempotencyKey);
    if (existing) return existing;
    for (const c of req.consumers) {
      if (!this.deps.consumerAllowlist[c])
        throw new ConsumerNotAllowlistedError(c);
    }
    const jobId = req.jobId ?? crypto.randomUUID();
    const now = this.now();
    if (!this.store.acquireLease(req.credential, jobId, now, this.leaseTtlMs)) {
      const owner = this.store.getLeaseOwner(req.credential, now) ?? "unknown";
      throw new LeaseHeldError(req.credential, owner);
    }
    const job = this.store.insertJob(
      {
        id: jobId,
        secret: req.credential,
        connector: req.connector,
        strategy: req.strategy,
        subject: req.subject,
        idempotencyKey: req.idempotencyKey,
        consumers: req.consumers,
        alias: req.alias ?? "current",
      },
      now,
    );
    this.store.appendCheckpoint(jobId, "requested", "entered", 1, null, now);
    // Release so a resuming process can reclaim; step() re-acquires per call.
    this.store.releaseLease(req.credential, jobId);
    return job;
  }

  /** Step the engine exactly one stage. Test/debug hook for crash simulation. */
  async step(jobId: string): Promise<JobRow> {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(`no such job ${jobId}`);
    if (isTerminal(job.stage)) return job;
    await this.runStage(job);
    return this.store.getJob(jobId)!;
  }

  getReceipt(jobId: string): RotationReceipt {
    return this.receipt(jobId);
  }

  // -----------------------------------------------------------------------
  // Driver
  // -----------------------------------------------------------------------

  private async drive(jobId: string): Promise<RotationReceipt> {
    // Bounded outer loop: each iteration advances one stage. The state machine
    // itself is the termination guarantee (terminal stages have no outbound
    // edges); the counter is a belt-and-suspenders against a graph bug.
    let guard = 64;
    while (guard-- > 0) {
      const job = this.store.getJob(jobId)!;
      if (isTerminal(job.stage)) break;
      await this.runStage(job);
    }
    return this.receipt(jobId);
  }

  /**
   * Execute the effect for the CURRENT stage, then transition. Each stage is
   * idempotent: re-entering a stage whose effect already committed is a no-op
   * that just advances. Leak guard is armed per job from the staged checksum's
   * source material only inside the connector; here we scan every persisted row.
   */
  private async runStage(job: JobRow): Promise<void> {
    const leak = new LeakGuard();
    const attempt = this.store.attemptsFor(job.id, job.stage) + 1;

    try {
      switch (job.stage) {
        case "requested":
          return await this.stageProviderCreate(job, leak, attempt);
        case "provider-created":
          return await this.stageStage(job, leak, attempt);
        case "staged":
          return await this.stageConsumers(job, leak, attempt);
        case "consumers-reloaded":
          return await this.stageVerify(job, leak, attempt);
        case "verified":
          return await this.stageAliasMove(job, leak, attempt);
        case "alias-moved":
          return await this.stageRevoke(job, leak, attempt);
        case "old-revoked":
          return await this.transition(job, "done", leak, attempt, {});
        case "failed":
          return await this.stageRollback(job, leak, attempt);
        case "rolling-back":
          // rollback effect already ran; resolve terminal
          return await this.transition(job, "rolled-back", leak, attempt, {});
        default:
          return; // terminal
      }
    } catch (err) {
      await this.onStageError(job, err, leak, attempt);
    }
  }

  // -----------------------------------------------------------------------
  // Stage effects
  // -----------------------------------------------------------------------

  private ctx(job: JobRow): ConnectorContext {
    return {
      jobId: job.id,
      secret: job.secret,
      strategy: job.strategy,
      newPayloadRef: job.newPayloadRef ?? undefined,
      oldPayloadRef: job.oldPayloadRef ?? undefined,
      newProviderRef: job.newProviderRef ?? undefined,
      oldProviderRef: job.oldProviderRef ?? undefined,
      vault: this.deps.vault,
    };
  }

  /** requested -> provider-created: connector creates + stages material. */
  private async stageProviderCreate(
    job: JobRow,
    leak: LeakGuard,
    attempt: number,
  ): Promise<void> {
    const result = await this.deps.connector.create(this.ctx(job));
    // Defense in depth: the connector returns refs/hashes only, but scan.
    leak.assertClean(result, "connector.create result");
    await this.transition(job, "provider-created", leak, attempt, {
      newPayloadRef: result.payloadRef,
      newChecksum: result.checksum,
      newProviderRef: result.providerRef ?? null,
    });
  }

  /** provider-created -> staged: register immutable version in control plane. */
  private async stageStage(
    job: JobRow,
    leak: LeakGuard,
    attempt: number,
  ): Promise<void> {
    if (!job.newPayloadRef || !job.newChecksum) {
      throw new Error("cannot stage: missing payload ref/checksum");
    }
    // Idempotent: addVersion dedupes on idempotencyKey server-side.
    const { version } = await this.deps.store.addVersion({
      secret: job.secret,
      payloadRef: job.newPayloadRef,
      checksum: job.newChecksum,
      idempotencyKey: job.idempotencyKey,
    });
    // Capture the version currently behind the alias as the CAS expectation.
    const current = await this.deps.store.getVersion(job.secret, job.alias);
    await this.transition(job, "staged", leak, attempt, {
      newVersion: version,
      expectedFromVersion: current ? current.version : null,
    });
  }

  /** staged -> consumers-reloaded: allowlisted hooks only. */
  private async stageConsumers(
    job: JobRow,
    leak: LeakGuard,
    attempt: number,
  ): Promise<void> {
    for (const c of job.consumers) {
      const hook: ConsumerHook | undefined = this.deps.consumerAllowlist[c];
      if (!hook) throw new ConsumerNotAllowlistedError(c);
      await this.deps.consumerReloader.reload(c, hook);
    }
    await this.transition(job, "consumers-reloaded", leak, attempt, {});
  }

  /** consumers-reloaded -> verified: probe the replacement. */
  private async stageVerify(
    job: JobRow,
    leak: LeakGuard,
    attempt: number,
  ): Promise<void> {
    const ok = await this.deps.connector.verify(this.ctx(job));
    if (!ok) {
      // Verification failed: old credential is STILL valid. Bounded rollback.
      throw new VerificationFailedError(job.secret);
    }
    await this.transition(job, "verified", leak, attempt, {});
  }

  /** verified -> alias-moved: CAS-guarded alias move (no stale publish). */
  private async stageAliasMove(
    job: JobRow,
    leak: LeakGuard,
    attempt: number,
  ): Promise<void> {
    if (job.newVersion == null)
      throw new Error("cannot move alias: no staged version");
    await this.assertAuthorized(job.subject, "move-alias", job.secret);
    await this.deps.store.moveAlias({
      secret: job.secret,
      alias: job.alias,
      toVersion: job.newVersion,
      expectedFromVersion: job.expectedFromVersion,
    });
    await this.transition(job, "alias-moved", leak, attempt, {});
  }

  /** alias-moved -> old-revoked: revoke ONLY now (after verify + alias). */
  private async stageRevoke(
    job: JobRow,
    leak: LeakGuard,
    attempt: number,
  ): Promise<void> {
    await this.assertAuthorized(job.subject, "revoke", job.secret);
    try {
      await this.deps.connector.revoke(this.ctx(job));
    } catch (err) {
      // Alias already committed: revoke failure is a partial cross-store
      // outcome. Escalate to reconcile-required rather than rolling back a
      // published alias.
      await this.markReconcile(job, "revoke", this.errMsg(err), leak);
      return;
    }
    await this.transition(job, "old-revoked", leak, attempt, {});
  }

  /** failed -> rolling-back: bounded connector rollback (old cred intact). */
  private async stageRollback(
    job: JobRow,
    leak: LeakGuard,
    attempt: number,
  ): Promise<void> {
    // Move into rolling-back first (durable), then run the effect.
    await this.transition(job, "rolling-back", leak, attempt, {});
    const rb = this.store.getJob(job.id)!;
    try {
      await this.deps.connector.rollback(this.ctx(rb));
    } catch (err) {
      await this.markReconcile(rb, "rollback", this.errMsg(err), leak);
      return;
    }
    await this.transition(
      rb,
      "rolled-back",
      leak,
      this.store.attemptsFor(rb.id, "rolling-back"),
      {},
    );
  }

  // -----------------------------------------------------------------------
  // Error handling / reconcile
  // -----------------------------------------------------------------------

  private async onStageError(
    job: JobRow,
    err: unknown,
    leak: LeakGuard,
    attempt: number,
  ): Promise<void> {
    const msg = this.errMsg(err);
    this.store.appendCheckpoint(
      job.id,
      job.stage,
      "error",
      attempt,
      JSON.stringify(leak.assertClean({ error: msg }, "error checkpoint")),
      this.now(),
    );
    await this.emit(job, job.stage, "error", leak, { attempt, error: msg });

    // Retry within bounds for retryable stages (idempotent effects).
    if (attempt < this.maxAttempts && this.isRetryable(job.stage)) {
      // Leave stage unchanged; the driver loop re-enters and retries.
      return;
    }

    // Exhausted / non-retryable: transition to failed, then the driver rolls
    // back. Verification failure is explicitly a rollback path.
    await this.transition(job, "failed", leak, attempt, { error: msg });
  }

  private isRetryable(stage: RotationStage): boolean {
    // Verification failures should not spin retries against a bad credential;
    // they go straight to rollback. Transport-ish stages are retryable.
    return (
      stage === "requested" ||
      stage === "provider-created" ||
      stage === "staged" ||
      stage === "consumers-reloaded" ||
      stage === "alias-moved"
    );
  }

  private async markReconcile(
    job: JobRow,
    op: string,
    detail: string,
    leak: LeakGuard,
  ): Promise<void> {
    await this.deps.store.markReconcileRequired({
      op,
      secret: job.secret,
      detail,
    });
    await this.transition(
      job,
      "reconcile-required",
      leak,
      this.store.attemptsFor(job.id, job.stage) + 1,
      {
        error: `${op}: ${detail}`,
      },
    );
  }

  // -----------------------------------------------------------------------
  // Transition primitive (durable + audited + leak-guarded)
  // -----------------------------------------------------------------------

  private async transition(
    job: JobRow,
    to: RotationStage,
    leak: LeakGuard,
    attempt: number,
    patch: Partial<JobRow>,
  ): Promise<void> {
    if (!canTransition(job.stage, to)) {
      throw new InvalidTransitionError(job.stage, to);
    }
    const now = this.now();
    const merged = { ...patch, stage: to };
    // Scan the exact bytes we are about to persist for leaked material.
    leak.assertClean(merged, `job row transition ${job.stage}->${to}`);
    this.store.updateJob(job.id, merged, now);
    this.store.appendCheckpoint(job.id, to, "ok", attempt, null, now);
    await this.emit({ ...job, ...merged } as JobRow, to, "ok", leak, {});
  }

  /** Emit a redacted audit entry + outbox event for a stage outcome. */
  private async emit(
    job: JobRow,
    stage: RotationStage,
    outcome: "ok" | "error" | "skip",
    leak: LeakGuard,
    extra: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    const detail: Record<string, string | number | boolean | null> = {
      strategy: job.strategy,
      newVersion: job.newVersion,
      newChecksum: job.newChecksum,
      ...extra,
    };
    leak.assertClean(detail, `audit/outbox detail for ${stage}`);
    const at = new Date(this.now()).toISOString();
    await this.deps.audit.appendAudit({
      jobId: job.id,
      secret: job.secret,
      stage,
      outcome,
      detail,
      at,
    });
    await this.deps.outbox.enqueueEvent({
      jobId: job.id,
      secret: job.secret,
      type: `rotation.${stage}.${outcome}`,
      data: detail,
      at,
    });
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async assertAuthorized(
    subject: string,
    action: "rotate" | "move-alias" | "revoke" | "rollback",
    resource: string,
  ): Promise<void> {
    const res = await this.deps.authorize({ subject, action, resource });
    if (!res.allow)
      throw new UnauthorizedRotationError(action, resource, res.reason);
  }

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private receipt(jobId: string): RotationReceipt {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(`no such job ${jobId}`);
    const checkpoints = this.store.listCheckpoints(jobId).map((c) => ({
      stage: c.stage,
      status: c.status,
      attempt: c.attempt,
      at: c.at,
    }));
    return {
      jobId: job.id,
      secret: job.secret,
      stage: job.stage,
      strategy: job.strategy,
      newVersion: job.newVersion,
      newChecksum: job.newChecksum,
      newPayloadRef: job.newPayloadRef,
      error: job.error,
      checkpoints,
    };
  }
}

export class VerificationFailedError extends Error {
  constructor(secret: string) {
    super(
      `replacement verification failed for ${secret}; old credential preserved`,
    );
    this.name = "VerificationFailedError";
  }
}
