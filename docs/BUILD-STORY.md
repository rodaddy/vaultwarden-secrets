# How vaultwarden-secrets was built

This is the build history of vaultwarden-secrets, taken from its git log (72
commits, 2026-02-04 to 2026-08-09), the design and test docs in `docs/`, the
goal-run packet that drove the July 2026 rebuild, and the project's issue
tracker and pull requests. This public repository is a one-commit snapshot
of that history.

## The problem

Scripts and AI agents need credentials. Copying them into `.env` files
spreads secrets across machines and repositories, and giving an agent a full
password-manager session gives it every secret at once. The goal was one
self-hosted service in front of a Vaultwarden (Bitwarden-compatible) vault
that hands out only the secrets a caller is allowed to see, logs every read
without logging values, and works for shell scripts, TypeScript code and AI
agents through MCP.

## Timeline

| Date | Phase | What changed |
|---|---|---|
| 2026-02-04 | Library and CLI | A TypeScript library over the Bitwarden CLI, a `secret` CLI with shell integration and folders, a migration wizard that moves secrets out of `.env` and config files, alias resolution. Then an HTTP server with tiered security profiles. |
| 2026-02-05 | Security profiles | Four profiles from development-only to mTLS plus JWT with encryption (`feeling-lucky`, `im-aware`, `im-a-dev`, `trust-no-one`), Touch ID unlock on macOS, and a black-box security test report: 117 end-to-end plus 144 unit tests. |
| 2026-02-06 to 02-11 | Agent access | List, search and field endpoints; per-client folder scoping for API tokens; an MCP server; an offline snapshot fallback; MCP write tools; a credential proxy for least-privilege agent access; GitGuardian scanning in CI. |
| 2026-07-14 to 07-15 | Control-plane rebuild | A planned goal run, described below: compatibility baseline, default-deny authorisation, hardened runtime and workload identity, a non-secret metadata store with immutable versions and aliases, an audit ledger with an outbox, encrypted backup with a restore drill, a durable rotation engine, and a pilot cutover. |
| 2026-08-09 | MCP v2 | A second MCP server on the 2026-07-28 protocol revision, run side by side with the live one on its own port instead of replacing it. |

The source repository continued after this snapshot: in August and
September 2026 the control plane moved from SQLite to Postgres and the
service moved to Kubernetes; in October reads were served from an in-memory
snapshot because serial vault decrypts were timing callers out, and idle MCP
sessions were closed to stop memory growth.

## Key design decisions

The July rebuild was run from a written decision log. The main entries:

- **Vaultwarden keeps the payloads; a separate store keeps everything else.**
  Encrypted secret values stay in the vault. A small non-secret store holds
  logical ids, immutable versions, aliases, policy, operations, audit and
  outbox state. Putting metadata into vault item fields, or payloads into the
  new database, were both rejected. The cost is reconciliation between two
  systems, so tests and schemas are built to refuse payload leakage.
- **Never break the running service.** The MCP endpoint every agent used for
  credentials stayed untouched until a replacement passed its gates. The
  compatibility baseline (#25) pins the tool list, input fields, response
  shapes and error shapes by booting the real server offline, and a
  shadow-check script compares a candidate endpoint with the baseline. The
  August v2 server was added as a new file on a new port for the same reason.
- **Default deny.** Authorisation has one decision point with explicit
  allow and deny precedence, and denials are shaped so a caller cannot use
  them to enumerate secret names.
- **Rotation as a state machine.** Rotation moves through named states
  (requested, provider-created, staged, consumers-reloaded, verified,
  alias-moved, old-revoked, done) with checkpoints and leases, resumes after
  a crash, and revokes the old credential only after the new one verifies.
- **Strict inputs on credential tools.** The v2 server rejects and names an
  unknown argument rather than dropping it, because a misspelt field name on
  a credential tool would otherwise return the whole item.
- **Audit logs carry shapes, not values.** Request logging takes the tool
  name, sorted argument key names and a response byte count, and has no
  parameter that could carry a secret.

## How AI was used to build and check it

The code was written with Claude models as pair programmers; the history
carries 78 co-author trailers across Claude Opus, Sonnet and Fable versions.
The July rebuild was a controller-run goal run: a written packet set the
scope, the phase order, the role of each implementation and review agent,
the validation contract and a hard gate before anything went live. Each
slice was then attacked by a separate adversarial review before merge, and
the commits record the results, for example:

- the rotation engine: 8 P0 and 5 P1 findings fixed (lease correctness,
  crash-safe create, no rollback after publish, the leak guard);
- the de-rooted deploy path: a security review found 2 P0 and 3 P1
  privilege issues, fixed before merge;
- field-level deny in `get_credential`: a review caught that looking up the
  deny rule by raw client id would miss legacy subjects and fail open; the
  lookup now shares one normalisation function with folder scoping.

## Testing

- 2026-02-05: 117 end-to-end and 144 unit tests across the four profiles,
  recorded in `docs/testing.md`.
- At this snapshot the unit suite has about 435 tests across 30 test files,
  run with `bun test`. The rotation engine alone has 27 offline tests
  (happy path, crash-resume, idempotency, lease contention, rollback, alias
  compare-and-swap, no-secret-leak guard); a real Cloudflare connector test
  runs only when a token is supplied.
- `scripts/mcp-probe.ts` and `scripts/mcp-shadow-check.ts` check a live or
  candidate endpoint without printing values, names or tokens.

## What did not work

- The first rebuild plan kept every legacy service stopped. Partway through,
  the team found that live agents still depended on the MCP service, so that
  decision was superseded: the MCP service and its session-refresh and
  snapshot timers stayed up, and only the retired ports stayed closed.
- The Bitwarden CLI returns several results for ambiguous names, which broke
  item lookups (fixed 2026-02-08). In September 2026 duplicate names were
  found to start two CLI processes per lookup; six concurrent reads took
  the container from about 200 MiB to about 900 MiB and it was being killed
  for memory. That and the missing way to address one of two same-named
  items were both filed and closed.
- A small Swift helper for Touch ID unlock was killed by macOS Sequoia
  because it had no Apple Developer signing identity. It was replaced with
  the Apple-signed `security` Keychain CLI.
- An early deploy ran as root; the July pass moved it to a scoped service
  user with a de-rooted session refresh.

## Current state

Active. The snapshot is the August 2026 code with both MCP servers. The
source tracker has two open issues, both about name matching in credential
lookups (a fuzzy match returned for an exact name, and a scope check that
compares a differently normalised name than it reads).
