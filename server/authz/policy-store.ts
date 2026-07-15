import type { Database } from "bun:sqlite";
import type { Action } from "./authz";

export type PolicyAction = Action | "secret.read";
export type PolicyEffect = "allow" | "deny";

export interface PolicyInput {
  subject: string;
  resourcePattern: string;
  actions: readonly PolicyAction[];
  effect: PolicyEffect;
}

export interface StoredPolicy {
  id: unknown;
  subject: unknown;
  resourcePattern: unknown;
  actions: unknown;
  effect: unknown;
}

export interface Policy extends PolicyInput {
  id: string;
}

export interface PolicySummary {
  id: string;
  subject: string;
  resourcePattern: string;
  actions: readonly PolicyAction[];
  effect: PolicyEffect;
}

export interface PolicyMutation {
  id: string;
  changed: boolean;
  before?: PolicySummary;
  after?: PolicySummary;
}

export interface PolicyStore {
  setPolicy(input: PolicyInput): PolicyMutation;
  removePolicy(id: string): PolicyMutation;
  listPolicies(subject?: string): StoredPolicy[];
}

const ACTIONS: readonly Action[] = [
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
const POLICY_ACTIONS = new Set<PolicyAction>([...ACTIONS, "secret.read"]);

export function isPolicyAction(value: unknown): value is PolicyAction {
  return typeof value === "string" && POLICY_ACTIONS.has(value as PolicyAction);
}

export function isResourcePattern(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (!value.includes("*")) return true;
  if (value === "*") return true;
  const prefix = value.slice(0, -2);
  return value.endsWith("/*") && prefix.length > 0 && !prefix.includes("*");
}

function normalizeInput(input: PolicyInput): Omit<Policy, "id"> {
  if (typeof input.subject !== "string" || input.subject.length === 0)
    throw new Error("Policy subject must be a non-empty string");
  if (!isResourcePattern(input.resourcePattern))
    throw new Error(
      "Policy resource pattern must be exact, *, or a terminal /* prefix glob",
    );
  if (input.effect !== "allow" && input.effect !== "deny")
    throw new Error("Policy effect must be allow or deny");
  if (
    !Array.isArray(input.actions) ||
    input.actions.length === 0 ||
    !input.actions.every(isPolicyAction)
  ) {
    throw new Error(
      "Policy actions must contain supported actions or action groups",
    );
  }
  return {
    subject: input.subject,
    resourcePattern: input.resourcePattern,
    actions: [...new Set(input.actions)].sort(),
    effect: input.effect,
  };
}

function toSummary(policy: Policy): PolicySummary {
  return {
    id: policy.id,
    subject: policy.subject,
    resourcePattern: policy.resourcePattern,
    actions: policy.actions,
    effect: policy.effect,
  };
}

function samePolicy(left: Policy, right: Omit<Policy, "id">): boolean {
  return (
    left.subject === right.subject &&
    left.resourcePattern === right.resourcePattern &&
    left.effect === right.effect &&
    JSON.stringify(left.actions) === JSON.stringify(right.actions)
  );
}

/** Test-friendly policy store. It is intentionally synchronous like bun:sqlite. */
export class InMemoryPolicyStore implements PolicyStore {
  private readonly policies = new Map<string, StoredPolicy>();

  constructor(initialPolicies: readonly StoredPolicy[] = []) {
    for (const policy of initialPolicies)
      if (typeof policy.id === "string") this.policies.set(policy.id, policy);
  }

  setPolicy(input: PolicyInput): PolicyMutation {
    const normalized = normalizeInput(input);
    const existing = this.listPolicies(normalized.subject)
      .map(asPolicy)
      .find(
        (policy): policy is Policy =>
          policy !== undefined && samePolicy(policy, normalized),
      );
    if (existing)
      return {
        id: existing.id,
        changed: false,
        before: toSummary(existing),
        after: toSummary(existing),
      };

    const policy: Policy = { id: crypto.randomUUID(), ...normalized };
    this.policies.set(policy.id, policy);
    return { id: policy.id, changed: true, after: toSummary(policy) };
  }

  removePolicy(id: string): PolicyMutation {
    const existing = asPolicy(this.policies.get(id));
    if (!existing) return { id, changed: false };
    this.policies.delete(id);
    return { id, changed: true, before: toSummary(existing) };
  }

  listPolicies(subject?: string): StoredPolicy[] {
    return [...this.policies.values()].filter(
      (policy) => subject === undefined || policy.subject === subject,
    );
  }
}

interface SqlitePolicyRow {
  id: string;
  subject: string;
  resource_pattern: string;
  actions_json: string;
  effect: string;
}

/** Durable store; the caller owns the injected database handle and migrations. */
export class SqlitePolicyStore implements PolicyStore {
  constructor(private readonly database: Database) {}

  setPolicy(input: PolicyInput): PolicyMutation {
    const normalized = normalizeInput(input);
    const actionsJson = JSON.stringify(normalized.actions);
    const policy: Policy = { id: crypto.randomUUID(), ...normalized };
    const result = this.database
      .query(
        "INSERT INTO authz_policies (id, subject, resource_pattern, actions_json, effect) VALUES (?, ?, ?, ?, ?) ON CONFLICT (subject, resource_pattern, actions_json, effect) DO NOTHING",
      )
      .run(
        policy.id,
        policy.subject,
        policy.resourcePattern,
        actionsJson,
        policy.effect,
      );
    if (result.changes === 0) {
      const existing = this.findByNaturalKey(
        normalized.subject,
        normalized.resourcePattern,
        actionsJson,
        normalized.effect,
      );
      if (existing)
        return {
          id: existing.id,
          changed: false,
          before: toSummary(existing),
          after: toSummary(existing),
        };
      throw new Error("Authorization policy insert did not persist a policy");
    }
    return { id: policy.id, changed: true, after: toSummary(policy) };
  }

  removePolicy(id: string): PolicyMutation {
    const existing = this.findById(id);
    if (!existing) return { id, changed: false };
    this.database.query("DELETE FROM authz_policies WHERE id = ?").run(id);
    return { id, changed: true, before: toSummary(existing) };
  }

  listPolicies(subject?: string): StoredPolicy[] {
    const rows =
      subject === undefined
        ? this.database
            .query<
              SqlitePolicyRow,
              []
            >("SELECT id, subject, resource_pattern, actions_json, effect FROM authz_policies ORDER BY id")
            .all()
        : this.database
            .query<
              SqlitePolicyRow,
              [string]
            >("SELECT id, subject, resource_pattern, actions_json, effect FROM authz_policies WHERE subject = ? ORDER BY id")
            .all(subject);
    return rows.map(fromRow);
  }

  private findById(id: string): Policy | undefined {
    const row = this.database
      .query<
        SqlitePolicyRow,
        [string]
      >("SELECT id, subject, resource_pattern, actions_json, effect FROM authz_policies WHERE id = ?")
      .get(id);
    return row ? asPolicy(fromRow(row)) : undefined;
  }

  private findByNaturalKey(
    subject: string,
    resourcePattern: string,
    actionsJson: string,
    effect: PolicyEffect,
  ): Policy | undefined {
    const row = this.database
      .query<
        SqlitePolicyRow,
        [string, string, string, PolicyEffect]
      >("SELECT id, subject, resource_pattern, actions_json, effect FROM authz_policies WHERE subject = ? AND resource_pattern = ? AND actions_json = ? AND effect = ?")
      .get(subject, resourcePattern, actionsJson, effect);
    return row ? asPolicy(fromRow(row)) : undefined;
  }
}

function fromRow(row: SqlitePolicyRow): StoredPolicy {
  let actions: unknown;
  try {
    actions = JSON.parse(row.actions_json);
  } catch {
    actions = undefined;
  }
  return {
    id: row.id,
    subject: row.subject,
    resourcePattern: row.resource_pattern,
    actions,
    effect: row.effect,
  };
}

function asPolicy(value: StoredPolicy | undefined): Policy | undefined {
  if (
    !value ||
    typeof value.id !== "string" ||
    typeof value.subject !== "string" ||
    !isResourcePattern(value.resourcePattern)
  )
    return undefined;
  if (
    (value.effect !== "allow" && value.effect !== "deny") ||
    !Array.isArray(value.actions) ||
    value.actions.length === 0 ||
    !value.actions.every(isPolicyAction)
  )
    return undefined;
  return {
    id: value.id,
    subject: value.subject,
    resourcePattern: value.resourcePattern,
    actions: [...new Set(value.actions)].sort(),
    effect: value.effect,
  };
}
