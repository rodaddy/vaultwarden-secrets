# Pilot cutover: the MCP consumer as the first migrated workload (#22)

This documents the one real workload migrated onto the new control plane +
rotation engine: the **MCP server** (`server/mcp.ts`, port `3001`,
`vaultwarden-secrets-mcp.service`). It is the pilot consumer that proves the
end-to-end path — MCP compatibility, control-plane-backed rotation, and
no-downtime credential replacement — against real components rather than
fakes. Everything below is scoped to what the code actually does.

## What "migrated" means here

The MCP server keeps its frozen read/write tool contract (verified by
`server/__tests__/mcp-contract.test.ts`) and gains one additive,
`allowWrites`-gated tool: **`rotate_secret`**. The tool constructs a
`RotationEngine` (`server/rotation/engine.ts`) wired to the REAL merged modules
through `server/rotation/wiring.ts`:

- Control plane: `server/control-plane/store.ts` (`ControlPlaneStore`) —
  immutable versions, aliases, audit ledger, outbox — behind
  `ControlPlaneStoreAdapter`.
- Authorization: `server/authz` `AuthorizationEngine` (default-deny) behind
  `makeAuthorize`, over a `SqlitePolicyStore` sharing the control-plane DB.
- Vault I/O: `server/vault-client.ts` behind `VaultWriterAdapter` /
  `VaultReaderAdapter` (the only material-touching components).
- Consumer reload: allowlist-only `SystemdConsumerReloader` (systemd units from
  `profile.rotationConsumers`; caller-supplied commands are never accepted).

The tool count under `im-aware` therefore moves from **10 to 11**. This is the
deliberate contract evolution the compatibility guard (`docs/compat/cutover-gates.md`)
now records; every other tool's schema is unchanged.

## GCP-Secret-Manager-style rotation for this workload

`rotate_secret` drives the engine's durable state machine, which enforces the
no-downtime ordering **create → stage → reload consumers → verify → alias-move
→ revoke**:

1. **create** — the connector mints a replacement at the provider and stages
   the new material via the arming `VaultWriter`. The engine only ever sees a
   `payloadRef` + `checksum`, never the material.
2. **stage** — the new material is registered as a new immutable **version** in
   the control plane (`addVersion`). The old version is untouched and still
   ENABLED.
3. **verify** — the connector probes **as the new credential**. If verify
   fails, the engine fails closed: no alias move, no revoke, the old credential
   stays live, and a bounded rollback deletes only the just-created new
   credential.
4. **alias-move** — only after verify passes does the alias (`current`) move to
   the new version, under a **compare-and-swap** guard (`expectedFromVersion`)
   enforced atomically by `store.moveAliasCas` (read-alias + check + write in
   one control-plane transaction). A concurrent rotation that moved the alias
   out from under this one loses the CAS and cannot publish a stale version.
5. **revoke** — only after the alias is published is the **old** provider
   credential revoked. First-issuance has no old credential and advances
   directly.

The invariant that gives **no downtime**: the old credential remains valid
until the new one is proven (verify) and published (alias-move). Any failure
after publish never rolls back — it fails closed to `reconcile-required`, so a
published-but-partially-completed rotation is surfaced for repair rather than
silently reverted. This mirrors GCP Secret Manager's add-version /
move-alias / disable-old lifecycle.

### No secret material crosses the boundary

The engine's `LeakGuard` arms on the generated material and scans every
persisted row, audit entry, outbox event, receipt, and sanitized error. The
wiring preserves the control plane's own redaction (the store rejects
secret-looking audit/outbox values and reconciliation-evidence keys matching
`password|token|secret|credential|payload|private_key`). The returned
`RotationReceipt` is identifiers/hashes only. End-to-end non-leak is asserted
in `server/rotation/__tests__/wiring.test.ts`
("drives a first-issuance rotation to done with no material leak").

## Shadow-check / rollback / recovery story

The pilot reuses the compatibility harness already established for #23; no new
cutover tooling was needed.

### Shadow check (pre-cutover, no service stopped)

`scripts/mcp-shadow-check.ts` runs the same non-secret read operations against
the live baseline and the candidate and compares **normalized shapes only**
(redacted hashes; never values). It compares `tools/list` (names + required
inputs), `snapshot_info` (key set + value types), and `list_secrets` (envelope
shape). Gate **C1** in `docs/compat/cutover-gates.md` requires `0 / N`
divergence over `N=20` runs before promotion. Because `rotate_secret` is a new
tool, a shadow check between a pre-#22 baseline and this candidate is EXPECTED
to diverge on `tools/list`; the candidate's own frozen baseline is
`server/__tests__/mcp-contract.test.ts` (now 11 tools).

### Probe (health gate)

`scripts/mcp-probe.ts` runs `initialize` + `tools/list` with a token and exits
`0` only on `HEALTHY` with the expected `toolCount`. It gates the baseline
(P2), the candidate (P4), and the post-promotion service (C3).

### Rollback and recovery

- **Cutover rollback (R1, `docs/compat/cutover-gates.md`):** the promotion is a
  `systemctl restart` of the unit against a captured commit anchor
  (`/root/vw-rollback-anchor`); the active service is never stopped before the
  replacement is proven. Rollback re-checks out the anchor revision and
  restarts in place. Rollback is complete only when the probe is `HEALTHY`, the
  contract test is green, and the required timers are active.
- **Rotation-level recovery:** the rotation engine is crash-safe and
  resumable. `RotationEngine.resumePending()` reclaims expired leases and
  continues each non-terminal job from its persisted stage. A failure after
  publish routes to `reconcile-required` (surfaced via
  `markReconcileRequired`, bridged to the control plane's operation-based
  reconciliation records) instead of an unsafe revert. A failed pre-publish
  rotation rolls back only the new credential, leaving the old one intact.

## REST enumeration parity (PR-D deferred item, closed here)

The get / list / fields REST endpoints (`server/routes/secrets-read.ts`, wired
from `server/main.ts`) now route every authorization denial AND every
backend/lookup error through one canonical, byte-identical `404`
`{"error":"Secret not found"}` (`normalizeDenial` from `server/authz/authz.ts`).
No raw `Error.message` and no conditional `503`/`500` can distinguish denied,
not-found, and backend-error cases, so callers cannot enumerate which secrets
exist or which they may access. Byte-equivalence is proven in
`server/__tests__/secrets-read-parity.test.ts`.

## Verification summary

- `bun test server/__tests__/mcp-contract.test.ts` — frozen contract (now 11
  tools) green.
- `bun test server/rotation/__tests__/wiring.test.ts` — adapter hazards (CAS,
  audit/outbox tx, reconcile shape), authz mapping, vault checksum non-leak,
  and a full end-to-end rotation to `done` against the real control-plane store.
- `bun test server/__tests__/secrets-read-parity.test.ts` — REST byte-equivalence.
- Cutover gates: `docs/compat/cutover-gates.md` (probe P2/P4/C3, shadow C1,
  rollback R1).
