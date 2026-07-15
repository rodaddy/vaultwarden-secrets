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
  VaultWriteResult,
} from "../deps";
import { TestConnector } from "../connectors/test-connector";
import { CloudflareConnector } from "../connectors/cloudflare";
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
 * Fetch-backed model of the REAL Cloudflare token API, so the crash-safe test
 * drives the ACTUAL CloudflareConnector.create() code (LIST -> delete-orphan ->
 * mint) on resume, not any test-owned cleanup. Tokens are keyed by their name.
 */
class CfProviderApi {
  private seq = 0;
  readonly tokens = new Map<string, { name: string; status: string }>();
  countByName(name: string): number {
    return [...this.tokens.values()].filter((t) => t.name === name).length;
  }
  /** A fetch impl matching cloudflare.ts's calls against this in-memory state. */
  fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const env = (result: unknown) => ({
      ok: true,
      json: async () => ({ result, success: true, errors: [], messages: [] }),
    });
    // LIST tokens (orphan scan)
    if (u.endsWith("/user/tokens") && method === "GET") {
      return env(
        [...this.tokens].map(([id, t]) => ({
          id,
          name: t.name,
          status: t.status,
        })),
      ) as unknown as Response;
    }
    // MINT token
    if (u.endsWith("/user/tokens") && method === "POST") {
      const body = JSON.parse(String(init!.body)) as { name: string };
      const id = `tok-${++this.seq}`;
      this.tokens.set(id, { name: body.name, status: "active" });
      return env({
        id,
        name: body.name,
        status: "active",
        value: `SECRET-${id}-plaintext-abcdef0123456789`,
      }) as unknown as Response;
    }
    // DELETE token (orphan cleanup / revoke / rollback)
    const del = u.match(/\/user\/tokens\/([^/]+)$/);
    if (del && method === "DELETE") {
      this.tokens.delete(del[1]!);
      return env({ id: del[1] }) as unknown as Response;
    }
    // verify probe (GET /user/tokens/verify as the new bearer)
    if (u.endsWith("/user/tokens/verify") && method === "GET") {
      return env({ id: "probe", status: "active" }) as unknown as Response;
    }
    throw new Error(`unexpected cf call ${method} ${u}`);
  }) as unknown as typeof fetch;
}

/** A VaultWriter that stores material, then throws -- models a process crash
 * AFTER the provider mint + vault write but BEFORE the engine's handle
 * checkpoint. */
class CrashAfterStoreVault extends InMemoryVaultWriter {
  async writeItem(
    ref: string,
    gen: () => string | Promise<string>,
  ): Promise<VaultWriteResult> {
    await super.writeItem(ref, gen); // material + provider mint persisted
    throw new Error(
      "SIMULATED CRASH after vault write, before handle checkpoint",
    );
  }
}

describe("crash-resume (real CloudflareConnector, two connections, one file db)", () => {
  test("TRUE crash after Cloudflare mint (before handle checkpoint) -> real resume adopts/cleans, exactly ONE token", async () => {
    const path = tmpDbPath();
    const provider = new CfProviderApi();
    const name = "rotation-cf-dns-job-cf1";

    // Executor 1 uses the REAL CloudflareConnector. Its create() mints a token
    // at the provider (orphan) and writes to the vault, but the vault write
    // throws -> the engine never reaches the handle checkpoint. Job stays at
    // 'requested' with no provider ref. Exactly the pre-checkpoint crash.
    const crashVault = new CrashAfterStoreVault();
    const cp1 = new InMemoryControlPlaneStore();
    const conn1 = new CloudflareConnector({
      apiToken: "mgmt",
      fetchImpl: provider.fetch,
      vaultReader: crashVault,
    });
    const db1 = new Database(path);
    const e1 = new RotationEngine(db1, {
      store: cp1,
      authorize: allowAllAuthorize(),
      audit: new InMemoryAudit(),
      outbox: new InMemoryOutbox(),
      connector: conn1,
      vault: crashVault,
      consumerAllowlist: { caddy: { kind: "systemd", unit: "caddy.service" } },
      consumerReloader: new RecordingConsumerReloader(),
      leaseTtlMs: 60_000,
      // default maxAttempts: a single step() records one crashed attempt and
      // leaves the job resumable at 'requested' (no provider handle recorded).
    });
    await e1.startJob({
      credential: "cf-dns",
      connector: "cloudflare",
      strategy: "dual",
      consumers: ["caddy"],
      idempotencyKey: "cf-key",
      subject: "op",
      jobId: "job-cf1",
    });
    await e1.step("job-cf1"); // real CF mint + vault write that throws

    const stalled = e1.getReceipt("job-cf1");
    expect(stalled.stage).toBe("requested"); // never recorded a handle
    // No provider handle / refs were persisted (crash before the checkpoint).
    expect(stalled.newPayloadRef).toBeNull();
    expect(stalled.newChecksum).toBeNull();
    // The provider now holds exactly one ORPHAN token from the crashed mint.
    expect(provider.countByName(name)).toBe(1);
    db1.close(); // process gone

    // Executor 2: fresh connection, SAME control plane + provider, a REAL
    // CloudflareConnector with a working vault. resumePending() drives the REAL
    // connector.create() whose LIST->delete-orphan->mint runs in PRODUCTION
    // code -- no test-owned cleanup.
    const goodVault = new InMemoryVaultWriter();
    const conn2 = new CloudflareConnector({
      apiToken: "mgmt",
      fetchImpl: provider.fetch,
      vaultReader: goodVault,
    });
    const db2 = new Database(path);
    const e2 = new RotationEngine(db2, {
      store: cp1, // same control plane survives the crash
      authorize: allowAllAuthorize(),
      audit: new InMemoryAudit(),
      outbox: new InMemoryOutbox(),
      connector: conn2,
      vault: goodVault,
      consumerAllowlist: { caddy: { kind: "systemd", unit: "caddy.service" } },
      consumerReloader: new RecordingConsumerReloader(),
      leaseTtlMs: 60_000,
    });
    const resumed = await e2.resumePending();
    expect(resumed.length).toBe(1);
    expect(resumed[0]!.stage).toBe("done");

    // THE ASSERTION THE OLD TEST MISSED, now against PRODUCTION behavior: after
    // the real resume, exactly ONE live token for this job -- the orphan minted
    // by the crashed attempt was detected + deleted by CloudflareConnector,
    // then one fresh token minted. Not two.
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
