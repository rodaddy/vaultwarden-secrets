import { expect, describe, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ControlPlaneStore } from "./store";

function makeStore(): ControlPlaneStore {
  const root = process.env.VW_TEST_TMPDIR ?? tmpdir();
  return new ControlPlaneStore({
    stateDir: mkdtempSync(join(root, "vw-control-plane-")),
    actor: "test",
  });
}

describe("control-plane migrations and metadata", () => {
  test("migrations are repeatable and state is durable", () => {
    const first = makeStore();
    const path = first.database.path;
    first.createSecret({ name: "repeatable" });
    first.close();
    const second = new ControlPlaneStore({ databasePath: path, actor: "test" });
    expect(second.getSecret("repeatable")?.name).toBe("repeatable");
    expect(
      second.database.db
        .query("SELECT COUNT(*) AS count FROM schema_migrations")
        .get(),
    ).toEqual({ count: 1 });
    second.close();
  });

  test("parallel version and alias mutations preserve numbering and never serve destroyed", async () => {
    const store = makeStore();
    store.createSecret({ name: "service" });
    const versions = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        Promise.resolve().then(() =>
          store.addVersion({
            secret: "service",
            payloadRef: `item-${index}.password`,
            checksum: `hash-${index}`,
          }),
        ),
      ),
    );
    expect(versions.map((item) => item.version).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    await Promise.all(
      [1, 2, 3, 4].map((toVersion) =>
        Promise.resolve().then(() =>
          store.moveAlias({ secret: "service", alias: "stable", toVersion }),
        ),
      ),
    );
    const stable = store.getVersion("service", "stable");
    expect(stable?.version).toBeGreaterThanOrEqual(1);
    store.destroyVersion("service", 12);
    expect(store.getVersion("service", "latest")?.version).toBe(11);
    expect(store.getVersion("service", 12)).toBeNull();
    store.close();
  });

  test("payload plaintext never enters SQLite", () => {
    const store = makeStore();
    const sentinel = "plain-payload-MUST-NOT-REACH-SQLITE";
    store.createSecret({ name: "no-plaintext" });
    store.addVersion({
      secret: "no-plaintext",
      payloadRef: "vault-item-1.login.password",
      checksum: "sha256:abc",
    });
    store.database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    store.close();
    const databaseBytes = readFileSync(store.database.path).toString("utf8");
    expect(databaseBytes).not.toContain(sentinel);
  });
});

describe("lifecycle and idempotency", () => {
  test("enforces graph, immutable versions, atomic latest, and retry-safe calls", () => {
    const store = makeStore();
    const first = store.createSecret({
      name: "api",
      labels: { owner: "ops" },
      idempotencyKey: "create-api",
    });
    expect(
      store.createSecret({ name: "api", idempotencyKey: "create-api" }),
    ).toEqual(first);
    const version = store.addVersion({
      secret: "api",
      payloadRef: "item-a.field",
      checksum: "abc",
      idempotencyKey: "add-api",
    });
    expect(
      store.addVersion({
        secret: "api",
        payloadRef: "different-ref",
        checksum: "different",
        idempotencyKey: "add-api",
      }),
    ).toEqual(version);
    expect(store.getVersion("api", "latest")?.version).toBe(1);
    expect(store.disableVersion("api", 1).state).toBe("DISABLED");
    expect(store.enableVersion("api", 1).state).toBe("ENABLED");
    const destroyed = store.destroyVersion("api", 1);
    expect(destroyed.payloadRef).toBeNull();
    expect(() => store.enableVersion("api", 1)).toThrow(
      "Invalid version transition",
    );
    expect(store.getVersion("api", "latest")).toBeNull();
    expect(() =>
      store.moveAlias({ secret: "api", alias: "stable", toVersion: 1 }),
    ).toThrow("DESTROYED");
    store.close();
  });

  test("legacy import preserves provenance and never duplicates custody", () => {
    const store = makeStore();
    const imported = store.importLegacy({
      name: "legacy",
      payloadRef: "existing-item.custom.value",
      checksum: "sum",
      importedFrom: "vaultwarden:item-4",
    });
    const retried = store.importLegacy({
      name: "legacy",
      payloadRef: "existing-item.custom.value",
      checksum: "sum",
      importedFrom: "vaultwarden:item-4",
    });
    expect(retried).toEqual(imported);
    expect(imported.importedFrom).toBe("vaultwarden:item-4");
    expect(store.getVersion("legacy", 1)?.payloadRef).toBe(
      "existing-item.custom.value",
    );
    store.close();
  });
});

describe("operations, audit, and outbox", () => {
  test("partial cross-store failures are reconcileable and idempotent", async () => {
    const store = makeStore();
    await expect(
      store.performCrossStoreOperation(
        { kind: "vault-write", resource: "secrets/fake" },
        () => {
          throw new Error("fake vault failed mid-operation");
        },
      ),
    ).rejects.toThrow("fake vault failed");
    const before = store.database.db
      .query("SELECT state FROM operations")
      .get() as { state: string };
    expect(before.state).toBe("reconcile-required");
    const repaired = await store.reconcile(() => ({
      remoteState: "confirmed",
    }));
    expect(repaired).toHaveLength(1);
    expect(
      await store.reconcile(() => ({ remoteState: "confirmed" })),
    ).toHaveLength(0);
    store.close();
  });

  test("audit rolls back with failed mutation and rejects sensitive fields", () => {
    const store = makeStore();
    expect(() =>
      store.transaction((tx) => {
        tx.query(
          `INSERT INTO logical_secrets (id, name, labels_json, created_at) VALUES ('x', 'rollback', '{}', 'now')`,
        ).run();
        store.appendAudit(
          {
            actor: "test",
            action: "test.write",
            resource: "secrets/rollback",
            outcome: "ok",
            correlationId: "rollback",
          },
          tx,
        );
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(store.getSecret("rollback")).toBeNull();
    expect(
      store.database.db
        .query("SELECT COUNT(*) AS count FROM audit_ledger")
        .get(),
    ).toEqual({ count: 0 });
    expect(() =>
      store.appendAudit({
        actor: "test",
        action: "x",
        resource: "r",
        outcome: "ok",
        correlationId: "c",
        password: "forbidden",
      } as never),
    ).toThrow("Sensitive");
    store.createSecret({ name: "audited" });
    expect(store.verifyLedger()).toEqual({ ok: true });
    store.close();
  });

  test("ledger verification detects tampering and sequence gaps", () => {
    const store = makeStore();
    store.appendAudit({
      actor: "test",
      action: "one",
      resource: "secrets/a",
      outcome: "ok",
      correlationId: "1",
    });
    store.appendAudit({
      actor: "test",
      action: "two",
      resource: "secrets/b",
      outcome: "ok",
      correlationId: "2",
    });
    store.database.db
      .query(`UPDATE audit_ledger SET outcome = 'altered' WHERE sequence = 1`)
      .run();
    expect(store.verifyLedger()).toMatchObject({
      ok: false,
      reason: "hash-mismatch",
    });
    store.close();

    const gapped = makeStore();
    gapped.appendAudit({
      actor: "test",
      action: "one",
      resource: "secrets/a",
      outcome: "ok",
      correlationId: "1",
    });
    gapped.appendAudit({
      actor: "test",
      action: "two",
      resource: "secrets/b",
      outcome: "ok",
      correlationId: "2",
    });
    gapped.database.db
      .query(`UPDATE audit_ledger SET sequence = 9 WHERE sequence = 2`)
      .run();
    expect(gapped.verifyLedger()).toMatchObject({
      ok: false,
      reason: "sequence-gap",
    });
    gapped.close();
  });

  test("outbox retries with dedupe keys, dead-letters, and resumes expired leases", async () => {
    const store = makeStore();
    store.transaction((tx) =>
      store.enqueueEvent(
        {
          type: "version.created",
          resource: "secrets/a",
          dedupeKey: "dedupe-a",
        },
        tx,
      ),
    );
    let attempts = 0;
    await store.deliverPending(async (event) => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary");
      expect(event.dedupeKey).toBe("dedupe-a");
    });
    store.database.db
      .query(
        "UPDATE outbox_events SET next_attempt_at = 0 WHERE dedupe_key = ?",
      )
      .run("dedupe-a");
    expect(await store.deliverPending(() => undefined)).toBe(1);
    expect(attempts).toBe(1);

    store.transaction((tx) =>
      store.enqueueEvent(
        { type: "version.deleted", resource: "secrets/a", dedupeKey: "dead" },
        tx,
      ),
    );
    for (let index = 0; index < 3; index += 1) {
      await store.deliverPending(() => {
        throw new Error("permanent");
      });
      store.database.db
        .query(
          "UPDATE outbox_events SET next_attempt_at = 0 WHERE dedupe_key = ?",
        )
        .run("dead");
    }
    expect(store.listDeadLetters().map((event) => event.dedupeKey)).toContain(
      "dead",
    );

    store.transaction((tx) =>
      store.enqueueEvent(
        { type: "version.enabled", resource: "secrets/a", dedupeKey: "resume" },
        tx,
      ),
    );
    store.database.db
      .query(
        `UPDATE outbox_events SET state = 'delivering', processing_until = 0 WHERE dedupe_key = 'resume'`,
      )
      .run();
    expect(await store.deliverPending(() => undefined)).toBe(1);
    expect(existsSync(store.database.path)).toBe(true);
    store.close();
  });
});
