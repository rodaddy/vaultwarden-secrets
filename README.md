# vaultwarden-secrets

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/rodaddy)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.0+-orange.svg)](https://bun.sh/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**A personal, self-hosted secret-manager control plane over Vaultwarden — GCP Secret Manager-style semantics (immutable versions, aliases, rotation) without multi-tenant bloat.**

`vaultwarden-secrets` is a TypeScript/Bun library *and* a small fleet of services that put a real secrets platform in front of a [Vaultwarden](https://github.com/dani-garcia/vaultwarden) (self-hosted Bitwarden) instance. It started as a caching secrets library and grew a control plane (immutable versions + aliases + audit ledger), a durable rotation engine, a REST API, an MCP server for AI agents, a least-privilege credential proxy, and a hardened, non-root deployment story.

> **Version:** The package is `0.5.2` (see `package.json`). The MCP server reports its own server/version string `0.7.0` and speaks MCP protocol `2025-03-26`. This README describes what the code in this repository actually ships.

---

## Table of Contents

- [What it is](#what-it-is)
- [Architecture](#architecture)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Library API reference](#library-api-reference)
- [CLI reference](#cli-reference)
- [MCP server](#mcp-server)
- [REST API](#rest-api)
- [Credential proxy](#credential-proxy)
- [Control plane: versions & aliases](#control-plane-versions--aliases)
- [Rotation](#rotation)
- [Access control & security model](#access-control--security-model)
- [Deployment](#deployment)
- [Configuration](#configuration)
- [Testing](#testing)
- [Contributing & Security](#contributing--security)
- [License](#license)

---

## What it is

At its core is a caching secrets library that reads items from a Vaultwarden/Bitwarden vault via the `bw` CLI, encrypts them at rest, and serves them fast. On top of that library are optional services you run only if you want them:

- **Secrets library** — `getSecret()` / `getSecretObject()` / `listSecrets()` with an encrypted LRU cache, macOS Keychain (or Linux file) session storage, multi-vault support, folder prefixes, path/field syntax, and an encrypted **snapshot** fallback so reads keep working when the vault is locked.
- **REST API** (`server/main.ts`) — HTTP read access with tiered security profiles, enumeration-parity 404s, and folder scoping per client.
- **MCP server** (`server/mcp.ts`) — the same vault exposed to AI agents as Model Context Protocol tools over Streamable HTTP, folder-scoped and profile-gated.
- **Credential proxy** (`server/cred-proxy.ts`) — least-privilege, per-service credential handout for agents/workloads that should see *only* the fields they need.
- **Control plane** (`server/control-plane/`) — an append-only SQLite metadata store for immutable secret versions, aliases, an audit ledger, and a durable outbox.
- **Rotation engine** (`server/rotation/`) — a durable, crash-safe rotation state machine (create → verify → move alias → revoke) with provider connectors.
- **Authorization** (`server/authz/`) — a default-deny policy engine that is the single decision point for secret-level operations.
- **Workload identity** (`server/identity/`) — opaque `vwsk_` tokens issued/revoked/rotated by an operator CLI, honored identically by REST, MCP, and the proxy.

Everything is designed for a homelab / single-operator deployment: no user directory, no tenants — just your vault, hardened services, and least-privilege access for the things that consume secrets.

---

## Architecture

```
                                bw CLI  ─►  Vaultwarden / Bitwarden vault
                                   ▲
                                   │  (session token in Keychain / file)
        ┌──────────────────────────┴──────────────────────────┐
        │            secrets library  (index.ts)               │
        │   encrypted LRU cache · encrypted snapshot fallback  │
        │   multi-vault · folder prefixes · field paths        │
        └───┬───────────────┬───────────────┬─────────────┬────┘
            │               │               │             │
     ┌──────┴─────┐  ┌──────┴─────┐  ┌───────┴─────┐  ┌────┴──────────┐
     │  CLI /     │  │  REST API  │  │  MCP server │  │ credential    │
     │  `secret`  │  │  :3000     │  │  :3001      │  │ proxy :3003   │
     │  bin       │  │ main.ts    │  │  mcp.ts     │  │ cred-proxy.ts │
     └────────────┘  └──────┬─────┘  └──────┬──────┘  └───────────────┘
                            │               │
                            │        ┌──────┴────────────────────────┐
                            └────────┤  workload identity (vwsk_)     │
                                     │  default-deny authz            │
                                     │  control plane (SQLite):       │
                                     │   versions · aliases · ledger  │
                                     │   · outbox                     │
                                     │  rotation engine + connectors  │
                                     └────────────────────────────────┘
```

The library is usable entirely on its own. Each service is independently runnable and shares the same underlying vault access and (where applicable) the same identity/authz path.

---

## Features

**Secret retrieval & caching**
- Read secrets by item name, field path (`item.login.password`), or custom field (`item.fields.API_KEY`).
- Encrypted at-rest LRU cache (AES-256-GCM, key derived with PBKDF2) with hit/miss/eviction stats.
- Encrypted **snapshot** fallback (`vw-snapshot-v2`, AES-256-GCM + HMAC) so reads survive a locked vault, with staleness warnings.
- Multi-vault switching and per-vault sessions; default **folder prefix** to shorten lookups.
- Cross-platform session storage: macOS Keychain via `security`, Linux via `BW_SESSION_FILE` / `MASTER_KEY_FILE`.

**Control plane** (GCP Secret Manager-style)
- Immutable, append-only secret **versions** (metadata only — `payload_ref`/checksum, never payload bytes).
- **Aliases** (e.g. `current`, `latest`) that move atomically (CAS) between versions.
- Version lifecycle: `ENABLED ⇄ DISABLED → DESTROYED` (terminal); destroyed versions are never returned.
- Append-only **audit ledger** with hash chaining, and a durable **outbox** delivery queue with retries and dead-lettering.

**Rotation**
- Durable, resumable rotation engine: create → stage → reload consumers → verify → move alias → revoke → redacted receipt.
- Never revokes the old credential until the new one verifies and the alias has moved; **never rolls back after publish** (routes to `reconcile-required`).
- Per-credential fenced leases; idempotency keys de-duplicate concurrent rotations.
- No secret material ever enters engine state (a leak guard scans every persisted/emitted value and fails closed).
- Provider connectors (ships with a Cloudflare connector and a test connector).

**Access control**
- **Default-deny** authorization engine — the sole secret-level decision point.
- **Enumeration parity**: REST get/list/fields return one byte-identical `404 {"error":"Secret not found"}` for denial, not-found, and backend-error alike.
- **Workload identity**: opaque `vwsk_` tokens (only the SHA-256 hash is stored) honored identically across REST/MCP/proxy; legacy tokens accepted during migration and killable via `VW_LEGACY_TOKENS=off`.
- **Folder scoping**: restrict a client/agent to specific Vaultwarden folders.
- Tiered **security profiles** (`feeling-lucky`, `im-aware`, `im-a-dev`, `trust-no-one`) selecting auth, TLS, rate limiting, audit level, and write permissions.

**Deployment**
- Least-privilege: services run as a non-root `vaultwarden-secrets` user; automated deploys run as an operator via command-scoped `sudo -n` (no root shell, no blanket sudo).
- systemd units, hardening (`NoNewPrivileges`, `ProtectSystem=strict`, etc.), and a runtime **drift check**.
- Encrypted, verified, off-host **backups** with a monthly restore drill.

---

## Prerequisites

- **[Bun](https://bun.sh/)** ≥ 1.0 (runtime + package manager; there is no separate build step — sources are `.ts`).
- **[Bitwarden CLI](https://bitwarden.com/help/cli/)** (`bw`) configured against your Vaultwarden server (`bw config server <url>`), logged in and unlockable.
- A running **Vaultwarden** (or Bitwarden) instance.
- For the hardened server deployment: a systemd-based Linux host (see [Deployment](#deployment)).

The `install.sh` script can install Bun and the Bitwarden CLI for you (macOS and common Linux package managers).

---

## Installation

Clone the repo and install dependencies:

```bash
git clone https://github.com/yourusername/vaultwarden-secrets
cd vaultwarden-secrets
bun install
```

Optionally run the installer, which detects your OS, installs `bun` and `bw` if missing, and wires up the `secret` CLI + shell integration:

```bash
bun run install-config      # ./install.sh — standard install
bun run install-pai         # ./install.sh --pai — install into a PAI private config layout
bun run uninstall           # ./install.sh --uninstall
```

`install.sh` also accepts `--dry-run` (preview), `--dir <path>`, and `--no-pai` (force standard mode). PAI integration is optional — the library, CLI, and services work standalone.

To use the library from your own Bun/TypeScript project, import from the package root (`main` / `types` is `index.ts`).

---

## Quick start

### Library

```ts
import { getSecret, getSecretObject, setSession, setFolder } from 'vaultwarden-secrets';

// One-time: store a BW session token for a vault (see below for how to obtain it)
await setSession('default', process.env.BW_SESSION!);

// Optional: set a default folder so short names resolve under it
await setFolder('Infrastructure');

// Get the password field (default) of an item
const token = await getSecret('github-pat');

// Get a specific field
const user = await getSecret('github-pat.login.username');

// Get a custom field
const apiKey = await getSecret('github-pat.fields.API_KEY');

// Get every field as an object
const all = await getSecretObject('github-pat');
// → { username, password, uri?, totp?, notes?, ...customFields }
```

Obtaining a session token (macOS example — Keychain handles the rest):

```bash
export BW_SESSION="$(bw unlock --raw)"
bun run set-session default "$BW_SESSION"
```

### Services

```bash
# REST API (im-aware profile, bearer auth) on :3000
bun run server:prod

# REST API (feeling-lucky, no auth — DEV ONLY) on :3000
bun run server:dev

# MCP server on :3001
bun run mcp

# Credential proxy on :3003
bun run cred-proxy
```

---

## Library API reference

All functions are exported from `index.ts`. `SecretOptions` supports `{ vault?, skipCache?, category? }`.

| Function | Signature | Description |
|---|---|---|
| `getSecret` | `(path: string, options?: SecretOptions) => Promise<string>` | Resolve one secret value. Supports field paths (`item.login.password`), custom fields (`item.fields.NAME`), alias resolution, folder prefixing, cache, and snapshot fallback. |
| `getSecretObject` | `(itemName: string, options?: SecretOptions) => Promise<Record<string,string>>` | All fields of an item as a flat object (login fields, `notes`, and custom fields). |
| `listSecrets` | `(filter?: string, options?: SecretOptions) => Promise<string[]>` | Sorted item names, optionally filtered (case-insensitive). Falls back to the snapshot when the vault is locked. |
| `clearCache` | `(vaultId?: string) => Promise<void>` | Clear the encrypted cache (all vaults, or one). |
| `getCacheStats` | `() => CacheStats` | Hit rate, entries, hits/misses/evictions/expirations, active vaults. |
| `switchVault` | `(vaultId: string) => Promise<void>` | Make a vault the default and clear the cache. |
| `getActiveVault` | `() => Promise<string>` | Current default vault ID. |
| `setSession` | `(vaultId: string, token: string) => Promise<void>` | Store a `BW_SESSION` token for a vault (Keychain / file); registers the vault if new. |
| `listVaults` | `() => Promise<VaultConfig[]>` | Configured vaults. |
| `getFolder` | `() => Promise<string>` | Current default folder prefix (or `''`). |
| `setFolder` | `(folder: string) => Promise<void>` | Set a default folder prefix; short names resolve under it. |
| `clearFolder` | `() => Promise<void>` | Remove the default folder prefix. |
| `getItemByName` | `(session: string, name: string) => Promise<any>` | Resolve an item by exact name, handling `bw`'s "More than one result" ambiguity via list + exact filter. |
| `extractFieldFromItem` | `(item: any, parsed: { field?: string; customField?: string }) => string` | Pure field extractor: custom field, nested field path, or smart fallback (`password` → `notes` → first custom field). |

Also re-exported: `SecretError`, `ErrorCode`, `DEFAULT_TTLS`, `Constants`, the `vaultManager` and `secretCache` singletons (advanced use), and the types `SecretOptions`, `CacheStats`, `VaultConfig`, `VaultConfigFile`, `CacheEntry`, `EncryptedData`, `SecretCategory`.

**Path syntax**

| Path | Resolves to |
|---|---|
| `Item` | The item's `login.password` (smart default) |
| `Item.login.username` | Nested login field |
| `Item.notes` | Notes field |
| `Item.fields.CUSTOM` | A custom field named `CUSTOM` |
| `Folder/Item` | Explicit folder (bypasses the default prefix) |

---

## CLI reference

Two entry points:

### `cli.ts` (`bun run cli.ts <command>`)

| Command | Description |
|---|---|
| `set-session <vault> <session>` | Store a Bitwarden session token |
| `get <path>` | Print a secret value |
| `list-vaults` | List configured vaults |
| `cache-stats` | Show cache statistics |
| `clear-cache [vault]` | Clear cache (all, or one vault) |
| `snapshot` | Create a new encrypted snapshot of the default vault |
| `snapshot --info` | Show existing snapshot metadata (age, item count, staleness) |
| `help` | Usage |

Convenience scripts: `bun run get <path>` and `bun run set-session <vault> <token>`.

### `secret` bin (`./bin/secret`)

The richer daily-driver CLI (also installed on `PATH` by `install.sh`). `secret <path>` is shorthand for `secret get <path>`.

- **Daily:** `get`, `copy`, `paste`, `set`, `create`, `delete`
- **Discovery:** `list [filter]`, `search <query>`, `show <item>` (tree view of all fields)
- **Vault:** `vault list`, `vault use <name>`, `vault current`
- **Folder prefix:** `folder`, `folder <path>`, `folder clear`
- **Cache:** `cache clear`, `cache stats`, `cache refresh`
- **Migration:** `migrate [paths...]`, `migrate --list|--auto|--dry-run`, `reset [source|all|list]` (scan a codebase and move discovered secrets into the vault)
- **System:** `unlock` (Touch ID where available), `unlock --save`, `health`, `set-session <vault> <token>`, `version`, `help`

On macOS, `unlock` can use Touch ID / Apple Watch via a bundled biometric helper (`bin/biometric-auth`).

A portable shell integration (`shell/secret.sh`, bash + zsh) auto-detects the `secret` binary; source it from your shell rc.

---

## MCP server

`server/mcp.ts` exposes the vault to AI agents as Model Context Protocol tools over **Streamable HTTP** (`@modelcontextprotocol/sdk`). It runs on `MCP_PORT` (default `3001`) at `/mcp`, with a `/health` endpoint. Auth is a bearer token resolved through the shared workload-identity path (audience `mcp`); legacy `API_TOKEN_<CLIENT>` tokens are also accepted during migration. Requests without a valid credential get `401`. Stale MCP sessions are transparently re-initialized server-side.

Tools are folder-scoped by the active [security profile](#access-control--security-model) and (for writes) gated by `profile.allowWrites`. Under the default `im-aware` profile, all 12 tools below are available.

**Read tools** (always available)

| Tool | Purpose |
|---|---|
| `search_secrets` | Fuzzy search secret names |
| `get_secret` | Get a secret value by name/path |
| `get_secret_fields` | Get all fields of an item |
| `list_secrets` | List secrets (optional filter) |
| `snapshot_info` | Snapshot metadata (age, item count, staleness) |
| `get_service` | All vault items for a multi-host service (`SERVICE_API` + `service01/02/...` naming convention) |
| `get_credential` | Smart single-call lookup (exact → fuzzy → all fields) to avoid chaining calls |

**Write tools** (only when `profile.allowWrites` is true)

| Tool | Purpose | Hint |
|---|---|---|
| `refresh_snapshot` | Force a snapshot refresh from the live vault | idempotent |
| `create_secret` | Create a login (type 1) or secure note (type 2) with custom fields | — |
| `update_secret` | Update login/custom fields (`fieldStrategy: merge \| replace`) | destructive |
| `delete_secret` | Delete a secret in an allowed folder | destructive |
| `rotate_secret` | Rotate a credential through the [rotation engine](#rotation) (verify → alias-move → revoke), returning a **redacted** receipt; authorized via default-deny authz | destructive, idempotent |

Cross-vault access is **rejected**: folder scope is enforced only against the default vault's snapshot, so any non-default `vault` argument on a scope-enforced read tool fails closed. A `vaultwarden://info` resource reports the server name, profile, folder scope, and tool list.

> The frozen tool contract is verified by `server/__tests__/mcp-contract.test.ts`. See [docs/pilot-cutover.md](docs/pilot-cutover.md) for how the MCP service was migrated onto the control plane + rotation engine, and [docs/compat/mcp-baseline.md](docs/compat/mcp-baseline.md) / [docs/compat/cutover-gates.md](docs/compat/cutover-gates.md) for the compatibility gates.

---

## REST API

`server/main.ts` serves read access over HTTP on `PORT` (default `3000`). Endpoints:

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness (public, no auth) |
| `GET` | `/vaults` | List configured vaults |
| `GET` | `/secret/:name` | Get a secret value (`?vault=`) |
| `GET` | `/secret/:name/fields` | Get all fields of an item |
| `GET` | `/secrets` | List secrets (`?filter=`) |
| `GET` | `/secrets/search` | Fuzzy search (`?q=`, `?limit=`) |
| `GET` | `/cache/stats` | Cache statistics |
| `POST` | `/cache/clear` | Clear cache (`?vault=`) + refresh folder scope |
| `GET` | `/snapshot/info` | Snapshot metadata |
| `POST` | `/snapshot/create` | Create a snapshot |

The `get` / `list` / `fields` routes enforce **enumeration parity**: every denial, not-found, and backend error returns one byte-identical `404 {"error":"Secret not found"}` so existence and access can't be probed (see `server/routes/secrets-read.ts` and [docs/authz.md](docs/authz.md)). Unsupported methods on valid paths return `405`. Middleware (IP whitelist, rate limit, auth, audit, response encryption, folder scope) is applied per security profile. See [server/README.md](server/README.md) for endpoint examples and profile details.

---

## Credential proxy

`server/cred-proxy.ts` is a least-privilege credential handout for agents/workloads. It exposes a single route, `GET /cred/:service`, that returns **only** env-var-formatted credentials for an allowed service — no vault enumeration, no metadata, no item browsing. It listens on `PROXY_PORT` (default `3003`) with a `/health` endpoint, authenticated via the shared workload-identity path (audience `proxy`); the legacy `PROXY_TOKEN` shared secret is also accepted during migration.

Two access modes (see `proxy.config.json`):

1. **Allowlist** — map a service name → a vault item → env-var field mappings, e.g.:
   ```json
   {
     "allowlist": {
       "litellm": {
         "vaultItem": "LiteLLM API Key",
         "map": { "OPENAI_API_KEY": "field:API Key", "OPENAI_BASE_URL": "field:Base URL" }
       }
     }
   }
   ```
2. **Folder fallback** — resolve a designated Vaultwarden folder (e.g. `AgentKeys`) at startup and auto-map fields for a matching item name.

Field extraction (`server/cred-proxy-extract.ts`) supports `field:<name>`, `login.password`, `login.username`, `login.uri`, and `notes`. Unknown services return `403`.

---

## Control plane: versions & aliases

`server/control-plane/` is a local SQLite metadata store (WAL + foreign keys) at `${VW_STATE_DIR:-~/.vaultwarden-secrets/state}/control-plane.db`, with numbered SQL migrations tracked in `schema_migrations`. It gives Vaultwarden GCP-Secret-Manager-style semantics:

- **Logical secrets** and an append-only **`secret_versions`** table that stores only a `payload_ref` + checksum — **never payload bytes**.
- **Aliases** (`secret_aliases`) that move atomically (`latest` auto-tracks; other aliases move by CAS).
- Version lifecycle `ENABLED ⇄ DISABLED → DESTROYED` (terminal); `getVersion()` never returns a destroyed version.
- An append-only **audit ledger** with `sha256(prevHash || row)` hash chaining (`ledger_head`), and a durable **outbox** delivery queue (leased delivery, bounded retries, dead-letter state).
- An idempotent `reconcile()` for pending/committed operations; transactions use `BEGIN IMMEDIATE`.

Full design: [docs/control-plane/design.md](docs/control-plane/design.md).

---

## Rotation

`server/rotation/` is a durable, crash-safe rotation job state machine (`bun run scripts/rotate.ts` or the `rotate_secret` MCP tool). A rotation runs: **create → stage → reload consumers → verify → move alias → revoke → redacted receipt**, with these guarantees:

- **No downtime**: the old credential stays valid until the new one is verified and the alias is CAS-moved.
- **Never rollback after publish**: once the alias may point at the new version, any failure fails closed to `reconcile-required`.
- **No leak**: generated material flows only through an arming vault-writer proxy; a leak guard scans every persisted row, audit entry, outbox event, receipt, and error and fails closed.
- **Serialized & idempotent**: per-credential fenced leases (`BEGIN IMMEDIATE` CAS); a duplicate idempotency key returns the existing job.
- **Resumable**: `RotationEngine.resumePending()` on startup continues an interrupted rotation from its last fenced checkpoint.

Manual entry point (defaults to `--dry-run`; `--no-dry-run` intentionally errors in this build until real deps are injected):

```bash
bun run scripts/rotate.ts \
  --credential "Cloudflare - DNS API" \
  --connector cloudflare \
  --strategy dual \
  --consumers caddy,certbot \
  --idempotency-key <request-id>
```

Ships with a **Cloudflare** connector (requires `CLOUDFLARE_API_TOKEN`) and a test connector. Consumer reloads are allowlist-only (systemd units named in `profile.rotationConsumers`); callers never supply commands. Full details: [docs/rotation.md](docs/rotation.md).

---

## Access control & security model

**Default-deny authorization** (`server/authz/`) is the single secret-level decision point. Policies bind a workload `subject`, a `resourcePattern` (exact name, `*`, or `infra/*` prefix), one or more actions, and an allow/deny effect. Actions include `secret.get`, `secret.list`, `secret.create`, `secret.addVersion`, `secret.disable`, `secret.enable`, `secret.destroy`, `alias.move`, `policy.set`, `rotate`, `rotate.revoke`, `rotate.rollback`, `reconcile`. Precedence is fail-closed: malformed → deny, no match → deny, conflicting allow+deny → deny. Secret values never enter the policy model. See [docs/authz.md](docs/authz.md).

**Enumeration parity** — REST get/list/fields (and MCP scope checks) return indistinguishable responses for denial, not-found, and backend errors, so callers can't enumerate which secrets exist or which they can reach.

**Workload identity** (`server/identity/`) — opaque `vwsk_<id>_<random>` tokens; only the SHA-256 hash is stored, plaintext shown once at issuance/rotation. Verification fails closed on malformed/forged/expired/revoked/superseded/wrong-audience/missing tokens. One decision is applied identically across REST, MCP, and proxy. Operator CLI:

```bash
bun run identity issue  --subject <s> --audiences rest,mcp [--ttl <seconds>]
bun run identity list
bun run identity revoke --id <id>
bun run identity rotate --id <id> [--overlap <seconds>]
```

Legacy `API_TOKEN_<CLIENT>` (REST/MCP) and `PROXY_TOKEN` (proxy only) are accepted during migration; `VW_LEGACY_TOKENS=off` disables **all** legacy acceptance. See [docs/runtime/identity.md](docs/runtime/identity.md).

**Folder scoping** — restrict a client/agent to specific Vaultwarden folders (per-client `API_FOLDERS_*` for REST, or `folderScope` in the security profile for MCP).

**Security profiles** (`server/profiles.ts`) select the whole posture:

| Profile | Auth | IP whitelist | TLS | Writes | Folder scope |
|---|---|---|---|---|---|
| `feeling-lucky` | none | auto local /24 | off | yes | none — **DEV ONLY** |
| `im-aware` (default) | bearer | auto local /24 | recommended | yes (confirm) | `Infrastructure` |
| `im-a-dev` | OAuth2 | auto local /24 | required | yes (confirm) | `Infrastructure` |
| `trust-no-one` | mTLS + JWT | 127.0.0.1/32 | required+strict | no | none |

`trust-no-one` has fun aliases: `openclaw`, `tinfoil-hat`, `maximum-paranoia`, `aluminum-foil`, `aluminium-hat`, `fort-knox`. It adds ECDH P-256 + AES-256-GCM **response encryption** (see [docs/encryption.md](docs/encryption.md), `examples/encrypted-client.ts`) and forensic audit logging. mTLS setup: [docs/mtls-setup.md](docs/mtls-setup.md).

**Least-privilege runtime** — services run as the non-root `vaultwarden-secrets` user (group `ai-services`) with systemd hardening (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`). Automated deploys run as an **operator** (not root) via command-scoped `sudo -n` — no root shell, no blanket sudo. `bun run drift-check` compares the repo-declared systemd envelope against the live host (unit content, listener exposure, service identity, state-path perms, liveness) and exits non-zero on any drift. See [docs/runtime/envelope.md](docs/runtime/envelope.md).

---

## Deployment

The full production guide is [deploy/DEPLOY.md](deploy/DEPLOY.md). Highlights:

- Runtime services run as **non-root** `vaultwarden-secrets:ai-services` (the account is provisioned upstream; deploy preflight fails closed if it's missing).
- Automated deploys (`deploy/deploy.sh` via `vw-deploy.service`) run as the **operator user**, routing every privileged action through `sudo -n` against the command-scoped grant in [deploy/sudoers.d/vaultwarden-secrets](deploy/sudoers.d/vaultwarden-secrets) — no root shell, no wildcard installs/deletes. Install & validate it:
  ```bash
  sudo install -m 0440 -o root -g root \
    deploy/sudoers.d/vaultwarden-secrets /etc/sudoers.d/vaultwarden-secrets
  visudo -cf /etc/sudoers.d/vaultwarden-secrets   # must print "parsed OK"
  ```
- systemd units for the REST API (:3000), MCP (:3001), cred-proxy (:3003), snapshot timer, backup timer, and deploy timer live in `deploy/systemd/`. The retired unauthenticated deploy trigger on port 3002 is removed and must not be restored.
- **Backups** (`deploy/systemd/vw-backup.{service,timer}`) package the state directory with SQLite's online `.backup`, encrypt with AES-256-GCM, and ship off-host. `bun run scripts/backup-health.ts` fails closed on missing/stale/corrupt backups; `bun run scripts/restore-drill.ts <archive> --target <dir>` runs a monthly restore drill with `PRAGMA integrity_check`. See [docs/operations/backup.md](docs/operations/backup.md).

---

## Configuration

Environment variables actually read by the code (see [deploy/env.example](deploy/env.example)):

**Server / REST (`server/main.ts`)**

| Variable | Default | Purpose |
|---|---|---|
| `SECURITY_PROFILE` | `im-aware` | Active security profile |
| `PORT` | `3000` | REST listen port |
| `HOST` | `0.0.0.0` | REST bind address |
| `NODE_ENV` | — | `production` blocks the `feeling-lucky` profile |
| `API_TOKEN_<CLIENT>` | — | Legacy bearer token(s) for the `im-aware` profile |
| `API_FOLDERS_<CLIENT>` | — | Per-client folder scope for REST |
| `IP_WHITELIST` | auto | Comma-separated CIDRs (or `disable`) to override auto-detection |
| `AUDIT_LOG_FILE` | — | Write audit log to a file instead of console |

**MCP (`server/mcp.ts`)**

| Variable | Default | Purpose |
|---|---|---|
| `MCP_PORT` | `3001` | MCP listen port |
| `MCP_HOST` | `0.0.0.0` | MCP bind address |
| `SECURITY_PROFILE` | `im-aware` | Profile (folder scope + write gate) |
| `VW_ROTATION_DB` | `<control-plane>.rotation-jobs.db` | Rotation job DB path |

**Credential proxy (`server/cred-proxy.ts`)**

| Variable | Default | Purpose |
|---|---|---|
| `PROXY_PORT` | `3003` | Proxy listen port |
| `PROXY_TOKEN` | — | Legacy bearer token |
| `BW_SESSION_FILE` | — | Vault session file (Linux/systemd) |

**Auth profiles (OAuth2 / mTLS)**

`OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_CLIENTS_FILE`, `OAUTH_PROVIDER`, `OAUTH_CALLBACK_URL`, `JWT_SECRET`, `ALLOWED_CLIENT_CERTS`, `ALLOWED_CERT_FINGERPRINTS`, `MTLS_MODE`, `MTLS_HEADER`, `TLS_CERT`, `TLS_KEY`, `TLS_CA`.

**Identity, TLS & runtime**

| Variable | Purpose |
|---|---|
| `VW_STATE_DIR` | Control-plane / identity state dir (default `~/.vaultwarden-secrets/state`) |
| `VW_LEGACY_TOKENS` | `off` disables all legacy token acceptance |
| `VW_REQUIRE_TLS` | `1` makes `recommended` TLS fail-closed if no cert |
| `VW_DEPLOY_HOST` | SSH target for `drift-check` (never hardcoded) |
| `BW_SESSION` / `BW_SESSION_FILE` / `MASTER_KEY_FILE` | Session/master-key storage (Linux) |

**Backups** (`/etc/vaultwarden-secrets/backup.env`): `VW_BACKUP_KEY_FILE`, `VW_BACKUP_DEST`, `VW_BACKUP_RETAIN_DAYS` (30), `VW_BACKUP_MAX_AGE_HOURS` (24), `VW_BACKUP_RECEIPTS_DIR`.

**Rotation connectors:** `CLOUDFLARE_API_TOKEN` (Cloudflare connector).

---

## Testing

```bash
bun test          # run the suite
bun run typecheck # tsc --noEmit
```

The suite spans 29 test files across the library, control plane, rotation engine, authz, identity, middleware, and the MCP contract. Deeper security-profile testing notes: [docs/testing.md](docs/testing.md).

> **Fixture convention:** test fixtures use obviously-fake credential values (`test-`/`fake-` prefixed, e.g. `test-secret`, `test-value-abc`) so secret scanners don't false-positive on the test data. Please keep any new fixtures fake and clearly prefixed.

---

## Contributing & Security

Contributions are welcome. Before opening a PR:

```bash
bun test
bun run typecheck
```

- Keep all example/fixture credentials **fake** (`test-`/`fake-` prefixed). Never commit real secrets — `.gitignore` already excludes `.env`, `.env.*`, `.master-key`, `.vw-cache.json`, `.bw_session*`, `snapshot.enc`, and `deploy/tls/`.
- Secret scanning runs in CI via **[betterleaks](https://github.com/betterleaks/betterleaks)** (a FOSS scanner) on every push/PR — see `.github/workflows/security.yml`.
- Match the existing security posture: default-deny, fail-closed, enumeration parity, no secret material in logs/state/receipts.

**Reporting a vulnerability:** please open a private security report on the repository rather than a public issue.

---

## License

[MIT](LICENSE) © Rico
