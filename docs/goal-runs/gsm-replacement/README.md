# Secret-Manager Migration Goal Run

This packet controls a greenfield internal control plane and compatibility-preserving migration from the active MCP service. Vaultwarden remains encrypted payload custody; an independent non-secret control plane owns logical secret IDs, immutable versions, aliases, policy, operations, reconciliation, and redacted audit state.

## Active Compatibility Baseline

- `vaultwarden-secrets-mcp.service` on port 3001 is an active shared dependency for `mcp2cli vaultwarden-secrets`.
- `vw-session-refresh.timer` and `vw-snapshot.timer` are restored and required while compatibility work proceeds.
- Ports 3000, 3002, and 3003 remain contained and closed; their services remain disabled.
- No runtime redesign or cutover may break the current MCP contract or stop port 3001 before an approved replacement cutover.

## Control Plane

- Tracking source: this packet plus umbrella issue #12. This repository has no Project board as of 2026-07-14.
- Existing issues: [#10](https://github.com/rodaddy/vaultwarden-secrets/issues/10), rotation epic; [#11](https://github.com/rodaddy/vaultwarden-secrets/issues/11), optional operator console.
- Verified implementation issues, in dependency order: #23 MCP compatibility baseline; independent #13 retired-trigger removal; #14 hardened runtime; #15 workload identity; #16 metadata store; #17 version lifecycle; #18 authorization; #19 audit/outbox; #20 recovery; #21 rotation engine under epic #10; and #22 pilot consumer/cutover.
- Historical inputs such as the dirty legacy checkout, stopped live services, and preserved snapshot are evidence only. This branch, current issues, and verified deployed state are authoritative.

## Packet Index

- `EXECUTION_WORKFLOW.md`: scope-lock and phase gates.
- `TASKS.md`: ordered implementation map and executable acceptance checks.
- `AGENTS.md`: bounded implementation and review roles.
- `PROGRESS.md`: current state, receipts, blockers, and handoff.
- `VALIDATION.md`: local, deployment, live, and no-secret evidence contract.
- `DECISIONS.md`: controlling architecture and run decisions.

## Ordered Scope

1. Compatibility baseline and cutover safety.
2. Containment and runtime envelope.
3. Workload identity and control-plane foundation.
4. Version/lifecycle semantics, authorization, and audit.
5. Recovery and durable rotation.
6. One real workload pilot.
7. Optional operator console only after its dependencies pass.

## Hard Reactivation Gate

No legacy or replacement live service may start until every P0 runtime/security issue has met its acceptance criteria, the exact candidate has passed Full-tier review and required fix verification, the validation contract in `VALIDATION.md` is satisfied, and the controller explicitly approves reactivation. A healthy process or `/health` response alone never satisfies this gate.

## Explicit Non-Goals

Multi-region replication, CMEK/HSM, data residency, multi-tenancy, cloud IAM federation, a generic password-manager replacement, browser secret reveal, and implementation of #11 before its dependencies are complete.
