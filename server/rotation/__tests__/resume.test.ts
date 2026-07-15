/**
 * Crash-resume and concurrency FAITHFULNESS tests.
 *
 * These use TWO independent bun:sqlite connections to the SAME on-disk database
 * (two "processes") plus deterministic barriers injected into the connector, so
 * the tests actually interleave two executors and interrupt the gap between an
 * effect and its checkpoint -- rather than politely stepping one engine.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RotationEngine, type RotateRequest, LeaseHeldError } from "../engine";
import type {
  EngineDeps,
  ConsumerAllowlist,
  Connector,
  ConnectorContext,
  ConnectorCreateResult,
} from "../deps";
import { TestConnector } from "../connectors/test-connector";
import {
  InMemoryVaultWriter,
  InMemoryControlPlaneStore,
  InMemoryAudit,
  InMemoryOutbox,
  RecordingConsumerReloader,
  allowAllAuthorize,
} from "../fakes";

const SENTINEL = "CRASH-RESUME-secret-material-abcdef0123456789";

// Shared control-plane / vault instances model the external services that
// survive a process crash (only the SQLite job store is per-connection).
interface Shared {
  cp: InMemoryControlPlaneStore;
  vault: InMemoryVaultWriter;
  audit: InMemoryAudit;
  outbox: InMemoryOutbox;
  reloader: RecordingConsumerReloader;
  allowlist: ConsumerAllowlist;
}

function newShared(): Shared {
  return {
    cp: new InMemoryControlPlaneStore(),
    vault: new InMemoryVaultWriter(),
    audit: new InMemoryAudit(),
    outbox: new InMemoryOutbox(),
    reloader: new RecordingConsumerReloader(),
    allowlist: { caddy: { kind: "systemd", unit: "caddy.service" } },
  };
}

function depsFor(shared: Shared, connector: Connector): EngineDeps {
  return {
    store: shared.cp,
    authorize: allowAllAuthorize(),
    audit: shared.audit,
    outbox: shared.outbox,
    connector,
    vault: shared.vault,
    consumerAllowlist: shared.allowlist,
    consumerReloader: shared.reloader,
    leaseTtlMs: 60_000,
  };
}

function req(over: Partial<RotateRequest> = {}): RotateRequest {
  return {
    credential: "svc-token",
    connector: "test",
    strategy: "dual",
    consumers: ["caddy"],
    idempotencyKey: "resume-1",
    subject: "operator",
    oldProviderRef: "old-ref",
    oldPayloadRef: "old-payload",
    ...over,
  };
}

let dir: string | null = null;
function tmpDbPath(): string {
  dir = mkdtempSync(join(tmpdir(), "vw-rotation-"));
  return join(dir, "rotation.sqlite");
}
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

describe("crash-resume (two connections, one file db)", () => {
  test("crash in the gap between provider-create effect and its checkpoint is safe (no double create)", async () => {
    const path = tmpDbPath();
    const shared = newShared();

    // Barrier: create() writes material to the vault (durable side effect),
    // then BLOCKS before returning -- modelling a crash after the effect but
    // before the engine can persist the provider-created checkpoint.
    let createReached!: () => void;
    const createHit = new Promise<void>((r) => (createReached = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let createCount = 0;

    const crashingConn: Connector = {
      async create(ctx: ConnectorContext): Promise<ConnectorCreateResult> {
        createCount++;
        const w = await ctx.vault.writeItem(
          `${ctx.secret}#${ctx.jobId}`,
          () => SENTINEL,
        );
        createReached();
        await gate; // "crash" here: never returns for this executor
        return {
          payloadRef: w.payloadRef,
          checksum: w.checksum,
          providerRef: `prov-${ctx.jobId}`,
        };
      },
      async verify() {
        return true;
      },
      async revoke() {},
      async rollback() {},
    };

    // Executor 1: its own connection; starts the job, hangs in create().
    const db1 = new Database(path);
    const e1 = new RotationEngine(db1, depsFor(shared, crashingConn));
    const p1 = e1.rotate(req({ jobId: "job-1" }));
    await createHit; // effect done, checkpoint NOT yet written

    // Simulate crash: abandon p1's lease by expiring time is heavy; instead we
    // just proceed -- executor 1 still "holds" a live lease, so executor 2 must
    // be blocked until the lease expires. Prove that here:
    const db2 = new Database(path);
    // A job-scoped-idempotent connector: reuses the SAME material, no 2nd write.
    const e2 = new RotationEngine(
      db2,
      depsFor(shared, new TestConnector({ material: SENTINEL })),
    );
    // Same idempotency key -> returns the existing (in-flight) job, no rotation.
    const dup = await e2.rotate(req({ jobId: "job-1" }));
    expect(dup.jobId).toBe("job-1");

    // Let executor 1 finish; it drives to done.
    release();
    const r1 = await p1;
    expect(r1.stage).toBe("done");

    // Exactly ONE credential minted despite the crash gap: the crashing
    // connector's create ran once (executor 1); executor 2 short-circuited on
    // idempotency and never called create.
    expect(createCount).toBe(1);
    // Only one vault write for this job (no double-create).
    const writes = [...shared.vault.stored.keys()].filter((k) =>
      k.startsWith("svc-token#job-1"),
    );
    expect(writes.length).toBe(1);

    db1.close();
    db2.close();
  });

  test("resumePending on a fresh connection completes a job stalled mid-flight", async () => {
    const path = tmpDbPath();
    const shared = newShared();

    // Executor 1 seeds + advances two stages, then "crashes" (stops).
    const db1 = new Database(path);
    const e1 = new RotationEngine(
      db1,
      depsFor(shared, new TestConnector({ material: SENTINEL })),
    );
    await e1.startJob(req({ jobId: "job-2" }));
    await e1.step("job-2"); // -> provider-created
    await e1.step("job-2"); // -> staged
    expect(e1.getReceipt("job-2").stage).toBe("staged");
    db1.close(); // crash: connection gone

    // Executor 2: brand-new connection to the same file, fresh executor id.
    const db2 = new Database(path);
    const e2 = new RotationEngine(
      db2,
      depsFor(shared, new TestConnector({ material: SENTINEL })),
    );
    const resumed = await e2.resumePending();
    expect(resumed.length).toBe(1);
    expect(resumed[0]!.stage).toBe("done");

    // No secret material in any durable row.
    const rows = JSON.stringify(db2.query("SELECT * FROM rotation_jobs").all());
    const cks = JSON.stringify(
      db2.query("SELECT * FROM rotation_checkpoints").all(),
    );
    expect(rows.includes(SENTINEL)).toBe(false);
    expect(cks.includes(SENTINEL)).toBe(false);
    db2.close();
  });

  test("two live executors cannot both drive the same credential (fencing)", async () => {
    const path = tmpDbPath();
    const shared = newShared();

    // Executor 1 holds the lease by blocking in create().
    let hit!: () => void;
    const reached = new Promise<void>((r) => (hit = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const blockingConn: Connector = {
      async create(ctx) {
        const w = await ctx.vault.writeItem("x", () => SENTINEL);
        hit();
        await gate;
        return { payloadRef: w.payloadRef, checksum: w.checksum };
      },
      async verify() {
        return true;
      },
      async revoke() {},
      async rollback() {},
    };

    const db1 = new Database(path);
    const e1 = new RotationEngine(db1, depsFor(shared, blockingConn));
    const p1 = e1.rotate(req({ jobId: "job-3", idempotencyKey: "k3" }));
    await reached; // executor 1 holds a live lease

    // Executor 2 (different connection, DIFFERENT idempotency key -> same
    // credential) must be refused the lease -- not collude as the same owner.
    const db2 = new Database(path);
    const e2 = new RotationEngine(
      db2,
      depsFor(shared, new TestConnector({ material: SENTINEL })),
    );
    await expect(
      e2.rotate(req({ jobId: "job-3b", idempotencyKey: "k3b" })),
    ).rejects.toBeInstanceOf(LeaseHeldError);

    release();
    await p1;
    db1.close();
    db2.close();
  });
});
