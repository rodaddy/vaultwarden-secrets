# Progress

## Current State

- Status: PR #24 is in the focused verification gate for issue #13; the terminal audit has not started.
- Current phase: the active MCP baseline is restored; the #13 focused verification loop is active and the terminal audit awaits a clean verdict; the #23 compatibility baseline remains the next implementation issue.
- Control plane: this packet plus umbrella issue #12; no repository Project board currently exists.
- Scope: greenfield internal control plane with compatibility-preserving migration from the active MCP service, Vaultwarden payload custody, and an independent non-secret control plane.

## Containment Receipts

The controller-provided containment inspection recorded:

- `vaultwarden-secrets-mcp.service` on port 3001 is restored and required by `mcp2cli vaultwarden-secrets`; `vw-session-refresh.timer` and `vw-snapshot.timer` are restored and required.
- Retired services remain disabled; ports 3000, 3002, and 3003 remain closed.
- `vw-deploy.timer` was already disabled before containment and was not one of the two stopped timers.
- SSH access and node-exporter preserved.
- Existing data and encrypted snapshot preserved.

These receipts establish the compatibility-preserving baseline. They are not authorization to cut over or redesign the runtime and must be refreshed before controller approval.

## Phase Checklist

- [ ] Phase 0A: establish MCP compatibility baseline and cutover guard.
- [ ] Phase 0B: #13 remove retired deploy trigger and prevent reactivation — PR #24 review fixes and verification in progress.
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
| 2026-07-14 | Initial live containment handoff | Four services and two timers inactive/disabled; ports 3000-3003 closed; SSH/node-exporter and snapshot preserved | Superseded after the active MCP dependency was discovered |
| 2026-07-14 | MCP dependency correction and restoration | MCP service plus session/snapshot timers enabled and active; non-secret `snapshot_info` healthy and current | Active compatibility baseline restored; ports 3000, 3002, and 3003 remain closed |
| 2026-07-14 | Issue #13 containment cleanup | Retired-trigger test: 2 passed; full suite: 191 passed, 18 skipped, 0 failed; typecheck, diff check, and focused retired-reference scan passed | Controller verified port 3002 closed while port 3001 and non-secret MCP probe remained healthy |
| 2026-07-14 | PR #24 review-fix validation | Retired installed unit moved to a root-only backup and systemd reloaded; unit path absent/inactive; port 3001, MCP service, and required timers active/enabled; ports 3000, 3002, and 3003 closed; non-secret `snapshot_info` current; focused test 3 passed; full suite 192 passed, 18 skipped, 0 failed; typecheck, ShellCheck, shell syntax, and diff check passed | Initial findings fixed; first focused verification found daemon-reload ordering and phase-label follow-ups |

## Blockers and Risks

- DAG: #13 is independent; the full downstream dependency graph is explicit in `TASKS.md`.
- Runtime topology, control-plane persistence technology, and pilot workload remain implementation decisions within the acceptance boundaries.
- The legacy code exposes multiple auth profiles and deployment paths; retaining parallel contracts would undermine the single identity/runtime design.
- Preserved snapshot/data are recovery assets, not proof that coordinated restore works.

## Handoff

Next exact task: complete the focused verification gate, then run the opposite-runtime terminal audit without disrupting the active MCP path. After merge authorization and closure, begin #23. At every handoff record exact head, changed files, validation, review state, blockers, decisions, and next issue.
