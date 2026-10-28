/**
 * server/rotation/engine.ts
 *
 * Durable rotation job state machine. Drives a rotation through the
 * GCP/#10-shaped stages, persisting a fenced checkpoint at every transition so
 * an interrupted process resumes exactly where it left off. Concurrency on a
 * single credential is serialized by a fenced lease; duplicate idempotency keys
 * return the existing job instead of rotating twice.
 *
 * Correctness posture (post-review hardening):
 *  - LEASE: acquired atomically, owned by a PER-EXECUTION uuid (not job id),
 *    carries a monotonic fencing token. The lease is revalidated before every
 *    awaited effect and renewed around long ones; a holder that lost the lease
 *    aborts before mutating. Every persisted write is fenced.
 *  - CRASH-SAFE CREATE: a durable creation-intent is set BEFORE the connector
 *    /vault create call, and create is job-scoped-idempotent, so a crash
 *    between create and its checkpoint reuses the existing credential rather
 *    than minting a second one.
 *  - NEVER ROLLBACK AFTER PUBLISH: once the alias may point at the new version,
 *    any failure fails closed to reconcile-required. Rollback (credential
 *    deletion) is only reachable on a pre-publish failure. On resume, an alias
 *    already at the target advances to done (never re-rolls-back).
 *  - ROLLBACK IS EFFECT-PENDING: crash mid-rollback resumes rollback, not
 *    "rolled-back". Rollback is authorized; denial -> reconcile-required.
 *  - NO LEAK: generated material flows only through an ARMING vault-writer
 *    proxy that registers it with the job LeakGuard; every persisted row,
 *    audit entry, outbox event, receipt, and error is scanned and fails closed.
 */

import type { Database } from "bun:sqlite";
import {
  type EngineDeps,
  type RotationStrategy,
  type ConnectorContext,
  type ConsumerHook,
  type VaultWriter,
  type MaterialGenerator,
  type VaultWriteResult,
} from "./deps";
import {
  type RotationStage,
  canTransition,
  isTerminal,
  InvalidTransitionError,
} from "./states";
import { LeakGuard, SecretLeakError } from "./guard";
import {
  RotationStore,
  FencedOutError,
  type JobRow,
  type LeaseHandle,
} from "./store-sqlite";

export interface RotateRequest {
  credential: string; // secret identifier
  connector: string; // connector name (for the record; instance is injected)
  strategy: RotationStrategy;
  consumers: string[];
  idempotencyKey: string;
  subject: string; // authorization subject
  alias?: string; // defaults to 'current'
  jobId?: string; // optional explicit id (else generated)
  /** Provider handle for the credential being superseded (revoke target). */
  oldProviderRef?: string | null;
  /** Vault ref for the credential being superseded. */
  oldPayloadRef?: string | null;
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
  constructor(secret: string) {
    super(`rotation lease for ${secret} is held by another executor`);
    this.name = "LeaseHeldError";
  }
}

export class ConsumerNotAllowlistedError extends Error {
  constructor(consumer: string) {
    super(`consumer not allowlisted: ${consumer}`);
    this.name = "ConsumerNotAllowlistedError";
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

/**
 * VaultWriter proxy that arms a LeakGuard with every material value written
 * during a job, so any later leak of that value into persisted state is caught.
 */
class ArmingVaultWriter implements VaultWriter {
  constructor(
    private inner: VaultWriter,
    private leak: LeakGuard,
  ) {}
  async writeItem(
    ref: string,
    generator: MaterialGenerator,
  ): Promise<VaultWriteResult> {
    const armingGen: MaterialGenerator = async () => {
      const material = await generator();
      this.leak.arm(material); // register before it can be persisted anywhere
      return material;
    };
    return this.inner.writeItem(ref, armingGen);
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
    this.maxAttempts = validateMaxAttempts(deps.maxAttempts);
  }

  private now(): number {
    return this.deps.clock ? this.deps.clock.now() : Date.now();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Start (or resume, on duplicate key) a rotation and drive it to a terminal
   * stage. Serialized per credential by a fenced lease.
   */
  async rotate(req: RotateRequest): Promise<RotationReceipt> {
    await this.assertAuthorized(req.subject, "rotate", req.credential);

    // Idempotency: a duplicate key returns the existing job untouched.
    const existing = this.store.getJobByIdempotencyKey(req.idempotencyKey);
    if (existing) return this.receipt(existing.id);

    for (const c of req.consumers) {
      if (!this.deps.consumerAllowlist[c]) {
        throw new ConsumerNotAllowlistedError(c);
      }
    }

    const jobId = req.jobId ?? crypto.randomUUID();
    const executorId = crypto.randomUUID(); // per-execution owner
    const now = this.now();

    const lease = this.store.acquireLease(
      req.credential,
      executorId,
      now,
      this.leaseTtlMs,
    );
    if (!lease) throw new LeaseHeldError(req.credential);

    try {
      // First-issuance when no old credential handle was supplied.
      const firstIssuance = !req.oldProviderRef && !req.oldPayloadRef;
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
          oldProviderRef: req.oldProviderRef ?? null,
          oldPayloadRef: req.oldPayloadRef ?? null,
          firstIssuance,
        },
        now,
      );
      this.store.appendCheckpoint(
        jobId,
        "requested",
        "entered",
        1,
        null,
        now,
        lease.fence,
      );
      return await this.drive(jobId, lease);
    } finally {
      this.store.releaseLease(lease);
    }
  }

  /**
   * Resume every non-terminal job after a crash. Each job is claimed with a
   * FRESH per-execution owner + fence (reclaiming expired leases) and continues
   * from its persisted stage. A job whose lease is still live under another
   * executor is skipped.
   */
  async resumePending(): Promise<RotationReceipt[]> {
    const out: RotationReceipt[] = [];
    for (const job of this.store.listPending()) {
      const executorId = crypto.randomUUID();
      const now = this.now();
      const lease = this.store.acquireLease(
        job.secret,
        executorId,
        now,
        this.leaseTtlMs,
      );
      if (!lease) continue; // another live owner is driving it
      try {
        out.push(await this.drive(job.id, lease));
      } finally {
        this.store.releaseLease(lease);
      }
    }
    return out;
  }

  /**
   * Seed a job WITHOUT driving it (test/crash-simulation hook). Acquires and
   * immediately releases the lease so a later resumePending() reclaims it.
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
    const executorId = crypto.randomUUID();
    const now = this.now();
    const lease = this.store.acquireLease(
      req.credential,
      executorId,
      now,
      this.leaseTtlMs,
    );
    if (!lease) throw new LeaseHeldError(req.credential);
    const firstIssuance = !req.oldProviderRef && !req.oldPayloadRef;
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
        oldProviderRef: req.oldProviderRef ?? null,
        oldPayloadRef: req.oldPayloadRef ?? null,
        firstIssuance,
      },
      now,
    );
    this.store.appendCheckpoint(
      jobId,
      "requested",
      "entered",
      1,
      null,
      now,
      lease.fence,
    );
    this.store.releaseLease(lease);
    return job;
  }

  /**
   * Step exactly one stage under a FRESH per-execution lease (test/debug hook
   * for crash simulation). The lease is released after the step so an
   * interleaved executor can take over -- this is what makes step-wise tests
   * faithfully model separate processes.
   */
  async step(jobId: string): Promise<JobRow> {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(`no such job ${jobId}`);
    if (isTerminal(job.stage)) return job;
    const executorId = crypto.randomUUID();
    const now = this.now();
    const lease = this.store.acquireLease(
      job.secret,
      executorId,
      now,
      this.leaseTtlMs,
    );
    if (!lease) throw new LeaseHeldError(job.secret);
    // step() models a single-process lifetime: a fresh guard per step. Because
    // create material is written to the vault and re-read cannot happen here,
    // step-wise crash tests assert non-leak on the durable rows across steps.
    const leak = new LeakGuard();
    try {
      await this.runStage(job, lease, leak);
    } finally {
      this.store.releaseLease(lease);
    }
    return this.store.getJob(jobId)!;
  }

  getReceipt(jobId: string): RotationReceipt {
    return this.receipt(jobId);
  }

  // -----------------------------------------------------------------------
  // Driver
  // -----------------------------------------------------------------------

  private async drive(
    jobId: string,
    lease: LeaseHandle,
  ): Promise<RotationReceipt> {
    // ONE LeakGuard for the whole job execution. Once the arming vault writer
    // registers the generated material during create(), the guard stays armed
    // for every later stage's persistence/emission -- so a leak in any stage
    // (including sanitized errors) is caught, not just the stage that wrote.
    const leak = new LeakGuard();
    let guard = 64;
    while (guard-- > 0) {
      const job = this.store.getJob(jobId)!;
      if (isTerminal(job.stage)) break;
      // Revalidate/renew the lease before each stage; abort if stolen.
      if (!this.store.renewLease(lease, this.now(), this.leaseTtlMs)) {
        throw new LeaseHeldError(job.secret);
      }
      await this.runStage(job, lease, leak);
    }
    return this.receipt(jobId);
  }

  private async runStage(
    job: JobRow,
    lease: LeaseHandle,
    leak: LeakGuard,
  ): Promise<void> {
    const attempt = this.store.attemptsFor(job.id, job.stage) + 1;

    try {
      switch (job.stage) {
        case "requested":
          return await this.stageProviderCreate(job, leak, lease, attempt);
        case "provider-created":
          return await this.stageStage(job, leak, lease, attempt);
        case "staged":
          return await this.stageConsumers(job, leak, lease, attempt);
        case "consumers-reloaded":
          return await this.stageVerify(job, leak, lease, attempt);
        case "verified":
          return await this.stageAliasMove(job, leak, lease, attempt);
        case "alias-moved":
          return await this.stageRevoke(job, leak, lease, attempt);
        case "old-revoked":
          return await this.transition(job, "done", leak, lease, attempt, {});
        case "failed":
          return await this.stageRollback(job, leak, lease, attempt);
        case "rolling-back":
          // Effect-pending: (re)run rollback until it durably completes.
          return await this.stageRollback(job, leak, lease, attempt);
        default:
          return; // terminal
      }
    } catch (err) {
      // A fenced-out executor must NOT record anything -- it lost the lease.
      if (err instanceof FencedOutError) throw new LeaseHeldError(job.secret);
      await this.onStageError(job, err, leak, lease, attempt);
    }
  }

  // -----------------------------------------------------------------------
  // Stage effects
  // -----------------------------------------------------------------------

  private ctx(job: JobRow, leak: LeakGuard): ConnectorContext {
    return {
      jobId: job.id,
      secret: job.secret,
      strategy: job.strategy,
      newPayloadRef: job.newPayloadRef ?? undefined,
      oldPayloadRef: job.oldPayloadRef ?? undefined,
      newProviderRef: job.newProviderRef ?? undefined,
      oldProviderRef: job.oldProviderRef ?? undefined,
      firstIssuance: job.firstIssuance,
      vault: new ArmingVaultWriter(this.deps.vault, leak),
    };
  }

  /**
   * requested -> provider-created. Crash-safe: a durable creation-intent is
   * persisted BEFORE calling the connector. On resume, if the intent is set but
   * we have no provider ref yet, we still call create() -- but the connector's
   * create is job-scoped-idempotent (keyed on jobId) so it reuses the existing
   * credential instead of minting a second one. Once we have a providerRef we
   * skip straight to the transition (no second create).
   */
  private async stageProviderCreate(
    job: JobRow,
    leak: LeakGuard,
    lease: LeaseHandle,
    attempt: number,
  ): Promise<void> {
    // Already created (resume after create but before transition checkpoint):
    if (job.newProviderRef && job.newPayloadRef && job.newChecksum) {
      await this.transition(job, "provider-created", leak, lease, attempt, {});
      return;
    }
    // Record creation intent durably before the side-effecting call.
    if (!job.createIntent) {
      this.store.updateJob(
        job.id,
        { createIntent: true },
        this.now(),
        lease.fence,
      );
    }
    const result = await this.deps.connector.create(this.ctx(job, leak));
    leak.assertClean(result, "connector.create result");
    // Persist the provider handle + refs in a dedicated fenced write BEFORE the
    // stage transition, so a crash between mint and the transition checkpoint
    // still leaves the handle durably recorded. On resume the guard at the top
    // of this stage sees newProviderRef set and ADOPTS it (no re-mint). Even if
    // this write itself is lost, the connector's create is provider-idempotent
    // (deterministic job-scoped handle: orphan detected + cleaned on re-create).
    this.store.updateJob(
      job.id,
      {
        newPayloadRef: result.payloadRef,
        newChecksum: result.checksum,
        newProviderRef: result.providerRef ?? null,
      },
      this.now(),
      lease.fence,
    );
    const adopted = this.store.getJob(job.id)!;
    await this.transition(
      adopted,
      "provider-created",
      leak,
      lease,
      attempt,
      {},
    );
  }

  /** provider-created -> staged: register immutable version in control plane. */
  private async stageStage(
    job: JobRow,
    leak: LeakGuard,
    lease: LeaseHandle,
    attempt: number,
  ): Promise<void> {
    if (!job.newPayloadRef || !job.newChecksum) {
      throw new Error("cannot stage: missing payload ref/checksum");
    }
    const { version } = await this.deps.store.addVersion({
      secret: job.secret,
      payloadRef: job.newPayloadRef,
      checksum: job.newChecksum,
      idempotencyKey: job.idempotencyKey,
    });
    const current = await this.deps.store.getVersion(job.secret, job.alias);
    await this.transition(job, "staged", leak, lease, attempt, {
      newVersion: version,
      expectedFromVersion: current ? current.version : null,
    });
  }

  /**
   * staged -> consumers-reloaded. Per-consumer progress is checkpointed so a
   * resume replays only the not-yet-reloaded consumers (hooks may not be
   * idempotent). Only allowlisted hooks run.
   */
  private async stageConsumers(
    job: JobRow,
    leak: LeakGuard,
    lease: LeaseHandle,
    attempt: number,
  ): Promise<void> {
    const done = new Set(job.consumersDone);
    for (const c of job.consumers) {
      if (done.has(c)) continue;
      const hook: ConsumerHook | undefined = this.deps.consumerAllowlist[c];
      if (!hook) throw new ConsumerNotAllowlistedError(c);
      await this.deps.consumerReloader.reload(c, hook);
      done.add(c);
      // Persist progress after each reload (fenced) so a crash doesn't repeat.
      this.store.updateJob(
        job.id,
        { consumersDone: [...done] },
        this.now(),
        lease.fence,
      );
    }
    await this.transition(job, "consumers-reloaded", leak, lease, attempt, {});
  }

  /** consumers-reloaded -> verified: probe as the new credential. */
  private async stageVerify(
    job: JobRow,
    leak: LeakGuard,
    lease: LeaseHandle,
    attempt: number,
  ): Promise<void> {
    const ok = await this.deps.connector.verify(this.ctx(job, leak));
    if (!ok) {
      // Fail closed: old credential still valid; go to bounded rollback.
      throw new VerificationFailedError(job.secret);
    }
    await this.transition(job, "verified", leak, lease, attempt, {});
  }

  /** verified -> alias-moved: CAS-guarded alias move (no stale publish). */
  private async stageAliasMove(
    job: JobRow,
    leak: LeakGuard,
    lease: LeaseHandle,
    attempt: number,
  ): Promise<void> {
    if (job.newVersion == null)
      throw new Error("cannot move alias: no staged version");

    // Resume safety: if the alias is ALREADY at our target version, the move
    // committed on a prior (crashed) attempt. Advance -- never re-roll-back a
    // completed publish.
    const currentAlias = await this.deps.store.getVersion(
      job.secret,
      job.alias,
    );
    if (currentAlias && currentAlias.version === job.newVersion) {
      await this.transition(job, "alias-moved", leak, lease, attempt, {});
      return;
    }

    await this.assertAuthorized(job.subject, "move-alias", job.secret);
    await this.deps.store.moveAlias({
      secret: job.secret,
      alias: job.alias,
      toVersion: job.newVersion,
      expectedFromVersion: job.expectedFromVersion,
    });
    await this.transition(job, "alias-moved", leak, lease, attempt, {});
  }

  /**
   * alias-moved -> old-revoked. The alias is PUBLISHED. Any failure here fails
   * closed to reconcile-required -- rollback (credential deletion) is forbidden
   * once the new version may be live. First-issuance has no old credential to
   * revoke, so it advances directly.
   */
  private async stageRevoke(
    job: JobRow,
    leak: LeakGuard,
    lease: LeaseHandle,
    attempt: number,
  ): Promise<void> {
    if (job.firstIssuance || !job.oldProviderRef) {
      await this.transition(job, "old-revoked", leak, lease, attempt, {});
      return;
    }
    let allowed = false;
    try {
      const res = await this.deps.authorize({
        subject: job.subject,
        action: "revoke",
        resource: job.secret,
      });
      allowed = res.allow;
      if (!allowed) {
        // Alias already published; cannot roll back. Reconcile.
        await this.markReconcile(
          job,
          "revoke",
          `unauthorized: ${res.reason ?? "revoke denied"}`,
          leak,
          lease,
        );
        return;
      }
      await this.deps.connector.revoke(this.ctx(job, leak));
    } catch (err) {
      // Sanitize BEFORE it reaches the persisted reconcile detail.
      await this.markReconcile(
        job,
        "revoke",
        this.safeErr(err, leak, "revoke error"),
        leak,
        lease,
      );
      return;
    }
    await this.transition(job, "old-revoked", leak, lease, attempt, {});
  }

  /**
   * failed|rolling-back -> rolled-back. Effect-pending: idempotently (re)runs
   * connector.rollback until it durably completes; a crash mid-rollback resumes
   * rollback (stage stays 'rolling-back'), not 'rolled-back'. Rollback is
   * authorized; denial or failure -> reconcile-required. Rollback is only ever
   * reached on a PRE-PUBLISH failure (alias never moved).
   */
  private async stageRollback(
    job: JobRow,
    leak: LeakGuard,
    lease: LeaseHandle,
    attempt: number,
  ): Promise<void> {
    // Safety net: never rollback if the alias could be at the new version.
    if (job.newVersion != null) {
      const alias = await this.deps.store.getVersion(job.secret, job.alias);
      if (alias && alias.version === job.newVersion) {
        await this.markReconcile(
          job,
          "rollback",
          "refused: alias already at new version",
          leak,
          lease,
        );
        return;
      }
    }

    // Enter (or stay in) rolling-back durably BEFORE running the effect.
    let rb = job;
    if (job.stage === "failed") {
      await this.transition(job, "rolling-back", leak, lease, attempt, {});
      rb = this.store.getJob(job.id)!;
    }

    let allowed = false;
    try {
      const res = await this.deps.authorize({
        subject: rb.subject,
        action: "rollback",
        resource: rb.secret,
      });
      allowed = res.allow;
      if (!allowed) {
        await this.markReconcile(
          rb,
          "rollback",
          `unauthorized: ${res.reason ?? "rollback denied"}`,
          leak,
          lease,
        );
        return;
      }
      await this.deps.connector.rollback(this.ctx(rb, leak));
    } catch (err) {
      // Sanitize ONCE, then use the clean string for every persisted surface.
      const safe = this.safeErr(err, leak, "rollback error");
      // Stay in rolling-back (effect-pending) if retries remain; else reconcile.
      const attempts = this.store.attemptsFor(rb.id, "rolling-back") + 1;
      this.store.appendCheckpoint(
        rb.id,
        "rolling-back",
        "error",
        attempts,
        JSON.stringify({ error: safe }),
        this.now(),
        lease.fence,
      );
      if (attempts < this.maxAttempts) return; // retry rollback on next loop
      await this.markReconcile(rb, "rollback", safe, leak, lease);
      return;
    }
    await this.transition(rb, "rolled-back", leak, lease, attempt, {});
  }

  // -----------------------------------------------------------------------
  // Error handling / reconcile
  // -----------------------------------------------------------------------

  private async onStageError(
    job: JobRow,
    err: unknown,
    leak: LeakGuard,
    lease: LeaseHandle,
    attempt: number,
  ): Promise<void> {
    // Sanitize so a payload-bearing error cannot leak into a checkpoint.
    const msg = leak.sanitizeError(err, `stage ${job.stage} error`).message;
    this.store.appendCheckpoint(
      job.id,
      job.stage,
      "error",
      attempt,
      JSON.stringify(leak.assertClean({ error: msg }, "error checkpoint")),
      this.now(),
      lease.fence,
    );
    await this.emit(job, job.stage, "error", leak, lease, {
      attempt,
      error: msg,
    });

    if (attempt < this.maxAttempts && this.isRetryable(job.stage)) {
      return; // driver re-enters and retries (idempotent effects)
    }

    // A failure AFTER the alias publish must NEVER roll back. Fail closed.
    if (this.isPostPublish(job)) {
      await this.markReconcile(job, job.stage, msg, leak, lease);
      return;
    }
    await this.transition(job, "failed", leak, lease, attempt, { error: msg });
  }

  /** True once the alias could point at the new version (publish committed). */
  private isPostPublish(job: JobRow): boolean {
    return job.stage === "alias-moved" || job.stage === "old-revoked";
  }

  private isRetryable(stage: RotationStage): boolean {
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
    lease: LeaseHandle,
  ): Promise<void> {
    // Defense in depth: sanitize the detail before it reaches ANY persisted or
    // emitted surface (the external reconcile store AND the fenced job row).
    // Callers should already pass a sanitized string, but this is the final
    // chokepoint so a raw payload-bearing message can never land here.
    const safeDetail = leak.sanitizeError(
      detail,
      `reconcile detail (${op})`,
    ).message;
    await this.deps.store.markReconcileRequired({
      op,
      secret: job.secret,
      detail: safeDetail,
    });
    await this.transition(
      job,
      "reconcile-required",
      leak,
      lease,
      this.store.attemptsFor(job.id, job.stage) + 1,
      { error: `${op}: ${safeDetail}` },
    );
  }

  /**
   * Sanitized error string for persistence/emission. Routes the value through
   * the armed LeakGuard: if it embeds registered material it is replaced with a
   * SecretLeakError message (identifiers only), never the payload.
   */
  private safeErr(err: unknown, leak: LeakGuard, where: string): string {
    return leak.sanitizeError(err, where).message;
  }

  // -----------------------------------------------------------------------
  // Transition primitive (durable + fenced + audited + leak-guarded)
  // -----------------------------------------------------------------------

  private async transition(
    job: JobRow,
    to: RotationStage,
    leak: LeakGuard,
    lease: LeaseHandle,
    attempt: number,
    patch: Partial<JobRow>,
  ): Promise<void> {
    if (!canTransition(job.stage, to)) {
      throw new InvalidTransitionError(job.stage, to);
    }
    const now = this.now();
    const merged = { ...patch, stage: to };
    leak.assertClean(merged, `job row transition ${job.stage}->${to}`);
    // Fenced writes: reject if this executor lost the lease.
    this.store.updateJob(job.id, merged, now, lease.fence);
    this.store.appendCheckpoint(
      job.id,
      to,
      "ok",
      attempt,
      null,
      now,
      lease.fence,
    );
    await this.emit({ ...job, ...merged } as JobRow, to, "ok", leak, lease, {});
  }

  private async emit(
    job: JobRow,
    stage: RotationStage,
    outcome: "ok" | "error" | "skip",
    leak: LeakGuard,
    _lease: LeaseHandle,
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

/** Reject non-finite / non-positive / non-integer maxAttempts. */
export function validateMaxAttempts(v: number | undefined): number {
  if (v === undefined) return DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(v) || v < 1 || !Number.isFinite(v)) {
    throw new RangeError(
      `maxAttempts must be a positive integer, got ${String(v)}`,
    );
  }
  return v;
}

export { SecretLeakError };
