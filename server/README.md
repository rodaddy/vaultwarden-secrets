# Vaultwarden Secrets Server

HTTP API for secret retrieval with tiered security profiles.

## Security Profiles

Choose based on your deployment environment:

| Profile | Auth | IP Whitelist | Use Case | Command |
|---------|------|--------------|----------|---------|
| **feeling-lucky** | None | Auto (local /24) | Dev/testing only | `bun run server:dev` |
| **im-aware** | Bearer token | Auto (local /24) | Homelab/internal | `bun run server:prod` |
| **im-a-dev** | OAuth2 | Auto (local /24) | Production web apps | `SECURITY_PROFILE=im-a-dev bun run server` |
| **openclaw** | mTLS + JWT | 127.0.0.1/32 only | Maximum security | `SECURITY_PROFILE=openclaw bun run server` |

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

### 3. Maximum Security (OpenClaw)
```bash
# Set up client certificates
export ALLOWED_CLIENT_CERTS="/path/to/allowed-certs.json"

# Start server
SECURITY_PROFILE=openclaw bun run server

# Test with client cert
curl --cert client.crt --key client.key \
  -H "Authorization: Bearer <jwt-token>" \
  https://secrets.rodaddy.live/secret/MyPassword
```

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

## Roadmap

- [ ] Implement middleware (IP whitelist, rate limiting, audit logging)
- [ ] OAuth2 provider integration
- [ ] mTLS certificate validation
- [ ] Response encryption (double-encrypted secrets)
- [ ] Anomaly detection and alerts
- [ ] Search endpoint (`GET /search?q=...`)
- [ ] MCP server mode for AI agents

## Security Notes

- **Never use `feeling-lucky` in production**
- **Always use TLS** (HTTPS) for bearer token auth
- **Rotate API tokens** every 90 days
- **Monitor audit logs** for suspicious patterns
- **Use IP whitelist** when possible
