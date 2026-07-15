import type { PolicyStore, StoredPolicy } from "./policy-store";
import { isPolicyAction, isResourcePattern } from "./policy-store";

export type Action =
  | "secret.get"
  | "secret.list"
  | "secret.create"
  | "secret.addVersion"
  | "secret.disable"
  | "secret.enable"
  | "secret.destroy"
  | "alias.move"
  | "policy.set"
  | "rotate"
  | "reconcile";
export type DecisionReason =
  | "matched"
  | "no-policy"
  | "ambiguous"
  | "malformed";
export interface Decision {
  allow: boolean;
  reason: DecisionReason;
}
export interface AuthorizationRequest {
  subject: string;
  action: Action;
  resource: string;
  onDecision?: (record: DecisionAuditRecord) => void;
}
export interface DecisionAuditRecord {
  subject: string;
  action: Action;
  resource: string;
  allow: boolean;
  reason: DecisionReason;
}
export interface NormalizedDenial {
  status: 404;
  body: { error: "Secret not found" };
}

const ACTIONS = new Set<Action>([
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
]);
const ACTION_GROUPS: Readonly<Record<"secret.read", readonly Action[]>> = {
  "secret.read": ["secret.get", "secret.list"],
};

/** Central, transport-independent authorization decision point. */
export class AuthorizationEngine {
  constructor(private readonly policyStore: PolicyStore) {}

  authorize(request: AuthorizationRequest): Decision {
    const decision = this.decide(request);
    request.onDecision?.({
      subject: request.subject,
      action: request.action,
      resource: request.resource,
      ...decision,
    });
    return decision;
  }

  private decide(request: AuthorizationRequest): Decision {
    if (!isRequestWellFormed(request))
      return { allow: false, reason: "malformed" };
    const policies = this.policyStore.listPolicies(request.subject);
    const validPolicies = policies.filter(
      (policy) => !isMalformedPolicy(policy),
    );
    const matches = validPolicies.filter((policy) =>
      policyMatches(policy, request.subject, request.action, request.resource),
    );
    if (matches.length === 0)
      return {
        allow: false,
        reason:
          validPolicies.length === policies.length ? "no-policy" : "malformed",
      };

    const hasAllow = matches.some((policy) => policy.effect === "allow");
    const hasDeny = matches.some((policy) => policy.effect === "deny");
    if (hasAllow && hasDeny) return { allow: false, reason: "ambiguous" };
    if (hasDeny) return { allow: false, reason: "matched" };
    return { allow: true, reason: "matched" };
  }
}

/** Convenience factory preserving authorize({ subject, action, resource }) at call sites. */
export function createAuthorizer(
  policyStore: PolicyStore,
): (request: AuthorizationRequest) => Decision {
  const engine = new AuthorizationEngine(policyStore);
  return engine.authorize.bind(engine);
}

/** Every denial maps to the existing missing-secret response shape. */
export function normalizeDenial(_action: Action): NormalizedDenial {
  return { status: 404, body: { error: "Secret not found" } };
}

function isRequestWellFormed(request: AuthorizationRequest): boolean {
  return (
    typeof request.subject === "string" &&
    request.subject.length > 0 &&
    ACTIONS.has(request.action) &&
    isResourceTarget(request.resource)
  );
}

function isResourceTarget(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    (!value.includes("*") || value === "*")
  );
}

function isMalformedPolicy(policy: StoredPolicy): boolean {
  return (
    typeof policy.id !== "string" ||
    policy.id.length === 0 ||
    typeof policy.subject !== "string" ||
    policy.subject.length === 0 ||
    !isResourcePattern(policy.resourcePattern) ||
    !Array.isArray(policy.actions) ||
    policy.actions.length === 0 ||
    !policy.actions.every(isPolicyAction) ||
    (policy.effect !== "allow" && policy.effect !== "deny")
  );
}

function policyMatches(
  policy: StoredPolicy,
  subject: string,
  action: Action,
  resource: string,
): boolean {
  if (
    !Array.isArray(policy.actions) ||
    typeof policy.resourcePattern !== "string"
  )
    return false;
  return (
    policy.subject === subject &&
    policy.actions.some(
      (candidate: unknown) =>
        candidate === action ||
        ACTION_GROUPS[candidate as "secret.read"]?.includes(action),
    ) &&
    resourceMatches(policy.resourcePattern, resource)
  );
}

function resourceMatches(pattern: string, resource: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.endsWith("/*")) return pattern === resource;
  return resource.startsWith(pattern.slice(0, -1));
}
