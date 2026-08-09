# MCP 2026-07-28 v2 — parallel deployment plan

**Truth state: WRITTEN (2026-08-09). Not merged, not deployed.** The candidate
has been RUN only on loopback (`127.0.0.1:7142`) by
`scripts/mcp-v2-done-means.ts`. Nothing in this branch touches CT 214.

Program: MCP 2026-07-28 cutover (map `rodaddy/development#104`), this lane
`development#112`. Recipe: `development:mcp-cutover/recipes/v2-migration-recipe.md`.

---

## The constraint this design exists to satisfy

Operator ruling, 2026-08-09:

> "we can't really move Vaultwarden secrets until this is known to work because
> that's literally how we get all of our secrets. I wouldn't say we can live
> migrate it, but we can create its own version so that they both exist at the
> same time until we can verify this new platform works."

Read literally: **the live endpoint and its process are untouchable.** No code
edit that the running process loads, no restart, no config change, no port
change. The v2 server is a *separate version* that can run beside it. Cutover is
a later ticket, gated on proof.

This is not an abstract concern. `vaultwarden-secrets` is the second-busiest
service in the roster (18 call sites, behind only `open-brain`), and it is the
path by which every other credential is obtained. A regression here does not
degrade one workflow; it removes the ability to authenticate anything.

The deployed unit already says the same thing in its own header
(`deploy/systemd/vaultwarden-secrets-mcp.service`):

> Protected compatibility service — MCP Streamable HTTP on MCP_PORT (default
> 3001). Do not stop before a proven replacement.

## What runs where

| | Live (v1) | Candidate (v2) |
| --- | --- | --- |
| Entry point | `server/mcp.ts` | `server/mcp-v2.ts` |
| SDK | `@modelcontextprotocol/sdk@1.26.0` | `@modelcontextprotocol/server@2.0.0` |
| Host | CT 214 `vaultwarden-secrets`, proxmox01 | not deployed |
| Port | **3001 — untouchable** | 7142 local; **3011 proposed** on CT 214 |
| Supervisor | systemd `vaultwarden-secrets-mcp.service` | none yet |
| Observed | `active`, `MainPID=166`, `NRestarts=0`, up since 2026-08-05 | loopback only |

Both SDK majors are installed side by side. v1 stays in `package.json` because
the live entry point still imports it; removing it is cutover work, not this
ticket.

### Port choice

`3011`. Read-only `ss -lntp` on CT 214 (2026-08-09) showed 3000 (REST), 3001
(live MCP), and 3003 already bound by `bun`. 3011 is free there and keeps the
30xx grouping. **PROPOSED** — nothing in this branch deploys, and the port is
settled by whoever writes the deployment ticket.

Local default is 7142, inside the 7100-7199 band Development reserves for local
dev servers. `server/mcp-v2.ts` refuses to start on 3001 outright; that guard is
cheap and removes the one typo that could reach the live port.

## Protocol posture

`legacy: 'stateless'` — the SDK default — so **one instance serves both eras**
and can eventually take all traffic:

- 2026-07-28 requests: per-request, no handshake, no `Mcp-Session-Id`.
- 2025-era requests: answered from the same factory, per request.

**Known limitation, deliberately not hidden.** The stateless legacy leg answers
GET/DELETE with 405 and does not preserve 2025 session semantics: pushed
elicitation/sampling/roots, standalone streams, resumability, replay, and
session deletion are unavailable. v1's real clients (mcp2cli, the `_ob` skills)
are simple request/response callers, so this is *believed* sufficient — that
belief is **PROPOSED** and is exactly what the cutover ticket must verify
against real traffic before the live service is retired.

**Do not remove load-balancer session affinity at cutover.** Modern traffic
stops needing it; 2025-era traffic still does, and today that is most traffic.

## Audit safety (mcp2cli#71)

mcp2cli#71: `~/.cache/mcp2cli/logs/audit.ndjson` recorded `responseSummary` with
full response bodies — observed carrying a complete service-account private key
in cleartext, on every box running mcp2cli.

v2's request log is built so that defect is **not expressible**. `logRequest()`
takes a tool name, the sorted argument KEY NAMES, a response BYTE COUNT, and an
ok/error outcome. There is no parameter through which a value or a body could be
passed, so no call site can leak one — including `get_credential`, the exact
call that leaked. Cardinality, not content.

If a future change adds a `value`, `payload`, `body`, or `result` parameter to
that function, it has reintroduced mcp2cli#71.

## Done-means

`bun run mcp:v2:done-means` — exit 0 GREEN, 1 RED, 2 INCOMPLETE.

| Clause | Proves |
| --- | --- |
| A | handshake-free `tools/call` returns `resultType: "complete"` |
| B | undeclared param rejected **and named**; declared param still accepted |
| C | `Mcp-Name` mismatch → 400/`-32020`; matching header → 200 |
| B2 | a 2025-era `initialize` works on the same instance |
| D | **the live endpoint answered identically before and after** |
| E | clause D is mutation-tested and can actually fail |

Clause D is the one that matters for the operator ruling: it probes the live
service read-only (unauthenticated, expecting its 401) and compares a redacted
shape fingerprint — status + sorted key names + byte count — before and after
the candidate runs. It never holds, uses, or logs a live credential. When the
live endpoint is unreachable the run reports **INCOMPLETE (exit 2)**, never a
silent pass; a control that quietly no-ops is worse than no control.

Clauses B, B2, and D have each been mutation-tested and observed to FAIL when
the behavior they assert is removed. Clause C is paired with a positive control
after an earlier hand-rolled version of it passed a mutation that disabled the
validator it was supposed to be testing.

No clause prints a credential value. Assertions are on status codes, JSON-RPC
error codes, key names, and byte counts.

## Recipe corrections earned by running the real SDK

1. **`CacheScope` is `'public' | 'private'` in TypeScript too.** Read from the
   installed `2.0.0` `.d.mts`. The TS migration doc's `'shared'` example does
   not typecheck. Resolves recipe §2c; matches what dev#110 found for Python.
2. **`2.0.0` is the stable dist-tag.** `npm view @modelcontextprotocol/server
   dist-tags` → `{ latest: '2.0.0' }`, with `2.0.0` distinct from the
   `2.0.0-beta.*` line. Resolves the "First beta release" caveat in recipe §1.
3. **The SDK owns header/body validation — do not hand-roll it.** Recipe §8
   reads as though a server author must implement the comparison.
   `createMcpHandler` already answers a mismatch with 400 + `-32020` and a
   `data.mismatch` detail. An earlier draft of `server/mcp-v2.ts` implemented
   ~90 lines of it; a mutation test that disabled that code still passed,
   because the SDK had been answering the whole time.
4. **Undeclared-param rejection lands on the tool-execution channel in
   TypeScript** (`isError: true`), naming the offending key, once
   `z.strictObject` is used. Resolves recipe §5's PROPOSED question for TS —
   same channel Python landed on. With a plain `z.object` the param is silently
   dropped, so the v1 defect survives the SDK bump in TypeScript exactly as
   dev#110 found for Python.

## Not in this lane

- **Write tools are not ported.** `refresh_snapshot`, `create_secret`,
  `update_secret`, `delete_secret`, and `rotate_secret` exist in v1 behind
  `profile.allowWrites` and the default-deny authz engine. Porting the rotation
  engine's authz wiring is its own ticket; the seven read tools are what the 18
  call sites use.
- **No deployment.** No systemd unit, no Ansible, no CT 214 change.
- **No cutover.** `services.json` still points at 3001 and is not edited here.
