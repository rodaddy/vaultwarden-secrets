# Declared Runtime & Ingress Envelope (issue #14)

This is the source-of-truth description of the hardened runtime boundary for
`vaultwarden-secrets`. The systemd unit files in `deploy/systemd/*.service` are
the declaration; `scripts/drift-check.ts` compares them to the live host; and
`server/__tests__/runtime-envelope.test.ts` is the CI tripwire that fails if the
declaration regresses (root user, missing hardening, or a reintroduced port
3002).

## Service identity

All runtime workload services run as a dedicated non-root identity:

- User/Group: `vwsecrets` / `vwsecrets`
- Home: `/var/lib/vaultwarden-secrets` (the systemd `StateDirectory`)

Create it once on the host:

```sh
groupadd --system vwsecrets
useradd --system --gid vwsecrets \
        --home-dir /var/lib/vaultwarden-secrets \
        --shell /usr/sbin/nologin vwsecrets
```

## Runtime workload services (non-root, hardened)

| Unit                                   | Role                          | Port |
| -------------------------------------- | ----------------------------- | ---- |
| `vaultwarden-secrets.service`          | REST API (`server/main.ts`)   | 3000 |
| `vaultwarden-secrets-mcp.service`      | MCP Streamable HTTP (`mcp.ts`)| 3001 |
| `vw-cred-proxy.service`                | Credential proxy              | 3003 |
| `vw-snapshot.service` (+ timer)        | Periodic vault snapshot       | —    |

Each carries the same hardening block:

```ini
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
StateDirectory=vaultwarden-secrets
StateDirectoryMode=0700
ReadWritePaths=/var/lib/vaultwarden-secrets
```

Each also declares an explicit `PATH` and `HOME`. This is load-bearing: systemd
gives units a minimal PATH, and `bw` lives at `/usr/local/bin/bw`. Without
`/usr/local/bin` on PATH the Bitwarden CLI silently fails.

## Privileged orchestrator (intentionally exempt)

`vw-deploy.service` (+ `vw-deploy.timer`) is the deployment mechanism, not a
runtime workload. It runs `deploy/deploy.sh`, which invokes `systemctl`, writes
`/etc/systemd/system`, and `git reset` in `/opt/vaultwarden-secrets` — all of
which require root. It is therefore excluded from the non-root workload rule in
the tripwire test, but it must still never literally declare `User=root` and
never reference the retired port 3002.

## Ingress

- Allowed listeners: **3000 / 3001 / 3003** only.
- Port **3002** (the retired unauthenticated deploy trigger) must be absent.
- TLS: enabled automatically when `TLS_CERT` and `TLS_KEY` are provided (Bun
  `serve` `tls`). Plain HTTP stays allowed for localhost/LAN dev.
- Fail-closed: set `VW_REQUIRE_TLS=1` to refuse plaintext startup — the process
  exits non-zero if no usable cert/key is configured. See `server/utils/tls.ts`.

## State paths

- `/var/lib/vaultwarden-secrets` — 0700, owned by `vwsecrets` (systemd
  `StateDirectory` guarantees this).
- `VW_STATE_DIR=/var/lib/vaultwarden-secrets/state` — workload-identity token
  store (0600 file, see `docs/runtime/identity.md`).
- `BW_SESSION_FILE=/var/lib/vaultwarden-secrets/.bw-session`.

## Migration: root → service user

The previous deployment ran services as root with the BW session at
`/root/.bw-session`. To adopt this envelope:

1. Create the `vwsecrets` user/group (above).
2. Install `bun` at `/usr/local/bin/bun` (the hardened units no longer reference
   `/root/.bun/bin/bun`, which the non-root user cannot read).
3. Create the state dir and move the existing session file:
   ```sh
   install -d -m 700 -o vwsecrets -g vwsecrets /var/lib/vaultwarden-secrets
   install -d -m 700 -o vwsecrets -g vwsecrets /var/lib/vaultwarden-secrets/state
   mv /root/.bw-session /var/lib/vaultwarden-secrets/.bw-session
   chown vwsecrets:vwsecrets /var/lib/vaultwarden-secrets/.bw-session
   chmod 600 /var/lib/vaultwarden-secrets/.bw-session
   ```
4. Ensure `/opt/vaultwarden-secrets` is readable by `vwsecrets` (code is
   read-only for the service; `.env` files should be `chmod 640` owned by
   `vwsecrets`).
5. `systemctl daemon-reload` then restart services **one at a time**, verifying
   health before proceeding (never stop MCP before its replacement is proven —
   see rollback).

## Rollback

The envelope must never leave MCP down. Rollback restores the previous
known-good unit files and restarts, and never stops MCP before a replacement is
proven healthy.

1. Restore the previous unit files (from git or backup) into
   `/etc/systemd/system/`.
2. `systemctl daemon-reload`.
3. Restart the affected service(s). For MCP specifically:
   ```sh
   # Bring the restored unit up FIRST, confirm 3001 answers, only then stop
   # anything. Prefer restart (never a bare stop) so there is no down window.
   systemctl restart vaultwarden-secrets-mcp.service
   curl -fsS http://127.0.0.1:3001/ >/dev/null || echo "MCP not healthy — do not proceed"
   ```
4. Re-run `scripts/drift-check.ts` to confirm the host matches the restored
   declaration.

## Verification

```sh
# CI tripwire (offline, no host needed)
bun test server/__tests__/runtime-envelope.test.ts

# Live drift report (redacted; SSH target from env, never a hardcoded IP)
VW_DEPLOY_HOST=root@<host-or-ssh-alias> bun run scripts/drift-check.ts
```
