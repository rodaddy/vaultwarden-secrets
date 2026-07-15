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

/**
 * Minimal in-memory model of a provider (like Cloudflare) whose tokens are
 * keyed by a deterministic job-scoped NAME. It reproduces the real failure the
 * previous test missed: a crash AFTER the provider mints but BEFORE the engine
 * records the handle leaves an ORPHAN. A resume that blindly re-mints would
 * double-create; the crash-safe connector must detect+clean the orphan so
 * exactly one live token remains.
 */
class FakeProvider {
  private seq = 0;
  readonly live = new Map<string, { name: string }>(); // id -> token
  mintByName(name: string): { id: string; value: string } {
    const id = `tok-${++this.seq}`;
    this.live.set(id, { name });
    return { id, value: `SECRET-${id}-plaintext-abcdef0123456789` };
  }
  deleteOrphansByName(name: string): void {
    for (const [id, t] of [...this.live])
      if (t.name === name) this.live.delete(id);
  }
  countByName(name: string): number {
    return [...this.live.values()].filter((t) => t.name === name).length;
  }
}

/** Connector over FakeProvider that models the crash-safe create contract. */
function providerConnector(
  provider: FakeProvider,
  opts: { crashAfterMint?: boolean } = {},
): Connector {
  return {
    async create(ctx: ConnectorContext): Promise<ConnectorCreateResult> {
      const name = `rotation-${ctx.secret}-${ctx.jobId}`;
      // Crash-safe: clean any orphan from a prior crashed attempt, then mint one.
      provider.deleteOrphansByName(name);
      const tok = provider.mintByName(name);
      const w = await ctx.vault.writeItem(`${name}#${tok.id}`, () => tok.value);
      if (opts.crashAfterMint) {
        // Simulate a process crash AFTER the mint + vault write but BEFORE the
        // engine can persist the provider handle / checkpoint.
        throw new Error("SIMULATED CRASH after mint, before checkpoint");
      }
      return {
        payloadRef: w.payloadRef,
        checksum: w.checksum,
        providerRef: tok.id,
      };
    },
    async verify() {
      return true;
    },
    async revoke() {},
    async rollback() {},
  };
}

describe("crash-resume (two connections, one file db)", () => {
  test("TRUE crash after provider mint (before checkpoint) -> resume leaves exactly one live token", async () => {
    const path = tmpDbPath();
    const shared = newShared();
    const provider = new FakeProvider();
    const name = "rotation-svc-token-job-1";

    // Executor 1: seeds the job, then a single step MINTS at the provider but
    // "crashes" (throws) before the engine records the provider handle. The
    // step's error handling leaves the job at 'requested' with NO provider ref
    // -- exactly the pre-checkpoint crash window. Then the connection dies.
    const db1 = new Database(path);
    const e1 = new RotationEngine(db1, {
      ...depsFor(shared, providerConnector(provider, { crashAfterMint: true })),
      leaseTtlMs: 60_000,
    });
    await e1.startJob(req({ jobId: "job-1" }));
    await e1.step("job-1"); // mints at provider, throws before persisting handle

    // The engine never recorded a provider handle (crash was pre-checkpoint)...
    const stalled = e1.getReceipt("job-1");
    expect(stalled.stage).toBe("requested");
    expect(stalled.newPayloadRef).toBeNull();
    // ...yet the provider has exactly one orphan token from the mint.
    expect(provider.countByName(name)).toBe(1);
    db1.close(); // process is gone

    // Executor 2: fresh connection + fresh executor id, crash-safe connector.
    const db2 = new Database(path);
    const e2 = new RotationEngine(db2, {
      ...depsFor(shared, providerConnector(provider)),
      leaseTtlMs: 60_000,
    });
    const resumed = await e2.resumePending();
    expect(resumed.length).toBe(1);
    expect(resumed[0]!.stage).toBe("done");

    // THE ASSERTION THE OLD TEST MISSED: after resume, exactly ONE live token
    // for this job -- the orphan was cleaned, not double-created.
    expect(provider.countByName(name)).toBe(1);

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
