#!/usr/bin/env bash
# Refresh the Bitwarden CLI session token for the vaultwarden-secrets services.
#
# De-rooted (issue #14): reads/writes the session at BW_SESSION_FILE (state dir),
# NOT a hardcoded /root path, and relies on HOME for bw's appdata (data.json)
# so it runs as the mcp2cli service identity. Credentials come from the app .env,
# never hardcoded.
set -euo pipefail

ENV_FILE="${VW_ENV_FILE:-/opt/vaultwarden-secrets/.env}"
SESSION_FILE="${BW_SESSION_FILE:-/var/lib/vaultwarden-secrets/.bw-session}"

# Source login credentials from .env (values are secrets — never echo them).
if [ -f "$ENV_FILE" ]; then
  BW_EMAIL=$(grep "^BW_EMAIL=" "$ENV_FILE" | cut -d= -f2- || true)
  BW_PASSWORD=$(grep "^BW_PASSWORD=" "$ENV_FILE" | cut -d= -f2- || true)
fi

# Try to extend the existing session first; fall back to a full login.
SESSION=$(cat "$SESSION_FILE" 2>/dev/null || echo "")
NEW_SESSION=$(BW_SESSION="$SESSION" bw unlock --raw 2>/dev/null || echo "")
if [ -z "$NEW_SESSION" ]; then
  NEW_SESSION=$(bw login "${BW_EMAIL:-}" "${BW_PASSWORD:-}" --raw 2>/dev/null || echo "")
fi

if [ -n "$NEW_SESSION" ]; then
  # Write atomically with tight perms; the file holds a live session token.
  umask 077
  tmp="${SESSION_FILE}.tmp.$$"
  printf '%s' "$NEW_SESSION" > "$tmp"
  mv -f "$tmp" "$SESSION_FILE"
else
  echo "refresh-session: failed to obtain a session" >&2
  exit 1
fi
