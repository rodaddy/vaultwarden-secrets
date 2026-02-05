/**
 * mTLS authentication middleware
 * Validates client certificates against an allowlist of fingerprints
 *
 * Note: Bun's TLS support doesn't directly expose client cert info in request context.
 * This middleware supports two modes:
 * 1. Direct Bun mode: Requires Bun.serve({ tls: { requestCert: true } })
 * 2. Reverse proxy mode: Reads X-Client-Cert-Fingerprint header from nginx/haproxy
 */

import { type Context, type MiddlewareHandler } from 'hono';

export interface ClientCertInfo {
  fingerprint: string;
  subject?: string;
  issuer?: string;
  validFrom?: Date;
  validTo?: Date;
}

export interface MTLSConfig {
  allowedFingerprints: string[];
  mode?: 'direct' | 'proxy';
  headerName?: string; // For proxy mode, default: X-Client-Cert-Fingerprint
}


/**
 * Extract client certificate info from Bun TLS connection
 * Returns null if no certificate or Bun doesn't expose the cert
 */
function extractClientCert(_c: Context): ClientCertInfo | null {
  // Bun currently doesn't expose client cert in request context
  // This is a placeholder for when Bun adds support
  // For now, this will always return null in direct mode

  // Future Bun API (hypothetical):
  // const tlsInfo = c.env?.tlsInfo;
  // if (tlsInfo?.clientCert) {
  //   return {
  //     fingerprint: calculateFingerprint(tlsInfo.clientCert.raw),
  //     subject: tlsInfo.clientCert.subject,
  //     issuer: tlsInfo.clientCert.issuer,
  //   };
  // }

  return null;
}

/**
 * Extract client certificate fingerprint from reverse proxy header
 */
function extractProxyFingerprint(c: Context, headerName: string): string | null {
  const fingerprint = c.req.header(headerName);
  if (!fingerprint) {
    return null;
  }

  // Normalize format: accept both "sha256:abc..." and "abc...", and normalize case
  const normalized = fingerprint.toLowerCase().trim();
  if (normalized.startsWith('sha256:')) {
    return normalized;
  }
  return `sha256:${normalized}`;
}

/**
 * mTLS authentication middleware
 * Validates client certificate fingerprint against allowlist
 */
export function mtlsAuth(config: MTLSConfig): MiddlewareHandler {
  const mode = config.mode || 'proxy';
  const headerName = config.headerName || 'X-Client-Cert-Fingerprint';

  return async (c: Context, next) => {
    // Skip auth for /health and /auth endpoints
    const path = c.req.path;
    if (path === '/health' || path.startsWith('/auth/')) {
      return next();
    }

    let certInfo: ClientCertInfo | null = null;

    // Try to extract certificate info based on mode
    if (mode === 'direct') {
      certInfo = extractClientCert(c);
    } else if (mode === 'proxy') {
      const fingerprint = extractProxyFingerprint(c, headerName);
      if (fingerprint) {
        certInfo = { fingerprint };
      }
    }

    // No certificate provided
    if (!certInfo || !certInfo.fingerprint) {
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'Client certificate required',
          hint: mode === 'direct'
            ? 'Configure Bun with TLS client cert validation'
            : `Missing ${headerName} header from reverse proxy`,
        },
        401
      );
    }

    // Validate fingerprint against allowlist
    const fingerprint = certInfo.fingerprint.toLowerCase();
    const allowed = config.allowedFingerprints.map(fp => fp.toLowerCase());

    if (!allowed.includes(fingerprint)) {
      // Log the rejected fingerprint for debugging
      console.warn(`[mTLS] Rejected certificate: ${fingerprint}`);

      return c.json(
        {
          error: 'forbidden',
          error_description: 'Client certificate not authorized',
          fingerprint: fingerprint.slice(0, 16) + '...', // Show prefix for debugging
        },
        403
      );
    }

    // Certificate is valid - attach to context for downstream use
    c.set('clientCert', certInfo);
    c.set('clientFingerprint', fingerprint);

    return next();
  };
}

/**
 * Load allowed certificate fingerprints from config
 *
 * Config format:
 * {
 *   "allowedFingerprints": [
 *     "sha256:abc123...",
 *     "sha256:def456..."
 *   ]
 * }
 *
 * Or environment variable:
 * ALLOWED_CERT_FINGERPRINTS=sha256:abc123...,sha256:def456...
 */
export async function loadAllowedFingerprints(): Promise<string[]> {
  // Try environment variable first
  const envFingerprints = process.env.ALLOWED_CERT_FINGERPRINTS;
  if (envFingerprints) {
    return envFingerprints.split(',').map(fp => fp.trim());
  }

  // Try config file
  const configPath = process.env.ALLOWED_CLIENT_CERTS;
  if (configPath) {
    try {
      const configFile = Bun.file(configPath);
      const config = await configFile.json() as { allowedFingerprints: string[] };
      return config.allowedFingerprints || [];
    } catch (error) {
      console.error(`Failed to load certificate config from ${configPath}:`, error);
      return [];
    }
  }

  return [];
}
