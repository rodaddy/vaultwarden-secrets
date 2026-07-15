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
  `serve` `tls`). Plain HTTP stays allowed for localhost/LAN dev only.
- Fail-closed (SEC-1): `server/utils/tls.ts:resolveIngressTls` is the
  authoritative gate. It exits non-zero — never serving plaintext — when TLS is
  required (`VW_REQUIRE_TLS=1`, or a profile `tls` level of `required` /
  `required+strict`) and cert+key cannot both be loaded, OR when any provided
  cert/key/ca is broken (cert-but-no-key, a garbage key, or a missing path).

## State paths (DEP-3 / DEP-6)

Every path-valued env points inside the owner-only `StateDirectory`. None fall
back to `/root` or a `HOME`-derived default, and the audit log is inside the
writable state dir (not `/var/log`, which is read-only under
`ProtectSystem=strict`). Required ownership is `vwsecrets:vwsecrets`.

| Env var                   | Path                                          | Mode | Owner     |
| ------------------------- | --------------------------------------------- | ---- | --------- |
| (StateDirectory root)     | `/var/lib/vaultwarden-secrets`                | 0700 | vwsecrets |
| `VW_STATE_DIR`            | `/var/lib/vaultwarden-secrets/state`          | 0700 | vwsecrets |
| (identity store file)     | `…/state/identities.json`                     | 0600 | vwsecrets |
| `VAULTWARDEN_SECRETS_DIR` | `/var/lib/vaultwarden-secrets/config`         | 0700 | vwsecrets |
| (snapshot)                | `…/config/snapshot.enc`                       | 0600 | vwsecrets |
| (cache)                   | `…/config/cache.json`                         | 0600 | vwsecrets |
| `BW_SESSION_FILE`         | `/var/lib/vaultwarden-secrets/.bw-session`    | 0600 | vwsecrets |
| `MASTER_KEY_FILE`         | `/var/lib/vaultwarden-secrets/.master-key`    | 0600 | vwsecrets |
| `AUDIT_LOG_FILE`          | `/var/lib/vaultwarden-secrets/audit.log`      | 0640 | vwsecrets |
| `TLS_CERT` / `TLS_KEY`    | operator-chosen; must be readable by vwsecrets | 0640 | vwsecrets |

The code already honors these envs: `VAULTWARDEN_SECRETS_DIR` via
`types.ts:getConfigDir`, `BW_SESSION_FILE` / `MASTER_KEY_FILE` via `keychain.ts`,
`VW_STATE_DIR` via `server/identity/store.ts`, `AUDIT_LOG_FILE` via
`server/main.ts`. The deploy preflight (DEP-1) checks the session/key files
exist and are readable by `User=` before allowing the hardened unit swap, and
checks the TLS/master-key files are readable when configured.

## Migration: root → service user

The previous deployment ran services as root with the BW session at
`/root/.bw-session`. To adopt this envelope:

1. Create the `vwsecrets` user/group (above).
2. Install `bun` at `/usr/local/bin/bun` (the hardened units no longer reference
   `/root/.bun/bin/bun`, which the non-root user cannot read).
3. Create the state dirs and move/relocate the existing state (exact commands):
   ```sh
   # Owner-only state + subdirs
   install -d -m 700 -o vwsecrets -g vwsecrets /var/lib/vaultwarden-secrets
   install -d -m 700 -o vwsecrets -g vwsecrets /var/lib/vaultwarden-secrets/state
   install -d -m 700 -o vwsecrets -g vwsecrets /var/lib/vaultwarden-secrets/config

   # BW session: move off /root, re-own and lock down
   mv /root/.bw-session /var/lib/vaultwarden-secrets/.bw-session
   chown vwsecrets:vwsecrets /var/lib/vaultwarden-secrets/.bw-session
   chmod 600 /var/lib/vaultwarden-secrets/.bw-session

   # Master key: move any existing key file (if MASTER_KEY_FILE was set before)
   # or leave absent to be generated on first run as vwsecrets.
   if [ -f /root/.vaultwarden-master-key ]; then
     mv /root/.vaultwarden-master-key /var/lib/vaultwarden-secrets/.master-key
     chown vwsecrets:vwsecrets /var/lib/vaultwarden-secrets/.master-key
     chmod 600 /var/lib/vaultwarden-secrets/.master-key
   fi

   # Relocate any prior config/snapshot/cache the root user held.
   if [ -d /root/.config/vaultwarden-secrets ]; then
     cp -a /root/.config/vaultwarden-secrets/. /var/lib/vaultwarden-secrets/config/
     chown -R vwsecrets:vwsecrets /var/lib/vaultwarden-secrets/config
   fi

   # Audit log inside the writable state dir (ProtectSystem=strict blocks /var/log).
   install -m 640 -o vwsecrets -g vwsecrets /dev/null /var/lib/vaultwarden-secrets/audit.log
   ```
4. Regenerate the snapshot AS the service user BEFORE restart, so the servers
   read a snapshot encrypted with the service-owned master key and pointing at
   the service session (a snapshot made as root under root's key is unreadable
   to `vwsecrets`):
   ```sh
   sudo -u vwsecrets env \
     VAULTWARDEN_SECRETS_DIR=/var/lib/vaultwarden-secrets/config \
     VW_STATE_DIR=/var/lib/vaultwarden-secrets/state \
     BW_SESSION_FILE=/var/lib/vaultwarden-secrets/.bw-session \
     MASTER_KEY_FILE=/var/lib/vaultwarden-secrets/.master-key \
     SECURITY_PROFILE=im-aware \
     /usr/local/bin/bun run /opt/vaultwarden-secrets/cli.ts snapshot
   ```
5. Ensure `/opt/vaultwarden-secrets` is readable by `vwsecrets` (code is
   read-only for the service; `.env` files should be `chmod 640` owned by
   `vwsecrets`). If TLS is configured, ensure `TLS_CERT`/`TLS_KEY` are readable
   by `vwsecrets` too.
6. `systemctl daemon-reload` then restart services **one at a time**, verifying
   health before proceeding (never stop MCP before its replacement is proven —
   see rollback). The deploy preflight (DEP-1) enforces these file checks
   automatically; running `deploy/deploy.sh` will refuse the unit swap and leave
   the old units running if any required file/user/binary is missing.

## Deploy safety (DEP-1 / DEP-2)

`deploy/deploy.sh` is fail-closed:

- **Preflight before any sync (DEP-1):** every declared unit is checked — the
  `User=` exists, each `ExecStart` binary is executable, non-optional
  `EnvironmentFile` is present, and the state dir + `BW_SESSION_FILE` /
  `MASTER_KEY_FILE` are readable by `User=`. Any failure aborts the whole sync;
  no unit is swapped and the running services are untouched. Exit nonzero.
- **Backup + verified restart + rollback (DEP-2):** each replaced unit is
  backed up to `/etc/systemd/system/.vw-backup/` first. After the MCP restart,
  `deploy.sh` verifies health (`systemctl is-active` + a bounded
  `scripts/mcp-probe.ts` on 3001). On failure it restores the backed-up unit,
  `daemon-reload`s, restarts, re-verifies, and exits nonzero. The MCP unit is
  only ever stopped as part of its own `restart`.

Preflight logic is unit-tested offline via `deploy/preflight.test.sh` (a fake
root exercises the PASS branch and each fail-closed branch).

## Rollback

The envelope must never leave MCP down. Rollback restores the previous
known-good unit files and restarts, and never stops MCP before a replacement is
proven healthy.

1. Restore the previous unit files into `/etc/systemd/system/`. `deploy.sh`
   keeps backups at `/etc/systemd/system/.vw-backup/<unit>`; otherwise restore
   from git.
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

# Deploy preflight fail-closed branches (offline, fake root)
sh deploy/preflight.test.sh

# Live drift report (redacted; SSH target from env, never a hardcoded IP).
# DEP-5: this now also REQUIRES each long-running unit is is-active, MCP is
# listening on 3001, effective ExecStart matches the declared unit, and the MCP
# probe is HEALTHY (or AUTH_ENFORCED only with --allow-auth-enforced). A host
# with MCP down is reported as drift (nonzero exit).
VW_DEPLOY_HOST=root@<host-or-ssh-alias> bun run scripts/drift-check.ts
```
