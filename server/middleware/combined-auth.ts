/**
 * Combined mTLS + JWT authentication middleware
 * Defense in depth: Both layers must pass for request to proceed
 *
 * Security model:
 * 1. mTLS validates WHO the client is (certificate fingerprint)
 * 2. JWT validates WHAT the client can do (scopes, expiry)
 *
 * Both must pass. Either failing = 401/403.
 */

import { type Context, type MiddlewareHandler } from 'hono';
import { mtlsAuth, type MTLSConfig, loadAllowedFingerprints } from './mtls-auth';
import { jwtAuth, type JWTAuthConfig } from './jwt-auth';

export interface CombinedAuthConfig {
  mtls: MTLSConfig;
  jwt?: JWTAuthConfig;
}

/**
 * Combined authentication middleware
 * Applies both mTLS and JWT validation in sequence
 */
export function combinedAuth(config: CombinedAuthConfig): MiddlewareHandler {
  // Create individual middleware instances
  const mtlsMiddleware = mtlsAuth(config.mtls);
  const jwtMiddleware = jwtAuth(config.jwt);

  return async (c: Context, next) => {
    // Skip auth for /health and /auth endpoints
    const path = c.req.path;
    if (path === '/health' || path.startsWith('/auth/')) {
      return next();
    }

    // Layer 1: mTLS validation
    let mtlsPassed = false;
    const mtlsResult = await mtlsMiddleware(c, async () => {
      mtlsPassed = true;
    });

    // If mTLS failed, return error immediately
    if (!mtlsPassed) {
      logSecurityEvent(c, 'mtls_failed', { path });
      return mtlsResult;
    }

    // Layer 2: JWT validation
    let jwtPassed = false;
    const jwtResult = await jwtMiddleware(c, async () => {
      jwtPassed = true;
    });

    // If JWT failed, return error immediately
    if (!jwtPassed) {
      logSecurityEvent(c, 'jwt_failed', {
        path,
        clientFingerprint: c.get('clientFingerprint'),
      });
      return jwtResult;
    }

    // Both passed - log success and proceed
    logSecurityEvent(c, 'auth_success', {
      path,
      clientId: c.get('clientId'),
      clientFingerprint: c.get('clientFingerprint'),
      scopes: c.get('scopes'),
    });

    return next();
  };
}

/**
 * Log security events for forensic audit
 */
function logSecurityEvent(
  c: Context,
  event: 'mtls_failed' | 'jwt_failed' | 'auth_success',
  details: Record<string, unknown>
): void {
  const timestamp = new Date().toISOString();
  const ip = c.req.header('X-Forwarded-For') || c.req.header('X-Real-IP') || 'unknown';

  const logEntry = {
    timestamp,
    event,
    ip,
    userAgent: c.req.header('User-Agent'),
    ...details,
  };

  // Log to console (captured by systemd/logging system)
  console.log(`[SECURITY] ${JSON.stringify(logEntry)}`);

  // If audit file is configured, append there too (fire-and-forget)
  const auditFile = process.env.AUDIT_LOG_FILE;
  if (auditFile) {
    const logLine = JSON.stringify(logEntry) + '\n';
    import('fs').then(fs => {
      fs.appendFile(auditFile, logLine, (err) => {
        if (err) console.error('[SECURITY] Failed to write audit log:', err);
      });
    });
  }
}

/**
 * Create combined auth middleware with smart defaults
 * Loads fingerprints from env/config, uses sensible JWT requirements
 */
export async function createCombinedAuth(overrides?: Partial<CombinedAuthConfig>): Promise<MiddlewareHandler> {
  const allowedFingerprints = await loadAllowedFingerprints();

  if (allowedFingerprints.length === 0) {
    console.error('❌ No allowed certificate fingerprints configured!');
    console.error('   Set via: export ALLOWED_CERT_FINGERPRINTS=sha256:abc...,sha256:def...');
    console.error('   Or set: export ALLOWED_CLIENT_CERTS=/path/to/certs.json');
    process.exit(1);
  }

  const config: CombinedAuthConfig = {
    mtls: {
      allowedFingerprints,
      mode: process.env.MTLS_MODE === 'direct' ? 'direct' : 'proxy',
      headerName: process.env.MTLS_HEADER || 'X-Client-Cert-Fingerprint',
    },
    jwt: {
      requireScopes: ['read:secrets'],
    },
    ...overrides,
  };

  console.log(`  ✓ mTLS: ${allowedFingerprints.length} fingerprint(s), mode=${config.mtls.mode}`);
  console.log(`  ✓ JWT: Required scopes=${config.jwt?.requireScopes?.join(',') || 'none'}`);

  return combinedAuth(config);
}
