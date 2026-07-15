# Control-plane design

`server/control-plane/` owns a local SQLite metadata database. Its location is
`${VW_STATE_DIR:-~/.vaultwarden-secrets/state}/control-plane.db`; WAL and foreign
keys are enabled, and every numbered `NNN_*.sql` migration is recorded in
`schema_migrations` exactly once.

## Schema and invariants

- `logical_secrets` provides stable IDs and names. `secret_versions` is append
  only: it stores a version number, lifecycle state, `payload_ref`, and checksum.
  It never accepts or stores payload bytes.
- `secret_aliases` points to a concrete version. `latest` is automatically moved
  with the insertion of each new version. A destroyed version has its
  `payload_ref` scrubbed and aliases cannot resolve it.
- `policy_references` is a non-secret association surface for the later authz
  slice. `idempotency_keys` returns the original result for safe retries.
- `operations` records cross-store intent as `pending`, `committed`, or
  `reconcile-required`. A failed external write leaves a redacted, repairable
  record. `reconcile()` resolves each open record once, so repeated runs are
  no-ops with the same completed state.

Transactions use `BEGIN IMMEDIATE`; version allocation, alias updates, an audit
entry, and the corresponding outbox event commit together.

## Lifecycle graph

```
ENABLED  <-->  DISABLED
   |              |
   +--> DESTROYED <--+
```

`DESTROYED` is terminal. `getVersion()` never returns a destroyed version,
including through an alias.

## Evidence and delivery

The append-only `audit_ledger` stores actor, action, resource, outcome,
correlation ID, timestamp, predecessor hash, and `sha256(prevHash || row)`.
Sensitive key names are rejected before audit or outbox serialization.
`verifyLedger()` detects hash changes and sequence gaps.

`outbox_events` is the durable lifecycle delivery queue. Events have a stable
consumer dedupe key, a lease for crash recovery, bounded exponential retries,
and a visible `dead-letter` terminal state. Event bodies are metadata-only and
use the same sensitive-field guard as audit records.
