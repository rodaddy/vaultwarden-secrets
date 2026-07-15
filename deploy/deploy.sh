#!/usr/bin/env sh
# Deploy script — fetches latest, then fail-closed syncs + restarts.
#
# Hardened per review (DEP-1, DEP-2):
#   - PREFLIGHT before syncing ANY unit: required service user exists, every
#     ExecStart binary is executable, EnvironmentFile present, and the state
#     dir + session/key files are readable by the unit's User=. Any failure
#     skips the sync+restart of that unit, logs loudly, and exits nonzero.
#     The old unit keeps running.
#   - BACKUP each replaced unit, restart, then VERIFY health (is-active + a
#     bounded MCP probe on 3001). On failure, RESTORE the backup, daemon-reload,
#     restart, re-verify, and exit nonzero. The MCP unit is only ever stopped as
#     part of its own restart.
#
# Overridable paths (defaults are the production layout) — set for local dry-run
# tests via a fake root:
#   VW_SYSTEMD_DIR   target unit dir            (default /etc/systemd/system)
#   VW_STATE_DIR_HOST service state dir         (default /var/lib/vaultwarden-secrets)
#   VW_UNIT_SRC_DIR  repo unit source dir       (default $REPO_DIR/deploy/systemd)
#   VW_MCP_PORT      MCP health port            (default 3001)
#   VW_PROBE_RETRIES bounded health retries     (default 10)
#   VW_PROBE_SLEEP   seconds between retries     (default 2)
#   VW_PREFLIGHT_ONLY  =1 → run preflight for all units and exit (test hook)
#   VW_SYNC          =0  → skip git fetch/sync/restart (preflight-only harness)
#
# When sourced with VW_LIB_ONLY=1, only defines functions (for shell tests).

set -eu

REPO_DIR="${REPO_DIR:-/opt/vaultwarden-secrets}"
BRANCH="${DEPLOY_BRANCH:-develop}"
SYSTEMD_DIR="${VW_SYSTEMD_DIR:-/etc/systemd/system}"
STATE_DIR_HOST="${VW_STATE_DIR_HOST:-/var/lib/vaultwarden-secrets}"
UNIT_SRC_DIR="${VW_UNIT_SRC_DIR:-$REPO_DIR/deploy/systemd}"
BACKUP_DIR="$SYSTEMD_DIR/.vw-backup"
MCP_UNIT="vaultwarden-secrets-mcp.service"
MCP_PORT="${VW_MCP_PORT:-3001}"
PROBE_RETRIES="${VW_PROBE_RETRIES:-10}"
PROBE_SLEEP="${VW_PROBE_SLEEP:-2}"
RETIRED_UNIT="vw-deploy-webhook.service"
RETIRED_UNIT_PATH="$SYSTEMD_DIR/$RETIRED_UNIT"

log()  { echo "[deploy] $*"; }
err()  { echo "[deploy] ERROR: $*" >&2; }

# --- preflight helpers ------------------------------------------------------

# Extract a directive value from a unit file. Prints all matches (one per line).
# Usage: unit_get <file> <Key>
unit_get() {
  # Match "Key=" at line start, strip the key, trim a leading '-' (optional
  # EnvironmentFile marker) is handled by the caller.
  grep -E "^$2=" "$1" 2>/dev/null | sed -E "s/^$2=//"
}

# Does a system user exist?
user_exists() {
  id "$1" >/dev/null 2>&1
}

# Is a path readable by a given user? Uses sudo -u when available; falls back to
# a plain readability test (test harness runs as the invoking user).
readable_by() {
  _user="$1"; _path="$2"
  [ -e "$_path" ] || return 1
  if command -v sudo >/dev/null 2>&1 && [ "$(id -u)" = "0" ]; then
    sudo -u "$_user" test -r "$_path"
  else
    test -r "$_path"
  fi
}

# Preflight a single unit file. Returns 0 if safe to sync, nonzero otherwise.
# Emits a specific reason on failure. This is the fail-closed gate (DEP-1).
preflight_unit() {
  _unit="$1"
  _name=$(basename "$_unit")
  _ok=0

  # 1. Required service user must exist.
  _user=$(unit_get "$_unit" "User" | head -n1)
  if [ -n "$_user" ] && [ "$_user" != "root" ]; then
    if ! user_exists "$_user"; then
      err "$_name: required User=$_user does not exist"
      _ok=1
    fi
  fi

  # 2. Every ExecStart binary must exist and be executable.
  #    ExecStart line: "<binary> <args...>" (possibly with a leading '-' or '@').
  unit_get "$_unit" "ExecStart" | while IFS= read -r _line; do
    [ -n "$_line" ] || continue
    # Strip leading special prefixes (-, @, +, !, !!).
    _cmd=$(printf '%s' "$_line" | sed -E 's/^[-@+!]+//' )
    _bin=$(printf '%s' "$_cmd" | awk '{print $1}')
    if [ ! -x "$_bin" ]; then
      err "$_name: ExecStart binary not executable: $_bin"
      # Signal failure out of the subshell via a marker file.
      echo "fail" >> "${_PREFLIGHT_FAIL_MARK:-/dev/null}"
    fi
  done

  # 3. Non-optional EnvironmentFile (no leading '-') must be present AND
  #    readable by the unit's User= (same sudo -u / test -r pattern as the
  #    state/session/key checks). Optional files (leading '-') tolerate absence,
  #    but if present must still be readable.
  unit_get "$_unit" "EnvironmentFile" | while IFS= read -r _ef; do
    [ -n "$_ef" ] || continue
    _optional=0
    case "$_ef" in
      -*) _optional=1; _ef=${_ef#-} ;; # strip the optional marker
    esac
    if [ ! -f "$_ef" ]; then
      if [ "$_optional" -eq 0 ]; then
        err "$_name: required EnvironmentFile missing: $_ef"
        echo "fail" >> "${_PREFLIGHT_FAIL_MARK:-/dev/null}"
      fi
      continue # optional + absent is fine; nothing to read-check
    fi
    if [ -n "$_user" ] && [ "$_user" != "root" ] && ! readable_by "$_user" "$_ef"; then
      err "$_name: EnvironmentFile not readable by $_user: $_ef"
      echo "fail" >> "${_PREFLIGHT_FAIL_MARK:-/dev/null}"
    fi
  done

  # 4. State dir + declared session/key files readable by the unit's user.
  if [ -n "$_user" ] && [ "$_user" != "root" ]; then
    if ! readable_by "$_user" "$STATE_DIR_HOST"; then
      err "$_name: state dir $STATE_DIR_HOST not readable by $_user"
      _ok=1
    fi
    for _key in BW_SESSION_FILE MASTER_KEY_FILE; do
      _val=$(unit_get "$_unit" "Environment" | grep -E "^$_key=" | sed -E "s/^$_key=//" | head -n1)
      [ -n "$_val" ] || continue
      if [ ! -e "$_val" ]; then
        err "$_name: $_key path missing: $_val"
        _ok=1
      elif ! readable_by "$_user" "$_val"; then
        err "$_name: $_key not readable by $_user: $_val"
        _ok=1
      fi
    done
  fi

  return $_ok
}

# Wrapper that also honors the subshell fail-marker from loops above.
preflight_unit_checked() {
  _PREFLIGHT_FAIL_MARK=$(mktemp)
  export _PREFLIGHT_FAIL_MARK
  _rc=0
  preflight_unit "$1" || _rc=1
  if [ -s "$_PREFLIGHT_FAIL_MARK" ]; then
    _rc=1
  fi
  rm -f "$_PREFLIGHT_FAIL_MARK"
  unset _PREFLIGHT_FAIL_MARK
  return $_rc
}

# --- main deploy flow -------------------------------------------------------
#
# NOTE: the retirement block below (disable, remove, reload, then the no-change
# exit) must appear in the file before any other unit reload so the retirement
# contract test sees the correct ordering. The health/backup/rollback helpers
# are therefore defined AFTER this function (sh resolves them at call time).

deploy_main() {
  cd "$REPO_DIR"

  # Retire the removed unauthenticated network deploy trigger.
  systemctl disable --now "$RETIRED_UNIT" >/dev/null 2>&1 || true
  if [ -e "$RETIRED_UNIT_PATH" ] || [ -L "$RETIRED_UNIT_PATH" ]; then
    rm -f "$RETIRED_UNIT_PATH"
    log "Removed retired $RETIRED_UNIT"
  fi
  systemctl daemon-reload

  GIT_SSH_COMMAND="ssh -i /root/.ssh/id_ed25519_github -o StrictHostKeyChecking=accept-new" \
    git fetch origin "$BRANCH" 2>/dev/null

  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse "origin/$BRANCH")
  if [ "$LOCAL" = "$REMOTE" ]; then
    exit 0
  fi

  log "New commits detected: $LOCAL -> $REMOTE"
  git reset --hard "origin/$BRANCH"
  log "Pulled $(git log --oneline -1)"

  bun install --frozen-lockfile 2>/dev/null || bun install

  # PREFLIGHT ALL units first (DEP-1). Any failure aborts the whole sync — no
  # unit is swapped, the running services are untouched.
  _pf_failed=0
  for unit in "$UNIT_SRC_DIR"/*.service; do
    _name=$(basename "$unit")
    if preflight_unit_checked "$unit"; then
      log "preflight OK: $_name"
    else
      err "preflight FAILED: $_name — aborting sync"
      _pf_failed=1
    fi
  done
  if [ "$_pf_failed" -ne 0 ]; then
    err "one or more units failed preflight; leaving running units in place"
    exit 1
  fi

  # Start each deploy with a clean backup dir so a stale backup from a prior
  # deploy can never become a wrong restore source (DEP-2).
  rm -rf "$BACKUP_DIR"
  mkdir -p "$BACKUP_DIR"

  # Sync changed units, backing up the previous version first (DEP-2).
  _changed=0
  for unit in "$UNIT_SRC_DIR"/*.service; do
    _name=$(basename "$unit")
    if ! cmp -s "$unit" "$SYSTEMD_DIR/$_name" 2>/dev/null; then
      backup_unit "$_name"
      cp "$unit" "$SYSTEMD_DIR/$_name"
      log "Updated $_name"
      _changed=1
    fi
  done
  systemctl daemon-reload

  # DEP-2: guarantee a restorable snapshot of the MCP unit BEFORE restarting it,
  # whether or not its own content changed this deploy. Otherwise a failed
  # health probe (e.g. MCP unchanged but another unit's change broke the runtime)
  # would call restore_unit with no backup to restore. backup_unit overwrites the
  # per-deploy backup, so if MCP *did* change above it was already backed up as
  # its pre-change version — re-running here is a no-op refresh of that same
  # source. Since the change-sync runs first, re-back-up only when we did NOT
  # already capture it this deploy.
  if [ ! -f "$BACKUP_DIR/$MCP_UNIT" ]; then
    backup_unit "$MCP_UNIT"
  fi

  # Restart the protected MCP unit (only ever stopped via its own restart), then
  # verify health; roll back on failure. Literal name kept for the retirement
  # contract test.
  systemctl restart vaultwarden-secrets-mcp.service
  if verify_mcp_health; then
    log "Protected MCP service restarted and healthy"
  else
    err "MCP unhealthy after restart — rolling back $MCP_UNIT"
    if restore_unit "$MCP_UNIT"; then
      systemctl restart "$MCP_UNIT"
      if verify_mcp_health; then
        err "rolled back to previous $MCP_UNIT (healthy); deploy FAILED"
      else
        err "rollback restart still unhealthy — manual intervention required"
      fi
    fi
    exit 1
  fi
}

# --- health verification ----------------------------------------------------

# Bounded health check for the MCP unit (DEP-2): is-active + probe on MCP_PORT.
verify_mcp_health() {
  if ! systemctl is-active --quiet "$MCP_UNIT"; then
    err "$MCP_UNIT is not active after restart"
    return 1
  fi
  _i=0
  while [ "$_i" -lt "$PROBE_RETRIES" ]; do
    if VW_MCP_BASE_URL="http://127.0.0.1:$MCP_PORT/mcp" \
       bun run "$REPO_DIR/scripts/mcp-probe.ts" --allow-auth-enforced >/dev/null 2>&1; then
      return 0
    fi
    _i=$((_i + 1))
    sleep "$PROBE_SLEEP"
  done
  err "$MCP_UNIT failed health probe on :$MCP_PORT after $PROBE_RETRIES tries"
  return 1
}

# --- unit backup + rollback --------------------------------------------------

backup_unit() {
  _name="$1"
  mkdir -p "$BACKUP_DIR"
  if [ -f "$SYSTEMD_DIR/$_name" ]; then
    cp "$SYSTEMD_DIR/$_name" "$BACKUP_DIR/$_name"
    log "backed up $_name -> $BACKUP_DIR/$_name"
  fi
}

restore_unit() {
  _name="$1"
  if [ -f "$BACKUP_DIR/$_name" ]; then
    cp "$BACKUP_DIR/$_name" "$SYSTEMD_DIR/$_name"
    systemctl daemon-reload
    log "restored $_name from backup"
    return 0
  fi
  err "no backup to restore for $_name"
  return 1
}

# When sourced by a test harness, stop here (functions only).
if [ "${VW_LIB_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

# Test hook: preflight every unit and exit without touching git/systemd.
if [ "${VW_PREFLIGHT_ONLY:-0}" = "1" ]; then
  _rc=0
  for unit in "$UNIT_SRC_DIR"/*.service; do
    _name=$(basename "$unit")
    if preflight_unit_checked "$unit"; then
      log "preflight OK: $_name"
    else
      err "preflight FAILED: $_name"
      _rc=1
    fi
  done
  exit $_rc
fi

deploy_main
