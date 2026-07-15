# Deploy Runbook — migrate LXC 214 to mcp2cli + latest `main`

**Goal:** move the live host from `root`-on-old-code to `mcp2cli`-on-`main` (`0cf2723`+), bringing the control plane, rotation, authz, and `get_credential` online as non-root.

**Host:** LXC 214 — `10.71.20.14` (`/opt/vaultwarden-secrets`)
**Runtime user (new):** `mcp2cli` (uid 2020, group `ai-services` 2005) — already exists.
**Current state (verified live 2026-07-15):** LXC on `develop @ 0809266`. Units are the OLD root layout (`User=root`, `ExecStart=/root/.bun/bin/bun`). Only `vaultwarden-secrets-mcp.service` runs (as root); REST + cred-proxy are stopped/disabled. Two root timers are **enabled and firing every 15 min**: `vw-session-refresh.timer` (rewrites `/root/.bw-session`) and `vw-snapshot.timer`.

**Where secret material actually lives (verified — corrects earlier drafts):**
- BW session: `/root/.bw-session` (root:root 0644)
- Master key: **`/opt/vaultwarden-secrets/.master-key`** (root:root 0600) — NOT `/root/.master-key`, which does not exist. `.env` sets `MASTER_KEY_FILE=/opt/vaultwarden-secrets/.master-key`.
- **Bitwarden CLI vault DB: `/root/.config/Bitwarden CLI/data.json`** (root:root 0600, ~3.2 MB). The app runs live `bw list/get` — it needs this DB. The `main` units set `HOME=/var/lib/vaultwarden-secrets`, so `bw` will look for it at `/var/lib/vaultwarden-secrets/.config/Bitwarden CLI/data.json`. **This must be relocated or reads fail even with a valid session token.**
- `.env` / `.env.cred-proxy`: `/opt/vaultwarden-secrets/` (root:root 0600)

> Run each STEP in order. Stop and inspect on any error — the new `deploy.sh` is fail-closed, so a bad preflight aborts cleanly. Commands run **as root** on the LXC unless noted (`root@10.71.20.14`). `mcp2cli` is the target runtime user.
>
> **Ordering is load-bearing:** the mcp2cli units + `deploy.sh` (default `VW_SERVICE_USER=mcp2cli`) live on `main` (`0cf2723`). The host is on `develop`, where those files still say `vaultwarden-secrets`. STEP 1 checks out `main` **before** STEP 5 installs units from the checkout — do not reorder, or you'll install the old root units.

---

## STEP 0 — Snapshot current state (rollback anchor)

```sh
cd /opt/vaultwarden-secrets
git rev-parse HEAD > /root/vw-premigrate-HEAD.txt          # record old commit
mkdir -p /root/vw-unit-backup
cp -a /etc/systemd/system/vaultwarden-secrets*.service /etc/systemd/system/vw-*.service /etc/systemd/system/vw-*.timer /root/vw-unit-backup/ 2>/dev/null || true
cp -a /opt/vaultwarden-secrets/.env /root/vw-unit-backup/env.bak
cp -a /opt/vaultwarden-secrets/.env.cred-proxy /root/vw-unit-backup/env.cred-proxy.bak
systemctl list-unit-files 'vw*' 'vaultwarden*' > /root/vw-premigrate-units.txt

# STOP the racing root timers so they can't rewrite /root paths mid-migration.
# (They refresh the session + snapshot every 15 min as root — leaving them running
#  would clobber the state-dir copies we're about to create.)
systemctl stop    vw-session-refresh.timer vw-snapshot.timer
systemctl disable vw-session-refresh.timer vw-snapshot.timer
# MCP keeps serving on :3001 (root) until STEP 6 replaces it — do NOT stop it yet.
```

## STEP 1 — Update the code checkout to `main`

The host is on `develop`; the default trunk is now `main`. Point the checkout at `main` and pull.

```sh
cd /opt/vaultwarden-secrets
git fetch origin
git checkout main            # switch off develop
git reset --hard origin/main # = 0cf2723+ ; discards any local drift on the checkout
git rev-parse --short HEAD   # confirm it matches origin/main
bun install                  # refresh deps for the new modules (control-plane, rotation, etc.)
```

## STEP 2 — Provision the state dir (owned by mcp2cli)

The new units expect `/var/lib/vaultwarden-secrets` owned by `mcp2cli:ai-services`. systemd's `StateDirectory=` will create it on first start, but we pre-create so we can place secret material now.

```sh
install -d -m 0700 -o mcp2cli -g ai-services /var/lib/vaultwarden-secrets
install -d -m 0700 -o mcp2cli -g ai-services /var/lib/vaultwarden-secrets/state
install -d -m 0700 -o mcp2cli -g ai-services /var/lib/vaultwarden-secrets/config
# bw appdata dir — the units set HOME here, so bw expects its DB under $HOME/.config.
install -d -m 0700 -o mcp2cli -g ai-services /var/lib/vaultwarden-secrets/.config
install -d -m 0700 -o mcp2cli -g ai-services "/var/lib/vaultwarden-secrets/.config/Bitwarden CLI"
```

## STEP 3 — Relocate secret material into the mcp2cli-owned state dir  ⚠️ handles key + vault material

Copy (not move — keep root originals until verified) the session, master key, and the **bw vault DB** into the state dir, re-owned to mcp2cli. Source paths are the verified live locations from the header.

```sh
# 1. BW session token  (/root → state dir)
install -m 0600 -o mcp2cli -g ai-services /root/.bw-session \
  /var/lib/vaultwarden-secrets/.bw-session

# 2. Master key  (/opt → state dir). MANDATORY — preflight hard-fails if MASTER_KEY_FILE is missing.
ls -la /opt/vaultwarden-secrets/.master-key   # verified source path (NOT /root/.master-key)
install -m 0600 -o mcp2cli -g ai-services /opt/vaultwarden-secrets/.master-key \
  /var/lib/vaultwarden-secrets/.master-key

# 3. Bitwarden CLI vault DB  (/root/.config → $HOME/.config for mcp2cli).
#    Without this, `bw unlock`/`bw list` fail even with a valid session — the app
#    can't find the encrypted vault to decrypt. This is vault material: copy, re-own,
#    never inspect its contents.
install -m 0600 -o mcp2cli -g ai-services "/root/.config/Bitwarden CLI/data.json" \
  "/var/lib/vaultwarden-secrets/.config/Bitwarden CLI/data.json"

# 4. App .env files stay in /opt but must be readable by mcp2cli
chown mcp2cli:ai-services /opt/vaultwarden-secrets/.env /opt/vaultwarden-secrets/.env.cred-proxy
chmod 0640 /opt/vaultwarden-secrets/.env /opt/vaultwarden-secrets/.env.cred-proxy
```

> **Note on `.env` `BW_SESSION_FILE`:** the live `.env` sets `BW_SESSION_FILE=/root/.bw-session`. The `main` units override it via `Environment=BW_SESSION_FILE=/var/lib/...` (systemd `Environment=` wins over `EnvironmentFile=`), so no `.env` edit is strictly required for the services. But the manual snapshot/CLI and the session-refresh script read `.env` too — update the line to the state-dir path to avoid a split-brain session:
> ```sh
> sed -i 's#^BW_SESSION_FILE=.*#BW_SESSION_FILE=/var/lib/vaultwarden-secrets/.bw-session#' /opt/vaultwarden-secrets/.env
> ```

> **Backup key (`VW_BACKUP_KEY_FILE`)**: the vw-backup unit needs a backup encryption key you hold. If you want backups enabled, place it now at the path the backup unit expects (`/var/lib/vaultwarden-secrets/.backup-key` or per `docs/operations/backup.md`), `-o mcp2cli -m 0600`. If you skip it, leave `vw-backup.timer` disabled (STEP 6).

## STEP 4 — Hand the app dir to mcp2cli

```sh
chown -R mcp2cli:ai-services /opt/vaultwarden-secrets
# .git stays functional for mcp2cli; deploy.sh pulls as the operator, see note.
```

## STEP 5 — Install the scoped sudoers + sync the new units

```sh
# Sudoers (lets operator `rico` run the exact privileged deploy steps, no root shell)
install -m 0440 -o root -g root \
  /opt/vaultwarden-secrets/deploy/sudoers.d/vaultwarden-secrets \
  /etc/sudoers.d/vaultwarden-secrets
visudo -cf /etc/sudoers.d/vaultwarden-secrets      # MUST print "parsed OK"

# Install the new (mcp2cli) unit files — services + their timers
for u in vaultwarden-secrets vaultwarden-secrets-mcp vw-cred-proxy vw-snapshot vw-backup; do
  install -m 0644 /opt/vaultwarden-secrets/deploy/systemd/$u.service /etc/systemd/system/$u.service
done
install -m 0644 /opt/vaultwarden-secrets/deploy/systemd/vw-snapshot.timer /etc/systemd/system/
install -m 0644 /opt/vaultwarden-secrets/deploy/systemd/vw-backup.timer   /etc/systemd/system/

# De-rooted session refresh (this branch adds these; main dropped the old root ones).
install -m 0644 /opt/vaultwarden-secrets/deploy/systemd/vw-session-refresh.service /etc/systemd/system/
install -m 0644 /opt/vaultwarden-secrets/deploy/systemd/vw-session-refresh.timer   /etc/systemd/system/
# Remove the OLD root refresh script's unit if the file lingers (superseded):
rm -f /opt/vaultwarden-secrets/refresh-session.sh   # old hardcoded-/root version; new one is deploy/refresh-session.sh
chmod +x /opt/vaultwarden-secrets/deploy/refresh-session.sh

# Operator auto-deploy unit (User=rico, runs deploy.sh). Install but DECIDE in STEP 6
# whether to enable the timer — see the "Deploy-as-operator" prereq.
install -m 0644 /opt/vaultwarden-secrets/deploy/systemd/vw-deploy.service /etc/systemd/system/
install -m 0644 /opt/vaultwarden-secrets/deploy/systemd/vw-deploy.timer   /etc/systemd/system/
systemctl daemon-reload
```

## STEP 6 — Preflight (fail-closed) then start services

```sh
# Dry preflight via deploy.sh (checks user exists, ExecStart executable, env + session readable AS mcp2cli)
cd /opt/vaultwarden-secrets
VW_PREFLIGHT_ONLY=1 VW_SERVICE_USER=mcp2cli sh deploy/deploy.sh    # must exit 0

# Start the core services
systemctl enable --now vaultwarden-secrets.service          # REST :3000
systemctl enable --now vaultwarden-secrets-mcp.service      # MCP :3001 (replaces old root MCP)
systemctl enable --now vw-cred-proxy.service                # proxy :3003
systemctl enable --now vw-session-refresh.timer             # 15-min BW session refresh (now as mcp2cli)
systemctl enable --now vw-snapshot.timer                    # 15-min vault snapshot (now as mcp2cli)
# Backups — ONLY if you placed the backup key in STEP 3:
# systemctl enable --now vw-backup.timer
# Operator auto-deploy — ONLY if rico has the deploy SSH key + pull access (see prereqs):
# systemctl enable --now vw-deploy.timer
```

## STEP 7 — Verify

```sh
systemctl is-active vaultwarden-secrets vaultwarden-secrets-mcp vw-cred-proxy   # all: active
id mcp2cli; ps -o user= -C bun | sort -u                    # bun procs run as mcp2cli, NOT root

# MCP responds + advertises the new tool set (should include get_credential + rotate_secret)
curl -s -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $CLAUDE_MCP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  http://10.71.20.14:3001/mcp | grep -o '"name":"[a-z_]*"' | sort -u

# From the Mac: a real lookup through mcp2cli still works
mcp2cli vaultwarden-secrets get_credential --params '{"query":"<a known item>"}'
```

Expected tool list: `search_secrets, get_secret, get_secret_fields, list_secrets, snapshot_info, get_service, get_credential` + writes (`create_secret, update_secret, delete_secret, refresh_snapshot, rotate_secret`) under `im-aware`.

## STEP 8 — Decommission the old root footprint (after verify passes)

```sh
# All originals were COPIED, not moved — remove the root-owned copies only after
# STEP 7 verify passes and the mcp2cli services have run through a snapshot cycle.
# (KEEP for at least one refresh+snapshot interval, then:)
# rm -f /root/.bw-session
# rm -f "/root/.config/Bitwarden CLI/data.json"      # vault DB now lives under the state dir
# NOTE: /opt/vaultwarden-secrets/.master-key was copied to the state dir; the copy
#   is what the services use. Removing the /opt original is optional — leave it as a
#   break-glass copy unless policy says otherwise.
# The old root MCP was replaced by the mcp2cli unit in STEP 6 — no separate cleanup.
```

---

## Rollback (if any step fails)

```sh
# Restore old units + old checkout, restart old MCP:
cp -a /root/vw-unit-backup/*.service /etc/systemd/system/
cd /opt/vaultwarden-secrets && git reset --hard "$(cat /root/vw-premigrate-HEAD.txt)"
systemctl daemon-reload
systemctl start vaultwarden-secrets-mcp.service    # back to old root MCP on :3001
```

## Prerequisites you (Rico) own — cannot be done by the agent
1. **BW session validity** — `/root/.bw-session` must be a live unlocked session at migration time (STEP 3 copies it). If stale, `bw unlock` and refresh first. Because STEP 0 stops the root refresh timer, refresh once manually if the migration spans >15 min.
2. **Master key** — exists at `/opt/vaultwarden-secrets/.master-key` (verified); STEP 3 copies it. No action needed unless it's somehow absent, in which case the vault can't be decrypted and this migration should not proceed.
3. **Backup key** (optional) — only if enabling `vw-backup.timer` (STEP 3 note).
4. **Deploy-as-operator** — the `vw-deploy` timer runs `deploy.sh` as `rico` via scoped sudoers. Enable it (STEP 6) only once `rico` can `ssh`/pull on the host and holds the deploy SSH key (`VW_DEPLOY_SSH_KEY`). Until then leave `vw-deploy.timer` disabled and deploy manually.

## Notes
- Ports unchanged: REST 3000, MCP 3001, cred-proxy 3003.
- mcp2cli reaches the vault via `bw` at `/usr/local/bin/bw` (in the unit PATH) using the relocated session.
- The deploy webhook trigger was retired (unauthenticated) — deploys are operator-initiated (`git deploy` / manual `deploy.sh`), not webhook-driven.
