#!/usr/bin/env sh
# Deploy script — fetches latest, restarts only if changes detected.
# Run manually or via systemd timer (vw-deploy.timer).

set -eu

REPO_DIR="/opt/vaultwarden-secrets"
BRANCH="${DEPLOY_BRANCH:-feature/installer-cli}"

cd "$REPO_DIR"

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

# Restart services
systemctl restart vaultwarden-secrets.service
systemctl restart vaultwarden-secrets-mcp.service

echo "[deploy] Services restarted"
