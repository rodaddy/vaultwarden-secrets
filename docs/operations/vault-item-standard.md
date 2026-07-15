# Vault item standard

Canonical format for items in the agent-scoped **Infrastructure** folder. The goal:
one `get_credential` call resolves the right item on the first try, and
`get_service` aggregates multi-host services without guesswork. Items outside
Infrastructure (personal browser logins) are out of scope — agents cannot see them.

## Naming

- **`<Service> - <subject>`** — one item per credential-bearing identity at one
  service. `<Service>` uses ONE canonical spelling everywhere (`PiHole`, not
  `pihole03.rodaddy.live`); `<subject>` is the account/role in lowercase:
  `Grafana - admin`, `LiteLLM - rico`, `PiHole - linux account`.
- **`<service>NN`** — multi-instance hosts get numbered identities: `pihole01`,
  `pihole02`, `proxmox01`. Never `Primary`/`Secondary` (roles change; identity
  doesn't — and there is no natural "tertiary"). The FQDN/IP lives in `login.uri`
  or a `host:` note line, never in the name.
- **`<service>_api`** — a service-wide API credential (matches the `get_service`
  resolver: prefix + `_api`/`-api`/digit suffix, `server/service-resolver.ts`).
- No domains, no SCREAMING_SNAKE, no em-dashes, no prose in names. Names identify;
  fields and notes describe.

## Item shape — one identity per item

- Everything about one identity (token + its id + its url) lives in ONE item's
  fields — not five sibling items (no `X - Bot Token` + `X - Client Secret` +
  `X - Server ID` confetti).
- Nothing about a SECOND identity lives in it — no mega-vaults holding a whole
  system's secrets (they force a second `get_secret_fields` call and couple
  unrelated blast radii on rotation).
- Reference model: the `RTech MCPs - <server>` items — one item per consuming
  service, fields are exactly its env vars.
- Prefer **login** type; BW silently ignores login fields on Secure Notes
  (type 2). Use notes-type only for pure data bundles with custom fields.

## Field names — snake_case canon

`api_key`, `api_token`, `client_id`, `client_secret`, `bot_token`, `public_key`,
`private_key`, `ssh_public_key`, `ssh_private_key`, `url`, `uid`, `gid`, `lxc`,
`node`, `ct_id`. One spelling — never `API Key`, `Token Value`, `BotToken`, or
unnamed (`no_name`) fields.

## Where data lives (in order)

1. **`login.username` / `login.password` / `login.totp`** — the primary credential.
2. **`login.uri`** — FQDN/IP/URL of the thing the credential opens.
3. **Custom fields** — anything a machine consumes (canon names above).
4. **Notes** — human context as parseable `key: value` lines
   (`role: primary`, `host: pihole03.rodaddy.live`, `lxc: 214`,
   `See PiHole - linux account for ssh`). The resolver already parses
   `Token ID:` / `Token value:` / `Secret:` / `See <item> for ...` lines.
   **Notes never hold a secret value** — notes are returned wholesale by every
   item fetch; values belong in fields.

## Duplicates

- Two items may not share a name in Infrastructure. Identical twins: delete one
  (soft-delete → trash). Differing twins: both get a
  `DUPE-CHECK <date>: ... differ in: <parts>` note until reconciled.
- If "twins" turn out to be the same account on different hosts, they are not
  duplicates — rename per the multi-instance rule
  (`pihole01 - linux account` / `pihole02 - linux account`).

## Examples

| Bad (real, pre-cleanup)                     | Good                                  |
| ------------------------------------------- | ------------------------------------- |
| `pihole03.rodaddy.live`                      | `pihole03` (uri: pihole03.rodaddy.live) |
| `PiHole - Primary`                           | `pihole01` (note: `role: primary`)    |
| `CF-AI-API-TOKEN`                            | `Cloudflare - ai api token`           |
| `king-cap - Bot Token` + 4 sibling items     | `king-cap - bot` (fields: bot_token, client_secret, server_id, webhook_urls, channel_ids) |
| `OpenAI API Key - LiteLLM01`                 | `OpenAI - litellm upstream 01`        |
| 18-field `rtech-portal - Production` mega-vault | one item per identity: `rtech-portal - db`, `rtech-portal - oidc`, `rtech-portal - stripe`, … |

## Migration state (2026-07-15)

- Honcho decommissioned — all 5 items trashed.
- Dedup pass done: 5 identical twins trashed; 20 differing pairs carry
  `DUPE-CHECK` notes pending reconciliation (most are suspected per-host
  Linux accounts needing `<service>NN - linux account` renames).
- Pending: outlier renames, mega-vault splits, field-name normalization.
  Renames MUST be preceded by a consumer audit (`proxy.config.json`, scripts,
  n8n flows, agent skills fetch by exact name).
