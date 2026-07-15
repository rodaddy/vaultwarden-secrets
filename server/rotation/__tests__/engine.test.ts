import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { RotationEngine, type RotateRequest, LeaseHeldError } from "../engine";
import type { EngineDeps, ConsumerAllowlist } from "../deps";
import { TestConnector } from "../connectors/test-connector";
import {
  InMemoryVaultWriter,
  InMemoryControlPlaneStore,
  InMemoryAudit,
  InMemoryOutbox,
  RecordingConsumerReloader,
  allowAllAuthorize,
  denyAuthorize,
} from "../fakes";
import { RotationStore } from "../store-sqlite";

const SENTINEL = "SUPER-SECRET-cf-token-value-abcdef0123456789-DO-NOT-LEAK";

interface Harness {
  db: Database;
  deps: EngineDeps;
  connector: TestConnector;
  vault: InMemoryVaultWriter;
  store: InMemoryControlPlaneStore;
  audit: InMemoryAudit;
  outbox: InMemoryOutbox;
  reloader: RecordingConsumerReloader;
  engine: RotationEngine;
}

function makeHarness(
  overrides: Partial<EngineDeps> = {},
  connOpts = {},
): Harness {
  const db = new Database(":memory:");
  const connector = new TestConnector({ material: SENTINEL, ...connOpts });
  const vault = new InMemoryVaultWriter();
  const store = new InMemoryControlPlaneStore();
  const audit = new InMemoryAudit();
  const outbox = new InMemoryOutbox();
  const reloader = new RecordingConsumerReloader();
  const consumerAllowlist: ConsumerAllowlist = {
    caddy: { kind: "systemd", unit: "caddy.service" },
    certbot: { kind: "command", command: ["/usr/bin/certbot", "renew"] },
  };
  const deps: EngineDeps = {
    store,
    authorize: allowAllAuthorize(),
    audit,
    outbox,
    connector,
    vault,
    consumerAllowlist,
    consumerReloader: reloader,
    maxAttempts: 3,
    leaseTtlMs: 60_000,
    ...overrides,
  };
  const engine = new RotationEngine(db, deps);
  return { db, deps, connector, vault, store, audit, outbox, reloader, engine };
}

function req(over: Partial<RotateRequest> = {}): RotateRequest {
  return {
    credential: "Cloudflare - DNS API",
    connector: "test",
    strategy: "dual",
    consumers: ["caddy", "certbot"],
    idempotencyKey: "req-1",
    subject: "operator",
    ...over,
  };
}

/** Assert the sentinel never appears in ANY persisted/emitted surface. */
function assertNoLeak(h: Harness): void {
  const rawStore = new RotationStore(h.db);
  // job rows
  const jobs = rawStore.listPending();
  // include terminal jobs too: query all
  const allJobs = h.db.query("SELECT * FROM rotation_jobs").all();
  const checkpoints = h.db.query("SELECT * FROM rotation_checkpoints").all();
  const leases = h.db.query("SELECT * FROM rotation_leases").all();
  const surfaces = JSON.stringify({
    jobs,
    allJobs,
    checkpoints,
    leases,
    audit: h.audit.entries,
    outbox: h.outbox.events,
  });
  expect(surfaces.includes(SENTINEL)).toBe(false);
  // The material MUST live in the vault though (proves it went somewhere real).
  const inVault = [...h.vault.stored.values()].some((v) => v === SENTINEL);
  expect(inVault).toBe(true);
}

describe("RotationEngine happy path", () => {
  test("drives all stages to done", async () => {
    const h = makeHarness();
    const receipt = await h.engine.rotate(req());
    expect(receipt.stage).toBe("done");
    const stages = receipt.checkpoints
      .filter((c) => c.status === "ok")
      .map((c) => c.stage);
    expect(stages).toContain("provider-created");
    expect(stages).toContain("staged");
    expect(stages).toContain("consumers-reloaded");
    expect(stages).toContain("verified");
    expect(stages).toContain("alias-moved");
    expect(stages).toContain("old-revoked");
    expect(stages).toContain("done");
    // old credential revoked only after verify
    expect(h.connector.revoked).toBe(true);
    expect(h.connector.calls.verify).toBeGreaterThan(0);
    // consumers reloaded via allowlist hooks
    expect(h.reloader.reloads.map((r) => r.consumer).sort()).toEqual([
      "caddy",
      "certbot",
    ]);
    // alias points at the new version
    expect(h.store.aliasVersion("Cloudflare - DNS API", "current")).toBe(1);
    // audit + outbox recorded progress
    expect(h.audit.entries.length).toBeGreaterThan(0);
    expect(h.outbox.events.some((e) => e.type === "rotation.done.ok")).toBe(
      true,
    );
    assertNoLeak(h);
  });
});

describe("no-secret-leak guard", () => {
  test("sentinel never appears in persisted state after full rotation", async () => {
    const h = makeHarness();
    await h.engine.rotate(req());
    assertNoLeak(h);
  });
});

describe("idempotency", () => {
  test("duplicate idempotency key returns existing job, no second rotation", async () => {
    const h = makeHarness();
    const r1 = await h.engine.rotate(req({ idempotencyKey: "dup" }));
    const createCalls = h.connector.calls.create;
    const r2 = await h.engine.rotate(req({ idempotencyKey: "dup" }));
    expect(r2.jobId).toBe(r1.jobId);
    // no additional create call
    expect(h.connector.calls.create).toBe(createCalls);
    // only one version created
    expect(h.store.aliasVersion("Cloudflare - DNS API", "current")).toBe(1);
  });
});

describe("lease contention", () => {
  test("second engine cannot rotate same credential while lease held", async () => {
    const db = new Database(":memory:");
    // Two engines sharing one db, one credential.
    const shared = {
      store: new InMemoryControlPlaneStore(),
      audit: new InMemoryAudit(),
      outbox: new InMemoryOutbox(),
      vault: new InMemoryVaultWriter(),
      reloader: new RecordingConsumerReloader(),
      allowlist: {
        caddy: { kind: "systemd", unit: "caddy.service" },
      } as ConsumerAllowlist,
    };
    // Connector A blocks in create so the lease stays held.
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const connA: any = {
      calls: { create: 0 },
      async create(ctx: any) {
        await gate;
        const w = await ctx.vault.writeItem("x", () => SENTINEL);
        return { payloadRef: w.payloadRef, checksum: w.checksum };
      },
      async verify() {
        return true;
      },
      async revoke() {},
      async rollback() {},
    };
    const mk = (conn: any) =>
      new RotationEngine(db, {
        store: shared.store,
        authorize: allowAllAuthorize(),
        audit: shared.audit,
        outbox: shared.outbox,
        connector: conn,
        vault: shared.vault,
        consumerAllowlist: shared.allowlist,
        consumerReloader: shared.reloader,
      });
    const engineA = mk(connA);
    const engineB = mk(new TestConnector({ material: SENTINEL }));

    const pA = engineA.rotate(
      req({ consumers: ["caddy"], idempotencyKey: "A" }),
    );
    // Give A a tick to insert job + hold lease.
    await new Promise((r) => setTimeout(r, 10));
    await expect(
      engineB.rotate(req({ consumers: ["caddy"], idempotencyKey: "B" })),
    ).rejects.toBeInstanceOf(LeaseHeldError);
    release();
    await pA;
  });
});

describe("verify-fail -> rollback with old credential intact", () => {
  test("failed verification rolls back and never revokes old credential", async () => {
    const h = makeHarness({}, { verifyResult: false });
    const receipt = await h.engine.rotate(req());
    expect(receipt.stage).toBe("rolled-back");
    // old credential NOT revoked
    expect(h.connector.revoked).toBe(false);
    // rollback ran
    expect(h.connector.rolledBack).toBe(true);
    // alias never moved to the new version
    expect(h.store.aliasVersion("Cloudflare - DNS API", "current")).toBe(null);
    assertNoLeak(h);
  });
});

describe("transport failure mid-stage -> reconcile-required", () => {
  test("revoke failure after committed alias enters reconcile-required", async () => {
    const h = makeHarness({}, { failOn: "revoke" });
    const receipt = await h.engine.rotate(req());
    expect(receipt.stage).toBe("reconcile-required");
    // alias WAS committed before the revoke failure
    expect(h.store.aliasVersion("Cloudflare - DNS API", "current")).toBe(1);
    // reconcile op recorded
    expect(h.store.reconcile.some((o) => o.op === "revoke")).toBe(true);
    assertNoLeak(h);
  });

  test("rollback failure after failed verify enters reconcile-required", async () => {
    const h = makeHarness({}, { verifyResult: false, failOn: "rollback" });
    const receipt = await h.engine.rotate(req());
    expect(receipt.stage).toBe("reconcile-required");
    expect(h.store.reconcile.some((o) => o.op === "rollback")).toBe(true);
  });
});

describe("bounded retries", () => {
  test("retries a transient create failure then succeeds", async () => {
    // fail create once, then succeed
    const h = makeHarness({}, { failOn: "create", failTimes: 1 });
    const receipt = await h.engine.rotate(req());
    expect(receipt.stage).toBe("done");
    // at least 2 create attempts
    expect(h.connector.calls.create).toBeGreaterThanOrEqual(2);
    const errCk = receipt.checkpoints.filter(
      (c) => c.stage === "provider-created",
    );
    expect(errCk.length).toBeGreaterThanOrEqual(1);
  });

  test("exhausted retries fail then roll back", async () => {
    // fail create forever -> exhaust maxAttempts -> failed -> rolled-back
    const h = makeHarness(
      { maxAttempts: 2 },
      { failOn: "create", failTimes: 99 },
    );
    const receipt = await h.engine.rotate(req());
    expect(receipt.stage).toBe("rolled-back");
    expect(h.connector.calls.create).toBe(2);
  });
});

describe("authorization fail-closed", () => {
  test("rotate denied fails before any provider call", async () => {
    const h = makeHarness({ authorize: denyAuthorize(["rotate"]) });
    await expect(h.engine.rotate(req())).rejects.toThrow(/unauthorized/);
    expect(h.connector.calls.create).toBe(0);
  });

  test("move-alias denied leaves old credential intact", async () => {
    const h = makeHarness({ authorize: denyAuthorize(["move-alias"]) });
    const receipt = await h.engine.rotate(req());
    // denied alias move -> failed -> rolled-back, old cred not revoked
    expect(["rolled-back", "reconcile-required"]).toContain(receipt.stage);
    expect(h.connector.revoked).toBe(false);
    expect(h.store.aliasVersion("Cloudflare - DNS API", "current")).toBe(null);
  });
});

describe("consumer allowlist", () => {
  test("non-allowlisted consumer is rejected before rotation", async () => {
    const h = makeHarness();
    await expect(
      h.engine.rotate(req({ consumers: ["caddy", "evil-arbitrary-cmd"] })),
    ).rejects.toThrow(/not allowlisted/);
    expect(h.connector.calls.create).toBe(0);
  });
});
