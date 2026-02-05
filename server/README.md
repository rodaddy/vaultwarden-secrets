# Vaultwarden Secrets Server

HTTP API for secret retrieval with tiered security profiles.

## Security Profiles

Choose based on your deployment environment:

| Profile | Auth | IP Whitelist | Use Case | Command |
|---------|------|--------------|----------|---------|
| **feeling-lucky** | None | Auto (local /24) | Dev/testing only | `bun run server:dev` |
| **im-aware** | Bearer token | Auto (local /24) | Homelab/internal | `bun run server:prod` |
| **im-a-dev** | OAuth2 | Auto (local /24) | Production web apps | `SECURITY_PROFILE=im-a-dev bun run server` |
| **trust-no-one** | mTLS + JWT | 127.0.0.1/32 only | Maximum security | `SECURITY_PROFILE=trust-no-one bun run server` |

### Profile Aliases (for `trust-no-one`)

The maximum security profile has several aliases for backwards compatibility and fun:

| Alias | Points To |
|-------|-----------|
| `openclaw` | trust-no-one |
| `tinfoil-hat` | trust-no-one |
| `maximum-paranoia` | trust-no-one |
| `aluminum-foil` | trust-no-one |
| `aluminium-hat` | trust-no-one |
| `fort-knox` | trust-no-one |

Use any of these: `SECURITY_PROFILE=tinfoil-hat bun run server`

**Network Auto-Detection:**
All profiles except `openclaw` automatically detect your local network and whitelist it. For example, if the server's IP is 192.168.1.50, it will whitelist 192.168.1.0/24.

Override with: `IP_WHITELIST=10.0.0.0/8,172.17.0.0/16`

## Quick Start

### 1. Development (No Auth)
```bash
# Start server with no auth (DEVELOPMENT ONLY)
bun run server:dev

# Test
curl http://localhost:3000/health
curl http://localhost:3000/secret/MyPassword
```

### 2. Production (Bearer Token)
```bash
# Set API tokens for clients
export API_TOKEN_LXC200="secret-token-for-postgres"
export API_TOKEN_LXC202="secret-token-for-n8n"

# Start server
bun run server:prod

# Test with token
curl -H "Authorization: Bearer secret-token-for-postgres" \
  https://secrets.rodaddy.live/secret/MyPassword
```

### 3. Maximum Security (Trust No One - mTLS + JWT)
```bash
# Generate certificates (one-time setup)
cd deploy
./generate-certs.sh
# This creates: ca.crt, server.crt, client.crt, and certs.json

# Configure environment
export SECURITY_PROFILE=trust-no-one  # or: tinfoil-hat, openclaw, fort-knox
export ALLOWED_CLIENT_CERTS="/opt/vaultwarden-secrets/tls/certs.json"
export JWT_SECRET="$(openssl rand -hex 32)"

# Start server (localhost only)
bun run server

# Test with client cert + JWT
curl --cert tls/client.crt --key tls/client.key \
  -H "Authorization: Bearer <jwt-token>" \
  https://secrets.local/secret/MyPassword
```

See [mTLS Setup Guide](../docs/mtls-setup.md) for full details.

## API Endpoints

### Health Check
```bash
GET /health

Response:
{
  "status": "ok",
  "profile": "I'm Aware",
  "timestamp": "2026-02-04T..."
}
```

### List Vaults
```bash
GET /vaults

Response:
{
  "vaults": ["default", "work", "personal"]
}
```

### Get Secret
```bash
GET /secret/:name?vault=default

Examples:
  GET /secret/MyPassword
  GET /secret/MyPassword?vault=work
  GET /secret/API%20Key.notes

Response:
{
  "value": "hunter2"
}
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SECURITY_PROFILE` | Profile name (see above) | No (default: im-aware) |
| `PORT` | Server port | No (default: 3000) |
| `HOST` | Bind address | No (default: 0.0.0.0) |
| `API_TOKEN_<CLIENT>` | Bearer tokens for clients | Yes (im-aware profile) |
| `OAUTH_CLIENT_ID` | OAuth2 client ID | Yes (im-a-dev profile) |
| `OAUTH_CLIENT_SECRET` | OAuth2 client secret | Yes (im-a-dev profile) |
| `ALLOWED_CLIENT_CERTS` | Path to certs.json | Yes (trust-no-one profile) |
| `ALLOWED_CERT_FINGERPRINTS` | Inline cert fingerprints | Alternative to ALLOWED_CLIENT_CERTS |
| `JWT_SECRET` | JWT signing secret | Yes (trust-no-one/im-a-dev) |
| `MTLS_MODE` | direct or proxy | No (default: proxy) |
| `MTLS_HEADER` | Header name for proxy mode | No (default: X-Client-Cert-Fingerprint) |
| `NODE_ENV` | production prevents feeling-lucky | No |

## Deployment

### systemd Service
```ini
[Unit]
Description=Vaultwarden Secrets Server
After=network.target

[Service]
Type=simple
User=vw-secrets
WorkingDirectory=/opt/vaultwarden-secrets
Environment="SECURITY_PROFILE=im-aware"
Environment="API_TOKEN_LXC200=..."
Environment="API_TOKEN_LXC202=..."
ExecStart=/usr/local/bin/bun run server/main.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### nginx Reverse Proxy

**Standard (Bearer Auth):**
```nginx
server {
    listen 443 ssl;
    server_name secrets.rodaddy.live;

    ssl_certificate /etc/nginx/certs/secrets.rodaddy.live.crt;
    ssl_certificate_key /etc/nginx/certs/secrets.rodaddy.live.key;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

**mTLS (Trust No One):**
See [deploy/nginx-mtls.conf](../deploy/nginx-mtls.conf) for full mTLS configuration with client certificate validation.

## Roadmap

- [x] Implement middleware (IP whitelist, rate limiting, audit logging)
- [x] OAuth2 provider integration
- [x] mTLS certificate validation
- [x] Response encryption (double-encrypted secrets)
- [ ] Anomaly detection and alerts
- [ ] Search endpoint (`GET /search?q=...`)
- [ ] MCP server mode for AI agents

## Security Notes

- **Never use `feeling-lucky` in production**
- **Always use TLS** (HTTPS) for bearer token auth
- **Rotate API tokens** every 90 days
- **Monitor audit logs** for suspicious patterns
- **Use IP whitelist** when possible
