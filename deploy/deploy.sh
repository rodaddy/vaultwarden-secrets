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
# LEAST PRIVILEGE (deroot): this script runs as the OPERATOR user `rico`, NOT
# root. It never opens a root shell and never uses blanket sudo. Every
# privileged action (systemctl, daemon-reload, chown/install into the state
# dir, per-user readability probes) goes through run_privileged(), which runs
# the command directly when the caller happens to be root but otherwise prefixes
# `sudo -n` (non-interactive). The exact commands it may run are the ONLY grants
# in deploy/sudoers.d/vaultwarden-secrets. A missing grant fails loudly rather
# than prompting or silently degrading.
#   VW_SERVICE_USER     service identity referenced by preflight (default
#                       vaultwarden-secrets; the account itself is provisioned
#                       UPSTREAM in the TN01/rtech-infra scheme, not by this repo)
#   VW_DEPLOY_SSH_KEY   operator's read-only GitHub deploy key
#                       (default ${HOME}/.ssh/id_ed25519_github — the OPERATOR's
#                       key, never /root's)
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
# Service identity referenced by preflight. Provisioned UPSTREAM; this repo only
# references it and fails closed (preflight) if it is absent.
VW_SERVICE_USER="${VW_SERVICE_USER:-vaultwarden-secrets}"
# Operator's read-only GitHub deploy key — NOT root's. Configurable so the same
# script works for any operator identity; defaults under the operator's HOME.
VW_DEPLOY_SSH_KEY="${VW_DEPLOY_SSH_KEY:-${HOME:-/home/rico}/.ssh/id_ed25519_github}"
# Path to the scoped sudoers grant, surfaced in errors when a NOPASSWD grant is
# missing so the operator knows exactly which file to install/fix.
SUDOERS_FILE="/etc/sudoers.d/vaultwarden-secrets"

log()  { echo "[deploy] $*"; }
err()  { echo "[deploy] ERROR: $*" >&2; }

# Run a privileged command with least privilege:
#   - if the caller is already root (id -u == 0), run it directly;
#   - otherwise prefix `sudo -n` (non-interactive). If the matching NOPASSWD
#     grant is missing, sudo -n fails immediately (no prompt) and we surface a
#     loud, actionable error pointing at the scoped sudoers file. We NEVER fall
#     back to a root shell or a blanket/interactive sudo.
run_privileged() {
  # FAIL CLOSED: return the wrapped command's ACTUAL exit code, unmasked. No
  # enclosing `if ... then return 0` that could swallow a denial (P0-1). Under
  # `set -e` a bare `run_privileged ...` call aborts the deploy on nonzero;
  # call sites that intentionally tolerate failure use an explicit `|| true`.
  if [ "$(id -u)" = "0" ]; then
    "$@"
    return $?
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    err "not root and 'sudo' is unavailable; cannot run privileged: $*"
    err "install the scoped grant at $SUDOERS_FILE and ensure sudo is present"
    return 1
  fi
  # Direct passthrough of sudo's exit status — a denied NOPASSWD grant makes
  # `sudo -n` exit nonzero and that nonzero propagates unchanged.
  sudo -n "$@"
  _rc=$?
  if [ "$_rc" -ne 0 ]; then
    err "privileged command DENIED/failed (rc=$_rc): sudo -n $*"
    err "if this is a NOPASSWD-grant gap, fix $SUDOERS_FILE (validate: visudo -cf $SUDOERS_FILE)"
  fi
  return "$_rc"
}

# Fatal privileged action: run_privileged, but ABORT the whole deploy on any
# nonzero. Used for every privileged step whose failure must NOT be tolerated,
# so we never rely on `set -e` implicitly catching a function's return status
# (unreliable across POSIX shells). Call sites that intentionally tolerate
# failure use `run_privileged ... || true` instead.
must_privileged() {
  if ! run_privileged "$@"; then
    err "aborting deploy: required privileged step failed: $*"
    exit 1
  fi
}

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

# Is a path readable by a given user?
#   - When the checked user IS the caller (or the caller is that user's shell in
#     the test harness), a plain `test -r` is authoritative.
#   - Otherwise we must check AS that user. As root that's a direct `sudo -u`;
#     as the operator `rico` it's `sudo -n -u <user> test -r` via run_privileged
#     semantics (the scoped grant must allow it). If we genuinely cannot check
#     (no sudo, not root, not the same user), we FAIL CLOSED — a preflight that
#     cannot prove readability must not silently pass.
readable_by() {
  _user="$1"; _path="$2"
  [ -e "$_path" ] || return 1
  # If we ARE the target user, a direct read test is authoritative.
  if [ "$_user" = "$(id -un)" ]; then
    test -r "$_path"
    return $?
  fi
  # Root can check any user directly.
  if [ "$(id -u)" = "0" ] && command -v sudo >/dev/null 2>&1; then
    sudo -u "$_user" test -r "$_path"
    return $?
  fi
  # Non-root operator: check as the service user via scoped, non-interactive
  # sudo. run_privileged surfaces a loud error if the grant is missing.
  if command -v sudo >/dev/null 2>&1; then
    run_privileged -u "$_user" test -r "$_path"
    return $?
  fi
  err "cannot verify $_path is readable by $_user (no sudo, not root, not $_user) — failing closed"
  return 1
}

# Preflight a single unit file. Returns 0 if safe to sync, nonzero otherwise.
# Emits a specific reason on failure. This is the fail-closed gate (DEP-1).
preflight_unit() {
  _unit="$1"
  _name=$(basename "$_unit")
  _ok=0

  # 1. Required service user must exist. The unit's User= is authoritative; it
  #    should be VW_SERVICE_USER (default vaultwarden-secrets), which is
  #    provisioned UPSTREAM (TN01/rtech-infra), never by this repo. Fail closed
  #    if it is absent — this repo only REFERENCES the account.
  _user=$(unit_get "$_unit" "User" | head -n1)
  if [ -n "$_user" ] && [ "$_user" != "root" ]; then
    if ! user_exists "$_user"; then
      err "$_name: required User=$_user does not exist (service user is provisioned upstream; VW_SERVICE_USER=$VW_SERVICE_USER)"
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
  run_privileged systemctl disable --now "$RETIRED_UNIT" >/dev/null 2>&1 || true
  if [ -e "$RETIRED_UNIT_PATH" ] || [ -L "$RETIRED_UNIT_PATH" ]; then
    must_privileged rm -f "$RETIRED_UNIT_PATH"
    log "Removed retired $RETIRED_UNIT"
  fi
  must_privileged systemctl daemon-reload

  # Fetch as the OPERATOR using the operator's read-only deploy key (never
  # /root's key). VW_DEPLOY_SSH_KEY is configurable; default is under $HOME.
  GIT_SSH_COMMAND="ssh -i $VW_DEPLOY_SSH_KEY -o StrictHostKeyChecking=accept-new" \
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
  # deploy can never become a wrong restore source (DEP-2). SYSTEMD_DIR is
  # root-owned, so these mutations are privileged.
  must_privileged rm -rf "$BACKUP_DIR"
  must_privileged mkdir -p "$BACKUP_DIR"

  # Sync changed units, backing up the previous version first (DEP-2).
  _changed=0
  for unit in "$UNIT_SRC_DIR"/*.service; do
    _name=$(basename "$unit")
    if ! cmp -s "$unit" "$SYSTEMD_DIR/$_name" 2>/dev/null; then
      backup_unit "$_name"
      must_privileged install -m 0644 "$unit" "$SYSTEMD_DIR/$_name"
      log "Updated $_name"
      _changed=1
    fi
  done
  must_privileged systemctl daemon-reload

  # DEP-2: guarantee a restorable snapshot of the MCP unit BEFORE restarting it,
  # whether or not its own content changed this deploy. Otherwise a failed
  # health probe (e.g. MCP unchanged but another unit's change broke the runtime)
  # would call restore_unit with no backup to restore. backup_unit overwrites the
  # per-deploy backup, so if MCP *did* change above it was already backed up as
  # its pre-change version — re-running here is a no-op refresh of that same
  # source. Since the change-sync runs first, re-back-up only when we did NOT
  # already capture it this deploy.
  # Record whether the MCP unit already existed on the host BEFORE this deploy
  # installed/updated it. On a failed restart, an updated unit rolls back to its
  # backed-up previous version; a brand-new unit (no prior version to restore)
  # rolls back by being removed and stopped, returning to the known "not
  # present" state instead of leaving a broken unit installed.
  if [ -f "$BACKUP_DIR/$MCP_UNIT" ]; then
    _mcp_preexisted=1
  else
    backup_unit "$MCP_UNIT"
    [ -f "$BACKUP_DIR/$MCP_UNIT" ] && _mcp_preexisted=1 || _mcp_preexisted=0
  fi

  # Restart the protected MCP unit (only ever stopped via its own restart), then
  # verify health; roll back on failure. Literal name kept for the retirement
  # contract test.
  must_privileged systemctl restart vaultwarden-secrets-mcp.service
  if verify_mcp_health; then
    log "Protected MCP service restarted and healthy"
  else
    err "MCP unhealthy after restart — rolling back $MCP_UNIT"
    if [ "$_mcp_preexisted" -eq 1 ] && restore_unit "$MCP_UNIT"; then
      run_privileged systemctl restart "$MCP_UNIT"
      if verify_mcp_health; then
        err "rolled back to previous $MCP_UNIT (healthy); deploy FAILED"
      else
        err "rollback restart still unhealthy — manual intervention required"
      fi
    else
      # First-ever install failed: no prior version to restore. Remove the
      # just-installed unit and stop it so the host returns to a clean state.
      remove_unit "$MCP_UNIT"
      err "new $MCP_UNIT failed first start — removed it; deploy FAILED"
    fi
    exit 1
  fi
}

# --- health verification ----------------------------------------------------

# Bounded health check for the MCP unit (DEP-2): is-active + probe on MCP_PORT.
verify_mcp_health() {
  # `is-active` is a READ; the scoped sudoers allows it with flags (--quiet).
  if ! run_privileged systemctl is-active --quiet "$MCP_UNIT"; then
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
  # BACKUP_DIR lives under the root-owned SYSTEMD_DIR — privileged writes. A
  # failed backup must abort: DEP-2 rollback depends on a restorable snapshot.
  must_privileged mkdir -p "$BACKUP_DIR"
  if [ -f "$SYSTEMD_DIR/$_name" ]; then
    must_privileged install -m 0644 "$SYSTEMD_DIR/$_name" "$BACKUP_DIR/$_name"
    log "backed up $_name -> $BACKUP_DIR/$_name"
  fi
}

restore_unit() {
  _name="$1"
  if [ -f "$BACKUP_DIR/$_name" ]; then
    # Rollback restore is critical — a denied grant here must abort loudly, not
    # leave a broken unit silently in place.
    must_privileged install -m 0644 "$BACKUP_DIR/$_name" "$SYSTEMD_DIR/$_name"
    must_privileged systemctl daemon-reload
    log "restored $_name from backup"
    return 0
  fi
  err "no backup to restore for $_name"
  return 1
}

# Roll a first-ever install back to "not present": stop and remove the unit that
# was just installed but never had a prior version to restore.
remove_unit() {
  _name="$1"
  run_privileged systemctl stop "$_name" 2>/dev/null || true
  must_privileged rm -f "$SYSTEMD_DIR/$_name"
  must_privileged systemctl daemon-reload
  log "removed newly-installed $_name (no prior version to roll back to)"
}

# When sourced by a test harness, stop here (functions only).
if [ "${VW_LIB_ONLY:-0}" = "1" ]; then
  # `return` works when sourced; the `|| exit 0` is the executed-directly path.
  # shellcheck disable=SC2317  # reachable via the sourced-vs-executed idiom
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
