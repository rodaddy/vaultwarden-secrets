# Validation Contract

## Policy

Use the narrowest reliable test during implementation and the full local bundle at phase/PR boundaries. Commands must run against the exact candidate head. Live, remote, destructive, restore, or secret-rotation checks require controller approval. Never include secret values in fixtures, command arguments, logs, screenshots, artifacts, or receipts.

## Command Ladder

```zsh
# During a task: replace with exact new/changed test files
bun test <targeted-test-file>

# Phase/PR boundary
bun test
bun run typecheck

# Changed-content secret scan; use the same range contract as CI
betterleaks git --redact=100 --no-banner --log-opts='<base>..<head>' .

# Documentation/patch hygiene
git diff --check -- docs/goal-runs/gsm-replacement
```

Deployment/runtime candidates, executed only in the appropriate target environment and with exact paths supplied by the issue:

```zsh
systemd-analyze verify <declared-unit-files>
systemctl is-enabled <retired-and-replacement-units>
systemctl is-active <retired-and-replacement-units>
ss -lnt
nginx -t
```

Do not normalize an expected disabled/inactive exit code into a false failure or false pass; record stdout, exit status, unit names, and target identity. No service-start command belongs in an automated pre-reactivation bundle.

## Validation Matrix

| Boundary | Targeted evidence | Phase/PR evidence |
| --- | --- | --- |
| Release/runtime | auth, replay, digest, rollback, unit/config tests | full tests/typecheck, unit and ingress verification, closed-port/disabled-unit receipt, Full review |
| Workload identity | positive and negative token/certificate tests | expiry, revocation, audience, spoofing, restart, deployed transport proof |
| Metadata/reconciliation | schema, transaction, migration, drift, payload-rejection tests | disposable migrate/restore/reconcile, full local bundle |
| Versions/lifecycle | transitions, immutability, alias atomicity, concurrency/retry | fault injection and full local bundle |
| Authorization | default-deny policy matrix and every route/adapter | enumeration/cache/alias bypass negatives, Full security review |
| Audit/outbox | redaction canaries, transaction, crash/retry/dedup | durable readback, retention/tamper evidence, no-secret scan |
| Recovery | corrupt/stale/mismatched backup and session-loss tests | approved isolated restore and reconciliation evidence |
| Rotation | every state transition, crash point, lease, compensation | approved disposable end-to-end rotation and restart/replay |
| Pilot | client contract and failure-mode tests | real deployed-path authorized read plus denied read, audit correlation, restart and rollback |
| MCP compatibility | current `mcp2cli vaultwarden-secrets` tool/schema contract and shadow checks | port 3001 health, required timers, rollback, and no-downtime cutover evidence |

## Live Smoke Requirements

Only after all P0 acceptance, Full-tier review, exact local validation, and controller approval:

1. Reconfirm retired units stay disabled/inactive and undeclared ports stay closed.
2. Start only the declared replacement path using the approved release mechanism.
3. Exercise the real ingress, identity provider/transport, authorization engine, control plane, and Vaultwarden backend—not a mocked or localhost bypass.
4. Prove one authorized retrieval and one denied retrieval using non-sensitive canary material.
5. Correlate redacted audit/outbox records without printing the returned value.
6. Restart, repeat, and prove rollback/containment.

`systemctl active`, open ports, and `/health` are supporting evidence only.

## No-Secret Evidence

- Betterleaks passes on the exact changed commit range with full redaction and validation disabled.
- Tests use synthetic canaries, never production-shaped credentials.
- Logs and audit fixtures assert absence of payload, token, session, private-key, and credential fields.
- Metadata schema rejects payload-bearing fields; database inspection reports schema/key names and counts only.
- Live receipts use request/correlation IDs, logical IDs, versions, statuses, and hashes where safe—never returned values or auth material.

## Failure Handling and Acceptance

Record the exact command, head, target, output summary, next diagnostic layer, owner, and fix. A manually diagnosed failure gets a regression or a documented non-automatable reason. A phase cannot advance until targeted and phase gates pass, review findings are resolved or explicitly controller-waived, packet state is current, and no unapproved scope expansion remains. Only the controller can approve reactivation or final readiness.
