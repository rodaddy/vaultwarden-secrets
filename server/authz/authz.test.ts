import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorizationEngine, normalizeDenial, type Action } from "./authz";
import {
  InMemoryPolicyStore,
  SqlitePolicyStore,
  type PolicyInput,
  type PolicyStore,
  type StoredPolicy,
} from "./policy-store";

const ALL_ACTIONS: readonly Action[] = [
  "secret.get",
  "secret.list",
  "secret.create",
  "secret.addVersion",
  "secret.disable",
  "secret.enable",
  "secret.destroy",
  "alias.move",
  "policy.set",
  "rotate",
  "reconcile",
];
const subject = "workload-a";
const resource = "infra/db-password";

function decision(
  store: InMemoryPolicyStore,
  action: Action,
  target = resource,
) {
  return new AuthorizationEngine(store).authorize({
    subject,
    action,
    resource: target,
  });
}

function allow(action: Action): PolicyInput {
  return {
    subject,
    resourcePattern: resource,
    actions: [action],
    effect: "allow",
  };
}

function storedPolicy(overrides: Partial<StoredPolicy> = {}): StoredPolicy {
  return {
    id: "stored-policy",
    subject,
    resourcePattern: resource,
    actions: ["secret.get"],
    effect: "allow",
    ...overrides,
  };
}

function staticPolicyStore(policies: readonly StoredPolicy[]): PolicyStore {
  return {
    setPolicy: () => {
      throw new Error("static policy store cannot mutate");
    },
    removePolicy: () => {
      throw new Error("static policy store cannot mutate");
    },
    listPolicies: () => [...policies],
  };
}

async function applyAuthzMigration(database: Database): Promise<void> {
  database.exec(
    await Bun.file(
      new URL("../control-plane/migrations/100_authz.sql", import.meta.url),
    ).text(),
  );
}

describe("AuthorizationEngine", () => {
  test("defaults to deny for every action", () => {
    const store = new InMemoryPolicyStore();
    for (const action of ALL_ACTIONS)
      expect(decision(store, action)).toEqual({
        allow: false,
        reason: "no-policy",
      });
  });

  test("expands secret.read and honours explicit deny precedence", () => {
    const store = new InMemoryPolicyStore();
    store.setPolicy({
      subject,
      resourcePattern: "infra/*",
      actions: ["secret.read"],
      effect: "allow",
    });
    expect(decision(store, "secret.get")).toEqual({
      allow: true,
      reason: "matched",
    });
    expect(decision(store, "secret.list")).toEqual({
      allow: true,
      reason: "matched",
    });
    store.setPolicy({
      subject,
      resourcePattern: resource,
      actions: ["secret.get"],
      effect: "deny",
    });
    expect(decision(store, "secret.get")).toEqual({
      allow: false,
      reason: "ambiguous",
    });
    expect(decision(store, "secret.list")).toEqual({
      allow: true,
      reason: "matched",
    });
  });

  test("matches only exact resources, * and terminal prefix globs", () => {
    const store = new InMemoryPolicyStore();
    store.setPolicy({
      subject,
      resourcePattern: "infra/*",
      actions: ["secret.get"],
      effect: "allow",
    });
    expect(decision(store, "secret.get", "infra/db-password")).toEqual({
      allow: true,
      reason: "matched",
    });
    expect(decision(store, "secret.get", "infra/nested/db-password")).toEqual({
      allow: true,
      reason: "matched",
    });
    expect(decision(store, "secret.get", "infrastructure-x")).toEqual({
      allow: false,
      reason: "no-policy",
    });
    expect(decision(store, "secret.get", "infra")).toEqual({
      allow: false,
      reason: "no-policy",
    });
  });

  test("fails closed for malformed stored policies and malformed requests", () => {
    const malformed = new InMemoryPolicyStore([
      {
        id: "bad",
        subject,
        resourcePattern: "infra*",
        actions: ["secret.get"],
        effect: "allow",
      },
    ]);
    expect(decision(malformed, "secret.get")).toEqual({
      allow: false,
      reason: "malformed",
    });
    const store = new InMemoryPolicyStore();
    store.setPolicy(allow("secret.get"));
    expect(
      new AuthorizationEngine(store).authorize({
        subject,
        action: "secret.get",
        resource: "infra/*",
      }),
    ).toEqual({ allow: false, reason: "malformed" });
  });

  test("denies unknown, misspelled, empty, and incomplete requests without throwing", () => {
    const engine = new AuthorizationEngine(new InMemoryPolicyStore());
    const requests = [
      { subject, action: "secret.fetch", resource },
      { subject, action: "secret.get ", resource },
      { subject, action: "", resource },
      { subject: "", action: "secret.get", resource },
      { subject, action: "secret.get", resource: "" },
    ];

    for (const request of requests) {
      const malformedRequest = request as Parameters<
        AuthorizationEngine["authorize"]
      >[0];
      expect(() => engine.authorize(malformedRequest)).not.toThrow();
      expect(engine.authorize(malformedRequest)).toEqual({
        allow: false,
        reason: "malformed",
      });
    }
  });

  test("ignores malformed stored policies without throwing or granting", () => {
    const malformedPolicies: readonly [string, StoredPolicy][] = [
      ["missing id", storedPolicy({ id: undefined })],
      ["empty id", storedPolicy({ id: "" })],
      ["missing subject", storedPolicy({ subject: undefined })],
      ["empty subject", storedPolicy({ subject: "" })],
      ["non-string subject", storedPolicy({ subject: 42 })],
      ["missing actions", storedPolicy({ actions: undefined })],
      ["non-array actions", storedPolicy({ actions: "secret.get" })],
      ["empty actions", storedPolicy({ actions: [] })],
      ["unknown action", storedPolicy({ actions: ["secret.fetch"] })],
      ["missing effect", storedPolicy({ effect: undefined })],
      ["invalid effect", storedPolicy({ effect: "permit" })],
    ];

    for (const [, policy] of malformedPolicies) {
      const engine = new AuthorizationEngine(staticPolicyStore([policy]));
      expect(() =>
        engine.authorize({ subject, action: "secret.get", resource }),
      ).not.toThrow();
      expect(
        engine.authorize({ subject, action: "secret.get", resource }),
      ).toEqual({ allow: false, reason: "malformed" });
    }
  });

  test("honours a valid allow when malformed policies share its subject", () => {
    const engine = new AuthorizationEngine(
      staticPolicyStore([
        storedPolicy(),
        storedPolicy({ id: "bad-actions", actions: ["secret.fetch"] }),
      ]),
    );

    expect(
      engine.authorize({ subject, action: "secret.get", resource }),
    ).toEqual({
      allow: true,
      reason: "matched",
    });
    expect(
      engine.authorize({ subject, action: "secret.create", resource }),
    ).toEqual({ allow: false, reason: "malformed" });
  });

  test("reports a redacted decision record without secret payloads", () => {
    const records: unknown[] = [];
    new AuthorizationEngine(new InMemoryPolicyStore()).authorize({
      subject,
      action: "secret.get",
      resource,
      onDecision: (record) => records.push(record),
    });
    expect(records).toEqual([
      {
        subject,
        action: "secret.get",
        resource,
        allow: false,
        reason: "no-policy",
      },
    ]);
  });

  test("normalizes every denial to the existing not-found shape", () => {
    for (const action of ALL_ACTIONS)
      expect(normalizeDenial(action)).toEqual({
        status: 404,
        body: { error: "Secret not found" },
      });
  });

  test("covers all actions against exact, wildcard, and deny policy shapes", () => {
    for (const action of ALL_ACTIONS) {
      const exact = new InMemoryPolicyStore();
      exact.setPolicy(allow(action));
      expect(decision(exact, action)).toEqual({
        allow: true,
        reason: "matched",
      });
      const wildcard = new InMemoryPolicyStore();
      wildcard.setPolicy({
        subject,
        resourcePattern: "*",
        actions: [action],
        effect: "allow",
      });
      expect(decision(wildcard, action)).toEqual({
        allow: true,
        reason: "matched",
      });
      const denied = new InMemoryPolicyStore();
      denied.setPolicy({
        subject,
        resourcePattern: "*",
        actions: [action],
        effect: "deny",
      });
      expect(decision(denied, action)).toEqual({
        allow: false,
        reason: "matched",
      });
    }
  });

  test("covers every action across allow, deny, no-match, malformed, and wildcard policies", () => {
    for (const action of ALL_ACTIONS) {
      const cases: readonly [string, StoredPolicy, boolean, string][] = [
        ["allow", storedPolicy({ actions: [action] }), true, "matched"],
        [
          "deny",
          storedPolicy({ actions: [action], effect: "deny" }),
          false,
          "matched",
        ],
        [
          "no matching policy",
          storedPolicy({ actions: [action], resourcePattern: "other/secret" }),
          false,
          "no-policy",
        ],
        [
          "malformed policy",
          storedPolicy({ actions: ["not-an-action"] }),
          false,
          "malformed",
        ],
        [
          "wildcard pattern",
          storedPolicy({ actions: [action], resourcePattern: "*" }),
          true,
          "matched",
        ],
      ];

      for (const [, policy, allowResult, reason] of cases) {
        expect(
          new AuthorizationEngine(staticPolicyStore([policy])).authorize({
            subject,
            action,
            resource,
          }),
        ).toEqual({ allow: allowResult, reason });
      }
    }
  });

  test("limits secret.read to get and list and applies group-level denies", () => {
    const allowed = new InMemoryPolicyStore();
    allowed.setPolicy({
      subject,
      resourcePattern: resource,
      actions: ["secret.read"],
      effect: "allow",
    });
    for (const action of ["secret.get", "secret.list"] as const)
      expect(decision(allowed, action)).toEqual({
        allow: true,
        reason: "matched",
      });
    for (const action of [
      "secret.addVersion",
      "secret.disable",
      "secret.destroy",
      "alias.move",
    ] as const)
      expect(decision(allowed, action)).toEqual({
        allow: false,
        reason: "no-policy",
      });

    const denied = new InMemoryPolicyStore();
    denied.setPolicy({
      subject,
      resourcePattern: resource,
      actions: ["secret.read"],
      effect: "deny",
    });
    expect(decision(denied, "secret.get")).toEqual({
      allow: false,
      reason: "matched",
    });
    expect(decision(denied, "secret.list")).toEqual({
      allow: false,
      reason: "matched",
    });
  });

  test("uses literal, case-sensitive terminal glob matching at boundary edges", () => {
    const prefix = new InMemoryPolicyStore();
    prefix.setPolicy({
      subject,
      resourcePattern: "infra/*",
      actions: ["secret.get"],
      effect: "allow",
    });
    for (const target of ["infra/item", "infra/nested/item", "infra/"])
      expect(decision(prefix, "secret.get", target)).toEqual({
        allow: true,
        reason: "matched",
      });
    for (const target of ["infrastructure-x", "infra"])
      expect(decision(prefix, "secret.get", target)).toEqual({
        allow: false,
        reason: "no-policy",
      });

    const wildcard = new InMemoryPolicyStore();
    wildcard.setPolicy({
      subject,
      resourcePattern: "*",
      actions: ["secret.get"],
      effect: "allow",
    });
    for (const target of ["nested/item", "trailing/"])
      expect(decision(wildcard, "secret.get", target)).toEqual({
        allow: true,
        reason: "matched",
      });
    expect(
      new AuthorizationEngine(wildcard).authorize({
        subject,
        action: "secret.get",
        resource: "",
      }),
    ).toEqual({ allow: false, reason: "malformed" });

    const literal = new InMemoryPolicyStore();
    literal.setPolicy({
      subject,
      resourcePattern: "team.+(prod)/*",
      actions: ["secret.get"],
      effect: "allow",
    });
    expect(decision(literal, "secret.get", "team.+(prod)/db")).toEqual({
      allow: true,
      reason: "matched",
    });
    expect(decision(literal, "secret.get", "teamXprod/db")).toEqual({
      allow: false,
      reason: "no-policy",
    });

    const exact = new InMemoryPolicyStore();
    exact.setPolicy({
      subject,
      resourcePattern: "infra/Password",
      actions: ["secret.get"],
      effect: "allow",
    });
    expect(decision(exact, "secret.get", "infra/password")).toEqual({
      allow: false,
      reason: "no-policy",
    });
    expect(
      new AuthorizationEngine(
        staticPolicyStore([storedPolicy({ subject: "workloаd-a" })]),
      ).authorize({ subject, action: "secret.get", resource }),
    ).toEqual({ allow: false, reason: "no-policy" });
    expect(
      new AuthorizationEngine(
        staticPolicyStore([
          storedPolicy({ resourcePattern: "infra/pаssword" }),
        ]),
      ).authorize({
        subject,
        action: "secret.get",
        resource: "infra/password",
      }),
    ).toEqual({ allow: false, reason: "no-policy" });
  });
});

describe("Policy stores", () => {
  test("setPolicy is idempotent and returns auditable before/after summaries", () => {
    const store = new InMemoryPolicyStore();
    const first = store.setPolicy(allow("secret.get"));
    const second = store.setPolicy(allow("secret.get"));
    expect(first.changed).toBe(true);
    expect(first.after?.id).toBe(first.id);
    expect(second).toMatchObject({
      id: first.id,
      changed: false,
      before: first.after,
      after: first.after,
    });
    expect(store.removePolicy(first.id)).toMatchObject({
      id: first.id,
      changed: true,
      before: first.after,
    });
    expect(store.removePolicy(first.id)).toEqual({
      id: first.id,
      changed: false,
    });
  });

  test("SQLite store uses the migration schema and preserves idempotency", async () => {
    const database = new Database(":memory:");
    await applyAuthzMigration(database);
    const store = new SqlitePolicyStore(database);
    const first = store.setPolicy(allow("secret.get"));
    const second = store.setPolicy(allow("secret.get"));
    expect(second).toMatchObject({ id: first.id, changed: false });
    expect(store.listPolicies(subject)).toHaveLength(1);
    database.close();
  });

  test("SQLite malformed actions JSON denies without throwing", async () => {
    const database = new Database(":memory:");
    await applyAuthzMigration(database);
    database
      .query(
        "INSERT INTO authz_policies (id, subject, resource_pattern, actions_json, effect) VALUES (?, ?, ?, ?, ?)",
      )
      .run("malformed-json", subject, resource, "not json", "allow");
    const engine = new AuthorizationEngine(new SqlitePolicyStore(database));

    expect(() =>
      engine.authorize({ subject, action: "secret.get", resource }),
    ).not.toThrow();
    expect(
      engine.authorize({ subject, action: "secret.get", resource }),
    ).toEqual({
      allow: false,
      reason: "malformed",
    });
    database.close();
  });

  test("SQLite setPolicy is idempotent across two database connections", async () => {
    const databasePath = join(
      tmpdir(),
      `vaultwarden-authz-${crypto.randomUUID()}.sqlite`,
    );
    const firstDatabase = new Database(databasePath);
    const secondDatabase = new Database(databasePath);
    try {
      await applyAuthzMigration(firstDatabase);
      const firstStore = new SqlitePolicyStore(firstDatabase);
      const secondStore = new SqlitePolicyStore(secondDatabase);
      const [first, second] = await Promise.all([
        Promise.resolve().then(() => firstStore.setPolicy(allow("secret.get"))),
        Promise.resolve().then(() =>
          secondStore.setPolicy(allow("secret.get")),
        ),
      ]);

      expect([first.changed, second.changed].filter(Boolean)).toHaveLength(1);
      expect(first.id).toBe(second.id);
      expect(firstStore.listPolicies(subject)).toHaveLength(1);
    } finally {
      firstDatabase.close();
      secondDatabase.close();
      await Bun.file(databasePath).delete();
    }
  });

  test("SQLite parameterization safely persists hostile policy values", async () => {
    const database = new Database(":memory:");
    await applyAuthzMigration(database);
    const hostileSubject = "workload'; DROP TABLE authz_policies; --";
    const hostileResource = "secret'); DELETE FROM authz_policies; --";
    const hostileAction = "secret.get'; DROP TABLE authz_policies; --";
    const store = new SqlitePolicyStore(database);

    store.setPolicy({
      subject: hostileSubject,
      resourcePattern: hostileResource,
      actions: ["secret.get"],
      effect: "allow",
    });
    database
      .query(
        "INSERT INTO authz_policies (id, subject, resource_pattern, actions_json, effect) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "hostile-action",
        hostileSubject,
        hostileResource,
        JSON.stringify([hostileAction]),
        "allow",
      );
    const engine = new AuthorizationEngine(store);

    expect(
      engine.authorize({
        subject: hostileSubject,
        action: "secret.get",
        resource: hostileResource,
      }),
    ).toEqual({ allow: true, reason: "matched" });
    expect(store.listPolicies(hostileSubject)).toHaveLength(2);
    expect(store.listPolicies(hostileSubject)).toContainEqual(
      expect.objectContaining({ actions: [hostileAction] }),
    );
    expect(() =>
      engine.authorize({
        subject: hostileSubject,
        action: hostileAction as Action,
        resource: hostileResource,
      }),
    ).not.toThrow();
    expect(store.listPolicies(hostileSubject)).toHaveLength(2);
    database.close();
  });

  test("SQLite duplicate writes stay idempotent and conflicting rows deny", async () => {
    const database = new Database(":memory:");
    await applyAuthzMigration(database);
    const store = new SqlitePolicyStore(database);
    store.setPolicy(allow("secret.get"));
    expect(store.setPolicy(allow("secret.get")).changed).toBe(false);
    store.setPolicy({ ...allow("secret.get"), effect: "deny" });

    expect(
      new AuthorizationEngine(store).authorize({
        subject,
        action: "secret.get",
        resource,
      }),
    ).toEqual({ allow: false, reason: "ambiguous" });
    database.close();
  });
});
