# Declared Runtime & Ingress Envelope (issue #14)

This is the source-of-truth description of the hardened runtime boundary for
`vaultwarden-secrets`. The systemd unit files in `deploy/systemd/*.service` are
the declaration; `scripts/drift-check.ts` compares them to the live host; and
`server/__tests__/runtime-envelope.test.ts` is the CI tripwire that fails if the
declaration regresses (root user, missing hardening, or a reintroduced port
3002).

## Service identity

All runtime workload services run as a dedicated non-root identity:

- User/Group: `vaultwarden-secrets` / `ai-services`
- Home: `/var/lib/vaultwarden-secrets` (the systemd `StateDirectory`)

This account is provisioned **UPSTREAM** in the TN01/rtech-infra directory
scheme (UIDs synced from TN01; group `ai-services` holds sibling service users
like `mcp2cli`). This repo only **references** it — it does not create it, and
deploy preflight fails closed if the account is absent. For reference the
upstream provisioning is equivalent to:

```sh
# Provisioned upstream (TN01/rtech-infra) — shown for reference only.
useradd --system --gid ai-services \
        --home-dir /var/lib/vaultwarden-secrets \
        --shell /usr/sbin/nologin vaultwarden-secrets
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

## Deploy orchestrator (operator `rico`, scoped sudo — never root)

`vw-deploy.service` (+ `vw-deploy.timer`) is the deployment mechanism, not a
runtime workload. It runs `deploy/deploy.sh` as the **operator user `rico`**
(uid 3000), NOT root. `deploy.sh` still needs a few privileged actions
(`systemctl`, `daemon-reload`, writing units into `/etc/systemd/system`); it
performs each one through `run_privileged()`, which prefixes `sudo -n`
(non-interactive) against a **command-scoped NOPASSWD grant** — never a root
shell, never blanket sudo. The exact allowed commands are the ONLY entries in
`deploy/sudoers.d/vaultwarden-secrets`.

Install the grant and validate it before trusting the deploy path:

```sh
sudo install -m 0440 -o root -g root \
  deploy/sudoers.d/vaultwarden-secrets /etc/sudoers.d/vaultwarden-secrets
visudo -cf /etc/sudoers.d/vaultwarden-secrets   # must print "parsed OK"
```

The sudoers file honors the exact-write / wildcard-read matching rule: write
verbs (`start`/`stop`/`restart`/`daemon-reload`) are exact-match; read commands
(`status`/`is-active`/`journalctl`) carry a trailing ` *` so flags like
`--no-pager` still match. If a needed grant is missing, `sudo -n` fails loudly
(no prompt) and `deploy.sh` points at the sudoers file — it never silently
degrades.

The operator's read-only GitHub deploy key is resolved from `$HOME`
(`VW_DEPLOY_SSH_KEY`, default `${HOME}/.ssh/id_ed25519_github`) — the operator's
key, never `/root`'s. The tripwire test still requires `vw-deploy.service` never
declare `User=root` and never reference the retired port 3002.

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
`ProtectSystem=strict`). Required ownership is `vaultwarden-secrets:ai-services`.

| Env var                   | Path                                          | Mode | Owner     |
| ------------------------- | --------------------------------------------- | ---- | --------- |
| (StateDirectory root)     | `/var/lib/vaultwarden-secrets`                | 0700 | vaultwarden-secrets |
| `VW_STATE_DIR`            | `/var/lib/vaultwarden-secrets/state`          | 0700 | vaultwarden-secrets |
| (identity store file)     | `…/state/identities.json`                     | 0600 | vaultwarden-secrets |
| `VAULTWARDEN_SECRETS_DIR` | `/var/lib/vaultwarden-secrets/config`         | 0700 | vaultwarden-secrets |
| (snapshot)                | `…/config/snapshot.enc`                       | 0600 | vaultwarden-secrets |
| (cache)                   | `…/config/cache.json`                         | 0600 | vaultwarden-secrets |
| `BW_SESSION_FILE`         | `/var/lib/vaultwarden-secrets/.bw-session`    | 0600 | vaultwarden-secrets |
| `MASTER_KEY_FILE`         | `/var/lib/vaultwarden-secrets/.master-key`    | 0600 | vaultwarden-secrets |
| `AUDIT_LOG_FILE`          | `/var/lib/vaultwarden-secrets/audit.log`      | 0640 | vaultwarden-secrets |
| `TLS_CERT` / `TLS_KEY`    | operator-chosen; must be readable by vaultwarden-secrets | 0640 | vaultwarden-secrets |

The code already honors these envs: `VAULTWARDEN_SECRETS_DIR` via
`types.ts:getConfigDir`, `BW_SESSION_FILE` / `MASTER_KEY_FILE` via `keychain.ts`,
`VW_STATE_DIR` via `server/identity/store.ts`, `AUDIT_LOG_FILE` via
`server/main.ts`. The deploy preflight (DEP-1) checks the session/key files
exist and are readable by `User=` before allowing the hardened unit swap, and
checks the TLS/master-key files are readable when configured.

## Migration: root → service user

The previous deployment ran services as root with the BW session at
`/root/.bw-session`. To adopt this envelope:

1. Confirm the `vaultwarden-secrets` user (group `ai-services`) exists — it is
   provisioned UPSTREAM (TN01/rtech-infra), not created here. Deploy preflight
   fails closed if it is missing.
2. Install `bun` at `/usr/local/bin/bun` (the hardened units no longer reference
   `/root/.bun/bin/bun`, which the non-root user cannot read).
3. Create the state dirs and move/relocate the existing state (exact commands):
   ```sh
   # Owner-only state + subdirs
   install -d -m 700 -o vaultwarden-secrets -g ai-services /var/lib/vaultwarden-secrets
   install -d -m 700 -o vaultwarden-secrets -g ai-services /var/lib/vaultwarden-secrets/state
   install -d -m 700 -o vaultwarden-secrets -g ai-services /var/lib/vaultwarden-secrets/config

   # BW session: move off /root, re-own and lock down
   mv /root/.bw-session /var/lib/vaultwarden-secrets/.bw-session
   chown vaultwarden-secrets:ai-services /var/lib/vaultwarden-secrets/.bw-session
   chmod 600 /var/lib/vaultwarden-secrets/.bw-session

   # Master key: move any existing key file (if MASTER_KEY_FILE was set before)
   # or leave absent to be generated on first run as vaultwarden-secrets.
   if [ -f /root/.vaultwarden-master-key ]; then
     mv /root/.vaultwarden-master-key /var/lib/vaultwarden-secrets/.master-key
     chown vaultwarden-secrets:ai-services /var/lib/vaultwarden-secrets/.master-key
     chmod 600 /var/lib/vaultwarden-secrets/.master-key
   fi

   # Relocate any prior config/snapshot/cache the root user held.
   if [ -d /root/.config/vaultwarden-secrets ]; then
     cp -a /root/.config/vaultwarden-secrets/. /var/lib/vaultwarden-secrets/config/
     chown -R vaultwarden-secrets:ai-services /var/lib/vaultwarden-secrets/config
   fi

   # Audit log inside the writable state dir (ProtectSystem=strict blocks /var/log).
   install -m 640 -o vaultwarden-secrets -g ai-services /dev/null /var/lib/vaultwarden-secrets/audit.log
   ```
4. Regenerate the snapshot AS the service user BEFORE restart, so the servers
   read a snapshot encrypted with the service-owned master key and pointing at
   the service session (a snapshot made as root under root's key is unreadable
   to `vaultwarden-secrets`):
   ```sh
   sudo -u vaultwarden-secrets env \
     VAULTWARDEN_SECRETS_DIR=/var/lib/vaultwarden-secrets/config \
     VW_STATE_DIR=/var/lib/vaultwarden-secrets/state \
     BW_SESSION_FILE=/var/lib/vaultwarden-secrets/.bw-session \
     MASTER_KEY_FILE=/var/lib/vaultwarden-secrets/.master-key \
     SECURITY_PROFILE=im-aware \
     /usr/local/bin/bun run /opt/vaultwarden-secrets/cli.ts snapshot
   ```
5. Ensure `/opt/vaultwarden-secrets` is readable by `vaultwarden-secrets` (code is
   read-only for the service; `.env` files should be `chmod 640` owned by
   `vaultwarden-secrets`). If TLS is configured, ensure `TLS_CERT`/`TLS_KEY` are readable
   by `vaultwarden-secrets` too.
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
