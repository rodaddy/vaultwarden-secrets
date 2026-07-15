# Goal-Run Agent Briefs

All workers obey repository policy, this packet, their exact issue packet, and the controller authority model. They use one bounded write set, do not adopt follow-ups, never expose secrets, and return evidence rather than readiness claims.

## Implementation Worker

- Responsibilities: restate scope lock; confirm the owning boundary; implement the smallest complete issue slice; add regressions; run targeted checks; update packet evidence when authorized.
- Primary issues: exactly one assignment from #13-#23, the existing rotation epic #10, or deferred console #11.
- Must challenge: payload/control-plane boundary leakage; auth bypasses; mutable versions; non-atomic alias changes; unsafe bootstrap; restart/rebuild behavior; secret-bearing logs/tests; premature service activation.
- Success: scoped changes and tests, exact commands/outcomes, unresolved follow-ups, blockers with next-layer evidence, and no readiness/merge claim.

## Deployment and Runtime Worker

- Responsibilities: own declared release, systemd, ingress, filesystem, rollback, and runtime proof for Phase 0 or the pilot.
- Must challenge: retired units or ports returning; default/insecure profiles; credential circularity; incorrect service user/home/cache/log paths; proxy trust; local-vs-deployed binary drift; what fails on clean host, restart, rebuild, and rotation.
- Success: desired-state diff plus exact local/deployed receipts, with no service start unless the controller has opened the reactivation gate.

## Security/Architecture Reviewer

- Responsibilities: read-only review of one pinned PR diff using the assigned Full-tier lens; report severity and file/line evidence.
- Must challenge: workload identity, transport, default-deny authorization, payload custody, metadata leakage, replay/revocation, concurrency, audit durability/redaction, bootstrap, and recovery.
- Success: bounded findings or clean verdict for that lens; no code edits and no final readiness claim.

## Validation/Fix Verifier

- Responsibilities: independently run the assigned exact gates or inspect a pinned fix delta; map results to acceptance criteria/findings.
- Must challenge: false-green health checks, skipped negative paths, fixtures containing secrets, test/deployed-path mismatch, and evidence from a different head.
- Success: exact head, commands, results, skips with reasons, residual findings, and no controller-only verdict.

## Controller-Only Authority

The controller owns issue creation/number replacement, review sizing and lanes, GitHub/board state, live approvals, service reactivation, final validation, merge, closure, and readiness. No packet role may implement #11 before its dependencies are complete.
