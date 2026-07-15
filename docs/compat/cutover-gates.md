# MCP Cutover & Rollback Gates

Written, testable gates for replacing the live MCP service (port `3001`,
`vaultwarden-secrets-mcp.service`) without downtime or contract regression.
Established for issue #23; consumed by the runtime redesign (#14) and the
migration/cutover work (#22).

> **Fail-closed principle.** The active port-`3001` service is **never** stopped
> before the replacement's health is proven against the frozen baseline. Every
> gate below is a precondition that must pass *before* the next step. Any gate
> failure aborts the cutover and leaves the current service running.

> **Security note.** No secret values, tokens, item names, or IP addresses
> appear here. All commands are parameterized by environment variables. The
> live service is "the production host". Set the host in your shell only, never
> in committed files:
>
> ```sh
> export VW_MCP_BASE_URL="http://<production-host>:3001"   # baseline
> export VW_CANDIDATE_URL="http://<production-host>:<candidate-port>"
> # Tokens (shell only): export VW_MCP_TOKEN / VW_BASELINE_TOKEN / VW_CANDIDATE_TOKEN
> ```

Artifacts referenced:

- Contract tests: `server/__tests__/mcp-contract.test.ts`
- Probe: `scripts/mcp-probe.ts`
- Shadow check: `scripts/mcp-shadow-check.ts`
- Baseline inventory: `docs/compat/mcp-baseline.md`

---

## Preconditions (all must pass before any cutover step)

### Gate P1 — Contract tests green

Pins the tool list, input schemas, error envelopes, and auth shape.

```sh
bun test server/__tests__/mcp-contract.test.ts
```

**Pass:** `0 fail`. **Fail action:** abort; the candidate diverges from the
frozen contract — fix the candidate, do not weaken the test.

### Gate P2 — Baseline probe healthy

The current live service answers `initialize` + `tools/list`.

```sh
VW_MCP_BASE_URL="$VW_MCP_BASE_URL" VW_MCP_TOKEN="$VW_MCP_TOKEN" bun scripts/mcp-probe.ts
echo "exit=$?"
```

**Pass:** exit `0` with `"status":"HEALTHY"` and `"toolCount"` matching the
baseline (10 under `im-aware`), **or** `"status":"AUTH_ENFORCED"` if run without
a token (proves the auth layer is up). **Fail action:** abort; the current
service is unhealthy — investigate before introducing a candidate.

Exit-code contract (from `scripts/mcp-probe.ts`):

| Exit | Meaning |
|---|---|
| 0 | `HEALTHY` or `AUTH_ENFORCED` |
| 2 | `UNHEALTHY` (reachable but handshake/list failed) |
| 3 | `UNREACHABLE` (connection/timeout/DNS) |
| 4 | `CONFIG_ERROR` (bad/missing `VW_MCP_BASE_URL`) |

### Gate P3 — Required timers active

Both operational timers from the baseline must be active (snapshot freshness +
BW session refresh).

```sh
ssh root@<production-host> \
  'systemctl is-active vw-snapshot.timer vw-session-refresh.timer vaultwarden-secrets-mcp.service'
```

**Pass:** three lines of `active`. **Fail action:** abort; a lapsed timer means
stale snapshots or a locked vault session, which the candidate would inherit.

### Gate P4 — Candidate probe healthy

Bring the candidate up on a **separate port** (never replacing 3001 yet) and
probe it.

```sh
VW_MCP_BASE_URL="$VW_CANDIDATE_URL" VW_MCP_TOKEN="$VW_CANDIDATE_TOKEN" bun scripts/mcp-probe.ts
echo "exit=$?"
```

**Pass:** exit `0`, `"status":"HEALTHY"`, `toolCount` equal to the baseline.
**Fail action:** abort; keep the candidate offline until healthy.

---

## Cutover gates (no-downtime)

### Gate C1 — Shadow check clean over N calls

Run the same non-secret read operations against baseline and candidate and
compare **normalized shapes only** (redacted hashes; no payload values). Repeat
`N` times (default `N=20`) to catch intermittent divergence.

```sh
N="${N:-20}"
fails=0
for i in $(seq 1 "$N"); do
  VW_BASELINE_URL="$VW_MCP_BASE_URL" VW_CANDIDATE_URL="$VW_CANDIDATE_URL" \
  VW_BASELINE_TOKEN="$VW_BASELINE_TOKEN" VW_CANDIDATE_TOKEN="$VW_CANDIDATE_TOKEN" \
    bun scripts/mcp-shadow-check.ts >/dev/null 2>&1 || fails=$((fails+1))
done
echo "shadow: $fails / $N diverged"
test "$fails" -eq 0
```

**Pass:** `0 / N diverged` (loop exits `0`). The shadow check exits `2` on any
divergence in `tools/list`, `snapshot_info` shape, or `list_secrets` envelope.
**Fail action:** abort cutover; investigate the diverging operation from the
redacted per-op hashes. Do **not** stop the 3001 service.

### Gate C2 — Promote candidate to port 3001 (atomic, reversible)

Only after C1 passes. The service unit is the single switch point; keep the
previous unit/port reachable until C3 confirms health.

```sh
# On the production host — record current state first (rollback anchor):
ssh root@<production-host> 'systemctl status vaultwarden-secrets-mcp.service --no-pager | head -5'

# Promote the candidate (deploy the new revision, then restart the unit):
ssh root@<production-host> 'systemctl restart vaultwarden-secrets-mcp.service'
```

**Do not** `stop` the service and leave it down; `restart` minimizes the window.
If the candidate cannot bind 3001, systemd `Restart=on-failure` and the rollback
(R1) restore the prior revision.

### Gate C3 — Post-promotion probe on 3001

Immediately re-probe the canonical endpoint.

```sh
VW_MCP_BASE_URL="$VW_MCP_BASE_URL" VW_MCP_TOKEN="$VW_MCP_TOKEN" bun scripts/mcp-probe.ts
echo "exit=$?"
```

**Pass:** exit `0`, `"status":"HEALTHY"`, `toolCount` unchanged. **Fail action:**
execute rollback R1 immediately.

### Gate C4 — Timers still active post-cutover

```sh
ssh root@<production-host> 'systemctl is-active vw-snapshot.timer vw-session-refresh.timer'
```

**Pass:** two `active`. **Fail action:** re-enable the lapsed timer
(`systemctl enable --now <timer>`); if it will not start, roll back.

---

## Rollback (fail-closed)

### R1 — Restore the previous MCP revision

Preconditions to *start* rollback: C3 or C4 failed, **or** any post-cutover probe
returns non-zero.

```sh
# Restore the previous code revision (the promotion left the prior commit tagged
# or the prior unit available), then restart:
ssh root@<production-host> '
  cd /opt/vaultwarden-secrets &&
  git checkout <previous-revision> &&
  systemctl restart vaultwarden-secrets-mcp.service
'
```

Then re-run **Gate C3** (probe) and **Gate P1** (contract tests) against the
restored service.

**Rollback is only complete when:**

1. `scripts/mcp-probe.ts` against port 3001 exits `0` (`HEALTHY`), **and**
2. `bun test server/__tests__/mcp-contract.test.ts` is green against the
   restored contract, **and**
3. both required timers are `active`.

### Fail-closed invariants (must hold at every step)

- The active 3001 service is **never stopped** before a healthy replacement is
  proven (C1 shadow clean + C4 candidate probe healthy).
- Auth is never disabled or loosened to make a gate pass — an unauthorized
  request must still return `401 { "error": "Unauthorized" }`.
- No gate command prints a secret value, item name, token, or IP. The shadow
  check emits only redacted shape hashes; the probe emits only tool *names*
  (public contract) and counts.
- If any gate's tooling is itself broken/unreachable (exit 3/4), treat it as a
  **failed** gate, not a pass — abort or roll back.

---

## No-downtime cutover simulation (dry run)

Rehearse the full sequence against a **candidate on a scratch port** without
touching 3001. This is the pre-cutover rehearsal referenced by #23's validation:

```sh
# 1. Preconditions
bun test server/__tests__/mcp-contract.test.ts
VW_MCP_BASE_URL="$VW_MCP_BASE_URL"     bun scripts/mcp-probe.ts     # P2 (baseline)
VW_MCP_BASE_URL="$VW_CANDIDATE_URL" VW_MCP_TOKEN="$VW_CANDIDATE_TOKEN" \
  bun scripts/mcp-probe.ts                                          # P4 (candidate)

# 2. Shadow check N times (C1) — no service is stopped
N=20 bash -c '...C1 loop above...'

# 3. Rollback rehearsal: confirm the restore command set is correct WITHOUT
#    promoting — i.e. verify the previous-revision anchor exists.
ssh root@<production-host> 'cd /opt/vaultwarden-secrets && git rev-parse HEAD'
```

A green dry run (contract tests pass, both probes healthy, `0/N` shadow
divergence, rollback anchor confirmed) is the go/no-go signal for the real
cutover in #22.
