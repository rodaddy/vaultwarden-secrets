# HTTP Secrets Server - Technical Specification

> **Historical planning document.** This predates the built system and is kept for provenance. For current behavior see README.md and docs/.

**Version:** 1.0
**Date:** 2026-02-04
**Status:** Draft

## Overview

HTTP API server that exposes the `vaultwarden-secrets` library (v0.5.2) via REST endpoints with tiered security profiles.

## Goals

1. **Programmatic access** - Services/scripts can fetch secrets via HTTP
2. **Flexible security** - Choose auth level based on environment (dev → prod → paranoid)
3. **Infrastructure deployment** - Easy distribution to LXC containers
4. **Universal compatibility** - Works from any system with HTTP client

## Non-Goals

- ❌ Secret creation/modification (read-only API)
- ❌ Multi-user authentication (single-system scope)
- ❌ Secret sharing/collaboration features
- ❌ Web UI (CLI + API only)

---

## Security Profiles

### 1. feeling-lucky (Development)

**Use case:** Local development, quick prototyping
**WARNING:** ⚠️  NEVER USE IN PRODUCTION

| Layer | Configuration |
|-------|---------------|
| Auth | None |
| IP Whitelist | Disabled |
| TLS | Optional |
| Rate Limiting | Disabled |
| Audit | Basic (console only) |

**Client usage:**
```bash
curl http://localhost:3000/secret/MyPassword
```

**Environment:**
```bash
SECURITY_PROFILE=feeling-lucky
```

---

### 2. im-aware (Homelab/Internal)

**Use case:** Internal VLAN, homelab services, LXC deployment
**Recommended for:** Your infrastructure (10.71.20.x)

| Layer | Configuration |
|-------|---------------|
| Auth | Bearer token (API key) |
| IP Whitelist | VLAN 20 (10.71.20.0/24) |
| TLS | Recommended (nginx handles it) |
| Rate Limiting | 100 req/min per client |
| Audit | Standard (file + console) |

**Client usage:**
```bash
curl -H "Authorization: Bearer $API_TOKEN" \
  https://secrets.rodaddy.live/secret/MyPassword
```

**Environment:**
```bash
SECURITY_PROFILE=im-aware
API_TOKEN_LXC200="token-for-postgres"
API_TOKEN_LXC202="token-for-n8n"
API_TOKEN_LXC204="token-for-clawdbot"
```

**Security guarantees:**
- Only systems on VLAN 20 can reach server
- Each client has unique token (revocable)
- All access logged with client ID + timestamp
- Rate limiting prevents abuse

---

### 3. im-a-dev (Production Web Apps)

**Use case:** Multi-user web applications, external access
**Future implementation** (OAuth2 provider integration needed)

| Layer | Configuration |
|-------|---------------|
| Auth | OAuth2 authorization flow |
| IP Whitelist | Disabled (OAuth handles auth) |
| TLS | Required (strict ciphers) |
| Rate Limiting | 60 req/min per user |
| Audit | Detailed (user ID, IP, secret name) |

**Features:**
- Short-lived access tokens (15 min)
- Refresh tokens for session renewal
- User-based access control
- Detailed audit trail

**Environment:**
```bash
SECURITY_PROFILE=im-a-dev
OAUTH_CLIENT_ID="..."
OAUTH_CLIENT_SECRET="..."
OAUTH_PROVIDER="https://auth.example.com"
```

---

### 4. openclaw (Maximum Security)

**Use case:** AI agents with cloud access, zero-trust environments
**For:** OpenClaw, Clawdbot, production services handling PII

| Layer | Configuration |
|-------|---------------|
| Auth | mTLS + JWT (dual-factor) |
| IP Whitelist | VLAN 20 (defense in depth) |
| TLS | Required + strict (TLS 1.3+) |
| Rate Limiting | 30 req/min, burst 5 |
| Audit | Forensic (everything logged) |

**Security layers:**
1. **Network:** IP whitelist (VLAN only)
2. **Transport:** TLS 1.3 with strict ciphers
3. **Client:** mTLS certificate validation (pinned fingerprints)
4. **Application:** JWT with 5-min expiry
5. **Response:** Double-encrypted secrets (TLS + AES-256-GCM)
6. **Monitoring:** Anomaly detection, failed auth lockout

**Client usage:**
```bash
curl --cert client.crt --key client.key \
  -H "Authorization: Bearer $JWT_TOKEN" \
  https://secrets.rodaddy.live/secret/MyPassword
```

**Environment:**
```bash
SECURITY_PROFILE=openclaw
TLS_CERT="/path/to/server.crt"
TLS_KEY="/path/to/server.key"
ALLOWED_CLIENT_CERTS="/path/to/allowed-certs.json"
JWT_SECRET="..."
```

**Features:**
- Certificate pinning (whitelist specific client certs)
- 3-strike lockout on failed auth
- Real-time anomaly detection
- Immutable audit log (append-only)
- Response payload encryption

---

## API Endpoints

### GET /health

Health check endpoint (no auth required).

**Response:**
```json
{
  "status": "ok",
  "profile": "I'm Aware",
  "timestamp": "2026-02-04T20:30:00Z"
}
```

---

### GET /vaults

List available vaults.

**Auth:** Required (except feeling-lucky)

**Response:**
```json
{
  "vaults": ["default", "work", "personal"]
}
```

---

### GET /secret/:name

Retrieve a secret by name.

**Parameters:**
- `:name` - Secret name (URL-encoded)
- `?vault=default` - Optional vault selection

**Auth:** Required (except feeling-lucky)

**Examples:**
```bash
GET /secret/MyPassword
GET /secret/MyPassword?vault=work
GET /secret/API%20Key.notes
GET /secret/PostgreSQL%20clawdbot.login.password
```

**Response (success):**
```json
{
  "value": "hunter2"
}
```

**Response (error):**
```json
{
  "error": "Secret not found"
}
```

**Status codes:**
- `200` - Success
- `401` - Unauthorized (missing/invalid token)
- `403` - Forbidden (IP not whitelisted)
- `404` - Secret not found
- `429` - Rate limit exceeded
- `500` - Server error

---

## Middleware Architecture

Middleware applied in order based on security profile:

```
1. CORS (if enabled)
2. IP Whitelist (if profile.ipWhitelist)
3. Rate Limiting (if profile.rateLimit)
4. Authentication (if profile.auth !== false)
5. Audit Logging (always, level varies)
6. Route Handler
```

### Middleware Components

#### IP Whitelist
- Parses CIDR notation (e.g., `10.71.20.0/24`)
- Checks `X-Forwarded-For`, `X-Real-IP`, then socket IP
- Logs blocked IPs
- Returns 403 if not whitelisted

#### Bearer Auth
- Validates `Authorization: Bearer <token>` header
- Loads tokens from `API_TOKEN_<CLIENT>` env vars
- Maps token → client ID
- Stores client ID in context for audit logging
- Returns 401 if invalid

#### Rate Limiting
- Sliding window algorithm
- Per-client tracking (by client ID or IP)
- Configurable: requests per window + burst
- Returns 429 if exceeded

#### Audit Logging
- Levels: none, basic, standard, detailed, forensic
- Logs to console + file (configurable)
- Format: JSON lines (one event per line)
- Fields: timestamp, clientId, clientIP, method, path, status, duration

**Example audit log entry:**
```json
{
  "timestamp": "2026-02-04T20:30:00Z",
  "clientId": "lxc200",
  "clientIP": "10.71.20.12",
  "method": "GET",
  "path": "/secret/PostgreSQL%20clawdbot",
  "secretName": "PostgreSQL clawdbot",
  "status": 200,
  "duration": 45
}
```

---

## Deployment

### Tarball Structure

```
vaultwarden-secrets-v0.5.2/
├── *.ts                     # Core library
├── bin/                     # CLI
├── server/                  # HTTP server
│   ├── main.ts
│   ├── profiles.ts
│   ├── middleware/
│   └── README.md
├── deploy/
│   ├── systemd/
│   │   └── vw-secrets.service
│   ├── nginx/
│   │   └── secrets.conf
│   └── DEPLOY.md
├── install.sh               # Installer
└── README.md
```

### Installation Flow

1. **Build tarball**
   ```bash
   ./build-release.sh
   # Creates: dist/vaultwarden-secrets-v0.5.2.tar.gz
   ```

2. **Copy to LXC**
   ```bash
   scp dist/vaultwarden-secrets-v0.5.2.tar.gz root@10.71.20.X:~
   ```

3. **Extract and install**
   ```bash
   ssh root@10.71.20.X
   tar xzf vaultwarden-secrets-v0.5.2.tar.gz
   cd vaultwarden-secrets-v0.5.2
   ./install.sh
   ```

4. **Configure server**
   ```bash
   # Set profile and tokens
   export SECURITY_PROFILE=im-aware
   export API_TOKEN_LXC200="..."

   # Start server
   bun run server
   ```

5. **Setup systemd** (optional)
   ```bash
   cp deploy/systemd/vw-secrets.service /etc/systemd/system/
   systemctl enable --now vw-secrets
   ```

---

## Testing Strategy

### Per-Profile Tests

**feeling-lucky:**
- ✓ GET /health works without auth
- ✓ GET /secret/Test works without auth
- ✓ No rate limiting

**im-aware:**
- ✓ Requires Bearer token
- ✓ Invalid token → 401
- ✓ IP outside VLAN → 403
- ✓ IP inside VLAN → 200
- ✓ Rate limit enforcement (>100 req/min → 429)
- ✓ Audit log entries created

**im-a-dev (future):**
- ✓ OAuth2 authorization flow
- ✓ Token refresh works
- ✓ Expired token → 401

**openclaw (future):**
- ✓ Requires client certificate
- ✓ Invalid cert → 403
- ✓ Requires JWT
- ✓ Expired JWT → 401
- ✓ Failed auth lockout (3 strikes)

### Integration Tests

```bash
# Test script example
./test-profiles.sh

# Output:
# ✓ feeling-lucky: all endpoints accessible
# ✓ im-aware: bearer auth working
# ✓ im-aware: IP whitelist blocking
# ✓ im-aware: rate limiting working
```

---

## Configuration Reference

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SECURITY_PROFILE` | No | `im-aware` | Profile name |
| `PORT` | No | `3000` | Server port |
| `HOST` | No | `0.0.0.0` | Bind address |
| `NODE_ENV` | No | - | `production` blocks feeling-lucky |
| `API_TOKEN_<CLIENT>` | Yes (im-aware) | - | Bearer tokens |
| `AUDIT_LOG_FILE` | No | - | Audit log path |
| `TLS_CERT` | Yes (openclaw) | - | TLS certificate |
| `TLS_KEY` | Yes (openclaw) | - | TLS private key |

### Profile Requirements Matrix

| Requirement | feeling-lucky | im-aware | im-a-dev | openclaw |
|-------------|---------------|----------|----------|----------|
| API tokens | ❌ | ✅ | ❌ | ❌ |
| OAuth config | ❌ | ❌ | ✅ | ❌ |
| TLS cert | ❌ | ⚠️  | ✅ | ✅ |
| Client certs | ❌ | ❌ | ❌ | ✅ |
| JWT secret | ❌ | ❌ | ⚠️  | ✅ |

---

## Implementation Phases

### Phase 1: Core (MVP)
- ✅ Security profiles defined
- ✅ Basic Hono server
- → IP whitelist middleware
- → Bearer auth middleware
- → Audit logger
- → Profile-based composition

### Phase 2: Deployment
- → Enhanced installer
- → systemd service template
- → nginx config template
- → Deployment documentation
- → Testing suite

### Phase 3: Advanced Profiles (Future)
- → OAuth2 integration (im-a-dev)
- → mTLS validation (openclaw)
- → JWT generation/validation
- → Response encryption
- → Anomaly detection

---

## Security Considerations

### Threat Model

**Threats mitigated:**
- ✅ Unauthorized network access (IP whitelist)
- ✅ Stolen/leaked API tokens (rotation + audit trail)
- ✅ Rate limiting abuse (per-client limits)
- ✅ Man-in-the-middle (TLS required)

**Threats NOT mitigated:**
- ❌ Compromised client system (has valid token/cert)
- ❌ Insider threat (admin access to server)
- ❌ Physical access to server

### Best Practices

1. **Token rotation** - Rotate API tokens every 90 days
2. **Audit review** - Weekly review of audit logs
3. **IP whitelist** - Use smallest possible CIDR range
4. **TLS enforcement** - Always use HTTPS in production
5. **Monitoring** - Alert on failed auth spikes

---

## Open Questions

1. **OAuth provider** - Which provider for im-a-dev? (Auth0, Keycloak, custom?)
2. **Certificate management** - Auto-renewal for openclaw client certs?
3. **Rate limit storage** - In-memory OK or need Redis for multi-instance?
4. **Audit log rotation** - logrotate config or built-in?
5. **Secret caching** - Should server cache secrets or always fetch from VW?
