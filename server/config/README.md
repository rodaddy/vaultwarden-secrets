# OAuth2 Configuration

## Overview

The `im-a-dev` security profile uses OAuth2 client credentials flow for authentication.

## Configuration Options

### Option 1: Environment Variables (Simple)

For single-client setups:

```bash
export OAUTH_CLIENT_ID="my-client-id"
export OAUTH_CLIENT_SECRET="my-secret-key"
export JWT_SECRET="random-secret-for-jwt-signing"
```

### Option 2: Clients File (Multiple Clients)

For multiple clients, create a `clients.json` file:

```json
{
  "clients": [
    {
      "id": "client-1",
      "secret": "secure-secret-1",
      "name": "Production App"
    },
    {
      "id": "client-2",
      "secret": "secure-secret-2",
      "name": "Development App"
    }
  ]
}
```

Then set the path:

```bash
export OAUTH_CLIENTS_FILE="/path/to/clients.json"
export JWT_SECRET="random-secret-for-jwt-signing"
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | No | `default-jwt-secret-change-in-production` | Secret for signing JWTs (HS256) |
| `OAUTH_CLIENT_ID` | No* | - | Single client ID |
| `OAUTH_CLIENT_SECRET` | No* | - | Single client secret |
| `OAUTH_CLIENTS_FILE` | No* | - | Path to clients.json |

\* Either `OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET` OR `OAUTH_CLIENTS_FILE` must be set.

## Token Specifications

### Access Token
- **Expiration:** 15 minutes (900 seconds)
- **Algorithm:** HS256
- **Payload:**
  ```json
  {
    "sub": "client-id",
    "scope": "secrets:read",
    "type": "access",
    "iss": "vaultwarden-secrets",
    "iat": 1234567890,
    "exp": 1234568790
  }
  ```

### Refresh Token
- **Expiration:** 7 days (604800 seconds)
- **Algorithm:** HS256
- **Payload:**
  ```json
  {
    "sub": "client-id",
    "type": "refresh",
    "iss": "vaultwarden-secrets",
    "iat": 1234567890,
    "exp": 1235172690
  }
  ```

## API Usage

### 1. Get Initial Tokens (Client Credentials)

```bash
curl -X POST http://localhost:3000/auth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=my-client&client_secret=my-secret"
```

**Response:**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 900,
  "scope": "secrets:read"
}
```

### 2. Use Access Token

```bash
curl http://localhost:3000/secret/MySecret \
  -H "Authorization: Bearer <access_token>"
```

### 3. Refresh Tokens

```bash
curl -X POST http://localhost:3000/auth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token&refresh_token=<refresh_token>"
```

**Response:**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 900,
  "scope": "secrets:read"
}
```

## Security Best Practices

1. **JWT Secret:** Use a strong random secret (at least 32 characters)
   ```bash
   export JWT_SECRET="$(openssl rand -base64 32)"
   ```

2. **Client Secrets:** Use strong random secrets for each client
   ```bash
   openssl rand -base64 32
   ```

3. **TLS:** Always use TLS in production (required by `im-a-dev` profile)
   ```bash
   export TLS_CERT="/path/to/cert.pem"
   export TLS_KEY="/path/to/key.pem"
   ```

4. **File Permissions:** Protect `clients.json` file
   ```bash
   chmod 600 /path/to/clients.json
   ```

5. **Rotate Secrets:** Regularly rotate JWT_SECRET and client secrets

## Example Setup

```bash
#!/usr/bin/env bash

# Generate JWT secret
export JWT_SECRET="$(openssl rand -base64 32)"

# Set client credentials
export OAUTH_CLIENT_ID="my-app"
export OAUTH_CLIENT_SECRET="$(openssl rand -base64 32)"

# Set TLS certificates (required for im-a-dev profile)
export TLS_CERT="/etc/ssl/certs/server.crt"
export TLS_KEY="/etc/ssl/private/server.key"

# Start server
bun run server/main.ts
```

## Troubleshooting

### "No OAuth2 clients configured!"

Ensure either:
- `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` are set, OR
- `OAUTH_CLIENTS_FILE` points to valid JSON file

### "Token verification failed"

- Check JWT_SECRET matches between token generation and verification
- Ensure token hasn't expired (15 min for access, 7 days for refresh)
- Verify token type (access token for API calls, refresh token for /auth/token)

### "Invalid client credentials"

- Verify client_id exists in clients map
- Verify client_secret matches exactly (case-sensitive)

## Testing

Run OAuth2 tests:
```bash
bun test server/__tests__/oauth2.test.ts
```
