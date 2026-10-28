# mTLS + JWT Quick Reference

## One-Time Setup

```bash
# 1. Generate certificates
cd deploy
./generate-certs.sh

# 2. Set environment variables
export SECURITY_PROFILE=openclaw
export ALLOWED_CLIENT_CERTS="/opt/vaultwarden-secrets/tls/certs.json"
export JWT_SECRET="$(openssl rand -hex 32)"

# 3. Start server
bun run server
```

## Making Requests

```bash
# With curl
curl --cert client.crt --key client.key \
  -H "Authorization: Bearer <jwt-token>" \
  https://secrets.local/secret/MyPassword

# Check health (no auth required)
curl https://secrets.local/health
```

## Environment Variables

| Variable | Example | Notes |
|----------|---------|-------|
| `SECURITY_PROFILE` | `openclaw` | Required |
| `ALLOWED_CLIENT_CERTS` | `/opt/.../certs.json` | File path |
| `ALLOWED_CERT_FINGERPRINTS` | `sha256:abc...` | Inline (comma-separated) |
| `JWT_SECRET` | `$(openssl rand -hex 32)` | 32+ bytes random |
| `MTLS_MODE` | `proxy` (default) | `proxy` or `direct` |
| `MTLS_HEADER` | `X-Client-Cert-Fingerprint` | Header name for proxy mode |

## Certificate Format

**Fingerprint extraction:**
```bash
openssl x509 -in client.crt -noout -fingerprint -sha256 | \
  sed 's/://g' | awk -F= '{print "sha256:"tolower($2)}'
```

**Output:** `sha256:1234567890abcdef...`

## certs.json Format

```json
{
  "allowedFingerprints": [
    "sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
  ]
}
```

## nginx Configuration

```nginx
server {
    listen 443 ssl;
    ssl_client_certificate /path/to/ca.crt;
    ssl_verify_client on;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header X-Client-Cert-Fingerprint $ssl_client_fingerprint;
    }
}
```

See `deploy/nginx-mtls.conf` for complete config.

## Security Layers (openclaw)

1. IP Whitelist: 127.0.0.1/32 only
2. mTLS: Certificate fingerprint
3. JWT: Bearer token with scopes
4. Rate Limit: 30 req/min
5. Response Encryption: ECDH + AES-256-GCM
6. Audit Logging: All events logged

## Error Messages

| Status | Error | Cause |
|--------|-------|-------|
| 401 | `Client certificate required` | Missing cert |
| 403 | `Client certificate not authorized` | Fingerprint not in allowlist |
| 401 | `Missing Authorization header` | No JWT |
| 401 | `Token verification failed` | Invalid/expired JWT |
| 403 | `Insufficient scopes` | JWT missing required scopes |

## Testing

```bash
# Run mTLS tests
bun test server/__tests__/mtls.test.ts

# Test server startup
SECURITY_PROFILE=openclaw \
  ALLOWED_CERT_FINGERPRINTS="sha256:test" \
  JWT_SECRET="test" \
  bun run server
```

## Certificate Rotation

1. Generate new cert: `./generate-certs.sh`
2. Add new fingerprint to `certs.json` (keep old)
3. Update clients with new cert
4. Verify new cert works
5. Remove old fingerprint from `certs.json`

## Troubleshooting

**"No allowed certificate fingerprints configured"**
- Set `ALLOWED_CLIENT_CERTS` or `ALLOWED_CERT_FINGERPRINTS`

**"Client certificate not authorized"**
- Check fingerprint format: `sha256:lowercase-hex`
- Verify fingerprint in allowlist

**nginx: "400 No required SSL certificate was sent"**
- Client didn't provide certificate
- Add `--cert` and `--key` to curl

**"Token verification failed: expired"**
- JWT expired (default: 5 minutes)
- Request new token

## Documentation

- Full Setup: [docs/mtls-setup.md](./mtls-setup.md)
- Implementation: [docs/mtls-implementation-summary.md](./mtls-implementation-summary.md)
- Server README: [server/README.md](../server/README.md)

## Example: TypeScript Client

```typescript
import https from 'https';
import fs from 'fs';

const options = {
  hostname: 'secrets.local',
  port: 443,
  path: '/secret/MyPassword',
  method: 'GET',
  cert: fs.readFileSync('/path/to/client.crt'),
  key: fs.readFileSync('/path/to/client.key'),
  ca: fs.readFileSync('/path/to/ca.crt'),
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
  },
};

https.get(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log(JSON.parse(data).value));
});
```

## Production Checklist

- [ ] Use proxy mode (nginx/haproxy)
- [ ] Strong JWT_SECRET (32+ bytes)
- [ ] Secure CA key (offline storage)
- [ ] Certificate rotation policy
- [ ] Audit log monitoring
- [ ] IP whitelist configured
- [ ] TLS 1.2+ only
- [ ] Test failure scenarios

## Support

See full documentation at:
- [docs/mtls-setup.md](./mtls-setup.md)
- [server/README.md](../server/README.md)
