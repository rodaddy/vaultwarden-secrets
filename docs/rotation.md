# Durable Rotation Engine

Implements issue #21 (durable rotation engine) as a child stream of epic #10
(end-to-end credential rotation orchestration).

The engine rotates a supported credential end-to-end: create the replacement at
the provider, stage it as an immutable version in Vaultwarden + the control
plane, reload its consumers, prove the replacement works, move the alias, revoke
the old credential, and produce a redacted receipt. A failure at any stage stops
safely and leaves a recoverable state.

## Security invariants (enforced)

- **No payloads in engine state.** Generated material never enters job rows,
  checkpoints, receipts, audit entries, outbox events, or errors. Connectors
  write material through an ARMING `VaultWriter` proxy that registers each
  written value with a job-scoped `LeakGuard`; the guard stays armed for every
  later stage, scans every persisted/emitted value AND sanitizes stage errors,
  and throws `SecretLeakError` (fail closed) if a value would leak. EVERY error
  string that can reach a persisted/emitted surface (checkpoint error, reconcile
  detail, terminal job `error`, audit, outbox) is routed through the armed guard
  (`safeErr` / `markReconcile` sanitize as the final chokepoint) before it lands.
- **Fail-closed authorization.** `rotate`, `move-alias`, `revoke`, AND
  `rollback` are each authorized via the injected `Authorize` dep before their
  effect runs. A denied `revoke`/`rollback` after publish escalates to
  `reconcile-required` (never a silent skip).
- **Old credential survives failed verification.** `verify()` probes AS the new
  credential (never the management credential); inability to probe returns
  `false` and fails closed. `revoke()` runs only after `verify()` passes AND the
  alias has moved. First issuance (no prior credential) skips revoke entirely.
- **Serialized per credential (fenced lease).** Acquire is ONE statement under
  `BEGIN IMMEDIATE`:
  `INSERT ... ON CONFLICT(secret) DO UPDATE SET owner=excluded.owner,
  fence=CASE WHEN owner unchanged THEN fence ELSE fence+1 END,
  expires_at=excluded.expires_at WHERE expires_at <= excluded.acquired_at OR
  owner = excluded.owner RETURNING owner, fence`. Acquisition SUCCEEDED iff the
  RETURNING row's owner is mine -- no SELECT-then-decide window; the ON CONFLICT
  guard guarantees at most one owner even if two writers interleave. Fence
  increments only on a real ownership change. `SQLITE_BUSY` / "database is
  locked" is treated as a LOSS (a normal outcome), retried with bounded
  synchronous backoff, and NEVER thrown out of the engine. Owner is a
  PER-EXECUTION uuid (not the job id, so two resume runs can't collude as one
  owner). Revalidated/renewed around every awaited effect; every persisted write
  is fenced, so an executor that lost the lease aborts before mutating.
  Duplicate `idempotencyKey` returns the existing job.
- **Crash-safe creation.** A durable creation-intent is set BEFORE the
  connector/vault create call, and the provider handle + refs are persisted in a
  dedicated fenced write immediately after the mint (before the stage
  transition). On resume, a recorded provider handle is ADOPTED (no re-mint).
  Even if that write is lost, connectors are provider-idempotent via a
  deterministic job-scoped handle: the Cloudflare connector LISTs tokens by the
  job-scoped name and DELETEs any orphan from a crashed prior attempt before
  minting exactly one fresh token -- so at most one LIVE credential per job
  survives any crash.
- **Never rollback after publish.** Once the alias may point at the new version,
  any failure fails closed to `reconcile-required`. Rollback (credential
  deletion) is only reachable on a pre-publish failure. On resume, an alias
  already at the target advances to `done` (never re-rolls-back a completed
  move). Rollback is effect-pending: a crash mid-rollback resumes rollback.
- **No stale alias.** The alias move is CAS-guarded (`expectedFromVersion`); a
  retry against a drifted alias is rejected.
- **Allowlist-only consumer hooks.** Consumers map to a declared systemd unit or
  fixed command template. Caller-supplied commands are never accepted. Reloads
  are checkpointed per-consumer so a resume replays only the not-yet-reloaded.
- **Bounded retries.** `maxAttempts` must be a positive integer (Infinity /
  non-integer / non-positive are rejected at construction).

## State machine

```mermaid
stateDiagram-v2
    [*] --> requested
    requested --> provider_created : connector.create + vault write
    requested --> failed : error (retries exhausted)
    provider_created --> staged : control-plane addVersion
    provider_created --> failed
    staged --> consumers_reloaded : allowlisted reload hooks
    staged --> failed
    consumers_reloaded --> verified : connector.verify == true
    consumers_reloaded --> failed : verify == false (old cred intact)
    verified --> alias_moved : CAS-guarded moveAlias (authz: move-alias)
    verified --> failed
    alias_moved --> old_revoked : connector.revoke (authz: revoke); first-issuance skips
    alias_moved --> reconcile_required : ANY post-publish failure (never rollback)
    old_revoked --> done
    old_revoked --> reconcile_required : revoke partial

    failed --> rolling_back : authz: rollback; only reachable PRE-publish
    failed --> reconcile_required : rollback denied / alias already published
    rolling_back --> rolled_back : rollback durably complete
    rolling_back --> reconcile_required : rollback retries exhausted

    done --> [*]
    rolled_back --> [*]
    reconcile_required --> [*]
```

Terminal stages: `done`, `rolled-back`, `reconcile-required`.

The valid-transition graph is data (`server/rotation/states.ts` `TRANSITIONS`),
not scattered conditionals; `canTransition()` rejects illegal jumps in one
place, and every non-terminal stage is proven (in tests) to reach a terminal
outcome.

## Direct-call contract (mirrors epic #10)

Requests carry identifiers only, never secret material:

```json
{
  "credential": "Cloudflare - DNS API",
  "connector": "cloudflare",
  "strategy": "dual",
  "consumers": ["caddy", "certbot"],
  "idempotencyKey": "operator-supplied-request-id"
}
```

The server generates and handles the replacement value internally.

### Receipt

A redacted receipt proves progress without secret material:

```json
{
  "jobId": "…",
  "secret": "Cloudflare - DNS API",
  "stage": "done",
  "strategy": "dual",
  "newVersion": 4,
  "newChecksum": "sha256:…",
  "newPayloadRef": "Cloudflare - DNS API#…",
  "error": null,
  "checkpoints": [{ "stage": "staged", "status": "ok", "attempt": 1, "at": 0 }]
}
```

## Durability & persistence

Migration `server/control-plane/migrations/200_rotation.sql` defines three
tables against an injected `bun:sqlite` handle:

- `rotation_jobs` — one row per job; `stage` is the durable state-machine
  position; `idempotency_key` is UNIQUE.
- `rotation_checkpoints` — one row per stage attempt (`entered` / `ok` /
  `error`) with a bounded `attempt` counter. Only `error` rows count against the
  retry budget.
- `rotation_leases` — one live lease per secret (owner + expiry); an expired
  lease is reclaimable after `leaseTtlMs`.

No column ever holds material — identifiers, hashes, stage names, counts, and
timestamps only.

## Retries

Retries are bounded by `maxAttempts` (default 3) per stage and are idempotent:

- `connector.create` stages via `VaultWriter`; a re-run overwrites the pending
  ref.
- `store.addVersion` dedupes on `idempotencyKey`.
- `store.moveAlias` is CAS-guarded so a retry can never publish a stale alias.
- Re-running a completed stage transition is a no-op that advances.

Verification failure is **not** retried against a bad credential; it goes
straight to `failed → rolling-back → rolled-back`, leaving the old credential
valid.

## Interfaces (injected)

Defined locally in `server/rotation/deps.ts` and satisfied at integration by the
parallel control-plane / authz / audit / outbox / vault streams:

- `ControlPlaneStore` — `addVersion`, `moveAlias` (CAS), `getVersion`,
  `markReconcileRequired`
- `Authorize` — fail-closed `{allow}` for `rotate` / `move-alias` / `revoke` /
  `rollback`
- `Audit` / `Outbox` — redacted `appendAudit` / `enqueueEvent`
- `VaultWriter` — `writeItem(ref, generator)` → `{payloadRef, checksum}` (the
  only component that touches material)
- `Connector` — `create` / `verify` / `revoke` / `rollback` (ctx carries
  identifiers only)
- `ConsumerReloader` + `ConsumerAllowlist` — allowlisted reload hooks

## Connectors

- `connectors/test-connector.ts` — deterministic in-memory connector for tests;
  supports scripted failure injection per phase.
- `connectors/cloudflare.ts` — real Cloudflare user-API-token rotation:
  `POST /user/tokens` (mint, mirroring old policies) → vault write; verify via
  `GET /user/tokens/{id}` (active); revoke old via `DELETE /user/tokens/{oldId}`;
  rollback deletes the new token (old untouched). Requires
  `CLOUDFLARE_API_TOKEN`; its live integration test skips cleanly offline.

## Manual entry point

```
bun run scripts/rotate.ts \
  --credential "Cloudflare - DNS API" \
  --connector cloudflare \
  --strategy dual \
  --consumers caddy,certbot \
  --idempotency-key operator-supplied-request-id
```

Defaults to `--dry-run` (in-memory fakes + temp SQLite) until the real deps are
wired at integration. `--no-dry-run` intentionally errors out in this build to
prevent accidental live rotation. No secret values are ever accepted as
arguments, printed, or logged.

## Recovery / break-glass runbook

### Resume after crash or restart

On startup, call `RotationEngine.resumePending()`. It re-acquires the lease for
every non-terminal job (reclaiming expired leases) and continues from the last
persisted stage. Because every stage effect is idempotent, replaying a
partially-committed stage is safe.

### A job is stuck in `reconcile-required`

A `reconcile-required` job had a partial cross-store outcome (e.g. the alias
committed but the old-credential revoke failed, or rollback could not fully
undo). The `markReconcileRequired` op is recorded on the control plane with the
`op` and a redacted `detail`. Operator steps:

1. Read the job's checkpoints (`rotation_checkpoints`) to find the last `ok`
   stage and the failing op.
2. If `op = revoke`: the new credential is live and the alias points at it. The
   old provider credential may still exist — revoke it manually at the provider,
   then close out the reconcile op.
3. If `op = rollback`: the new (unverified) credential may still exist at the
   provider — delete it manually; the old credential and alias were never
   changed.
4. Never delete a credential the alias currently points at without staging a
   replacement first.

### Break-glass: force-release a lease

A crashed owner's lease auto-expires after `leaseTtlMs`. To force it sooner:

```sql
DELETE FROM rotation_leases WHERE secret = '<credential>';
```

Only do this once you have confirmed no other process is actively driving the
job (check for recent `rotation_checkpoints` rows).

### Break-glass: abandon a job

Mark a wedged job terminal so `resumePending()` stops re-driving it, then
reconcile the provider state manually:

```sql
UPDATE rotation_jobs SET stage = 'reconcile-required',
  error = 'operator abandoned' WHERE id = '<jobId>';
```

## Acceptance mapping

| #21 criterion | Where |
| --- | --- |
| Checkpoints persist + resume after interruption | `store-sqlite.ts`, `engine.resumePending()`, `resume.test.ts` |
| Retries / leases / duplicate requests idempotent | `engine.ts` lease + idempotency, `engine.test.ts` |
| Version publish + alias obey lifecycle + authz | `stageStage` / `stageAliasMove` (CAS + authz) |
| Rollback explicit, bounded, auditable | `stageRollback`, `maxAttempts`, audit emit |
| Partial cross-store → reconcile-required | `markReconcile`, `engine.test.ts` |
| Failure-injection tests (worker/transport/consumer) | `engine.test.ts` |
| Receipts prove progress without secret material | `RotationReceipt`, `LeakGuard`, no-leak assertions |
