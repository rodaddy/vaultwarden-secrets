#!/usr/bin/env sh
# Deploy script — fetches latest, restarts only if changes detected.
# Run manually or via systemd timer (vw-deploy.timer).

set -eu

REPO_DIR="/opt/vaultwarden-secrets"
BRANCH="${DEPLOY_BRANCH:-develop}"
RETIRED_UNIT="vw-deploy-webhook.service"
RETIRED_UNIT_PATH="/etc/systemd/system/$RETIRED_UNIT"

cd "$REPO_DIR"

# Retire the removed unauthenticated network deploy trigger even when the
# repository is already current.
systemctl disable --now "$RETIRED_UNIT" >/dev/null 2>&1 || true
if [ -e "$RETIRED_UNIT_PATH" ] || [ -L "$RETIRED_UNIT_PATH" ]; then
  rm -f "$RETIRED_UNIT_PATH"
  echo "[deploy] Removed retired $RETIRED_UNIT"
fi
systemctl daemon-reload

# Fetch latest
GIT_SSH_COMMAND="ssh -i /root/.ssh/id_ed25519_github -o StrictHostKeyChecking=accept-new" \
  git fetch origin "$BRANCH" 2>/dev/null

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

echo "[deploy] New commits detected: $LOCAL -> $REMOTE"
git reset --hard "origin/$BRANCH"
echo "[deploy] Pulled $(git log --oneline -1)"

# Install dependencies if lockfile changed
bun install --frozen-lockfile 2>/dev/null || bun install

# Sync systemd unit files if changed
for unit in deploy/systemd/*.service; do
  name=$(basename "$unit")
  if ! cmp -s "$unit" "/etc/systemd/system/$name" 2>/dev/null; then
    cp "$unit" "/etc/systemd/system/$name"
    echo "[deploy] Updated $name"
  fi
done
systemctl daemon-reload

# Restart only the protected compatibility service. Ports 3000 and 3003 remain
# contained until the hard reactivation gate is approved.
systemctl restart vaultwarden-secrets-mcp.service

echo "[deploy] Protected MCP service restarted"
