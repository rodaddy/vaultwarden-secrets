# Implementation Plan: HTTP Secrets Server

> **Historical planning document.** This predates the built system and is kept for provenance. For current behavior see README.md and docs/.

**Project:** vaultwarden-secrets HTTP API
**Version:** 0.6.0 (next release)
**Date:** 2026-02-04

---

## Implementation Strategy

### Phased Approach

We'll implement profiles incrementally:
1. **Phase 1:** feeling-lucky + im-aware (80% use case)
2. **Phase 2:** Deployment tooling
3. **Phase 3:** im-a-dev + openclaw (future enhancement)

**Rationale:** Get working server deployed to LXCs quickly, add advanced profiles later.

---

## Phase 1: Core Server (Current Sprint)

### 1.1 Middleware Layer

**File:** `server/middleware/`

**Components:**
- `ip-whitelist.ts` - CIDR range validation
- `bearer-auth.ts` - API token validation
- `rate-limit.ts` - Sliding window rate limiter
- `audit-logger.ts` - Structured logging with levels

**Implementation order:**
1. IP whitelist (simplest, no state)
2. Audit logger (needed for all profiles)
3. Bearer auth (loads from env vars)
4. Rate limiter (in-memory, single-instance OK)

**Acceptance criteria:**
- Each middleware is independently testable
- Middleware composes cleanly (no order dependencies)
- All middleware respects Hono's Context/Next pattern

---

### 1.2 Profile Composition

**File:** `server/main.ts`

**Changes:**
1. Read `SECURITY_PROFILE` env var
2. Load profile config from `profiles.ts`
3. Validate profile requirements (tokens, TLS, etc.)
4. Apply middleware based on profile settings
5. Log active security configuration on startup

**Middleware application logic:**
```typescript
if (profile.ipWhitelist) {
  app.use('*', ipWhitelist(['10.71.20.0/24']));
}

if (profile.auth === 'bearer') {
  const tokens = loadBearerTokens();
  app.use('*', bearerAuth({ tokens }));
}

if (profile.rateLimit) {
  app.use('*', rateLimit(profile.rateLimit));
}

app.use('*', auditLogger(profile.audit));
```

**Acceptance criteria:**
- Server starts with correct middleware for selected profile
- Invalid profile selection shows clear error
- Missing requirements (e.g., no API tokens for im-aware) blocks startup

---

### 1.3 Testing

**File:** `server/test-profiles.sh`

**Test matrix:**
| Profile | Auth Test | IP Test | Rate Limit | Audit Log |
|---------|-----------|---------|------------|-----------|
| feeling-lucky | N/A (no auth) | ❌ | ❌ | Console only |
| im-aware | ✅ Bearer | ✅ CIDR | ✅ 100/min | File + console |

**Test script flow:**
```bash
#!/usr/bin/env bash

# Test 1: feeling-lucky (no auth)
SECURITY_PROFILE=feeling-lucky bun run server &
sleep 2
curl http://localhost:3000/secret/Test  # Should work
kill %1

# Test 2: im-aware (bearer auth)
export API_TOKEN_TEST="test-token-123"
SECURITY_PROFILE=im-aware bun run server &
sleep 2
curl http://localhost:3000/secret/Test  # Should fail (401)
curl -H "Authorization: Bearer test-token-123" http://localhost:3000/secret/Test  # Should work
kill %1
```

**Acceptance criteria:**
- All profiles start successfully
- Auth enforcement works as expected
- IP whitelist blocks external IPs (simulated)
- Rate limiting triggers after threshold

---

## Phase 2: Deployment Tooling

### 2.1 Enhanced Installer

**File:** `build-release.sh`

**Changes:**
1. Include `server/` directory in tarball
2. Add `deploy/systemd/vw-secrets.service` template
3. Add `deploy/nginx/secrets.conf` template
4. Add `deploy/DEPLOY.md` guide

**Tarball structure:**
```
vaultwarden-secrets-v0.6.0/
├── Core library files...
├── server/                      # HTTP server
│   ├── main.ts
│   ├── profiles.ts
│   ├── middleware/
│   │   ├── ip-whitelist.ts
│   │   ├── bearer-auth.ts
│   │   ├── rate-limit.ts
│   │   └── audit-logger.ts
│   ├── utils/
│   │   └── network.ts
│   └── README.md
├── deploy/
│   ├── systemd/vw-secrets.service
│   ├── nginx/secrets.conf
│   └── DEPLOY.md
└── install.sh
```

**Acceptance criteria:**
- Tarball contains all necessary files
- Templates are ready to use (minimal editing)
- Deployment guide is complete and tested

---

### 2.2 systemd Service Template

**File:** `deploy/systemd/vw-secrets.service`

```ini
[Unit]
Description=Vaultwarden Secrets HTTP Server
After=network.target

[Service]
Type=simple
User=vw-secrets
WorkingDirectory=/opt/vaultwarden-secrets
Environment="SECURITY_PROFILE=im-aware"
Environment="API_TOKEN_LXC200=REPLACE_ME"
Environment="API_TOKEN_LXC202=REPLACE_ME"
Environment="PORT=3000"
ExecStart=/usr/local/bin/bun run server/main.ts
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

**Installation:**
```bash
cp deploy/systemd/vw-secrets.service /etc/systemd/system/
# Edit tokens
systemctl daemon-reload
systemctl enable --now vw-secrets
```

---

### 2.3 nginx Reverse Proxy

**File:** `deploy/nginx/secrets.conf`

```nginx
server {
    listen 443 ssl http2;
    server_name secrets.rodaddy.live;

    ssl_certificate /etc/nginx/certs/secrets.rodaddy.live.crt;
    ssl_certificate_key /etc/nginx/certs/secrets.rodaddy.live.key;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts
        proxy_connect_timeout 5s;
        proxy_send_timeout 10s;
        proxy_read_timeout 10s;
    }

    # Health check (no auth required)
    location /health {
        proxy_pass http://localhost:3000/health;
        access_log off;
    }
}
```

**Installation:**
```bash
cp deploy/nginx/secrets.conf /etc/nginx/sites-available/
ln -s /etc/nginx/sites-available/secrets.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

---

### 2.4 LXC Deployment Guide

**File:** `deploy/DEPLOY.md`

**Sections:**
1. Prerequisites (bun, bw CLI, vault session)
2. Tarball extraction
3. API token generation
4. Environment configuration
5. Service installation
6. nginx configuration
7. Health check verification
8. Client usage examples

---

## Phase 3: Advanced Profiles (Future)

### 3.1 OAuth2 Integration (im-a-dev)

**Dependencies:**
- OAuth2 provider (Auth0, Keycloak, or custom)
- Hono OAuth middleware (or custom implementation)

**Implementation:**
1. OAuth2 authorization flow
2. Token validation
3. Token refresh mechanism
4. User-based audit logging

**Estimated effort:** 1-2 weeks

---

### 3.2 mTLS + JWT (openclaw)

**Dependencies:**
- Client certificate generation scripts
- JWT library (jose, jsonwebtoken)
- Certificate pinning storage

**Implementation:**
1. mTLS certificate validation
2. Certificate fingerprint checking
3. JWT generation/validation
4. Response encryption (double-wrapped)
5. Anomaly detection

**Estimated effort:** 2-3 weeks

---

## Risk Analysis

### Technical Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Rate limiter memory leak | High | Low | Use proven library or Redis backend |
| Audit log fills disk | Medium | Medium | Implement log rotation |
| IP whitelist edge cases | Low | Medium | Comprehensive test coverage |

### Deployment Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Token distribution security | High | Medium | Document secure distribution methods |
| systemd service fails | Medium | Low | Test on multiple distros |
| nginx config conflicts | Low | Low | Use unique server_name |

---

## Success Criteria

### Phase 1 Complete When:
- ✅ feeling-lucky profile works (no auth)
- ✅ im-aware profile works (bearer + IP whitelist)
- ✅ Rate limiting enforced
- ✅ Audit logging to file
- ✅ All tests pass

### Phase 2 Complete When:
- ✅ Tarball builds successfully
- ✅ LXC 200 (postgres) using server
- ✅ systemd service running
- ✅ nginx reverse proxy working
- ✅ Health checks passing

### Phase 3 Complete When:
- ✅ im-a-dev profile functional
- ✅ openclaw profile functional
- ✅ Production deployment guide complete

---

## Timeline (Estimated)

- **Phase 1:** 2-3 hours (middleware + composition)
- **Phase 2:** 1-2 hours (deployment tooling)
- **Testing:** 1 hour
- **Total:** 4-6 hours for MVP

**Phase 3:** Future enhancement (2-4 weeks)

---

## Next Steps

1. Mark task #5 (spec) complete ✅
2. Start task #2 (middleware implementation)
3. Implement in order: IP whitelist → Audit logger → Bearer auth → Rate limiter
4. Test each middleware independently
5. Move to task #3 (profile composition)
