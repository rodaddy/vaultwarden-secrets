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
  | grep -vE '(run|must)_privileged systemctl' \
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
  | grep -vE '(run|must)_privileged systemctl daemon-reload' \
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

rc=0; grep -q 'must_privileged()' "$DEPLOY_SH" || rc=1
check "must_privileged() (fatal wrapper) is defined" 0 "$rc"

rc=0; grep -qE 'sudo -n "\$@"' "$DEPLOY_SH" || rc=1
check "run_privileged falls back to 'sudo -n' when not root" 0 "$rc"

# Behavioral: source the lib and drive run_privileged with a fake non-root id +
# a fake sudo, asserting it prefixes `sudo -n`.
FAKE_ROOT=$(mktemp -d)
trap 'rm -rf "$FAKE_ROOT"' EXIT
# shellcheck source=deploy/deploy.sh
VW_LIB_ONLY=1 . "$DEPLOY_SH"

# Force the "not root" branch and capture what run_privileged hands to sudo.
# shellcheck disable=SC2329  # invoked indirectly by run_privileged
id() { if [ "$1" = "-u" ]; then echo 3000; else echo rico; fi; }
SUDO_LOG="$FAKE_ROOT/sudo.args"
# shellcheck disable=SC2329  # invoked indirectly by run_privileged
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

# --- 4b. FAIL CLOSED: a denied sudo must propagate nonzero (P0-1) ------------
# Stub a non-root id + a sudo that DENIES (exit 1). run_privileged must return
# that nonzero verbatim — never mask it to 0 — so callers abort the deploy.
# shellcheck disable=SC2329  # invoked indirectly by run_privileged
id() { if [ "$1" = "-u" ]; then echo 3000; else echo rico; fi; }
# shellcheck disable=SC2329  # invoked indirectly by run_privileged
sudo() { return 1; }
rc=0; run_privileged systemctl daemon-reload >/dev/null 2>&1 || rc=$?
check "run_privileged returns NONZERO when sudo is denied (fail closed)" 1 "$rc"

# must_privileged() must EXPLICITLY abort (exit nonzero) on a denied grant and
# never proceed — deploy.sh does not rely on `set -e` implicitly catching a
# function's return (unreliable across POSIX shells). Run it in a subshell so
# the exit is contained; assert nonzero exit AND that nothing ran afterward.
rc=0
( must_privileged systemctl daemon-reload; echo "REACHED-AFTER" ) \
  >"$FAKE_ROOT/abort.out" 2>&1 || rc=$?
REACHED=$(cat "$FAKE_ROOT/abort.out" 2>/dev/null || echo "")
if [ "$rc" -ne 0 ] && [ "${REACHED#*REACHED-AFTER}" = "$REACHED" ]; then
  rc=0   # aborted before the following statement, as required
else
  echo "    subshell rc=$rc out=[$REACHED]"
  rc=1
fi
check "must_privileged ABORTS the deploy on denial (never proceeds)" 0 "$rc"
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

# --- 7b. Hardened globs (security review) -----------------------------------
# All checks below inspect RULE lines only (comments stripped): the header
# comments legitimately describe the forbidden patterns in prose.
RULES=$(grep -vE '^\s*#' "$SUDOERS")

# P0-2: NO wildcard install into /etc/systemd/system — destination must be an
# exact filename, never a `*`. Any `install ... /etc/systemd/system/*` is a fail.
rc=0
if printf '%s\n' "$RULES" | grep -E 'install .*/etc/systemd/system/[^ ]*\*' >/dev/null 2>&1; then
  echo "    offending:"; printf '%s\n' "$RULES" | grep -nE 'install .*/etc/systemd/system/[^ ]*\*' | sed 's/^/      /'
  rc=1
fi
check "no wildcard install destination into /etc/systemd/system (P0-2)" 0 "$rc"

# P0-2: install sources are pinned under /opt/vaultwarden-secrets or the backup
# dir — never an unpinned `*` source.
rc=0
if printf '%s\n' "$RULES" | grep -E 'install -m 0644 \* ' >/dev/null 2>&1; then rc=1; fi
check "no wildcard install source (source is pinned) (P0-2)" 0 "$rc"

# P1-4: NO `rm -f *.service` wildcard — deletions are enumerated.
rc=0
if printf '%s\n' "$RULES" | grep -E 'rm -f /etc/systemd/system/\*' >/dev/null 2>&1; then rc=1; fi
check "no wildcard unit deletion (rm enumerated) (P1-4)" 0 "$rc"

# P1-3: NO `chown -R` and no `.../*` glob in state-dir ownership. Check only
# non-comment lines (the rationale comment legitimately mentions "chown").
rc=0
if grep -vE '^\s*#' "$SUDOERS" | grep -E 'chown' >/dev/null 2>&1; then rc=1; fi
check "no chown grant in a rule — state dir uses install -d (P1-3)" 0 "$rc"

rc=0
if grep -vE '^\s*#' "$SUDOERS" | grep -E '/var/lib/vaultwarden-secrets/\*' >/dev/null 2>&1; then rc=1; fi
check "no /var/lib/vaultwarden-secrets/* glob in a rule (P1-3)" 0 "$rc"

# P1-5: reads are exact invocations — no unit-prefix + trailing ` *` smuggling.
rc=0
if printf '%s\n' "$RULES" | grep -E 'systemctl (status|is-active) [^ ]*\* ' >/dev/null 2>&1; then rc=1; fi
check "no wildcard-prefixed systemctl read target (P1-5)" 0 "$rc"

rc=0
if printf '%s\n' "$RULES" | grep -E 'journalctl -u [^ ]*\* ' >/dev/null 2>&1; then rc=1; fi
check "no wildcard-prefixed journalctl target (P1-5)" 0 "$rc"

# The exact is-active health probe deploy.sh runs must still be granted.
rc=0; grep -qF '/usr/bin/systemctl is-active --quiet vaultwarden-secrets-mcp.service' "$SUDOERS" || rc=1
check "exact is-active health-probe invocation is granted" 0 "$rc"

echo ""
echo "deroot.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
