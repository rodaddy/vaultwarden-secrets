# Deployment Guide - Vaultwarden Secrets Server

Step-by-step guide for deploying the HTTP secrets server to production.

> **Retired deployment trigger:** The unauthenticated automatic network deploy
> trigger that listened on port 3002 has been removed and must not be restored.
> Replacement release automation is deferred to issues #14 and #15. The active
> MCP service on port 3001 is preserved and is not retired by this change.
> On every run, `deploy/deploy.sh` disables, stops, and removes the exact
> retired `vw-deploy-webhook.service` copy, then reloads systemd before checking
> for source changes. When changes are present, it restarts only the protected
> MCP service on port 3001; the port-3000 and port-3003 services remain
> contained until the hard reactivation gate is approved.

## Prerequisites

- Bun runtime installed (`curl -fsSL https://bun.sh/install | bash`)
- Vaultwarden CLI configured and authenticated
- systemd-based Linux system (Ubuntu, Debian, RHEL, etc.)
- nginx or similar reverse proxy (for HTTPS termination)

## Deployment Steps

### 1. Extract Release Tarball

```bash
# On target server
cd /opt
sudo tar xzf vaultwarden-secrets-v*.tar.gz
sudo mv vaultwarden-secrets-v* vaultwarden-secrets
```

### 2. Create Service User

```bash
# Create dedicated user (no shell access)
sudo useradd -r -s /usr/sbin/nologin vw-secrets

# Set ownership
sudo chown -R vw-secrets:vw-secrets /opt/vaultwarden-secrets
```

### 3. Configure Environment

```bash
# Copy environment template
cd /opt/vaultwarden-secrets
sudo cp deploy/env.example .env

# Edit configuration
sudo nano .env
```

**Required configuration:**

```bash
# Choose security profile
SECURITY_PROFILE=im-aware  # or im-a-dev, openclaw

# Generate bearer tokens for each client
# Use: openssl rand -base64 32
API_TOKEN_LXC200=<generated-token>
API_TOKEN_LXC202=<generated-token>
API_TOKEN_GRAFANA=<generated-token>

# Set to production
NODE_ENV=production

# Optional: Override IP whitelist
# IP_WHITELIST=10.0.0.0/8,172.17.0.0/16
```

**Secure the .env file:**

```bash
sudo chmod 600 .env
sudo chown vw-secrets:vw-secrets .env
```

### 4. Install systemd Service

```bash
# Copy service file
sudo cp /opt/vaultwarden-secrets/deploy/systemd/vaultwarden-secrets.service \
  /etc/systemd/system/

# Edit service (adjust paths/tokens as needed)
sudo nano /etc/systemd/system/vaultwarden-secrets.service

# Reload systemd
sudo systemctl daemon-reload

# Enable service (start on boot)
sudo systemctl enable vaultwarden-secrets

# Start service
sudo systemctl start vaultwarden-secrets

# Check status
sudo systemctl status vaultwarden-secrets
```

**Service configuration notes:**

- **User:** Change `User=vw-secrets` if using different user
- **WorkingDirectory:** Update if installed in different location
- **Environment variables:** Can be set in service file OR use `.env` file
- **ExecStart:** Verify bun path (`which bun`) matches `/usr/local/bin/bun`

### 5. Configure nginx Reverse Proxy

The server runs on HTTP (localhost:3000). Use nginx for HTTPS termination.

```bash
# Copy nginx config template
sudo cp /opt/vaultwarden-secrets/deploy/nginx/secrets.conf \
  /etc/nginx/sites-available/secrets.conf

# Edit configuration
sudo nano /etc/nginx/sites-available/secrets.conf
```

**Update the following:**

```nginx
server_name secrets.example.com;  # Your domain
ssl_certificate /etc/nginx/certs/secrets.example.com.crt;
ssl_certificate_key /etc/nginx/certs/secrets.example.com.key;
```

**Enable site and restart nginx:**

```bash
# Create symlink
sudo ln -s /etc/nginx/sites-available/secrets.conf \
  /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Reload nginx
sudo systemctl reload nginx
```

### 6. Verify Deployment

```bash
# Check service logs
sudo journalctl -u vaultwarden-secrets -f

# Test health endpoint (local)
curl http://localhost:3000/health

# Test health endpoint (via nginx)
curl https://secrets.example.com/health

# Test secret retrieval (with bearer token)
curl -H "Authorization: Bearer <API_TOKEN_LXC200>" \
  https://secrets.example.com/secret/TestSecret
```

**Expected health response:**

```json
{
  "status": "ok",
  "profile": "I'm Aware",
  "timestamp": "2026-02-04T..."
}
```

## Security Checklist

Before going to production, verify:

- [ ] **Profile:** NOT using `feeling-lucky` profile
- [ ] **NODE_ENV:** Set to `production`
- [ ] **HTTPS:** nginx configured with valid TLS certificates
- [ ] **Tokens:** Bearer tokens are cryptographically random (32+ bytes)
- [ ] **File permissions:** `.env` is mode 600, owned by service user
- [ ] **Service user:** Running as non-root user with no shell access
- [ ] **Firewall:** Port 3000 blocked from external access (nginx only)
- [ ] **IP whitelist:** Configured for your internal network
- [ ] **Vaultwarden:** Session token configured and valid
- [ ] **Logs:** systemd journal accessible for audit (`journalctl -u vaultwarden-secrets`)

## Client Configuration

Clients need to authenticate with bearer tokens:

```bash
# Example: curl
curl -H "Authorization: Bearer <token>" \
  https://secrets.example.com/secret/MyPassword

# Example: Python
import requests
headers = {"Authorization": "Bearer <token>"}
r = requests.get("https://secrets.example.com/secret/MyPassword", headers=headers)

# Example: Node.js
const response = await fetch("https://secrets.example.com/secret/MyPassword", {
  headers: { "Authorization": "Bearer <token>" }
});
```

## Monitoring

### Service Health

```bash
# Check if running
sudo systemctl is-active vaultwarden-secrets

# View recent logs
sudo journalctl -u vaultwarden-secrets -n 100

# Follow logs in real-time
sudo journalctl -u vaultwarden-secrets -f
```

### nginx Access Logs

```bash
# Monitor access
sudo tail -f /var/log/nginx/access.log | grep secrets

# Check for errors
sudo tail -f /var/log/nginx/error.log
```

## Maintenance

### Updating the Server

```bash
# Download new release
cd /tmp
wget https://github.com/yourusername/vaultwarden-secrets/releases/download/vX.Y.Z/vaultwarden-secrets-vX.Y.Z.tar.gz

# Stop service
sudo systemctl stop vaultwarden-secrets

# Backup current installation
sudo cp -r /opt/vaultwarden-secrets /opt/vaultwarden-secrets.backup

# Extract new version
cd /opt
sudo tar xzf /tmp/vaultwarden-secrets-vX.Y.Z.tar.gz
sudo mv vaultwarden-secrets-vX.Y.Z vaultwarden-secrets

# Restore configuration
sudo cp /opt/vaultwarden-secrets.backup/.env /opt/vaultwarden-secrets/

# Fix permissions
sudo chown -R vw-secrets:vw-secrets /opt/vaultwarden-secrets

# Start service
sudo systemctl start vaultwarden-secrets

# Verify
curl http://localhost:3000/health
```

### Token Rotation

Rotate bearer tokens every 90 days:

```bash
# Generate new token
openssl rand -base64 32

# Update .env
sudo nano /opt/vaultwarden-secrets/.env
# Or update systemd service Environment variables

# Restart service
sudo systemctl restart vaultwarden-secrets

# Update client configurations with new token
```

## Troubleshooting

### Service won't start

```bash
# Check logs
sudo journalctl -u vaultwarden-secrets -n 50

# Verify bun installation
which bun
bun --version

# Check file permissions
ls -la /opt/vaultwarden-secrets
```

### 403 Forbidden errors

- Verify bearer token is correct
- Check IP whitelist configuration
- Review nginx proxy headers

### Connection errors

```bash
# Verify service is listening
sudo netstat -tulpn | grep 3000

# Check firewall rules
sudo ufw status

# Test local connection
curl http://localhost:3000/health
```

### Vaultwarden session expired

```bash
# Re-authenticate as service user
sudo -u vw-secrets bw login
sudo -u vw-secrets bw unlock

# Or configure session token in environment
```

## Advanced Configurations

### High Availability Setup

For redundancy, run multiple instances behind a load balancer:

```nginx
upstream secrets_backend {
    server 10.0.1.10:3000;
    server 10.0.1.11:3000;
    server 10.0.1.12:3000;
}

server {
    listen 443 ssl;
    server_name secrets.example.com;

    location / {
        proxy_pass http://secrets_backend;
    }
}
```

### Rate Limiting (nginx)

```nginx
limit_req_zone $binary_remote_addr zone=secrets:10m rate=10r/s;

server {
    location / {
        limit_req zone=secrets burst=20;
        proxy_pass http://localhost:3000;
    }
}
```

### Docker Deployment

```dockerfile
FROM oven/bun:latest

WORKDIR /app
COPY . .

RUN bun install --production

USER bun
EXPOSE 3000

CMD ["bun", "run", "server/main.ts"]
```

```yaml
# docker-compose.yml
version: '3.8'
services:
  secrets:
    build: .
    ports:
      - "3000:3000"
    environment:
      - SECURITY_PROFILE=im-aware
      - API_TOKEN_CLIENT1=${API_TOKEN_CLIENT1}
      - NODE_ENV=production
    restart: unless-stopped
```

## Support

For issues or questions:
- GitHub Issues: https://github.com/yourusername/vaultwarden-secrets/issues
- Documentation: server/README.md
