# Workload-Identity Transport Contract (issue #15)

One authenticated workload-identity model shared by every interface: REST, MCP,
and the credential proxy make the **same** decision for the **same** token.

- Core: `server/identity/identity.ts`
- Store: `server/identity/store.ts` (injectable; JSON-file default, SQLite-ready)
- Middleware: `server/middleware/workload-identity.ts`
- Operator CLI: `scripts/identity-admin.ts`

## Identity

```ts
interface WorkloadIdentity {
  subject: string;        // e.g. "svc:deployer" or "legacy:lxc200"
  audiences: string[];    // e.g. ["rest","mcp"]
  expiresAt: string | null;
}
```

## Token format

Tokens are **opaque**: `vwsk_<id>_<random>`.

- `<id>` — public identifier (used for lookup, listing, revoke, rotate).
- `<random>` — 24 bytes base64url of entropy.
- Only the **sha256 hash** of the full token is persisted. The plaintext token
  is returned exactly once (at issuance/rotation) and never written to disk or
  logs.

## Issuance

```ts
issueToken({ subject, audiences, ttlSeconds? }): Promise<{ token, id }>
```

- `ttlSeconds` omitted → non-expiring (`expiresAt: null`).
- `ttlSeconds` provided → `expiresAt = now + ttlSeconds`.

CLI:

```sh
bun run scripts/identity-admin.ts issue --subject svc:deployer \
  --audiences rest,mcp --ttl 3600
```

## Presentation

Present as an HTTP bearer token:

```
Authorization: Bearer vwsk_<id>_<random>
```

Each interface pins its audience:

| Interface | File                    | Audience  |
| --------- | ----------------------- | --------- |
| REST      | `server/main.ts`        | `rest`    |
| MCP       | `server/mcp.ts`         | `mcp`     |
| Proxy     | `server/cred-proxy.ts`  | `proxy`   |

On success the middleware sets `c.set('clientId', subject)` exactly like the
legacy bearer auth, so downstream folder-scoping and audit logging are
unchanged.

## Verification (fail-closed)

```ts
verifyToken(token, audience): Promise<WorkloadIdentity | null>
```

Returns `null` — and the interface returns **401** — for any of:

- malformed / unknown token,
- forged token (id matches, secret does not; constant-time hash compare),
- expired token,
- revoked token,
- superseded token past its rotation-overlap cutoff,
- **wrong audience** (a `mcp`-only token is rejected on REST/proxy),
- missing `Authorization` (transport downgrade).

## Revocation

```ts
revokeToken(id): Promise<void>
```

Marks the record revoked; the token is rejected everywhere immediately.

```sh
bun run scripts/identity-admin.ts revoke --id <id>
```

## Rotation (overlap window)

```ts
rotateToken(id, overlapSeconds): Promise<{ token, id }>
```

Issues a fresh token inheriting the old subject + audiences, and marks the old
record superseded with a hard cutoff `overlapSeconds` in the future. During the
overlap window **both** tokens are valid; after it, only the new one is. An
`overlapSeconds` of 0 retires the old token immediately.

```sh
bun run scripts/identity-admin.ts rotate --id <id> --overlap 300
```

## Operator CLI — targeting the SERVICE store (DEP-4)

The admin CLI mutates the store at `VW_STATE_DIR`. The systemd services run as
`vaultwarden-secrets` with `VW_STATE_DIR=/var/lib/vaultwarden-secrets/state`. If you run
the CLI as your login user with `VW_STATE_DIR` unset, you edit a **different**
per-user store and the services will not see your changes. The CLI prints the
resolved store path on every run and warns loudly on the default fallback.

Always target the service store explicitly:

```sh
sudo -u vaultwarden-secrets env VW_STATE_DIR=/var/lib/vaultwarden-secrets/state \
  bun run scripts/identity-admin.ts issue --subject svc:deployer --audiences rest,mcp --ttl 3600

sudo -u vaultwarden-secrets env VW_STATE_DIR=/var/lib/vaultwarden-secrets/state \
  bun run scripts/identity-admin.ts list

sudo -u vaultwarden-secrets env VW_STATE_DIR=/var/lib/vaultwarden-secrets/state \
  bun run scripts/identity-admin.ts revoke --id <id>

sudo -u vaultwarden-secrets env VW_STATE_DIR=/var/lib/vaultwarden-secrets/state \
  bun run scripts/identity-admin.ts rotate --id <id> --overlap 300
```

## Back-compat (P0) — legacy tokens keep working

The identity layer is **additive**. During migration, legacy sources are scoped
per interface exactly as they exist today (SEC-2):

| Interface | Legacy source accepted        | Subject           |
| --------- | ----------------------------- | ----------------- |
| REST      | `API_TOKEN_<CLIENT>`          | `legacy:<client>` |
| MCP       | `API_TOKEN_<CLIENT>`          | `legacy:<client>` |
| Proxy     | `PROXY_TOKEN` only            | `legacy:proxy`    |

`PROXY_TOKEN` is **never** cross-honored on REST/MCP, and `API_TOKEN_*` is never
honored on the proxy.

### Kill-switch and migration bound (SEC-2)

Legacy acceptance exists only for the migration window. Set
`VW_LEGACY_TOKENS=off` (per service, in the unit `Environment` or its
`EnvironmentFile`) to disable **all** legacy acceptance — after that only new
`vwsk_` tokens authenticate. Any other value (or unset) keeps legacy enabled.

Migration bound: issue `vwsk_` tokens for each client, cut clients over, then
flip `VW_LEGACY_TOKENS=off` and remove the `API_TOKEN_*` / `PROXY_TOKEN` env
values. Do not leave legacy enabled indefinitely.

Nothing that works today breaks while legacy is enabled. MCP tool names,
schemas, and response shapes are unchanged (the compatibility baseline is
pinned separately).

## Storage

- Location: `VW_STATE_DIR` (default `~/.vaultwarden-secrets/state`), file
  `identities.json`.
- Permissions: file `0600`, directory `0700`.
- Concurrency (SEC-3): every mutation runs inside an exclusive `O_EXCL`
  lockfile with a stale-lock timeout; the record set is reloaded inside the lock
  (load-mutate-persist), a monotonic `version` is bumped, and the write lands
  via a unique temp file + atomic rename. Concurrent writers cannot lose each
  other's changes (e.g. a revocation racing an issuance).
- Corrupt-record handling (SEC-4): on verify, a record with a non-finite
  `expiresAt`/`supersededAt` or a non-array `audiences` is treated as invalid
  (fail closed) rather than fail open.
- Contents: hashed-token records only — id, tokenHash (sha256), subject,
  audiences, issuedAt, expiresAt, revokedAt, supersededAt. No plaintext token.
- The store is a small injectable interface (`IdentityStore`) so the JSON
  backend can be swapped for SQLite later without touching identity logic. A
  legacy bare-array file is read transparently.

## Redacted diagnostics

- Token values never appear in logs or receipts.
- `identity-admin.ts list` prints metadata only (id, subject, audiences,
  expiry, status) — never the token or its hash.

## Verification

```sh
bun test server/__tests__/identity.test.ts \
         server/__tests__/identity-store.test.ts \
         server/__tests__/workload-identity.test.ts
```

The `workload-identity` suite includes cross-interface tests proving REST, MCP,
and proxy reach identical decisions (accept / wrong-audience reject / revoked
reject) for the same token.
