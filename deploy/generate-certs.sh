#!/usr/bin/env bash
#
# Generate mTLS certificates for vaultwarden-secrets
# Creates CA, server cert, and client cert
#
# Usage:
#   ./generate-certs.sh [output-dir]
#   Default output-dir: ./tls

set -euo pipefail

OUTPUT_DIR="${1:-./tls}"
DAYS_CA=3650      # 10 years
DAYS_SERVER=365   # 1 year
DAYS_CLIENT=365   # 1 year

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "mTLS Certificate Generator"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Create output directory
mkdir -p "$OUTPUT_DIR"
cd "$OUTPUT_DIR"

# Step 1: Generate CA
echo "[1/5] Generating Certificate Authority (CA)..."
if [[ -f ca.key ]]; then
  echo "  ⚠  ca.key already exists, skipping CA generation"
else
  openssl genrsa -out ca.key 4096
  openssl req -new -x509 -days $DAYS_CA -key ca.key -out ca.crt \
    -subj "/C=US/ST=State/L=City/O=Homelab/CN=Vaultwarden Secrets CA" \
    -sha256
  echo "  ✓ CA generated: ca.crt, ca.key"
fi
echo ""

# Step 2: Generate server certificate
echo "[2/5] Generating server certificate..."
if [[ -f server.key ]]; then
  echo "  ⚠  server.key already exists, skipping server cert generation"
else
  openssl genrsa -out server.key 4096
  openssl req -new -key server.key -out server.csr \
    -subj "/C=US/ST=State/L=City/O=Homelab/CN=secrets.local" \
    -sha256
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key \
    -CAcreateserial -out server.crt -days $DAYS_SERVER -sha256
  rm server.csr
  echo "  ✓ Server cert generated: server.crt, server.key"
fi
echo ""

# Step 3: Generate client certificate
echo "[3/5] Generating client certificate..."
if [[ -f client.key ]]; then
  echo "  ⚠  client.key already exists, skipping client cert generation"
else
  openssl genrsa -out client.key 4096
  openssl req -new -key client.key -out client.csr \
    -subj "/C=US/ST=State/L=City/O=Homelab/CN=clawdbot" \
    -sha256
  openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key \
    -CAcreateserial -out client.crt -days $DAYS_CLIENT -sha256
  rm client.csr
  echo "  ✓ Client cert generated: client.crt, client.key"
fi
echo ""

# Step 4: Extract client certificate fingerprint
echo "[4/5] Extracting client certificate fingerprint..."
FINGERPRINT=$(openssl x509 -in client.crt -noout -fingerprint -sha256 | \
  sed 's/://g' | awk -F= '{print "sha256:"tolower($2)}')
echo "  ✓ Fingerprint: $FINGERPRINT"
echo ""

# Step 5: Generate certs.json config
echo "[5/5] Generating certs.json config..."
cat > certs.json << EOF
{
  "allowedFingerprints": [
    "$FINGERPRINT"
  ],
  "_comment": "Add additional client certificate fingerprints to this array",
  "_generated": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo "  ✓ Config generated: certs.json"
echo ""

# Summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Certificate generation complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Generated files:"
echo "  • ca.crt, ca.key         (Certificate Authority)"
echo "  • server.crt, server.key (Server certificate)"
echo "  • client.crt, client.key (Client certificate)"
echo "  • certs.json             (Fingerprint config)"
echo ""
echo "Next steps:"
echo "  1. Configure nginx with server.crt and ca.crt (see deploy/nginx-mtls.conf)"
echo "  2. Set ALLOWED_CLIENT_CERTS=$(pwd)/certs.json"
echo "  3. Start vaultwarden-secrets with SECURITY_PROFILE=openclaw"
echo "  4. Test with: curl --cert client.crt --key client.key https://secrets.local/health"
echo ""
echo "⚠️  IMPORTANT: Keep ca.key and server.key/client.key secure!"
echo "   Consider moving ca.key offline after generating all certs."
echo ""
