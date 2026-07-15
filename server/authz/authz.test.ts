import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { AuthorizationEngine, normalizeDenial, type Action } from "./authz";
import {
  InMemoryPolicyStore,
  SqlitePolicyStore,
  type PolicyInput,
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
    database.exec(
      await Bun.file(
        new URL("../control-plane/migrations/100_authz.sql", import.meta.url),
      ).text(),
    );
    const store = new SqlitePolicyStore(database);
    const first = store.setPolicy(allow("secret.get"));
    const second = store.setPolicy(allow("secret.get"));
    expect(second).toMatchObject({ id: first.id, changed: false });
    expect(store.listPolicies(subject)).toHaveLength(1);
    database.close();
  });
});
