import { expect, describe, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ControlPlaneStore } from "../../control-plane/store";
import { AliasCasError } from "../../control-plane/lifecycle";
import { InMemoryPolicyStore } from "../../authz/policy-store";
import { AuthorizationEngine } from "../../authz/authz";
import { Database } from "bun:sqlite";
import {
  ControlPlaneStoreAdapter,
  AuditAdapter,
  OutboxAdapter,
  makeAuthorize,
  VaultWriterAdapter,
  SystemdConsumerReloader,
  buildRotationEngine,
  type BwSession,
} from "../wiring";
import { TestConnector } from "../connectors/test-connector";

function makeStore(): ControlPlaneStore {
  const root = process.env.VW_TEST_TMPDIR ?? tmpdir();
  return new ControlPlaneStore({
    stateDir: mkdtempSync(join(root, "vw-wiring-")),
    actor: "test",
  });
}

/** Seed a secret with two enabled versions so aliases can be moved. */
function seedTwoVersions(store: ControlPlaneStore, secret: string): void {
  store.createSecret({ name: secret });
  store.addVersion({
    secret,
    payloadRef: `vaultwarden:${secret}-v1`,
    checksum: "sha256:aaa",
  });
  store.addVersion({
    secret,
    payloadRef: `vaultwarden:${secret}-v2`,
    checksum: "sha256:bbb",
  });
}

describe("ControlPlaneStoreAdapter — CAS on moveAlias (hazard a)", () => {
  test("real store rejects a stale expectedFromVersion atomically", () => {
    const store = makeStore();
    seedTwoVersions(store, "svc");
    // Alias currently unset -> first assignment to v1 with expected null.
    store.moveAliasCas({
      secret: "svc",
      alias: "current",
      toVersion: 1,
      expectedFromVersion: null,
    });
    // A stale rotation still believes the alias is unset -> must be rejected.
    expect(() =>
      store.moveAliasCas({
        secret: "svc",
        alias: "current",
        toVersion: 2,
        expectedFromVersion: null,
      }),
    ).toThrow(AliasCasError);
    // The correct expectation succeeds.
    store.moveAliasCas({
      secret: "svc",
      alias: "current",
      toVersion: 2,
      expectedFromVersion: 1,
    });
    expect(store.getVersion("svc", "current")?.version).toBe(2);
    store.close();
  });

  test("adapter enforces CAS: concurrent stale publish loses (falsifiable)", async () => {
    const store = makeStore();
    seedTwoVersions(store, "svc");
    const adapter = new ControlPlaneStoreAdapter(store);

    // Rotation A publishes v1 first (alias was unset).
    await adapter.moveAlias({
      secret: "svc",
      alias: "current",
      toVersion: 1,
      expectedFromVersion: null,
    });
    // Rotation B was planned when the alias was still unset (expected null) and
    // tries to publish v2 -> the CAS must reject it because A moved it to v1.
    await expect(
      adapter.moveAlias({
        secret: "svc",
        alias: "current",
        toVersion: 2,
        expectedFromVersion: null,
      }),
    ).rejects.toThrow(/CAS violation/);
    // Alias unchanged by the losing publish.
    expect(store.getVersion("svc", "current")?.version).toBe(1);
    store.close();
  });

  test("addVersion projects to {version}; getVersion maps VersionRecord", async () => {
    const store = makeStore();
    seedTwoVersions(store, "svc");
    const adapter = new ControlPlaneStoreAdapter(store);
    store.addVersion; // (versions already added)
    const rec = await adapter.getVersion("svc", 2);
    expect(rec).toEqual({
      version: 2,
      payloadRef: "vaultwarden:svc-v2",
      checksum: "sha256:bbb",
      state: "ENABLED",
    });
    expect(await adapter.getVersion("svc", "missing-alias")).toBeNull();
    store.close();
  });
});

describe("Audit/Outbox adapters — tx ownership + shape mapping (hazard b)", () => {
  test("appendAudit maps rotation shape and writes a durable ledger row", async () => {
    const store = makeStore();
    const audit = new AuditAdapter(store);
    await audit.appendAudit({
      jobId: "job-1",
      secret: "svc",
      stage: "verified",
      outcome: "ok",
      detail: { newVersion: 2 },
      at: new Date().toISOString(),
    });
    const rows = store.database.db
      .query(
        "SELECT action, resource, outcome, correlation_id FROM audit_ledger WHERE correlation_id = ?",
      )
      .all("job-1") as Array<{
      action: string;
      resource: string;
      outcome: string;
      correlation_id: string;
    }>;
    expect(rows).toEqual([
      {
        action: "rotation.verified",
        resource: "secrets/svc",
        outcome: "ok",
        correlation_id: "job-1",
      },
    ]);
    store.close();
  });

  test("enqueueEvent maps rotation shape and enqueues a redacted outbox event", async () => {
    const store = makeStore();
    const outbox = new OutboxAdapter(store);
    await outbox.enqueueEvent({
      jobId: "job-2",
      secret: "svc",
      type: "rotation.verified.ok",
      data: { newVersion: 2, newChecksum: "sha256:bbb" },
      at: new Date().toISOString(),
    });
    const rows = store.database.db
      .query(
        "SELECT type, resource, correlation_id, data_json FROM outbox_events WHERE correlation_id = ?",
      )
      .all("job-2") as Array<{
      type: string;
      resource: string;
      correlation_id: string;
      data_json: string;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.type).toBe("rotation.verified.ok");
    expect(rows[0]!.resource).toBe("secrets/svc");
    expect(rows[0]!.correlation_id).toBe("job-2");
    expect(JSON.parse(rows[0]!.data_json)).toEqual({
      newVersion: 2,
      newChecksum: "sha256:bbb",
    });
    store.close();
  });

  test("outbox redaction is preserved: secret-looking value is rejected", async () => {
    const store = makeStore();
    const outbox = new OutboxAdapter(store);
    await expect(
      outbox.enqueueEvent({
        jobId: "job-3",
        secret: "svc",
        type: "rotation.staged.ok",
        // A secret-shaped value must trip the store's redaction rejector.
        data: {
          leaked: ["sk", "live", "0123456789abcdefghijklmnop"].join("_"),
        },
        at: new Date().toISOString(),
      }),
    ).rejects.toThrow();
    store.close();
  });
});

describe("ControlPlaneStoreAdapter — markReconcileRequired bridge (hazard c)", () => {
  test("opens an operation then marks it reconcile-required with safe evidence", async () => {
    const store = makeStore();
    const adapter = new ControlPlaneStoreAdapter(store);
    await adapter.markReconcileRequired({
      op: "revoke",
      secret: "svc",
      detail: "unauthorized: revoke denied",
    });
    const ops = store.database.db
      .query(
        "SELECT o.kind, o.resource, o.state, o.evidence_json FROM operations o JOIN reconciliation_records r ON r.operation_id = o.id WHERE r.state = 'open'",
      )
      .all() as Array<{
      kind: string;
      resource: string;
      state: string;
      evidence_json: string;
    }>;
    expect(ops.length).toBe(1);
    expect(ops[0]!.kind).toBe("rotation.reconcile");
    expect(ops[0]!.resource).toBe("secrets/svc");
    expect(ops[0]!.state).toBe("reconcile-required");
    expect(JSON.parse(ops[0]!.evidence_json)).toEqual({
      op: "revoke",
      detail: "unauthorized: revoke denied",
    });
    store.close();
  });
});

describe("makeAuthorize — real AuthorizationEngine mapping", () => {
  function engineWith(
    policies: Array<{
      subject: string;
      resourcePattern: string;
      actions: string[];
      effect: "allow" | "deny";
    }>,
  ): AuthorizationEngine {
    const ps = new InMemoryPolicyStore();
    for (const p of policies)
      ps.setPolicy({
        subject: p.subject,
        resourcePattern: p.resourcePattern,
        actions: p.actions as never,
        effect: p.effect,
      });
    return new AuthorizationEngine(ps);
  }

  test("maps move-alias -> alias.move and honours allow", async () => {
    const authorize = makeAuthorize(
      engineWith([
        {
          subject: "mcp",
          resourcePattern: "*",
          actions: ["alias.move"],
          effect: "allow",
        },
      ]),
    );
    expect(
      await authorize({
        subject: "mcp",
        action: "move-alias",
        resource: "svc",
      }),
    ).toEqual({ allow: true });
  });

  test("fail-closed: no policy denies without leaking reason detail", async () => {
    const authorize = makeAuthorize(engineWith([]));
    const res = await authorize({
      subject: "mcp",
      action: "rotate",
      resource: "svc",
    });
    expect(res.allow).toBe(false);
    expect(res.reason).toBe("denied by policy");
  });

  test("revoke/rollback map to secret.destroy", async () => {
    const authorize = makeAuthorize(
      engineWith([
        {
          subject: "mcp",
          resourcePattern: "*",
          actions: ["secret.destroy"],
          effect: "allow",
        },
      ]),
    );
    expect(
      (await authorize({ subject: "mcp", action: "revoke", resource: "svc" }))
        .allow,
    ).toBe(true);
    expect(
      (await authorize({ subject: "mcp", action: "rollback", resource: "svc" }))
        .allow,
    ).toBe(true);
  });
});

describe("VaultWriterAdapter — checksum without leaking material", () => {
  test("returns vaultwarden ref + sha256 checksum, never surfaces material", async () => {
    const { createHash } = await import("node:crypto");
    const MATERIAL = "top-secret-generated-token-abcdef123456";
    const session: BwSession = { session: "sess", folderId: "folder-1" };
    let sawTemplate: Record<string, unknown> | null = null;
    const adapter = new VaultWriterAdapter(
      async () => session,
      async (_session, template) => {
        sawTemplate = template;
        return { id: "item-xyz" };
      },
    );

    const result = await adapter.writeItem("svc", async () => MATERIAL);

    const expectedChecksum =
      "sha256:" + createHash("sha256").update(MATERIAL).digest("hex");
    expect(result).toEqual({
      payloadRef: "vaultwarden:item-xyz",
      checksum: expectedChecksum,
    });
    // The returned identifiers/hash must never contain the raw material.
    expect(JSON.stringify(result)).not.toContain(MATERIAL);
    // Falsifiable: material IS stored in the vault template (hidden field),
    // proving writeItem actually persisted it (revert-the-impl would break).
    const fields = (
      sawTemplate as unknown as { fields?: Array<{ value: string }> }
    )?.fields;
    expect(fields?.[0]?.value).toBe(MATERIAL);
  });
});

describe("buildRotationEngine — end-to-end against real control-plane store", () => {
  test("drives a first-issuance rotation to done with no material leak", async () => {
    const store = makeStore();
    store.createSecret({ name: "pilot" });

    const ps = new InMemoryPolicyStore();
    ps.setPolicy({
      subject: "mcp",
      resourcePattern: "*",
      actions: ["rotate", "alias.move", "secret.destroy"] as never,
      effect: "allow",
    });
    const authz = new AuthorizationEngine(ps);

    const MATERIAL = "PILOT-GENERATED-SECRET-do-not-leak-abcdef0123456789";
    const connector = new TestConnector({ material: MATERIAL });
    // Offline vault: fake creator returns a bw-id-shaped item id.
    let seq = 0;
    const vault = new VaultWriterAdapter(
      async () => ({ session: "sess", folderId: "folder-1" }),
      async () => ({ id: `pilotitem${++seq}` }),
    );

    const engine = buildRotationEngine(new Database(":memory:"), {
      store,
      authz,
      connector,
      vault,
      consumerAllowlist: {
        caddy: { kind: "systemd", unit: "caddy.service" },
      },
      consumerReloader: new SystemdConsumerReloader(async () => {}),
    });

    const receipt = await engine.rotate({
      credential: "pilot",
      connector: "test",
      strategy: "single",
      consumers: ["caddy"],
      idempotencyKey: "pilot-req-1",
      subject: "mcp",
    });

    expect(receipt.stage).toBe("done");
    expect(receipt.newVersion).toBe(1);
    expect(receipt.newPayloadRef).toBe("vaultwarden:pilotitem1");

    // Alias published to the new version in the REAL store.
    expect(store.getVersion("pilot", "current")?.version).toBe(1);

    // No material anywhere in the redacted receipt.
    expect(JSON.stringify(receipt)).not.toContain(MATERIAL);

    // No material in the durable audit ledger or outbox.
    const auditRows = store.database.db
      .query("SELECT action, outcome FROM audit_ledger")
      .all() as Array<{ action: string; outcome: string }>;
    expect(auditRows.some((r) => r.action === "rotation.done")).toBe(true);
    const ledgerBlob = JSON.stringify(
      store.database.db.query("SELECT * FROM audit_ledger").all(),
    );
    const outboxBlob = JSON.stringify(
      store.database.db.query("SELECT * FROM outbox_events").all(),
    );
    expect(ledgerBlob).not.toContain(MATERIAL);
    expect(outboxBlob).not.toContain(MATERIAL);

    store.close();
  });

  test("denied rotate fails closed before any provider effect (falsifiable)", async () => {
    const store = makeStore();
    store.createSecret({ name: "pilot" });
    const authz = new AuthorizationEngine(new InMemoryPolicyStore()); // no policy
    const connector = new TestConnector();
    const engine = buildRotationEngine(new Database(":memory:"), {
      store,
      authz,
      connector,
      vault: new VaultWriterAdapter(
        async () => ({ session: "s", folderId: "f" }),
        async () => ({ id: "x" }),
      ),
      consumerAllowlist: {},
      consumerReloader: new SystemdConsumerReloader(async () => {}),
    });
    await expect(
      engine.rotate({
        credential: "pilot",
        connector: "test",
        strategy: "single",
        consumers: [],
        idempotencyKey: "denied-1",
        subject: "mcp",
      }),
    ).rejects.toThrow(/unauthorized/);
    // Connector.create never ran -> no provider side effect on denial.
    expect(connector.calls.create).toBe(0);
    store.close();
  });
});

describe("SystemdConsumerReloader — allowlist-only executor", () => {
  test("systemd hook runs reload-or-restart on the declared unit", async () => {
    const calls: string[][] = [];
    const reloader = new SystemdConsumerReloader(async (argv) => {
      calls.push([...argv]);
    });
    await reloader.reload("caddy", { kind: "systemd", unit: "caddy.service" });
    expect(calls).toEqual([
      ["systemctl", "reload-or-restart", "caddy.service"],
    ]);
  });

  test("command hook runs the fixed template argv verbatim", async () => {
    const calls: string[][] = [];
    const reloader = new SystemdConsumerReloader(async (argv) => {
      calls.push([...argv]);
    });
    await reloader.reload("app", {
      kind: "command",
      command: ["/usr/bin/reload-app", "--graceful"],
    });
    expect(calls).toEqual([["/usr/bin/reload-app", "--graceful"]]);
  });
});
