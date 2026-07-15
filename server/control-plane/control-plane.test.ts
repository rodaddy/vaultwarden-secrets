import { expect, describe, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ControlPlaneStore } from "./store";

const SECRET_SHAPED_FIXTURE = ["sk", "live", "0123456789abcdefghijklmnop"].join(
  "_",
);

function makeStore(): ControlPlaneStore {
  const root = process.env.VW_TEST_TMPDIR ?? tmpdir();
  return new ControlPlaneStore({
    stateDir: mkdtempSync(join(root, "vw-control-plane-")),
    actor: "test",
  });
}

function makeStoreAt(databasePath: string): ControlPlaneStore {
  return new ControlPlaneStore({ databasePath, actor: "test" });
}

async function runConcurrentStoreAction(
  databasePath: string,
  action: string,
): Promise<{ exitCode: number; stderr: string }> {
  const storeModule = new URL("./store.ts", import.meta.url).href;
  const script = `
    import { ControlPlaneStore } from ${JSON.stringify(storeModule)};
    const store = new ControlPlaneStore({ databasePath: process.env.CONTROL_PLANE_TEST_DB, actor: "concurrent" });
    try {
      ${action}
      store.close();
    } catch (error) {
      store.close();
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    env: { ...process.env, CONTROL_PLANE_TEST_DB: databasePath },
    stderr: "pipe",
  });
  return {
    exitCode: await child.exited,
    stderr: await new Response(child.stderr).text(),
  };
}

describe("control-plane migrations and metadata", () => {
  test("re-runs migrations against populated schema without duplicate data", () => {
    const first = makeStore();
    const path = first.database.path;
    first.createSecret({ name: "repeatable" });
    first.addVersion({
      secret: "repeatable",
      payloadRef: "repeatable.password",
      checksum: "sha256:repeatable",
    });
    first.close();
    const second = new ControlPlaneStore({ databasePath: path, actor: "test" });
    expect(second.getSecret("repeatable")?.name).toBe("repeatable");
    // This slice owns migrations 001 and 002; sibling slices may add their own
    // (e.g. 100_authz). Assert our migrations are applied exactly once rather
    // than pinning a global count that legitimately grows across slices.
    expect(
      second.database.db
        .query(
          "SELECT COUNT(*) AS count FROM schema_migrations WHERE name IN ('001_control_plane.sql', '002_ledger_head_and_outbox_dedupe.sql')",
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(
      second.database.db
        .query("SELECT COUNT(*) AS count FROM logical_secrets")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      second.database.db
        .query("SELECT COUNT(*) AS count FROM secret_versions")
        .get(),
    ).toEqual({ count: 1 });
    second.close();
  });

  test("upgrades a populated v1 outbox without restoring dedupe uniqueness", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vw-control-plane-v1-"));
    const path = join(stateDir, "control-plane.db");
    const legacy = new Database(path, { create: true, strict: true });
    legacy.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)",
    );
    legacy.exec(
      readFileSync(
        new URL("./migrations/001_control_plane.sql", import.meta.url),
        "utf8",
      ),
    );
    legacy
      .query(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, '001_control_plane.sql', 'now')",
      )
      .run();
    legacy
      .query(
        `INSERT INTO outbox_events
        (id, type, resource, correlation_id, data_json, dedupe_key, state, attempts, next_attempt_at, created_at)
        VALUES ('legacy-event', 'test.event', 'secrets/legacy', 'legacy', '{}', 'same-key', 'pending', 0, 0, 'now')`,
      )
      .run();
    legacy.close();

    const migrated = makeStoreAt(path);
    migrated.transaction((tx) =>
      migrated.enqueueEvent(
        {
          type: "test.event",
          resource: "secrets/legacy",
          dedupeKey: "same-key",
        },
        tx,
      ),
    );
    expect(
      migrated.database.db
        .query(
          "SELECT COUNT(*) AS count FROM outbox_events WHERE dedupe_key = 'same-key'",
        )
        .get(),
    ).toEqual({ count: 2 });
    migrated.close();
  });

  test("two SQLite connections serialize version allocation", async () => {
    const store = makeStore();
    store.createSecret({ name: "service" });
    const path = store.database.path;
    const results = await Promise.all(
      ["first", "second"].map((item) =>
        runConcurrentStoreAction(
          path,
          `store.addVersion({ secret: "service", payloadRef: "${item}.password", checksum: "${item}" });`,
        ),
      ),
    );
    expect(results).toEqual([
      { exitCode: 0, stderr: "" },
      { exitCode: 0, stderr: "" },
    ]);
    expect(
      store.database.db
        .query(
          "SELECT version FROM secret_versions WHERE secret_name = ? ORDER BY version",
        )
        .all("service"),
    ).toEqual([{ version: 1 }, { version: 2 }]);
    store.close();
  });

  test("two SQLite connections leave move-alias versus destroy consistent", async () => {
    const store = makeStore();
    const path = store.database.path;
    store.createSecret({ name: "service" });
    store.addVersion({
      secret: "service",
      payloadRef: "one.password",
      checksum: "one",
    });
    store.addVersion({
      secret: "service",
      payloadRef: "two.password",
      checksum: "two",
    });
    store.moveAlias({ secret: "service", alias: "stable", toVersion: 1 });
    const [move, destroy] = await Promise.all([
      runConcurrentStoreAction(
        path,
        'store.moveAlias({ secret: "service", alias: "stable", toVersion: 2 });',
      ),
      runConcurrentStoreAction(path, 'store.destroyVersion("service", 1);'),
    ]);
    expect(move).toEqual({ exitCode: 0, stderr: "" });
    expect([0, 1]).toContain(destroy.exitCode);
    expect(
      store.database.db
        .query(
          `SELECT COUNT(*) AS count FROM secret_aliases a
          JOIN secret_versions v ON v.secret_name = a.secret_name AND v.version = a.version
          WHERE a.secret_name = 'service' AND v.state = 'DESTROYED'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(store.getVersion("service", "stable")?.version).toBe(2);
    store.close();
  });

  test("destroy refuses an aliased version and never serves destroyed", () => {
    const store = makeStore();
    store.createSecret({ name: "service" });
    store.addVersion({
      secret: "service",
      payloadRef: "one.password",
      checksum: "one",
    });
    store.addVersion({
      secret: "service",
      payloadRef: "two.password",
      checksum: "two",
    });
    store.moveAlias({ secret: "service", alias: "stable", toVersion: 1 });
    expect(() => store.destroyVersion("service", 1)).toThrow(
      "Cannot destroy version targeted by alias: stable",
    );
    expect(store.getVersion("service", "stable")?.version).toBe(1);
    store.close();
  });

  test("payload references reject raw secret material and only references reach SQLite", () => {
    const store = makeStore();
    const sentinel = SECRET_SHAPED_FIXTURE;
    store.createSecret({ name: "no-plaintext" });
    expect(() =>
      store.addVersion({
        secret: "no-plaintext",
        payloadRef: sentinel,
        checksum: "sha256:rejected",
      }),
    ).toThrow("payloadRef must be a non-secret reference");
    store.addVersion({
      secret: "no-plaintext",
      payloadRef: "vault-item-1.login.password",
      checksum: "sha256:abc",
    });
    store.database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    store.close();
    const databaseBytes = readFileSync(store.database.path).toString("utf8");
    expect(databaseBytes).not.toContain(sentinel);
    const reopened = makeStoreAt(store.database.path);
    expect(
      reopened.database.db
        .query(
          "SELECT payload_ref FROM secret_versions WHERE secret_name = 'no-plaintext'",
        )
        .get(),
    ).toEqual({ payload_ref: "vault-item-1.login.password" });
    reopened.close();
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
        payloadRef: "different-ref.field",
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
    expect(() =>
      store.importLegacy({
        name: "legacy",
        payloadRef: "existing-item.custom.value",
        checksum: "sum",
        importedFrom: "vaultwarden:item-99",
      }),
    ).toThrow("different provenance");
    expect(() =>
      store.addVersion({
        secret: "legacy",
        payloadRef: "next.password",
        checksum: "next",
        idempotencyKey: "legacy-import:legacy:existing-item.custom.value",
      }),
    ).toThrow("Idempotency key already used for secret.import");
    store.close();
  });

  test("nested high-level calls use savepoints", () => {
    const store = makeStore();
    store.transaction(() => {
      store.createSecret({ name: "nested" });
      store.addVersion({
        secret: "nested",
        payloadRef: "nested.password",
        checksum: "nested",
      });
    });
    expect(store.getVersion("nested", 1)?.payloadRef).toBe("nested.password");
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

  test("audit rolls back with failed mutation and rejects sensitive keys and values", () => {
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
    expect(() =>
      store.createSecret({
        name: "secret-shaped-label",
        labels: { owner: SECRET_SHAPED_FIXTURE },
      }),
    ).toThrow("Sensitive audit/outbox value");
    store.createSecret({ name: "audited" });
    expect(store.verifyLedger()).toEqual({ ok: true });
    store.close();
  });

  test("ledger anchor detects trailing truncation and never reuses a sequence", () => {
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
      resource: "secrets/a",
      outcome: "ok",
      correlationId: "2",
    });
    expect(
      store.database.db
        .query("SELECT prev_hash FROM audit_ledger WHERE sequence = 1")
        .get(),
    ).toEqual({ prev_hash: "0".repeat(64) });
    store.database.db
      .query("DELETE FROM audit_ledger WHERE sequence = 2")
      .run();
    expect(store.verifyLedger()).toEqual({
      ok: false,
      sequence: 2,
      reason: "ledger-head-mismatch",
    });
    expect(
      store.appendAudit({
        actor: "test",
        action: "three",
        resource: "secrets/a",
        outcome: "ok",
        correlationId: "3",
      }),
    ).toBe(3);
    expect(
      store.database.db
        .query("SELECT sequence FROM audit_ledger ORDER BY sequence")
        .all(),
    ).toEqual([{ sequence: 1 }, { sequence: 3 }]);
    store.close();
  });

  test("ledger verification detects in-place edits, head mismatches, and mid-gaps", () => {
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

    const headed = makeStore();
    headed.appendAudit({
      actor: "test",
      action: "one",
      resource: "secrets/a",
      outcome: "ok",
      correlationId: "1",
    });
    headed.database.db
      .query("UPDATE ledger_head SET last_hash = ? WHERE id = 1")
      .run("f".repeat(64));
    expect(headed.verifyLedger()).toMatchObject({
      ok: false,
      reason: "ledger-head-mismatch",
    });
    headed.close();

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

  test("repeat lifecycle events persist while delivery dedupes semantic duplicates", async () => {
    const store = makeStore();
    store.createSecret({ name: "repeat" });
    store.addVersion({
      secret: "repeat",
      payloadRef: "repeat.password",
      checksum: "repeat",
    });
    store.disableVersion("repeat", 1);
    store.enableVersion("repeat", 1);
    store.disableVersion("repeat", 1);
    store.addVersion({
      secret: "repeat",
      payloadRef: "second.password",
      checksum: "second",
    });
    store.moveAlias({ secret: "repeat", alias: "stable", toVersion: 1 });
    store.moveAlias({ secret: "repeat", alias: "stable", toVersion: 2 });
    store.moveAlias({ secret: "repeat", alias: "stable", toVersion: 1 });
    expect(
      store.database.db
        .query(
          "SELECT COUNT(*) AS count FROM outbox_events WHERE type IN ('version.disabled', 'alias.move')",
        )
        .get(),
    ).toEqual({ count: 5 });

    const duplicateEvents = store.transaction((tx) => [
      store.enqueueEvent(
        {
          type: "test.duplicate",
          resource: "secrets/repeat",
          dedupeKey: "consumer-key",
        },
        tx,
      ),
      store.enqueueEvent(
        {
          type: "test.duplicate",
          resource: "secrets/repeat",
          dedupeKey: "consumer-key",
        },
        tx,
      ),
    ]);
    expect(duplicateEvents[0].id).not.toBe(duplicateEvents[1].id);
    let handled = 0;
    await store.deliverPending((event) => {
      if (event.dedupeKey === "consumer-key") handled += 1;
    });
    expect(handled).toBe(1);
    expect(
      store.database.db
        .query(
          "SELECT COUNT(*) AS count FROM outbox_events WHERE dedupe_key = 'consumer-key' AND state = 'delivered'",
        )
        .get(),
    ).toEqual({ count: 2 });
    store.close();
  });

  test("committed mutations atomically produce matching audit and outbox rows", () => {
    const store = makeStore();
    store.createSecret({ name: "atomic" });
    store.addVersion({
      secret: "atomic",
      payloadRef: "atomic.password",
      checksum: "one",
    });
    store.disableVersion("atomic", 1);
    store.enableVersion("atomic", 1);
    const auditCount = store.database.db
      .query("SELECT COUNT(*) AS count FROM audit_ledger")
      .get();
    const outboxCount = store.database.db
      .query("SELECT COUNT(*) AS count FROM outbox_events")
      .get();
    expect(auditCount).toEqual({ count: 4 });
    expect(outboxCount).toEqual(auditCount);
    store.close();
  });

  test("cold reopen resumes an expired delivery lease and rejects sensitive reconciliation evidence", async () => {
    const first = makeStore();
    const path = first.database.path;
    const operation = first.beginOperation({
      kind: "vault-write",
      resource: "secrets/cold",
    });
    expect(() =>
      first.markReconcileRequired(operation.id, {
        detail: SECRET_SHAPED_FIXTURE,
      }),
    ).toThrow("Sensitive reconciliation evidence");
    first.transaction((tx) =>
      first.enqueueEvent(
        {
          type: "lease.resume",
          resource: "secrets/cold",
          dedupeKey: "cold-resume",
        },
        tx,
      ),
    );
    first.database.db
      .query(
        "UPDATE outbox_events SET state = 'delivering', processing_until = 0 WHERE dedupe_key = 'cold-resume'",
      )
      .run();
    first.close();

    const reopened = makeStoreAt(path);
    let delivered = 0;
    expect(
      await reopened.deliverPending(() => {
        delivered += 1;
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(delivered).toBeGreaterThanOrEqual(1);
    reopened.close();
  });
});
