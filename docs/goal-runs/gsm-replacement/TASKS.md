# Task Map

All module paths are likely owning boundaries inferred from the current repository; the implementation owner must confirm them during scope lock. Commands are candidates and must be refined to exact test files as they are added. Never place credential values in commands, fixtures, output, or receipts.

## Phase 0 — Compatibility, containment, and hardened runtime

### P0.0 — #23: P0: establish the MCP compatibility baseline and cutover guard

- Likely owners: MCP adapter/tool schema, `mcp2cli` contract fixtures, deployment/runbook validation, and compatibility tests.
- Acceptance: inventory current MCP consumers and tool/schema behavior; capture compatibility tests for the current `mcp2cli vaultwarden-secrets` contract; define rollback and no-downtime cutover gates; preserve port 3001 and both required timers until approved cutover.
- Regressions: changed tool/schema behavior, unavailable port 3001, stopped required timer, untested rollback, or cutover interruption.
- Verify: contract/shadow tests, non-secret MCP probe, port/timer health receipt, rollback rehearsal, and no-downtime evidence.

### P0.1 — #13: P0: remove the retired port 3002 deploy trigger and prevent reactivation

- Likely owners: `deploy/webhook.ts`, `deploy/systemd/vw-deploy-webhook.service`, install/deploy wiring, retirement documentation, and a retirement regression test.
- Acceptance: remove the retired entrypoint, unit, and install/deploy wiring; document the retired runtime; add a regression that prevents reintroduction; preserve existing data.
- Regressions: retired source, unit, or install reference reintroduced; live application port reopened.
- Verify: retired-trigger regression; `bun test`; `bun run typecheck`; retired-reference scan; port 3002 remains closed while port 3001 and a non-secret MCP probe remain healthy.

### P0.2 — #14: P0: establish a declared hardened runtime and ingress envelope

- Likely owners: `deploy/systemd/*.service`, `deploy/systemd/*.timer`, `deploy/nginx/`, `deploy/DEPLOY.md`, `server/main.ts`, runtime tests.
- Acceptance: one declared service/port/ingress topology; non-root least privilege; fail-closed configuration; explicit state/cache/log paths and permissions; dependency and restart behavior; firewall/proxy contract; no legacy ports 3000-3003 exposed before approval; preserve the active port 3001 MCP contract until approved cutover.
- Dependency: #23 MCP compatibility baseline.
- Regressions: insecure profile, missing auth material, writable code/config, proxy-header trust, startup on an undeclared port, restart enabling retired units.
- Verify: targeted config tests; `systemd-analyze verify <unit-files>` on the target runtime; proxy syntax check; unit disabled/inactive and port-closed checks before approval; Full-tier runtime/security review.

## Phase 1 — Identity and control-plane foundation

### P1.1 — #15: P0: define one authenticated workload-identity transport contract

- Likely owners: `server/routes/auth.ts`, `server/middleware/{combined-auth,mtls-auth,oauth2-auth,jwt-auth}.ts`, `server/utils/jwt.ts`, `server/config/`, auth tests.
- Acceptance: one canonical machine identity; authenticated encrypted transport; audience/scope/expiry/revocation rules; no bearer fallback or header spoofing; identity reaches authorization and audit consistently.
- Regressions: missing/expired/wrong-audience token, revoked identity, spoofed forwarded certificate, split identity between layers, refresh after revocation.
- Verify: targeted auth unit/integration tests; negative transport tests; `bun test`; `bun run typecheck`; secret scan.

### P1.2 — #16: P0: add the non-secret control-plane metadata and reconciliation store

- Likely owners: new `server/control-plane/` or `control-plane/` module, schema/migrations, reconciliation tests; Vaultwarden adapter at `server/vault-client.ts`.
- Acceptance: durable schema for logical IDs, versions, aliases, policy references, operations, reconciliation state, and audit/outbox references; transactions and migration/rollback defined; payload fields structurally forbidden; reconciliation is idempotent and fail-closed.
- Regressions: duplicate logical ID, orphan version, stale alias, transaction interruption, schema downgrade, payload-like field insertion, Vaultwarden/control-plane drift.
- Verify: targeted repository/migration/reconciliation tests; migration up/down on disposable data; `bun test`; `bun run typecheck`; secret scan.

## Phase 2 — Lifecycle, authorization, and audit

### P2.1 — #17: P0: implement immutable secret versions, aliases, and lifecycle semantics

- Likely owners: control-plane domain/services, `server/vault-client.ts`, API/CLI adapters, lifecycle tests.
- Acceptance: versions never mutate; alias promotion is atomic; lifecycle transitions are explicit and validated; retries are idempotent; concurrent writers cannot lose updates; deletion/retention semantics preserve required evidence.
- Regressions: overwrite existing version, alias race, invalid transition, duplicate retry, partial Vaultwarden write, rollback to missing version.
- Verify: targeted lifecycle and concurrency tests; `bun test`; `bun run typecheck`; secret scan.

### P2.2 — #18: P0: enforce centralized secret-level authorization

- Likely owners: new policy module, request middleware, `server/utils/folder-scope.ts` replacement/adapter, API and MCP routes, authorization tests.
- Acceptance: one default-deny policy engine evaluates workload identity, logical secret ID, operation, and version/alias constraints; every retrieval/mutation path uses it; denials do not disclose existence; cache cannot bypass authorization.
- Regressions: cross-secret access, route bypass, list/search enumeration, stale cache after policy change, alias-based bypass, inconsistent 403/404 disclosure.
- Verify: policy matrix and route/MCP negative tests; `bun test`; `bun run typecheck`; secret scan; Full-tier security review.

### P2.3 — #19: P1: add a durable redacted audit ledger and lifecycle event outbox

- Likely owners: replace/extend `server/middleware/audit-logger.ts`, control-plane audit/outbox modules, dispatch worker, tests.
- Acceptance: append-only durable audit entries and transactional outbox; correlation and actor/secret/version/operation/result metadata; retry-safe delivery; retention/tamper controls; no payloads, credentials, or session material.
- Regressions: secret value in log, audit loss on failure, duplicate delivery, event before transaction commit, missing denial event, uncontrolled log path.
- Verify: redaction/canary tests, crash/retry/outbox tests, `bun test`; `bun run typecheck`; secret scan.

## Phase 3 — Recovery and durable rotation

### P3.1 — #20: P1: deliver backup, restore, and session-recovery evidence

- Likely owners: `snapshot.ts`, `snapshot.test.ts`, new control-plane backup/restore tooling, systemd units/runbooks.
- Acceptance: encrypted payload and non-secret metadata have coordinated backup points; restore is rehearsed into isolation; integrity/freshness are verified; session loss and re-authentication are documented; RPO/RTO and rollback evidence are recorded without secrets.
- Regressions: mismatched payload/metadata restore, corrupt snapshot, stale session, missing key material, restore into live path, secret-bearing evidence.
- Verify: disposable restore drill; integrity and reconciliation checks; targeted recovery tests; `bun test`; `bun run typecheck`; secret scan. Live drills require controller approval.

### P3.2 — #21: P1: implement the durable rotation engine for issue #10

- Likely owners: new rotation operation/worker modules, control-plane operations/outbox, Vaultwarden adapter, consumer verification adapters, rotation tests.
- Acceptance: durable state machine; idempotent retries and leases; stage new version, verify consumer, atomically promote alias, revoke/retire old version, and compensate safely; restart resumes without duplication; every transition is audited.
- Regressions: crash at each transition, concurrent rotations, consumer verification failure, alias promotion failure, duplicate event, rollback after partial revocation.
- Verify: transition and fault-injection tests; restart/replay tests; `bun test`; `bun run typecheck`; secret scan; approved end-to-end rotation through a disposable consumer.

## Phase 4 — Pilot adoption

### P4.1 — #22: P1: migrate and prove one real workload consumer

- Likely owners: selected consumer integration, client/API contract, deploy configuration/runbook, pilot tests.
- Acceptance: first migrate and prove `mcp2cli vaultwarden-secrets` as the compatibility-sensitive consumer path with shadow/contract checks, then one named workload uses canonical identity and deployed secret path; least-privilege policy; no legacy fallback; version/alias and audit evidence correlate; restart, rollback, and no-downtime cutover pass; no secret appears in logs, process args, fixtures, or receipts.
- Dependency: #23 MCP compatibility baseline.
- Regressions: identity expiry, denied secret, control-plane outage, Vaultwarden outage, stale alias, rollback, consumer restart.
- Verify: local contract tests, deployment/unit checks, then controller-approved live smoke through the real ingress/backend path including an authorized read and denied read. `/health` alone is insufficient.

## Phase 5 — Deferred console

### P5.1 — #11: P1: add an optional secure operator web console

- Likely owners: new console surface and operator API only after dependencies are verified.
- Acceptance: remains deferred until Phases 0-4; authenticated operator actions use centralized policy and audit; browser never reveals secret payloads.
- Verify: define only when the controller activates #11; do not implement in this run before dependencies.
