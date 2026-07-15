/**
 * server/rotation/connectors/test-connector.ts
 *
 * Deterministic in-memory connector for offline tests. It generates a fake
 * "secret" internally, writes it through the injected (arming) VaultWriter (so
 * the engine only ever sees refs/checksums), and lets each phase be scripted to
 * fail for failure-injection tests.
 *
 * create() is JOB-SCOPED IDEMPOTENT: called twice for the same jobId it returns
 * the same providerRef/payloadRef and does not double-write, modelling a
 * crash-safe provider that reuses the existing credential.
 *
 * The generated material is exposed via `lastGenerated` ONLY so a test can arm
 * the leak guard / assert the sentinel never surfaces in persisted state. The
 * engine itself never reads it.
 */

import type {
  Connector,
  ConnectorContext,
  ConnectorCreateResult,
} from "../deps";

export interface TestConnectorOptions {
  /** Deterministic material to "generate" (the sentinel). */
  material?: string;
  /** Force verify() to return this. Default true. */
  verifyResult?: boolean;
  /** Throw on the named phase to inject failure. */
  failOn?: "create" | "verify" | "revoke" | "rollback";
  /** Fail `failOn` only for the first N calls, then succeed (retry tests). */
  failTimes?: number;
  /**
   * When set, the injected failure error MESSAGE embeds this string. Used to
   * prove the leak guard sanitizes payload-bearing errors (pass the sentinel).
   */
  failWith?: string;
}

export class TestConnector implements Connector {
  readonly calls: Record<string, number> = {
    create: 0,
    verify: 0,
    revoke: 0,
    rollback: 0,
  };
  lastGenerated: string | null = null;
  revoked = false;
  rolledBack = false;

  private material: string;
  private verifyResult: boolean;
  private failOn?: string;
  private failTimes: number;
  private failWith?: string;
  /** jobId -> prior create result (job-scoped idempotency). */
  private created = new Map<string, ConnectorCreateResult>();

  constructor(opts: TestConnectorOptions = {}) {
    this.material =
      opts.material ?? "TEST-SECRET-MATERIAL-do-not-leak-0123456789";
    this.verifyResult = opts.verifyResult ?? true;
    this.failOn = opts.failOn;
    this.failTimes = opts.failTimes ?? Number.MAX_SAFE_INTEGER;
    this.failWith = opts.failWith;
  }

  private maybeFail(phase: string): void {
    if (this.failOn === phase && this.calls[phase]! <= this.failTimes) {
      const suffix = this.failWith ? ` [${this.failWith}]` : "";
      throw new Error(`injected ${phase} failure${suffix}`);
    }
  }

  async create(ctx: ConnectorContext): Promise<ConnectorCreateResult> {
    this.calls.create!++;
    this.maybeFail("create");
    // Job-scoped idempotency: reuse the prior result for the same job.
    const prior = this.created.get(ctx.jobId);
    if (prior) return prior;
    this.lastGenerated = this.material;
    // Material crosses ONLY into the (arming) vault writer, never to the engine.
    const written = await ctx.vault.writeItem(
      `${ctx.secret}#${ctx.jobId}`,
      () => this.material,
    );
    const result: ConnectorCreateResult = {
      payloadRef: written.payloadRef,
      checksum: written.checksum,
      providerRef: `prov-${ctx.jobId}`,
    };
    this.created.set(ctx.jobId, result);
    return result;
  }

  async verify(ctx: ConnectorContext): Promise<boolean> {
    this.calls.verify!++;
    void ctx;
    this.maybeFail("verify");
    return this.verifyResult;
  }

  async revoke(ctx: ConnectorContext): Promise<void> {
    this.calls.revoke!++;
    void ctx;
    this.maybeFail("revoke");
    this.revoked = true;
  }

  async rollback(ctx: ConnectorContext): Promise<void> {
    this.calls.rollback!++;
    void ctx;
    this.maybeFail("rollback");
    this.rolledBack = true;
  }
}
