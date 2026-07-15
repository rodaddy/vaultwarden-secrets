# MCP Compatibility Baseline

Phase 0 inventory of the **current** Model Context Protocol (MCP) service for
`vaultwarden-secrets`, captured for issue #23. This is the frozen reference the
runtime redesign (#14) and cutover (#22) must remain compatible with until
cutover is approved.

> **Security note.** This document contains **no secret values, tokens, item
> names, IP addresses, or private advisory content**. The live service is
> referred to as "the production host". Scripts are parameterized by
> environment variables (e.g. `VW_MCP_BASE_URL`). Tool names and JSON-schema
> shapes are public contract, not secrets.

Source of truth: `server/mcp.ts`, `server/profiles.ts`,
`server/service-resolver.ts`, `server/utils/folder-scope.ts`, `snapshot.ts`,
`server/middleware/bearer-auth.ts`, and `deploy/systemd/`. Live facts were
verified against the production host on the branch that introduced this doc.

---

## 1. Transport & endpoint

- **Transport:** Streamable HTTP (`WebStandardStreamableHTTPServerTransport`
  from `@modelcontextprotocol/sdk`, `enableJsonResponse: true`).
  `server/mcp.ts:472`.
- **Endpoint:** `POST|GET|DELETE /mcp` on `MCP_PORT` (default `3001`),
  `MCP_HOST` (default `0.0.0.0`). `server/mcp.ts:523`, `:591`.
- **Health:** `GET /health` → `{ status: "ok", transport:
  "mcp-streamable-http", timestamp }`. Public, no auth. `server/mcp.ts:461`.
- **Required request headers for `/mcp`:** `Content-Type: application/json`
  and `Accept: application/json, text/event-stream` (both JSON and SSE accept
  types are required by the SDK, even for the JSON-response path).
- **Session model:** `initialize` mints an `mcp-session-id` (returned as a
  response header). Subsequent calls pass it back via the `mcp-session-id`
  request header. `server/mcp.ts:539`.
- **Auto-reconnect:** on a POST with a stale/missing session id (non-init), the
  server transparently creates a fresh initialized transport and replays the
  request, so a client that lost its session never sees a 404 on POST.
  `server/mcp.ts:556`. GET/DELETE do **not** auto-reconnect and return `404`
  (`{ error: "Session not found. Re-initialize required." }`) for an unknown
  session. `server/mcp.ts:579`.

The REST API on port `3000` (`server/main.ts`) is a **separate service** with a
separate contract and is out of scope for this MCP baseline.

---

## 2. Authentication & authorization

- **Auth:** Bearer token. `Authorization: Bearer <token>` is validated against
  the `API_TOKEN_<CLIENT>` env-var map. `server/mcp.ts:48`,
  `server/middleware/bearer-auth.ts:61`.
- **Unauthorized shape:** missing or invalid token →
  HTTP `401` with body `{ "error": "Unauthorized" }`. `server/mcp.ts:525`.
  Verified live: unauthenticated `initialize` against the production host
  returns HTTP `401`.
- **Startup invariant:** the process exits (`process.exit(1)`) if no
  `API_TOKEN_*` is configured. `server/mcp.ts:43`.
- Tokens map to a `clientId`, but MCP folder scoping is driven by the
  **security profile** (below), not per-client env vars (unlike the REST API's
  `API_FOLDERS_<CLIENT>` mechanism in `server/utils/folder-scope.ts`).

---

## 3. Security profile & folder scoping

Set via `SECURITY_PROFILE` (default `im-aware`; **`im-aware` is live** on the
production host). Profiles are defined in `server/profiles.ts`.

| Profile | allowWrites | writeConfirmation | folderScope | Tools exposed |
|---|---|---|---|---|
| `feeling-lucky` | true | false | `[]` (unrestricted) | 10 (6 read + 4 write) |
| `im-aware` **(live)** | true | true | `["Infrastructure"]` | 10 (6 read + 4 write) |
| `im-a-dev` | true | true | `["Infrastructure"]` | 10 (6 read + 4 write) |
| `trust-no-one` | false | — | `[]` | 6 (read only) |

**Folder scoping semantics** (`server/mcp.ts:68`–`128`):

- At startup, `initProfileFolderScope()` resolves each `folderScope` name to a
  Vaultwarden folder id via `bw list folders`. If `folderScope` is **empty**,
  the function returns early and makes **no** BW CLI call (this is why the
  offline contract tests can boot the real module under `feeling-lucky`).
- `allowedFolderIds` (a `Set` of folder ids) gates every read/write:
  - `isItemAllowed(item)` → `true` if unrestricted, else the item's `folderId`
    must be in the allowed set.
  - `filterByScope(names)` removes out-of-scope names from list/search results.
  - `findScopedItem(name)` returns `null` for an item outside scope, which
    surfaces to the caller as a "not found or not in allowed folder scope"
    error (never distinguishing "does not exist" from "not permitted").
- `writeFolderId` is the first resolved scope folder; new items created by
  `create_secret` land there. If no write folder resolves, `create_secret`
  returns an error. `server/mcp.ts:339`.

**Write gating:** the four write tools are only registered when
`profile.allowWrites` is true. `server/mcp.ts:301`. `writeConfirmation`
surfaces as the `destructiveHint` annotation on `update_secret`/`delete_secret`.

---

## 4. Tool inventory (10 tools)

Names, descriptions, and input schemas are pinned in
`server/__tests__/mcp-contract.test.ts`. All read tools carry the
`readOnlyHint` annotation.

### Read tools (always present)

| Tool | Required input | Optional input | Returns (envelope) |
|---|---|---|---|
| `search_secrets` | `query` (string) | `limit` (number, default 20), `vault` (string) | text/JSON: array of `{ name, score, matched }`, scope-filtered |
| `get_secret` | `name` (string; supports dotted path e.g. `item.login.password`) | `vault` | text: the resolved value; error if not found / out of scope |
| `get_secret_fields` | `name` (string) | `vault` | text/JSON: field object for the item; error if not found / out of scope |
| `list_secrets` | — | `filter` (string), `vault` | text/JSON: array of names, scope-filtered |
| `snapshot_info` | — | — | text/JSON: snapshot metadata, or `"No snapshot exists"` |
| `get_service` | `service` (string prefix) | — | text/JSON: `ServiceInfo` aggregate; error if no items match |

### Write tools (only when `allowWrites`)

| Tool | Required input | Optional input | Annotations | Returns |
|---|---|---|---|---|
| `refresh_snapshot` | — | — | `idempotentHint: true` | JSON: `{ refreshed: true, ...metadata }` |
| `create_secret` | `name` | `type` (1=login default, 2=note), `username`, `password`, `uri`, `notes`, `fields[]` | `destructiveHint: false` | JSON: `{ created: true, id, name }` |
| `update_secret` | `name` | `username`, `password`, `uri`, `notes`, `fields[]`, `fieldStrategy` (`merge`\|`replace`) | `destructiveHint: true`, `idempotentHint: true` | JSON: `{ updated: true, id, name }` |
| `delete_secret` | `name` | — | `destructiveHint: true` | JSON: `{ deleted: true, id, name }` |

`fields[]` items have shape `{ name: string, value: string, type?: number }`
(`type` 0=text default, 1=hidden). `create_secret`/`update_secret` field
handling is pure and unit-tested in `server/__tests__/vault-client.test.ts`
(`buildCreateTemplate`, `mergeUpdateFields`).

### Result-envelope shapes

All tool results use the MCP content envelope:

```
{ "content": [ { "type": "text", "text": "<string>" } ], "isError"?: true }
```

- Success values are either raw strings (`get_secret`) or
  `JSON.stringify(obj, null, 2)` (everything else). `server/mcp.ts:134`.
- Tool-level failures return the same envelope with `isError: true` and a
  human-readable `Error: <message>` string. `server/mcp.ts:136`.

### `get_service` aggregation

`server/service-resolver.ts` groups items by a naming convention: `SERVICE_API`
(or `service-api`) for shared credentials, `service01/02/...` for per-host
entries. Credentials resolve through a fallback chain: login fields → custom
fields (`Token ID`/`Token value`/`username`/`password`/`Secret`) → notes
parsing. Output is `{ service, api, hosts[], itemCount }`. Pure and unit-tested
in `server/__tests__/service-resolver.test.ts`.

---

## 5. Error behaviors (contract)

| Condition | Layer | Shape |
|---|---|---|
| Missing/invalid bearer token | HTTP | `401` `{ "error": "Unauthorized" }` |
| Invalid JSON body on POST | HTTP | `400` `{ "error": "Invalid JSON" }` (`server/mcp.ts:534`) |
| Unknown session on GET/DELETE | HTTP | `404` `{ "error": "Session not found. Re-initialize required." }` |
| Unknown tool name | JSON-RPC | JSON-RPC error (SDK-level), surfaced in the response envelope |
| Missing required argument | JSON-RPC / tool | error envelope; never a silent success |
| Unknown JSON-RPC method | JSON-RPC | `{ error: { code: <number>, ... } }` |
| Vault locked / no session (write tools, `refresh_snapshot`) | tool | `isError` envelope: `Error: No vault session available. Run: bw unlock` |
| Item out of folder scope | tool | `isError` envelope: `... not found or not in allowed folder scope` |

The JSON-RPC and tool-level error shapes are pinned by
`server/__tests__/mcp-contract.test.ts` (`error envelope contract`).

---

## 6. Operational dependencies

Verified live on the production host. **The MCP service is not self-contained**:
it depends on a Bitwarden CLI session and a periodically refreshed snapshot.

### Service unit

- **`vaultwarden-secrets-mcp.service`** — active/running. Runs
  `bun run server/mcp.ts`, `EnvironmentFile=/opt/vaultwarden-secrets/.env`,
  with explicit `HOME` and `PATH` (systemd's minimal PATH does not include the
  `bw` binary or the `bun` runtime otherwise).

> The REST-API unit (`vaultwarden-secrets.service`, port 3000) and the
> credential proxy (`vw-cred-proxy.service`, port 3003) are separate services
> and out of scope for the MCP contract.

### Required timers (both must stay active through cutover)

| Timer | Cadence | Activates | Purpose |
|---|---|---|---|
| `vw-snapshot.timer` | `OnCalendar=*:0/15` (every 15 min) | `vw-snapshot.service` (`bun run cli.ts snapshot`) | Refreshes the encrypted vault snapshot used by all read tools |
| `vw-session-refresh.timer` | `OnBootSec=1min`, `OnUnitActiveSec=15min` | `vw-session-refresh.service` | Keeps the file-based Bitwarden CLI session (`/root/.bw-session`) unlocked |

If `vw-session-refresh` lapses, write tools and `refresh_snapshot` fail with
`No vault session available`. If `vw-snapshot` lapses, `snapshot_info` reports
staleness and read tools serve stale data (never a crash).

### Snapshot

- Encrypted snapshot managed by `snapshotManager` (`snapshot.ts`), format
  `vw-snapshot-v2`, AES-256-GCM + HMAC.
- `snapshot_info` exposes `SnapshotMetadata`:
  `{ vaultId, createdAt, itemCount, fileSizeBytes, isStale }` — no secret
  values. `snapshot.ts:48`.
- Read tools (`list_secrets`, `search_secrets`, `get_service`,
  `get_secret_fields`, `get_secret`) resolve against the snapshot, not the live
  vault, so they work offline as long as a snapshot exists.

---

## 7. Consumers

| Consumer | How it connects | Notes |
|---|---|---|
| `mcp2cli vaultwarden-secrets ...` | MCP client over Streamable HTTP to `/mcp` | Primary CLI consumer; contract is the tool list + input schemas frozen here |
| Claude Code MCP clients | `~/.claude/mcp_servers.json` → `/mcp` | Depends on transparent auto-reconnect (does not re-init on stale session) |
| PAI skill | documents the tool contract for other sessions | Teaching layer; no independent transport |

The **retired** port `3002` deploy trigger is **not** part of this contract and
must not be reintroduced.

---

## 8. What is frozen vs. free to change

**Frozen (must survive cutover, shadow-checked):**

- Endpoint path `/mcp`, Streamable HTTP transport, session header semantics.
- `GET /health` shape.
- Bearer auth + the `401 { error: "Unauthorized" }` unauthorized shape.
- The 10 tool names, their required input fields, and result-envelope shape.
- The `snapshot_info` metadata key set and value types.
- Profile-driven write gating and folder-scope "not found or not in allowed
  folder scope" behavior.

**Free to change (implementation detail, not contract):**

- Internal storage, snapshot format version, BW session mechanism.
- Fuzzy-search scoring weights (as long as the result envelope shape holds).
- Server version string, log formatting.

See `docs/compat/cutover-gates.md` for the gates that enforce the frozen set.
