#!/usr/bin/env sh
# Dry-run test for deploy.sh preflight fail-closed logic (DEP-1).
#
# Sources deploy.sh as a library (VW_LIB_ONLY=1) and exercises preflight against
# synthetic units in a temp fake-root, proving both the PASS and each FAIL-CLOSED
# branch. No systemd, no root, no network. Exit 0 = all assertions held.
#
# Run: sh deploy/preflight.test.sh

set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
FAKE_ROOT=$(mktemp -d)
trap 'rm -rf "$FAKE_ROOT"' EXIT

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

# --- fake host layout -------------------------------------------------------
STATE_DIR="$FAKE_ROOT/state"
BIN_DIR="$FAKE_ROOT/bin"
UNIT_DIR="$FAKE_ROOT/units"
mkdir -p "$STATE_DIR" "$BIN_DIR" "$UNIT_DIR"

# A fake bun that exists and is executable.
FAKE_BUN="$BIN_DIR/bun"
printf '#!/bin/sh\nexit 0\n' > "$FAKE_BUN"
chmod +x "$FAKE_BUN"

# Fake session + master key + env file, all readable.
SESSION_FILE="$STATE_DIR/.bw-session"
KEY_FILE="$STATE_DIR/.master-key"
ENV_FILE="$FAKE_ROOT/app.env"
: > "$SESSION_FILE"
: > "$KEY_FILE"
: > "$ENV_FILE"

# The current (test) user — a user that definitely exists, standing in for
# the vwsecrets service account so readable_by works without root.
TEST_USER=$(id -un)

# Source the deploy functions only.
VW_LIB_ONLY=1 \
  VW_STATE_DIR_HOST="$STATE_DIR" \
  REPO_DIR="$FAKE_ROOT" \
  . "$SCRIPT_DIR/deploy.sh"

# Stub systemctl for the rollback tests: this host has no systemd. The rollback
# functions under test (restore_unit/remove_unit) do real filesystem work; only
# their systemctl calls need to be inert here. On the live host systemctl is
# real and its failures are NOT suppressed by the production code.
systemctl() { return 0; }

# Helper to write a unit file.
write_unit() {
  # write_unit <path> <user> <execstart-bin> <session> <key> <envfile-line>
  cat > "$1" <<EOF
[Service]
User=$2
Environment=BW_SESSION_FILE=$4
Environment=MASTER_KEY_FILE=$5
$6
ExecStart=$3 run server/mcp.ts
EOF
}

# --- Case 1: fully valid unit → preflight PASSES ----------------------------
GOOD="$UNIT_DIR/good.service"
write_unit "$GOOD" "$TEST_USER" "$FAKE_BUN" "$SESSION_FILE" "$KEY_FILE" \
  "EnvironmentFile=-$ENV_FILE"
rc=0; preflight_unit_checked "$GOOD" || rc=$?
check "valid unit passes preflight" 0 "$rc"

# --- Case 2: missing service user → FAIL ------------------------------------
BADUSER="$UNIT_DIR/baduser.service"
write_unit "$BADUSER" "definitely-no-such-user-xyz" "$FAKE_BUN" \
  "$SESSION_FILE" "$KEY_FILE" "EnvironmentFile=-$ENV_FILE"
rc=0; preflight_unit_checked "$BADUSER" || rc=$?
check "missing service user fails preflight" 1 "$rc"

# --- Case 3: non-executable ExecStart binary → FAIL -------------------------
BADBIN="$UNIT_DIR/badbin.service"
write_unit "$BADBIN" "$TEST_USER" "$FAKE_ROOT/nope/bun" \
  "$SESSION_FILE" "$KEY_FILE" "EnvironmentFile=-$ENV_FILE"
rc=0; preflight_unit_checked "$BADBIN" || rc=$?
check "missing ExecStart binary fails preflight" 1 "$rc"

# --- Case 4: required (non-optional) EnvironmentFile missing → FAIL ---------
BADENV="$UNIT_DIR/badenv.service"
write_unit "$BADENV" "$TEST_USER" "$FAKE_BUN" "$SESSION_FILE" "$KEY_FILE" \
  "EnvironmentFile=$FAKE_ROOT/missing.env"
rc=0; preflight_unit_checked "$BADENV" || rc=$?
check "missing required EnvironmentFile fails preflight" 1 "$rc"

# --- Case 5: session file missing → FAIL ------------------------------------
BADSESSION="$UNIT_DIR/badsession.service"
write_unit "$BADSESSION" "$TEST_USER" "$FAKE_BUN" \
  "$STATE_DIR/.does-not-exist" "$KEY_FILE" "EnvironmentFile=-$ENV_FILE"
rc=0; preflight_unit_checked "$BADSESSION" || rc=$?
check "missing BW_SESSION_FILE fails preflight" 1 "$rc"

# --- Case 6: optional EnvironmentFile (leading '-') absent → still PASSES ----
OPTENV="$UNIT_DIR/optenv.service"
write_unit "$OPTENV" "$TEST_USER" "$FAKE_BUN" "$SESSION_FILE" "$KEY_FILE" \
  "EnvironmentFile=-$FAKE_ROOT/absent-but-optional.env"
rc=0; preflight_unit_checked "$OPTENV" || rc=$?
check "absent OPTIONAL EnvironmentFile still passes" 0 "$rc"

# --- Case 7: present-but-UNREADABLE EnvironmentFile → FAIL (DEP-1 residual) --
# The required EnvironmentFile exists but is not readable by User=. Preflight
# must fail closed rather than accept it on existence alone.
UNREADABLE_ENV="$FAKE_ROOT/unreadable.env"
: > "$UNREADABLE_ENV"
chmod 000 "$UNREADABLE_ENV"
if [ -r "$UNREADABLE_ENV" ]; then
  # Running as root (or a filesystem that ignores the read bit) — chmod 000 is
  # still readable, so this branch cannot be exercised meaningfully. Skip.
  echo "  skip: unreadable-EnvironmentFile branch (reader bypasses mode bits)"
else
  BADREAD="$UNIT_DIR/badread.service"
  write_unit "$BADREAD" "$TEST_USER" "$FAKE_BUN" "$SESSION_FILE" "$KEY_FILE" \
    "EnvironmentFile=$UNREADABLE_ENV"
  rc=0; preflight_unit_checked "$BADREAD" || rc=$?
  check "present-but-unreadable EnvironmentFile fails preflight" 1 "$rc"
fi
chmod 644 "$UNREADABLE_ENV" 2>/dev/null || true

# --- Case 8: MCP unit UNCHANGED, restart fails → live unit restored + nonzero -
# (DEP-2 residual) Guarantees a restorable snapshot exists before restart even
# when MCP content did not change this deploy, so a failed health probe can
# always restore the live unit and exit nonzero.
D2_ROOT=$(mktemp -d)
D2_SYSTEMD="$D2_ROOT/systemd"
D2_BACKUP="$D2_SYSTEMD/.vw-backup"
mkdir -p "$D2_SYSTEMD"

# The live (known-good) MCP unit, byte-identical to the repo source (unchanged).
LIVE_MARKER="# live-known-good-$(date +%s)"
printf '%s\n[Service]\nExecStart=/usr/local/bin/bun run server/mcp.ts\n' \
  "$LIVE_MARKER" > "$D2_SYSTEMD/$MCP_UNIT"

# Simulate the DEP-2 pre-restart guarantee: no backup captured yet this deploy
# (MCP unchanged), so the script backs up the current live unit unconditionally.
(
  # Re-scope the backup/systemd dirs to the D2 fake root for the real functions.
  SYSTEMD_DIR="$D2_SYSTEMD"
  BACKUP_DIR="$D2_BACKUP"
  rm -rf "$BACKUP_DIR"; mkdir -p "$BACKUP_DIR"

  # Guard identical to deploy_main: back up MCP if not already captured.
  if [ ! -f "$BACKUP_DIR/$MCP_UNIT" ]; then
    backup_unit "$MCP_UNIT" >/dev/null
  fi

  # Now simulate a broken restart: overwrite the live unit (as if a bad
  # daemon-reload/other-unit change left MCP unhealthy) and fail the probe.
  printf '# BROKEN\n' > "$SYSTEMD_DIR/$MCP_UNIT"

  # Health probe fails → restore must have a source and re-verify.
  if restore_unit "$MCP_UNIT" >/dev/null; then
    # Verify the restored file is the known-good live content, not the broken one.
    if grep -q "$LIVE_MARKER" "$SYSTEMD_DIR/$MCP_UNIT"; then
      exit 0
    fi
    exit 3
  fi
  # No backup to restore — the exact failure DEP-2 residual is fixing.
  exit 2
)
rc=$?
check "DEP-2: unchanged-MCP restart failure restores live unit" 0 "$rc"
rm -rf "$D2_ROOT"

# --- Case 9: FIRST install of MCP unit, restart fails → unit removed ----------
# (DEP-2 edge) When no prior MCP unit exists, there is nothing to restore; a
# failed first start must roll back to "not present" by removing the just-
# installed unit rather than leaving a broken unit on the host.
D3_ROOT=$(mktemp -d)
D3_SYSTEMD="$D3_ROOT/systemd"
D3_BACKUP="$D3_SYSTEMD/.vw-backup"
mkdir -p "$D3_SYSTEMD"
(
  SYSTEMD_DIR="$D3_SYSTEMD"
  BACKUP_DIR="$D3_BACKUP"
  rm -rf "$BACKUP_DIR"; mkdir -p "$BACKUP_DIR"

  # No live unit exists yet (first install). Pre-restart backup captures nothing.
  if [ ! -f "$BACKUP_DIR/$MCP_UNIT" ]; then
    backup_unit "$MCP_UNIT" >/dev/null
  fi
  [ -f "$BACKUP_DIR/$MCP_UNIT" ] && _mcp_preexisted=1 || _mcp_preexisted=0

  # The deploy installs the new unit, then the first start fails.
  printf '# BROKEN-NEW\n' > "$SYSTEMD_DIR/$MCP_UNIT"

  # Rollback branch for a never-existed unit: remove it.
  if [ "$_mcp_preexisted" -eq 0 ]; then
    remove_unit "$MCP_UNIT" >/dev/null 2>&1
    [ ! -f "$SYSTEMD_DIR/$MCP_UNIT" ] && exit 0
    exit 3
  fi
  # Should not reach: a first install must be treated as not pre-existing.
  exit 2
)
rc=$?
check "DEP-2: first-install restart failure removes the new unit" 0 "$rc"
rm -rf "$D3_ROOT"

echo ""
echo "preflight.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
