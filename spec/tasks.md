# Tasks: HTTP Secrets Server

**Status:** In Progress
**Updated:** 2026-02-04

---

## Task #5: Write specification ✅ IN PROGRESS

**Owner:** Current session
**Started:** 2026-02-04 21:16
**Status:** In progress

**Description:**
Document the full specification for the vaultwarden-secrets HTTP server including security profiles, authentication methods, middleware requirements, API endpoints, and deployment strategy.

**Deliverables:**
- [x] spec/spec.md - Complete technical specification
- [x] spec/plan.md - Implementation plan
- [x] spec/tasks.md - This file

**Next:** Mark complete and move to task #2

---

## Task #2: Implement core middleware layer

**Dependencies:** Task #5 complete
**Estimated:** 2 hours

**Description:**
Build reusable middleware components for security layers.

**Components to implement:**
1. `server/middleware/ip-whitelist.ts`
   - Parse CIDR notation
   - Validate client IP against ranges
   - Return 403 if not whitelisted

2. `server/middleware/audit-logger.ts`
   - Support 5 logging levels (none/basic/standard/detailed/forensic)
   - Log to console + file
   - JSON line format
   - Fields: timestamp, clientId, IP, method, path, status, duration

3. `server/middleware/bearer-auth.ts`
   - Load API tokens from `API_TOKEN_<CLIENT>` env vars
   - Validate `Authorization: Bearer <token>` header
   - Map token → client ID
   - Store client ID in context
   - Return 401 if invalid

4. `server/middleware/rate-limit.ts`
   - Sliding window algorithm
   - Per-client tracking (by client ID or IP)
   - Configurable: requests/window + burst
   - Return 429 if exceeded

**Utilities needed:**
- `server/utils/network.ts` - Get client IP from request

**Acceptance criteria:**
- [ ] All middleware files created
- [ ] Each middleware independently testable
- [ ] Type-safe with proper Context/Next signatures
- [ ] Error handling for edge cases

---

## Task #3: Build profile-based server composition

**Dependencies:** Task #2 complete
**Estimated:** 1 hour

**Description:**
Update server/main.ts to dynamically compose middleware based on selected security profile.

**Changes:**
1. Read `SECURITY_PROFILE` env var (default: im-aware)
2. Load profile from `profiles.ts`
3. Validate profile requirements:
   - im-aware: Check `API_TOKEN_*` env vars exist
   - im-a-dev: Check OAuth config (future)
   - openclaw: Check TLS cert, allowed certs (future)
4. Apply middleware based on profile config:
   ```typescript
   if (profile.ipWhitelist) app.use('*', ipWhitelist([...]));
   if (profile.auth === 'bearer') app.use('*', bearerAuth({...}));
   if (profile.rateLimit) app.use('*', rateLimit(...));
   app.use('*', auditLogger(profile.audit));
   ```
5. Log active configuration on startup

**Acceptance criteria:**
- [ ] Server applies correct middleware for each profile
- [ ] Profile validation prevents startup if requirements missing
- [ ] Clear error messages for config issues
- [ ] Startup log shows active security layers

---

## Task #4: Enhance build-release.sh for server deployment

**Dependencies:** Task #3 complete
**Estimated:** 1 hour

**Description:**
Update tarball builder to include server components and deployment templates.

**Changes to build-release.sh:**
1. Include `server/` directory
2. Copy deployment templates:
   - `deploy/systemd/vw-secrets.service`
   - `deploy/nginx/secrets.conf`
   - `deploy/DEPLOY.md`

**Files to create:**

### deploy/systemd/vw-secrets.service
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
Environment="PORT=3000"
ExecStart=/usr/local/bin/bun run server/main.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### deploy/nginx/secrets.conf
```nginx
server {
    listen 443 ssl http2;
    server_name secrets.rodaddy.live;
    ssl_certificate /etc/nginx/certs/secrets.rodaddy.live.crt;
    ssl_certificate_key /etc/nginx/certs/secrets.rodaddy.live.key;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### deploy/DEPLOY.md
- Prerequisites checklist
- Token generation guide
- systemd setup steps
- nginx configuration
- Health check verification
- Client usage examples

**Acceptance criteria:**
- [ ] Tarball includes all server files
- [ ] Templates are ready-to-use
- [ ] Deployment guide is complete
- [ ] Can deploy to test LXC successfully

---

## Task #1: Create deployment documentation

**Dependencies:** Task #4 complete
**Estimated:** 30 minutes

**Description:**
Write comprehensive documentation for deploying to LXC infrastructure.

**Files:**
- `server/README.md` - Server usage, profiles, API reference
- `deploy/DEPLOY.md` - Step-by-step deployment guide

**Topics to cover:**
- Prerequisites (bun, bw CLI)
- Profile selection guide
- Environment variable reference
- systemd service setup
- nginx reverse proxy setup
- Health checking
- Troubleshooting
- Client examples

**Acceptance criteria:**
- [ ] Documentation complete and accurate
- [ ] Tested on actual LXC deployment
- [ ] Client examples all work

---

## Task #6: Test each security profile

**Dependencies:** All above tasks complete
**Estimated:** 1 hour

**Description:**
Create comprehensive test suite for all implemented profiles.

**Test script:** `server/test-profiles.sh`

**Tests:**

### feeling-lucky
- [ ] Server starts without auth config
- [ ] `/health` returns 200
- [ ] `/secret/Test` works without auth
- [ ] No rate limiting enforced
- [ ] Audit log writes to console only

### im-aware
- [ ] Requires `API_TOKEN_*` env vars
- [ ] Missing auth header → 401
- [ ] Invalid token → 401
- [ ] Valid token → 200
- [ ] IP outside VLAN → 403 (simulated)
- [ ] IP inside VLAN → 200
- [ ] Rate limit: 101st request → 429
- [ ] Audit log writes to file

**Integration tests:**
- [ ] GET /health (all profiles)
- [ ] GET /vaults (with auth)
- [ ] GET /secret/:name (with auth)
- [ ] Query params work (?vault=work)
- [ ] URL encoding works (spaces, special chars)

**Acceptance criteria:**
- [ ] Test script runs all tests
- [ ] All tests pass
- [ ] Clear pass/fail reporting
- [ ] Easy to run in CI

---

## Progress Tracking

| Task | Status | Owner | Est. | Actual |
|------|--------|-------|------|--------|
| #5 | ✅ IN PROGRESS | Current | 30m | - |
| #2 | Pending | - | 2h | - |
| #3 | Pending | - | 1h | - |
| #4 | Pending | - | 1h | - |
| #1 | Pending | - | 30m | - |
| #6 | Pending | - | 1h | - |

**Total estimated:** 6 hours
**Total actual:** TBD

---

## Definition of Done

Project is complete when:
- [x] Specification written
- [ ] All middleware implemented
- [ ] Server composes profiles correctly
- [ ] Deployment tarball includes all files
- [ ] Documentation complete
- [ ] All tests pass
- [ ] Successfully deployed to LXC 200 (postgres)
- [ ] Client usage verified
