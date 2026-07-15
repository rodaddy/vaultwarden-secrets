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

echo ""
echo "preflight.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
