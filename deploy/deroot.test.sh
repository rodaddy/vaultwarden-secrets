#!/usr/bin/env sh
# Structural test for the deroot deploy path (fix/deroot-deploy).
#
# Proves, offline and without systemd/sudo, that deploy.sh no longer assumes it
# runs as root:
#   - no bare `/root/` path remains in deploy.sh
#   - every privileged systemctl / daemon-reload / install-into-/etc goes through
#     run_privileged (no bare, un-wrapped privileged call)
#   - run_privileged falls back to `sudo -n` when the caller is not root
#   - the scoped sudoers file exists and honors the exact-write / wildcard-read
#     matching rule
#
# Run: sh deploy/deroot.test.sh   (exit 0 = all assertions held)

set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
DEPLOY_SH="$SCRIPT_DIR/deploy.sh"
SUDOERS="$SCRIPT_DIR/sudoers.d/vaultwarden-secrets"

PASS=0
FAIL=0
check() {
  # check <description> <expected-rc> <actual-rc>
  if [ "$2" = "$3" ]; then
    echo "  ok: $1"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $1 (expected rc=$2, got rc=$3)"
    FAIL=$((FAIL + 1))
  fi
}

# --- 1. No bare /root/ path in deploy.sh ------------------------------------
# The old code hardcoded /root/.ssh/id_ed25519_github. Any literal /root/ path
# reintroduces a root assumption. (Word "root" in prose/`id -u == 0` is fine;
# we grep for the PATH form `/root/`.)
rc=0; grep -q '/root/' "$DEPLOY_SH" && rc=1 || rc=0
check "deploy.sh contains no bare /root/ path" 0 "$rc"

# --- 2. Every privileged systemctl goes through run_privileged --------------
# Find systemctl invocations that are NOT the function definition and NOT
# prefixed by run_privileged. In the harness/live code every real call must be
# `run_privileged systemctl ...`. Allow the literal string inside comments.
UNWRAPPED=$(grep -nE '(^|[^_])systemctl ' "$DEPLOY_SH" \
  | grep -vE 'run_privileged systemctl' \
  | grep -vE '^\s*#' \
  | grep -vE '#.*systemctl' || true)
if [ -n "$UNWRAPPED" ]; then
  echo "  offending lines:"; echo "$UNWRAPPED" | sed 's/^/    /'
  rc=1
else
  rc=0
fi
check "no un-wrapped (bare) systemctl call in deploy.sh" 0 "$rc"

# --- 3. daemon-reload is always wrapped -------------------------------------
UNWRAPPED_RELOAD=$(grep -nE 'daemon-reload' "$DEPLOY_SH" \
  | grep -vE 'run_privileged systemctl daemon-reload' \
  | grep -vE '^\s*#' \
  | grep -vE '#.*daemon-reload' || true)
if [ -n "$UNWRAPPED_RELOAD" ]; then
  echo "  offending lines:"; echo "$UNWRAPPED_RELOAD" | sed 's/^/    /'
  rc=1
else
  rc=0
fi
check "every daemon-reload is wrapped in run_privileged" 0 "$rc"

# --- 4. run_privileged is defined and falls back to `sudo -n` ---------------
rc=0; grep -q 'run_privileged()' "$DEPLOY_SH" || rc=1
check "run_privileged() is defined" 0 "$rc"

rc=0; grep -qE 'sudo -n "\$@"' "$DEPLOY_SH" || rc=1
check "run_privileged falls back to 'sudo -n' when not root" 0 "$rc"

# Behavioral: source the lib and drive run_privileged with a fake non-root id +
# a fake sudo, asserting it prefixes `sudo -n`.
FAKE_ROOT=$(mktemp -d)
trap 'rm -rf "$FAKE_ROOT"' EXIT
VW_LIB_ONLY=1 . "$DEPLOY_SH"

# Force the "not root" branch and capture what run_privileged hands to sudo.
id() { if [ "$1" = "-u" ]; then echo 3000; else echo rico; fi; }
SUDO_LOG="$FAKE_ROOT/sudo.args"
sudo() { echo "$*" > "$SUDO_LOG"; return 0; }

run_privileged systemctl restart vaultwarden-secrets-mcp.service >/dev/null 2>&1 || true
GOT=$(cat "$SUDO_LOG" 2>/dev/null || echo "")
if [ "$GOT" = "-n systemctl restart vaultwarden-secrets-mcp.service" ]; then
  rc=0
else
  echo "    got: [$GOT]"
  rc=1
fi
check "run_privileged (non-root) invokes 'sudo -n <cmd>'" 0 "$rc"
unset -f id sudo

# --- 5. Configurable SSH key, not a hardcoded /root key ---------------------
rc=0; grep -q 'VW_DEPLOY_SSH_KEY' "$DEPLOY_SH" || rc=1
check "deploy.sh uses configurable VW_DEPLOY_SSH_KEY" 0 "$rc"

rc=0; grep -q 'GIT_SSH_COMMAND="ssh -i \$VW_DEPLOY_SSH_KEY' "$DEPLOY_SH" || rc=1
check "git fetch uses VW_DEPLOY_SSH_KEY (not a hardcoded key)" 0 "$rc"

# --- 6. Configurable service user, canonical name ---------------------------
rc=0; grep -q 'VW_SERVICE_USER' "$DEPLOY_SH" || rc=1
check "deploy.sh exposes VW_SERVICE_USER" 0 "$rc"

rc=0; grep -q 'VW_SERVICE_USER:-vaultwarden-secrets' "$DEPLOY_SH" || rc=1
check "VW_SERVICE_USER defaults to vaultwarden-secrets" 0 "$rc"

# --- 7. Scoped sudoers file exists and validates ----------------------------
rc=0; [ -f "$SUDOERS" ] || rc=1
check "deploy/sudoers.d/vaultwarden-secrets exists" 0 "$rc"

if command -v visudo >/dev/null 2>&1; then
  rc=0; visudo -cf "$SUDOERS" >/dev/null 2>&1 || rc=1
  check "sudoers file parses (visudo -c)" 0 "$rc"
else
  echo "  skip: visudo not available for sudoers syntax check"
fi

# Exact-write rule: no trailing wildcard on a write verb line.
rc=0
if grep -E 'systemctl (start|stop|restart) [a-z0-9.-]+ \*' "$SUDOERS" >/dev/null 2>&1; then
  rc=1
fi
check "sudoers write verbs are exact-match (no trailing wildcard)" 0 "$rc"

# Wildcard-read rule: read commands carry a trailing ` *` for flags.
rc=0; grep -qE 'systemctl status .* \*' "$SUDOERS" || rc=1
check "sudoers read (status) carries trailing wildcard for flags" 0 "$rc"

rc=0; grep -qE 'journalctl -u [a-z*.-]+ \*' "$SUDOERS" || rc=1
check "sudoers journalctl read carries trailing wildcard for flags" 0 "$rc"

echo ""
echo "deroot.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
