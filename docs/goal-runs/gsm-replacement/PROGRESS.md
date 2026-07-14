# Progress

## Current State

- Status: packet preparation; implementation not started.
- Current phase: compatibility baseline and migration guard are pending; the active MCP baseline is restored; P0 code and runtime work is pending.
- Control plane: this packet plus umbrella issue #12; no repository Project board currently exists.
- Scope: greenfield internal control plane with compatibility-preserving migration from the active MCP service, Vaultwarden payload custody, and an independent non-secret control plane.

## Containment Receipts

The controller-provided containment inspection recorded:

- `vaultwarden-secrets-mcp.service` on port 3001 is restored and required by `mcp2cli vaultwarden-secrets`; `vw-session-refresh.timer` and `vw-snapshot.timer` are restored and required.
- Retired services remain disabled; ports 3000, 3002, and 3003 remain closed.
- `vw-deploy.timer` was already disabled before containment and was not one of the two stopped timers.
- Ports 3000, 3001, 3002, and 3003 closed.
- SSH access and node-exporter preserved.
- Existing data and encrypted snapshot preserved.

These receipts establish the compatibility-preserving baseline. They are not authorization to cut over or redesign the runtime and must be refreshed before controller approval.

## Phase Checklist

- [ ] Phase 0A: establish MCP compatibility baseline and cutover guard.
- [x] Phase 0B: #13 remove retired deploy trigger and prevent reactivation.
- [ ] Phase 0C: #14 hardened runtime and ingress envelope.
- [ ] Phase 1A: #15 workload-identity transport.
- [ ] Phase 1B: #16 metadata/reconciliation store.
- [ ] Phase 2A: #17 immutable versions, aliases, lifecycle.
- [ ] Phase 2B: #18 centralized authorization.
- [ ] Phase 2C: #19 durable audit/outbox.
- [ ] Phase 3A: #20 backup, restore, session recovery.
- [ ] Phase 3B: #21 durable rotation engine under epic #10.
- [ ] Phase 4: #22 one real workload pilot.
- [ ] Phase 5: #11 optional console, deferred.

## Verification Log

| Date | Scope | Evidence | Result |
| --- | --- | --- | --- |
| 2026-07-14 | Historical legacy dirty checkout | 229 passed, 36 skipped, 0 failed; typecheck passed | Context only; not proof for this clean branch |
| 2026-07-14 | Live containment handoff | Four services and two timers inactive/disabled; ports 3000-3003 closed; SSH/node-exporter and snapshot preserved | Containment recorded; refresh required before reactivation |
| 2026-07-14 | MCP dependency correction and restoration | MCP service plus session/snapshot timers enabled and active; non-secret `snapshot_info` healthy and current | Active compatibility baseline restored; ports 3000, 3002, and 3003 remain closed |
| 2026-07-14 | Issue #13 containment cleanup | Retired-trigger test: 2 passed; full suite: 191 passed, 18 skipped, 0 failed; typecheck, diff check, and focused retired-reference scan passed | Controller verified port 3002 closed while port 3001 and non-secret MCP probe remained healthy |

## Blockers and Risks

- DAG: #13 is independently ready with no #23 dependency; #23 gates #14 and #22; downstream dependencies otherwise remain unchanged.
- Runtime topology, control-plane persistence technology, and pilot workload remain implementation decisions within the acceptance boundaries.
- The legacy code exposes multiple auth profiles and deployment paths; retaining parallel contracts would undermine the single identity/runtime design.
- Preserved snapshot/data are recovery assets, not proof that coordinated restore works.

## Handoff

Next exact task: controller assigns #13 without starting live services. At every handoff record exact head, changed files, validation, review state, blockers, decisions, and next issue.
