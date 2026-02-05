#!/usr/bin/env bash
set -euo pipefail

# Build distributable release tarball
# Usage: ./build-release.sh [version]

VERSION="${1:-$(grep '"version"' package.json | cut -d'"' -f4)}"
RELEASE_NAME="vaultwarden-secrets-v${VERSION}"
RELEASE_DIR="dist/${RELEASE_NAME}"
TARBALL="dist/${RELEASE_NAME}.tar.gz"

echo "Building release: ${RELEASE_NAME}"
echo ""

# Clean previous builds
rm -rf dist
mkdir -p "$RELEASE_DIR"

echo "→ Copying source files..."
# Core library files
cp -r *.ts "$RELEASE_DIR/" 2>/dev/null || true
cp package.json "$RELEASE_DIR/"
cp README.md "$RELEASE_DIR/" 2>/dev/null || true
cp LICENSE "$RELEASE_DIR/" 2>/dev/null || true

# CLI and bin
mkdir -p "$RELEASE_DIR/bin"
cp -r bin/* "$RELEASE_DIR/bin/"

# Migration tools
mkdir -p "$RELEASE_DIR/migrate"
cp -r migrate/*.ts "$RELEASE_DIR/migrate/"

# Shell integration
mkdir -p "$RELEASE_DIR/shell"
cp -r shell/*.sh "$RELEASE_DIR/shell/" 2>/dev/null || true

# Server (HTTP API)
if [ -d "server" ]; then
    echo "→ Copying server files..."
    mkdir -p "$RELEASE_DIR/server"
    cp -r server/*.ts "$RELEASE_DIR/server/"
    cp -r server/auth "$RELEASE_DIR/server/" 2>/dev/null || true
    cp -r server/middleware "$RELEASE_DIR/server/" 2>/dev/null || true
    cp -r server/utils "$RELEASE_DIR/server/" 2>/dev/null || true
    cp server/README.md "$RELEASE_DIR/server/" 2>/dev/null || true
fi

# Deployment templates
if [ -d "deploy" ]; then
    echo "→ Copying deployment templates..."
    mkdir -p "$RELEASE_DIR/deploy"
    cp -r deploy/* "$RELEASE_DIR/deploy/"
fi

# Installer
cp install.sh "$RELEASE_DIR/"
chmod +x "$RELEASE_DIR/install.sh"

echo "→ Creating release config..."
# Create release-specific config hints (no hardcoded values)
cat > "$RELEASE_DIR/.release-config" << 'EOF'
# Release Configuration Hints
# Copy this to .env or set as environment variables

# CLI Configuration:
# Required: Your Vaultwarden server URL
# VAULTWARDEN_SERVER=https://vault.example.com

# Optional: Custom installation directory
# VAULTWARDEN_SECRETS_DIR=~/.config/vaultwarden-secrets

# Optional: Git repository (for updates)
# VW_SECRETS_REPO=https://github.com/yourusername/vaultwarden-secrets.git

# Server Configuration:
# See deploy/env.example for HTTP server environment variables
# See deploy/DEPLOY.md for full deployment guide
# Deployment templates available in deploy/ directory:
#   - deploy/systemd/vaultwarden-secrets.service
#   - deploy/nginx/secrets.conf
#   - deploy/env.example
EOF

echo "→ Creating tarball..."
cd dist
tar czf "${RELEASE_NAME}.tar.gz" "$RELEASE_NAME"
cd ..

# Calculate size and hash
SIZE=$(du -h "$TARBALL" | cut -f1)
HASH=$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)

echo ""
echo "✅ Release built successfully!"
echo ""
echo "  File:   $TARBALL"
echo "  Size:   $SIZE"
echo "  SHA256: $HASH"
echo ""
echo "Distribution:"
echo "  scp $TARBALL user@host:~"
echo "  ssh user@host 'tar xzf ${RELEASE_NAME}.tar.gz && cd $RELEASE_NAME && ./install.sh'"
echo ""
