# Execution Workflow

## Source-of-Truth Rule

Use current source and linked issue state for code and scope truth. Use freshly verified deployed state for runtime truth. This packet coordinates those owning sources but does not override either one. Treat legacy checkout results and prior live observations as historical evidence. If an owning source contradicts this packet, inspect the owning path, record the decision in `DECISIONS.md`, update the packet, then make the smallest owned change.

## Preflight Gate

Before each task, read this packet and the linked issue; refresh branch/dirty state and live issue state; verify prerequisites; record the scope lock below; identify a regression candidate; and obtain approval before any live, remote, expensive, or destructive check.

```md
Phase/task:
Issue(s):
Objective:
In scope:
Out of scope:
Likely files:
Acceptance criteria:
Targeted validation:
Phase validation:
Regression candidates:
Prerequisites/blockers:
```

## Task Loop

Scope -> Tasks -> Implementation -> Targeted validation -> Regression -> Phase validation -> Fixes -> Packet update. Any failure requiring manual diagnosis becomes an automated regression when practical; otherwise record why it cannot be automated.

## Phase Cards

### Phase 0 — Compatibility, containment, and runtime envelope

- Establish the MCP compatibility baseline before redesign: inventory current consumers and tool/schema behavior, capture current `mcp2cli vaultwarden-secrets` contract tests, and define rollback/no-downtime cutover gates.
- Keep port 3001 and its required timers healthy until approved cutover.

- Preserve the stopped/disabled state of retired services and the closure of ports 3000, 3002, and 3003.
- Remove only the retired port 3002 deploy trigger and prevent reactivation; replacement release automation is deferred to #14/#15.
- Declare and enforce the hardened systemd, filesystem, network, ingress, rollback, and secret-bootstrap envelope.
- Stop if any step would start a contained or replacement service before the hard reactivation gate; the protected MCP service on port 3001 remains active.

### Phase 1 — Identity and control-plane foundation

- Define one authenticated workload-identity transport contract.
- Add the independent non-secret metadata/reconciliation store.
- Prove the store cannot become payload custody and fails closed on ambiguity.

### Phase 2 — Lifecycle, authorization, and audit

- Implement immutable versions, atomic aliases, lifecycle transitions, centralized secret-level authorization, durable redacted audit, and an event outbox.
- Reject secret values, session tokens, credentials, and decrypted payloads from metadata, logs, errors, events, and fixtures.

### Phase 3 — Recovery and rotation

- Produce backup/restore/session-recovery evidence before enabling #10.
- Implement restart-safe, idempotent rotation with staged publish, consumer verification, alias promotion, rollback, and durable operation state.

### Phase 4 — Pilot adoption

- Migrate one named workload through the real deployed path.
- Migrate and prove `mcp2cli vaultwarden-secrets` as the first compatibility-sensitive consumer path, including shadow/contract checks, rollback, and no-downtime evidence.
- Prove identity, authorization, version resolution, audit linkage, failure behavior, and rollback without bypass paths.

### Phase 5 — Deferred console

- Keep #11 pending until Phases 0-4 and all dependencies are controller-verified.
- The console must not reveal secret payloads in a browser.

## Review and Completion

Reviews occur at the PR boundary. Auth, secrets, deploy/runtime, schema, and public transport work is Full tier. Only the controller may advance gates, approve reactivation, declare readiness, merge, close issues, or declare the goal complete.

Progress updates must record: date, phase/task, issue, exact head/diff, files, commands and outcomes, review receipt, blockers, decision changes, and next task.
