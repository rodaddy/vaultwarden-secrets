/**
 * mTLS authentication tests
 * Tests certificate fingerprint validation and combined auth flow
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import { mtlsAuth, type MTLSConfig } from '../middleware/mtls-auth';
import { combinedAuth, type CombinedAuthConfig } from '../middleware/combined-auth';
import { signAccessToken } from '../utils/jwt';

describe('mTLS Authentication', () => {
  const validFingerprint = 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  const invalidFingerprint = 'sha256:fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321';

  test('accepts valid certificate fingerprint (proxy mode)', async () => {
    const app = new Hono();
    const config: MTLSConfig = {
      allowedFingerprints: [validFingerprint],
      mode: 'proxy',
      headerName: 'X-Client-Cert-Fingerprint',
    };

    app.use('*', mtlsAuth(config));
    app.get('/test', (c) => c.json({ success: true }));

    const req = new Request('http://localhost/test', {
      headers: {
        'X-Client-Cert-Fingerprint': validFingerprint,
      },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({ success: true });
  });

  test('rejects invalid certificate fingerprint', async () => {
    const app = new Hono();
    const config: MTLSConfig = {
      allowedFingerprints: [validFingerprint],
      mode: 'proxy',
    };

    app.use('*', mtlsAuth(config));
    app.get('/test', (c) => c.json({ success: true }));

    const req = new Request('http://localhost/test', {
      headers: {
        'X-Client-Cert-Fingerprint': invalidFingerprint,
      },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toBe('forbidden');
    expect(body.error_description).toContain('not authorized');
  });

  test('rejects missing certificate', async () => {
    const app = new Hono();
    const config: MTLSConfig = {
      allowedFingerprints: [validFingerprint],
      mode: 'proxy',
    };

    app.use('*', mtlsAuth(config));
    app.get('/test', (c) => c.json({ success: true }));

    const req = new Request('http://localhost/test');
    const res = await app.fetch(req);

    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBe('unauthorized');
    expect(body.error_description).toContain('certificate required');
  });

  test('normalizes fingerprint format (with and without sha256: prefix)', async () => {
    const app = new Hono();
    const config: MTLSConfig = {
      allowedFingerprints: [validFingerprint],
      mode: 'proxy',
    };

    app.use('*', mtlsAuth(config));
    app.get('/test', (c) => c.json({ success: true }));

    // Test with sha256: prefix
    const req1 = new Request('http://localhost/test', {
      headers: {
        'X-Client-Cert-Fingerprint': validFingerprint,
      },
    });
    const res1 = await app.fetch(req1);
    expect(res1.status).toBe(200);

    // Test without sha256: prefix (should be normalized)
    const fingerprintWithoutPrefix = validFingerprint.replace('sha256:', '');
    const req2 = new Request('http://localhost/test', {
      headers: {
        'X-Client-Cert-Fingerprint': fingerprintWithoutPrefix,
      },
    });
    const res2 = await app.fetch(req2);
    expect(res2.status).toBe(200);
  });

  test('skips auth for /health endpoint', async () => {
    const app = new Hono();
    const config: MTLSConfig = {
      allowedFingerprints: [validFingerprint],
      mode: 'proxy',
    };

    app.use('*', mtlsAuth(config));
    app.get('/health', (c) => c.json({ status: 'ok' }));

    const req = new Request('http://localhost/health');
    const res = await app.fetch(req);

    expect(res.status).toBe(200);
  });
});

describe('Combined mTLS + JWT Authentication', () => {
  const validFingerprint = 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  let validJWT: string;

  beforeAll(async () => {
    // Generate a valid JWT for testing
    validJWT = await signAccessToken({
      sub: 'test-client',
      scope: 'read:secrets',
    });
  });

  test('accepts request with valid cert AND valid JWT', async () => {
    const app = new Hono();
    const config: CombinedAuthConfig = {
      mtls: {
        allowedFingerprints: [validFingerprint],
        mode: 'proxy',
      },
      jwt: {
        requireScopes: ['read:secrets'],
      },
    };

    app.use('*', combinedAuth(config));
    app.get('/secret/test', (c) => c.json({ value: 'secret-value' }));

    const req = new Request('http://localhost/secret/test', {
      headers: {
        'X-Client-Cert-Fingerprint': validFingerprint,
        'Authorization': `Bearer ${validJWT}`,
      },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.value).toBe('secret-value');
  });

  test('rejects request with valid cert but NO JWT', async () => {
    const app = new Hono();
    const config: CombinedAuthConfig = {
      mtls: {
        allowedFingerprints: [validFingerprint],
        mode: 'proxy',
      },
    };

    app.use('*', combinedAuth(config));
    app.get('/secret/test', (c) => c.json({ value: 'secret-value' }));

    const req = new Request('http://localhost/secret/test', {
      headers: {
        'X-Client-Cert-Fingerprint': validFingerprint,
        // Missing Authorization header
      },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBe('unauthorized');
    expect(body.error_description).toContain('Authorization');
  });

  test('rejects request with valid JWT but NO cert', async () => {
    const app = new Hono();
    const config: CombinedAuthConfig = {
      mtls: {
        allowedFingerprints: [validFingerprint],
        mode: 'proxy',
      },
    };

    app.use('*', combinedAuth(config));
    app.get('/secret/test', (c) => c.json({ value: 'secret-value' }));

    const req = new Request('http://localhost/secret/test', {
      headers: {
        // Missing X-Client-Cert-Fingerprint header
        'Authorization': `Bearer ${validJWT}`,
      },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBe('unauthorized');
    expect(body.error_description).toContain('certificate');
  });

  test('rejects request with invalid cert (even with valid JWT)', async () => {
    const app = new Hono();
    const invalidFingerprint = 'sha256:invalid';
    const config: CombinedAuthConfig = {
      mtls: {
        allowedFingerprints: [validFingerprint],
        mode: 'proxy',
      },
    };

    app.use('*', combinedAuth(config));
    app.get('/secret/test', (c) => c.json({ value: 'secret-value' }));

    const req = new Request('http://localhost/secret/test', {
      headers: {
        'X-Client-Cert-Fingerprint': invalidFingerprint,
        'Authorization': `Bearer ${validJWT}`,
      },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toBe('forbidden');
  });

  test('rejects request with expired JWT (even with valid cert)', async () => {
    const app = new Hono();
    const config: CombinedAuthConfig = {
      mtls: {
        allowedFingerprints: [validFingerprint],
        mode: 'proxy',
      },
    };

    app.use('*', combinedAuth(config));
    app.get('/secret/test', (c) => c.json({ value: 'secret-value' }));

    // Create an expired JWT (expires immediately)
    const expiredJWT = await signAccessToken(
      { sub: 'test-client', scope: 'read:secrets' },
      -1 // Negative expiry = already expired
    );

    const req = new Request('http://localhost/secret/test', {
      headers: {
        'X-Client-Cert-Fingerprint': validFingerprint,
        'Authorization': `Bearer ${expiredJWT}`,
      },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBe('unauthorized');
  });

  test('validates JWT scopes when configured', async () => {
    const app = new Hono();
    const config: CombinedAuthConfig = {
      mtls: {
        allowedFingerprints: [validFingerprint],
        mode: 'proxy',
      },
      jwt: {
        requireScopes: ['read:secrets', 'write:secrets'], // Requires BOTH
      },
    };

    app.use('*', combinedAuth(config));
    app.get('/secret/test', (c) => c.json({ value: 'secret-value' }));

    // JWT only has read:secrets, missing write:secrets
    const req = new Request('http://localhost/secret/test', {
      headers: {
        'X-Client-Cert-Fingerprint': validFingerprint,
        'Authorization': `Bearer ${validJWT}`,
      },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toBe('forbidden');
    expect(body.error_description).toContain('scopes');
  });
});
