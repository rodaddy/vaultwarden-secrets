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

### Gate P2 — Baseline probe HEALTHY (with token)

The current live service must answer `initialize` + `tools/list` **with a valid
token**. This gate requires `HEALTHY` — `AUTH_ENFORCED` (no token) is NOT
sufficient, because it only proves the auth layer rejects anonymous callers, not
that the tool contract is served.

```sh
# VW_MCP_TOKEN must be set (shell only). The probe exits 0 ONLY on HEALTHY.
VW_MCP_BASE_URL="$VW_MCP_BASE_URL" VW_MCP_TOKEN="$VW_MCP_TOKEN" bun scripts/mcp-probe.ts
```

Read the **exit code** (`$?`) on its own line, never appended after the command
(a trailing `; echo ...` on the same line would mask the probe's exit code):

```sh
status=$?
test "$status" -eq 0   # HEALTHY required; any nonzero fails the gate
```

**Pass:** exit `0` and `"status":"HEALTHY"` with `"toolCount"` matching the
baseline (10 under `im-aware`). **Fail action:** abort; the current service is
unhealthy or the token is wrong — investigate before introducing a candidate.

Exit-code contract (from `scripts/mcp-probe.ts`):

| Exit | Meaning |
|---|---|
| 0 | `HEALTHY` (also `AUTH_ENFORCED` **only** when `--allow-auth-enforced` is passed) |
| 2 | `UNHEALTHY` (reachable but handshake/list failed) |
| 3 | `UNREACHABLE` (connection/timeout/DNS) |
| 4 | `CONFIG_ERROR` (bad/missing `VW_MCP_BASE_URL`) |
| 5 | `AUTH_ENFORCED` (no token; auth is up but contract not verified) |

> A dedicated auth-liveness check (no token) may use
> `bun scripts/mcp-probe.ts --allow-auth-enforced` to accept `AUTH_ENFORCED`
> as exit 0. Do **not** use that flag for P2/P4/C3, which require `HEALTHY`.

### Gate P3 — Required timers active

Both operational timers from the baseline must be active (snapshot freshness +
BW session refresh).

```sh
ssh root@<production-host> \
  'systemctl is-active vw-snapshot.timer vw-session-refresh.timer vaultwarden-secrets-mcp.service'
```

**Pass:** three lines of `active`. **Fail action:** abort; a lapsed timer means
stale snapshots or a locked vault session, which the candidate would inherit.

### Gate P4 — Candidate probe HEALTHY (with token)

Bring the candidate up on a **separate port** (never replacing 3001 yet) and
probe it **with a token**. Like P2, this gate requires `HEALTHY`.

```sh
VW_MCP_BASE_URL="$VW_CANDIDATE_URL" VW_MCP_TOKEN="$VW_CANDIDATE_TOKEN" bun scripts/mcp-probe.ts
status=$?
test "$status" -eq 0
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

Only after C1 passes. The service unit is the single switch point.

**Step 1 — capture the rollback anchor before touching anything.** Persist the
currently-deployed commit to a file on the host so R1 has an exact revision to
restore (never rely on shell scrollback):

```sh
ssh root@<production-host> '
  git -C /opt/vaultwarden-secrets rev-parse HEAD > /root/vw-rollback-anchor &&
  echo "rollback anchor: $(cat /root/vw-rollback-anchor)"
'
```

**Step 2 — deploy the candidate revision and promote it via a unit restart.**
The `im-aware` unit is `vaultwarden-secrets-mcp.service` (runs
`bun run server/mcp.ts` on port 3001). Promotion is: fetch/checkout the
candidate revision, then `restart` the unit — a `restart` re-execs in place and
does **not** leave the service stopped:

```sh
ssh root@<production-host> '
  cd /opt/vaultwarden-secrets &&
  git fetch --all --quiet &&
  git checkout "<candidate-revision>" &&
  systemctl restart vaultwarden-secrets-mcp.service
'
```

**Never** `systemctl stop` the active unit and leave it down while staging the
replacement — the fail-closed rule requires the active contract to keep serving
until the replacement's health is proven (C3). If the candidate cannot bind
3001, systemd `Restart=on-failure` retries and rollback R1 restores the anchor.
If the candidate ships as a **separate unit**, enable/start it and confirm it is
healthy (C3) before `systemctl disable --now` on the old unit — again, old never
stops first.

### Gate C3 — Post-promotion probe on 3001

Immediately re-probe the canonical endpoint **with a token** (requires HEALTHY):

```sh
VW_MCP_BASE_URL="$VW_MCP_BASE_URL" VW_MCP_TOKEN="$VW_MCP_TOKEN" bun scripts/mcp-probe.ts
status=$?          # read on its own line — do not append `; echo` and mask it
test "$status" -eq 0
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

Restore the exact revision captured by the C2 rollback anchor
(`/root/vw-rollback-anchor`), then restart the unit in place:

```sh
ssh root@<production-host> '
  set -e
  test -s /root/vw-rollback-anchor || { echo "MISSING rollback anchor — abort"; exit 1; }
  cd /opt/vaultwarden-secrets &&
  git checkout "$(cat /root/vw-rollback-anchor)" &&
  systemctl restart vaultwarden-secrets-mcp.service
'
```

Then re-run **Gate C3** (probe, HEALTHY with token) and **Gate P1** (contract
tests) against the restored service.

**Rollback is only complete when:**

1. `scripts/mcp-probe.ts` against port 3001 exits `0` (`HEALTHY`), **and**
2. `bun test server/__tests__/mcp-contract.test.ts` is green against the
   restored contract, **and**
3. both required timers are `active`.

### Fail-closed invariants (must hold at every step)

- The active 3001 service is **never stopped** before a healthy replacement is
  proven (P4 candidate probe HEALTHY + C1 shadow clean).
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
# 1. Preconditions (both probes require HEALTHY, so pass tokens)
bun test server/__tests__/mcp-contract.test.ts

VW_MCP_BASE_URL="$VW_MCP_BASE_URL" VW_MCP_TOKEN="$VW_MCP_TOKEN" \
  bun scripts/mcp-probe.ts                                          # P2 (baseline)
test $? -eq 0

VW_MCP_BASE_URL="$VW_CANDIDATE_URL" VW_MCP_TOKEN="$VW_CANDIDATE_TOKEN" \
  bun scripts/mcp-probe.ts                                          # P4 (candidate)
test $? -eq 0

# 2. Shadow check N times (C1) — no service is stopped
N="${N:-20}"
fails=0
for i in $(seq 1 "$N"); do
  VW_BASELINE_URL="$VW_MCP_BASE_URL" VW_CANDIDATE_URL="$VW_CANDIDATE_URL" \
  VW_BASELINE_TOKEN="$VW_BASELINE_TOKEN" VW_CANDIDATE_TOKEN="$VW_CANDIDATE_TOKEN" \
    bun scripts/mcp-shadow-check.ts >/dev/null 2>&1 || fails=$((fails+1))
done
echo "shadow: $fails / $N diverged"
test "$fails" -eq 0

# 3. Rollback rehearsal: capture the anchor WITHOUT promoting, and confirm the
#    exact revision it would restore is reachable.
ssh root@<production-host> '
  git -C /opt/vaultwarden-secrets rev-parse HEAD > /root/vw-rollback-anchor &&
  git -C /opt/vaultwarden-secrets cat-file -e "$(cat /root/vw-rollback-anchor)^{commit}" &&
  echo "anchor OK: $(cat /root/vw-rollback-anchor)"
'
```

A green dry run (contract tests pass, both probes `HEALTHY` with token, `0/N`
shadow divergence, rollback anchor captured and reachable) is the go/no-go
signal for the real cutover in #22.
