# Decisions

### D-001 — Greenfield internal control plane with compatibility-preserving migration

Date: 2026-07-14
Phase/task: Run architecture
Issue(s): umbrella #12

Decision: Build a greenfield internal control plane and migrate from the active MCP service without breaking compatibility or cutting over before tested gates pass.

Reason: The target needs explicit identity, authorization, version/lifecycle, reconciliation, audit, recovery, and rotation contracts that the retired deployment did not establish as one trustworthy system.

Alternatives considered: reactivate the legacy services; adopt Google Secret Manager.
Impact: legacy code may be reused only after it satisfies the new boundaries; historical green tests do not certify the replacement; current `mcp2cli vaultwarden-secrets` consumers and port 3001 remain protected until cutover.
Validation required: phase acceptance plus exact Full-tier runtime/security review before reactivation.

### D-002 — Payload custody and control-plane split

Date: 2026-07-14
Phase/task: Architecture
Issue(s): metadata/reconciliation #16

Decision: Vaultwarden exclusively owns encrypted secret payloads. A small independent non-secret store owns logical IDs, immutable version metadata, aliases, policy references, operations, reconciliation, audit, and outbox state.

Reason: Separate durable orchestration and policy state without duplicating payload custody.
Alternatives considered: put all metadata into Vaultwarden item fields; store payloads in the new database.
Impact: schemas, logs, events, tests, and backups must structurally prevent payload leakage; operations coordinate two systems and require reconciliation.
Validation required: payload-rejection tests, transactional/reconciliation failures, coordinated restore proof, no-secret scan.

### D-003 — Retired runtime remains contained

Date: 2026-07-14
Phase/task: Phase 0
Issue(s): retired trigger #13, runtime #14
Status: Superseded by D-006 after the active MCP dependency was discovered.

Historical decision: Keep four legacy services and two timers stopped and disabled, ports 3000-3003 closed, and preserved data/snapshot untouched until the hard reactivation gate passes.

Current decision: Preserve `vaultwarden-secrets-mcp.service` on port 3001 plus `vw-session-refresh.timer` and `vw-snapshot.timer`; keep only retired ports 3000, 3002, and 3003 and their services contained until an approved cutover.

Reason: Containment prevents an unaudited runtime or deployment trigger from returning during redesign.
Alternatives considered: run the legacy stack during development.
Impact: live testing waits for controller approval; replacement units and ingress must be separately declared; compatibility checks must protect the active MCP path.
Validation required: refreshed unit, timer, port, SSH/node-exporter, and snapshot receipts before any approved start.

### D-004 — Packet and epic are the run control plane

Date: 2026-07-14
Phase/task: Run administration
Issue(s): #10-#22

Decision: Use umbrella issue #12 plus this packet; do not create a GitHub Project board unless Rico later requests one.

Reason: The repository currently has no board, and the supplied run contract explicitly chooses the epic/packet boundary.
Alternatives considered: automatically create a Project.
Impact: the controller keeps issue numbers/status and packet progress synchronized manually.
Validation required: live issue cross-reference at phase changes and placeholder replacement after issue creation.

### D-005 — Defer cloud parity and operator console

Date: 2026-07-14
Phase/task: Scope
Issue(s): #11

Decision: Defer multi-region replication, CMEK/HSM, data residency, multi-tenancy, cloud IAM federation, and #11 implementation. The console may begin only after Phases 0-4 and its dependencies pass, and it may never reveal secret payloads in a browser.

Reason: These capabilities do not belong to the smallest safe internal/homelab control plane.
Alternatives considered: pursue Google Secret Manager feature parity and build the console concurrently.
Impact: issues may document future work but current implementation must not widen to it.
Validation required: scope readback at every task and controller activation before #11.

### D-006 — Correct the LiteLLM-only assumption

Date: 2026-07-14
Phase/task: Compatibility baseline
Issue(s): #23, #14, #22; #13 noted as corrected validation context

Decision: The prior LiteLLM-only assumption was incorrect. The active `vaultwarden-secrets-mcp.service` on port 3001 and its required timers were restored; ports 3000, 3002, and 3003 remain contained.

Reason: `mcp2cli vaultwarden-secrets` is an active shared dependency, so compatibility and migration are not greenfield even though the internal control plane may be greenfield.

Alternatives considered: redesign first and cut over later without a compatibility baseline; stop port 3001 during migration.
Impact: compatibility inventory, contract tests, rollback, and no-downtime gates precede runtime redesign and pilot migration.
Validation required: non-secret MCP probe, tool/schema contract tests, port/timer health, rollback, and no-downtime cutover evidence.

## Future Decision Template

```md
### D-XXX — Title

Date:
Phase/task:
Issue(s):

Decision:
Reason:
Alternatives considered:
Impact:
Validation required:
```

Record any doc/source disagreement, scope change, deferred prerequisite, persistence/runtime choice, or skipped required validation before proceeding.
