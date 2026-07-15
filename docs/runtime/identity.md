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

## Back-compat (P0) — legacy tokens keep working

The identity layer is **additive**. During migration:

- `API_TOKEN_<CLIENT>` env bearer tokens still authenticate → subject
  `legacy:<client>`.
- `PROXY_TOKEN` still authenticates on the proxy → subject `legacy:proxy`.

Nothing that works today breaks. MCP tool names, schemas, and response shapes
are unchanged (the compatibility baseline is pinned separately).

## Storage

- Location: `VW_STATE_DIR` (default `~/.vaultwarden-secrets/state`), file
  `identities.json`.
- Permissions: file `0600`, directory `0700`, atomic writes (temp + rename).
- Contents: hashed-token records only — id, tokenHash (sha256), subject,
  audiences, issuedAt, expiresAt, revokedAt, supersededAt. No plaintext token.
- The store is a small injectable interface (`IdentityStore`) so the JSON
  backend can be swapped for SQLite later without touching identity logic.

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
