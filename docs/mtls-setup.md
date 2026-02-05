# mTLS + JWT Setup Guide

This guide explains how to configure mTLS (mutual TLS) with JWT authentication for the `openclaw` security profile.

## Overview

The `openclaw` profile provides **defense in depth** through multiple security layers:

1. **IP Whitelist**: Localhost only (127.0.0.1/32) by default
2. **mTLS**: Client must present valid certificate with known fingerprint
3. **JWT**: Client must provide valid Bearer token with correct scopes
4. **Response Encryption**: Secrets encrypted with ECDH + AES-256-GCM
5. **Forensic Audit**: All requests logged for security analysis

Both mTLS AND JWT must pass for the request to succeed.

## Architecture: Direct vs Proxy Mode

### Proxy Mode (Recommended)

```
Client → nginx/haproxy → vaultwarden-secrets
         ↑ validates cert
         ↑ sets X-Client-Cert-Fingerprint header
```

**Why proxy mode:**
- Mature TLS implementations (OpenSSL battle-tested)
- Better certificate validation and revocation checking
- Offloads TLS overhead from application
- Standard pattern in production deployments

**Configure nginx:**
```nginx
server {
    listen 443 ssl;
    ssl_certificate /etc/nginx/ssl/server.crt;
    ssl_certificate_key /etc/nginx/ssl/server.key;
    ssl_client_certificate /etc/nginx/ssl/ca.crt;
    ssl_verify_client on;

    location / {
        proxy_pass http://127.0.0.1:3000;

        # Pass client cert fingerprint to app
        proxy_set_header X-Client-Cert-Fingerprint $ssl_client_fingerprint;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

### Direct Mode (Experimental)

```
Client → vaultwarden-secrets (Bun TLS)
```

**Limitations:**
- Bun's TLS API doesn't currently expose client cert info
- Future Bun versions may add support
- Currently documented but not functional

**If Bun adds support:**
```typescript
export default {
  port: 3000,
  hostname: '127.0.0.1',
  fetch: app.fetch,
  tls: {
    cert: Bun.file('/opt/vaultwarden-secrets/tls/server.crt'),
    key: Bun.file('/opt/vaultwarden-secrets/tls/server.key'),
    ca: Bun.file('/opt/vaultwarden-secrets/tls/ca.crt'),
    requestCert: true,
    rejectUnauthorized: true,
  },
};
```

## Step-by-Step Setup

### 1. Generate CA (Certificate Authority)

```bash
# Create CA key and certificate
openssl genrsa -out ca.key 4096
openssl req -new -x509 -days 3650 -key ca.key -out ca.crt \
  -subj "/C=US/ST=State/L=City/O=Homelab/CN=Vaultwarden CA"
```

### 2. Generate Server Certificate

```bash
# Create server key
openssl genrsa -out server.key 4096

# Create certificate signing request
openssl req -new -key server.key -out server.csr \
  -subj "/C=US/ST=State/L=City/O=Homelab/CN=secrets.local"

# Sign with CA
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out server.crt -days 365
```

### 3. Generate Client Certificate

```bash
# Create client key
openssl genrsa -out client.key 4096

# Create certificate signing request
openssl req -new -key client.key -out client.csr \
  -subj "/C=US/ST=State/L=City/O=Homelab/CN=clawdbot"

# Sign with CA
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out client.crt -days 365
```

### 4. Extract Client Certificate Fingerprint

```bash
# Get SHA-256 fingerprint
openssl x509 -in client.crt -noout -fingerprint -sha256

# Output: SHA256 Fingerprint=12:34:56:78:90:AB:CD:EF:...

# Format for config (remove colons, add prefix, lowercase):
openssl x509 -in client.crt -noout -fingerprint -sha256 | \
  sed 's/://g' | \
  awk -F= '{print "sha256:"tolower($2)}'

# Output: sha256:1234567890abcdef...
```

### 5. Configure Allowed Fingerprints

**Option 1: Config file (recommended)**

```bash
# Create config file
cat > /opt/vaultwarden-secrets/certs.json << 'EOF'
{
  "allowedFingerprints": [
    "sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
  ]
}
EOF

# Set environment variable
export ALLOWED_CLIENT_CERTS=/opt/vaultwarden-secrets/certs.json
```

**Option 2: Environment variable (inline)**

```bash
# Multiple fingerprints separated by comma
export ALLOWED_CERT_FINGERPRINTS="sha256:abc123...,sha256:def456..."
```

### 6. Configure vaultwarden-secrets

**Environment variables:**

```bash
# Security profile
export SECURITY_PROFILE=openclaw

# mTLS configuration
export MTLS_MODE=proxy
export MTLS_HEADER=X-Client-Cert-Fingerprint
export ALLOWED_CLIENT_CERTS=/opt/vaultwarden-secrets/certs.json

# JWT configuration
export JWT_SECRET="$(openssl rand -hex 32)"

# Server config
export PORT=3000
export HOST=127.0.0.1
```

**Or use .env file:**

```bash
cp deploy/env.example /opt/vaultwarden-secrets/.env
# Edit /opt/vaultwarden-secrets/.env with your values
```

### 7. Start Server

```bash
cd /opt/vaultwarden-secrets
bun run server/main.ts
```

**Expected output:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔒 Security Profile: OpenClaw / Clawdbot
   MAXIMUM PARANOIA - Multi-layer defense in depth
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Active security layers:
  ✓ IP Whitelist: 127.0.0.1/32
  ✓ Rate Limiting: 30/1m
  ✓ mTLS: 1 fingerprint(s), mode=proxy
  ✓ JWT: Required scopes=read:secrets
  ✓ Combined Auth: mTLS + JWT (defense in depth)
  ✓ Audit Logging: forensic
  ✓ Response Encryption: ECDH P-256 + AES-256-GCM
```

## Testing mTLS + JWT

### 1. Generate JWT Token

First, obtain a valid JWT token. You'll need to implement a token issuance endpoint or use the existing OAuth2 flow.

**Example JWT payload:**

```json
{
  "sub": "clawdbot",
  "scope": "read:secrets",
  "type": "access",
  "iat": 1234567890,
  "exp": 1234567890,
  "iss": "vaultwarden-secrets"
}
```

### 2. Make Request with Certificate + JWT

**Using curl (proxy mode):**

```bash
# With client certificate (nginx validates)
curl -X GET https://secrets.local/secret/MY_SECRET \
  --cert client.crt \
  --key client.key \
  --cacert ca.crt \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**Using Node.js/TypeScript:**

```typescript
import https from 'https';
import fs from 'fs';

const options = {
  hostname: 'secrets.local',
  port: 443,
  path: '/secret/MY_SECRET',
  method: 'GET',
  cert: fs.readFileSync('client.crt'),
  key: fs.readFileSync('client.key'),
  ca: fs.readFileSync('ca.crt'),
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
  },
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => console.log(JSON.parse(data)));
});

req.end();
```

### 3. Test Failure Scenarios

**Missing certificate:**

```bash
curl https://secrets.local/secret/TEST -H "Authorization: Bearer ..."
# Expected: 401 Unauthorized (nginx rejects)
```

**Wrong certificate:**

```bash
curl https://secrets.local/secret/TEST \
  --cert wrong-client.crt --key wrong-client.key \
  -H "Authorization: Bearer ..."
# Expected: 403 Forbidden (fingerprint not in allowlist)
```

**Missing JWT:**

```bash
curl https://secrets.local/secret/TEST \
  --cert client.crt --key client.key
# Expected: 401 Unauthorized (no JWT)
```

**Expired JWT:**

```bash
curl https://secrets.local/secret/TEST \
  --cert client.crt --key client.key \
  -H "Authorization: Bearer <expired-token>"
# Expected: 401 Unauthorized (JWT expired)
```

## Security Audit Logs

All authentication events are logged for forensic analysis.

**Successful request:**

```json
{
  "timestamp": "2026-02-05T12:34:56.789Z",
  "event": "auth_success",
  "ip": "127.0.0.1",
  "userAgent": "curl/7.88.0",
  "path": "/secret/TEST",
  "clientId": "clawdbot",
  "clientFingerprint": "sha256:abc123...",
  "scopes": ["read:secrets"]
}
```

**Failed mTLS:**

```json
{
  "timestamp": "2026-02-05T12:34:56.789Z",
  "event": "mtls_failed",
  "ip": "127.0.0.1",
  "userAgent": "curl/7.88.0",
  "path": "/secret/TEST"
}
```

**Failed JWT:**

```json
{
  "timestamp": "2026-02-05T12:34:56.789Z",
  "event": "jwt_failed",
  "ip": "127.0.0.1",
  "userAgent": "curl/7.88.0",
  "path": "/secret/TEST",
  "clientFingerprint": "sha256:abc123..."
}
```

## Certificate Rotation

When rotating client certificates:

1. Generate new client certificate
2. Extract new fingerprint
3. Add new fingerprint to `certs.json` (keep old one)
4. Update clients to use new certificate
5. Verify new certificate works
6. Remove old fingerprint from `certs.json`

**Zero-downtime rotation:**

```json
{
  "allowedFingerprints": [
    "sha256:old-cert-fingerprint",
    "sha256:new-cert-fingerprint"
  ]
}
```

## Troubleshooting

### Error: "Client certificate required"

- **Proxy mode**: Nginx/HAProxy not configured to validate certs
- **Direct mode**: Not supported in current Bun version
- **Solution**: Verify nginx `ssl_verify_client on` and cert passing

### Error: "Client certificate not authorized"

- Fingerprint not in allowlist
- Check fingerprint format: `sha256:lowercase-hex`
- Verify config file loaded: `ALLOWED_CLIENT_CERTS` path correct

### Error: "Missing Authorization header"

- JWT token not provided
- Check header format: `Authorization: Bearer <token>`

### Error: "Token verification failed"

- JWT expired (default: 5 minutes)
- Wrong JWT_SECRET
- Token issued by different server

## Production Checklist

- [ ] Use proxy mode (nginx/haproxy) for TLS termination
- [ ] Generate strong CA key (4096-bit RSA minimum)
- [ ] Store CA key securely (offline, encrypted)
- [ ] Use unique JWT_SECRET (32+ bytes random)
- [ ] Configure IP whitelist appropriately
- [ ] Set up audit log file (`AUDIT_LOG_FILE`)
- [ ] Monitor failed auth attempts
- [ ] Implement certificate rotation policy
- [ ] Test all failure scenarios
- [ ] Document certificate issuance procedure

## See Also

- [Security Profiles](../README.md#security-profiles)
- [Response Encryption](./response-encryption.md)
- [Audit Logging](./audit-logging.md)
