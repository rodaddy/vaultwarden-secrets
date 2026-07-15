# Secret authorization

`server/authz` is the sole secret-level authorization decision point. It is default deny: no matching policy, malformed policy data, malformed requests, and conflicting matching allow/deny rules all deny.

## Model

A policy has a workload `subject`, a `resourcePattern`, one or more `actions`, and an `allow` or `deny` effect. Subjects are authenticated workload identities, not user-facing labels. Policies hold only metadata; secret values, version contents, tokens, and credentials never enter this model or its audit records.

Supported actions are `secret.get`, `secret.list`, `secret.create`, `secret.addVersion`, `secret.disable`, `secret.enable`, `secret.destroy`, `alias.move`, `policy.set`, `rotate`, and `reconcile`. The `secret.read` action group expands to `secret.get` and `secret.list`.

Precedence is fail closed:

1. A malformed request denies with `reason: 'malformed'`. A malformed stored policy cannot match or grant; when it leaves no valid matching policy, the request denies with `reason: 'malformed'`.
2. No matching rule denies with `reason: 'no-policy'`.
3. A matching allow and deny are conflicting and deny with `reason: 'ambiguous'`. This is the conservative form of explicit-deny precedence.
4. A matching deny denies; matching allows without a deny allow.

## Resource glob semantics

Only three pattern forms exist:

- `name` matches that exact logical secret name.
- `*` matches every non-empty resource target.
- `infra/*` matches a resource beginning with `infra/`, including nested names.

Globs are terminal prefix globs only. `infra/*` does not match `infra` or `infrastructure-x`; mid-string globs such as `infra*` and multiple globs are malformed and deny. Resource targets passed to `authorize` are exact names or `*` for an operation scoped across all resources; callers never pass a prefix glob as a target.

## Store and audit contract

`InMemoryPolicyStore` is for tests. `SqlitePolicyStore` receives an already opened `bun:sqlite` `Database`; the control-plane migration runner must apply `server/control-plane/migrations/100_authz.sql` before creating it.

`setPolicy` is idempotent over subject, pattern, canonical action array, and effect. It returns a stable ID plus `before`/`after` summaries and `changed`, so the authenticated policy-management caller can append its own durable audit entry. `removePolicy` returns the same mutation receipt shape.

`onDecision` receives only `{ subject, action, resource, allow, reason }`. It deliberately has no secret value, version content, token, or credential.

## Wiring-pass integration contract

The REST, MCP, and credential-proxy passes must share one injected engine and call it before looking up, listing, resolving, creating, mutating, or returning any secret/version/alias:

```ts
const decision = authz.authorize({
  subject: c.get('clientId') as string,
  action: 'secret.get',
  resource: logicalSecretName,
  onDecision: appendRedactedAuditDecision,
});

if (!decision.allow) {
  const denial = normalizeDenial('secret.get');
  return c.json(denial.body, denial.status);
}
```

For list, reconciliation, rotation, and policy-wide operations, use `resource: '*'`. The wiring must use this constant-shape early return before any resource lookup or version resolution, and should avoid distinguishable extra work on denial paths. It must never expose `Decision.reason` to callers; the reason is audit-only.

## Integration acceptance criteria (owned by pilot/wiring pass)

For the get, list, and fields REST endpoints, every authorization denial and every backend or lookup error (including a secret-not-found result or database error) MUST use one canonical, byte-identical `404` response body: `{"error":"Secret not found"}`. No raw `Error.message` may ever appear in that response.

No conditional `503`, or any other status or body, may distinguish denied, not-found, and backend-error cases: all three MUST be indistinguishable to callers. The pilot/wiring pass MUST add REST-boundary byte-equivalence tests proving that each case returns the identical status code and identical response-body bytes.
