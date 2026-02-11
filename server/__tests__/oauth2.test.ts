/**
 * OAuth2 authentication tests
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { signAccessToken, signRefreshToken, verifyToken, isAccessToken, isRefreshToken } from '../utils/jwt';
import { createAuthRouter, loadOAuthClients } from '../routes/auth';
import { Hono } from 'hono';

describe('JWT utilities', () => {
  test('signAccessToken creates valid token', async () => {
    const token = await signAccessToken({ sub: 'test-client', scope: 'secrets:read' }, 900);
    expect(token).toBeDefined();
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3); // JWT has 3 parts
  });

  test('signRefreshToken creates valid token', async () => {
    const token = await signRefreshToken({ sub: 'test-client' }, 604800);
    expect(token).toBeDefined();
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
  });

  test('verifyToken validates access token', async () => {
    const token = await signAccessToken({ sub: 'test-client', scope: 'secrets:read' }, 900);
    const payload = await verifyToken(token);

    expect(payload.sub).toBe('test-client');
    expect(payload.type).toBe('access');
    expect(isAccessToken(payload)).toBe(true);
    expect(isRefreshToken(payload)).toBe(false);
  });

  test('verifyToken validates refresh token', async () => {
    const token = await signRefreshToken({ sub: 'test-client' }, 604800);
    const payload = await verifyToken(token);

    expect(payload.sub).toBe('test-client');
    expect(payload.type).toBe('refresh');
    expect(isAccessToken(payload)).toBe(false);
    expect(isRefreshToken(payload)).toBe(true);
  });

  test('verifyToken rejects expired token', async () => {
    // Create token that expires immediately
    const token = await signAccessToken({ sub: 'test-client', scope: 'secrets:read' }, -1);

    // Wait a bit to ensure it's expired
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(async () => {
      await verifyToken(token);
    }).toThrow();
  });

  test('verifyToken rejects invalid token', async () => {
    const invalidToken = 'invalid.jwt.token';

    expect(async () => {
      await verifyToken(invalidToken);
    }).toThrow();
  });

  test('verifyToken rejects tampered token', async () => {
    const token = await signAccessToken({ sub: 'test-client', scope: 'secrets:read' }, 900);
    const parts = token.split('.');
    // Tamper with payload
    parts[1] = 'tampered';
    const tamperedToken = parts.join('.');

    expect(async () => {
      await verifyToken(tamperedToken);
    }).toThrow();
  });
});

describe('OAuth2 client loading', () => {
  test('loadOAuthClients from environment variables', () => {
    const originalId = process.env.OAUTH_CLIENT_ID;
    const originalSecret = process.env.OAUTH_CLIENT_SECRET;

    process.env.OAUTH_CLIENT_ID = 'test-id';
    process.env.OAUTH_CLIENT_SECRET = 'test-secret';

    const clients = loadOAuthClients();

    expect(clients.size).toBe(1);
    expect(clients.get('test-id')).toEqual({
      id: 'test-id',
      secret: 'test-secret',
      name: 'Default Client',
    });

    // Restore original values
    if (originalId) process.env.OAUTH_CLIENT_ID = originalId;
    else delete process.env.OAUTH_CLIENT_ID;
    if (originalSecret) process.env.OAUTH_CLIENT_SECRET = originalSecret;
    else delete process.env.OAUTH_CLIENT_SECRET;
  });
});

describe('OAuth2 auth routes', () => {
  let app: Hono;
  const testClients = new Map([
    ['test-client', { id: 'test-client', secret: 'test-secret', name: 'Test Client' }],
  ]);

  beforeAll(() => {
    const authRouter = createAuthRouter(testClients);
    app = new Hono();
    app.route('/auth', authRouter);
  });

  test('POST /auth/token with client_credentials grant', async () => {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'test-client',
      client_secret: 'test-secret',
    });

    const req = new Request('http://localhost/auth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(200);

    const json = await res.json() as any;
    expect(json.access_token).toBeDefined();
    expect(json.refresh_token).toBeDefined();
    expect(json.token_type).toBe('Bearer');
    expect(json.expires_in).toBe(900);
    expect(json.scope).toBe('secrets:read');
  });

  test('POST /auth/token with invalid credentials', async () => {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'test-client',
      client_secret: 'wrong-secret',
    });

    const req = new Request('http://localhost/auth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(401);

    const json = await res.json() as any;
    expect(json.error).toBe('invalid_client');
  });

  test('POST /auth/token with missing credentials', async () => {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
    });

    const req = new Request('http://localhost/auth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(400);

    const json = await res.json() as any;
    expect(json.error).toBe('invalid_request');
  });

  test('POST /auth/token with refresh_token grant', async () => {
    // First get tokens via client_credentials
    const body1 = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'test-client',
      client_secret: 'test-secret',
    });

    const req1 = new Request('http://localhost/auth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body1.toString(),
    });

    const res1 = await app.fetch(req1);
    const json1 = await res1.json() as any;
    const refreshToken = json1.refresh_token;

    // Now use refresh token to get new tokens
    const body2 = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    const req2 = new Request('http://localhost/auth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body2.toString(),
    });

    const res2 = await app.fetch(req2);
    expect(res2.status).toBe(200);

    const json2 = await res2.json() as any;
    expect(json2.access_token).toBeDefined();
    expect(json2.refresh_token).toBeDefined();
    expect(json2.token_type).toBe('Bearer');
    expect(json2.expires_in).toBe(900);
  });

  test('POST /auth/token with invalid refresh token', async () => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'invalid.refresh.token',
    });

    const req = new Request('http://localhost/auth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(401);

    const json = await res.json() as any;
    expect(json.error).toBe('invalid_grant');
  });

  test('POST /auth/token with access token as refresh token', async () => {
    // Get access token
    const accessToken = await signAccessToken({ sub: 'test-client', scope: 'secrets:read' }, 900);

    // Try to use access token as refresh token
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: accessToken,
    });

    const req = new Request('http://localhost/auth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(400);

    const json = await res.json() as any;
    expect(json.error).toBe('invalid_grant');
    expect(json.error_description).toContain('Invalid token type');
  });

  test('POST /auth/token with unsupported grant type', async () => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'some-code',
    });

    const req = new Request('http://localhost/auth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(400);

    const json = await res.json() as any;
    expect(json.error).toBe('unsupported_grant_type');
  });
});

describe('OAuth2 middleware', () => {
  let app: Hono;

  beforeAll(async () => {
    const { oauth2Auth } = await import('../middleware/oauth2-auth');

    app = new Hono();
    app.use('*', oauth2Auth());

    app.get('/health', (c) => c.json({ status: 'ok' }));
    app.get('/protected', (c) => {
      const clientId = c.get('clientId');
      return c.json({ message: 'success', clientId });
    });
  });

  test('allows request with valid access token', async () => {
    const token = await signAccessToken({ sub: 'test-client', scope: 'secrets:read' }, 900);

    const req = new Request('http://localhost/protected', {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(200);

    const json = await res.json() as any;
    expect(json.message).toBe('success');
    expect(json.clientId).toBe('test-client');
  });

  test('allows /health without token', async () => {
    const req = new Request('http://localhost/health');
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
  });

  test('rejects request without Authorization header', async () => {
    const req = new Request('http://localhost/protected');
    const res = await app.fetch(req);
    expect(res.status).toBe(401);

    const json = await res.json() as any;
    expect(json.error).toBe('unauthorized');
    expect(json.error_description).toContain('Missing Authorization header');
  });

  test('rejects request with invalid Authorization format', async () => {
    const req = new Request('http://localhost/protected', {
      headers: {
        'Authorization': 'InvalidFormat',
      },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(401);

    const json = await res.json() as any;
    expect(json.error).toBe('unauthorized');
    expect(json.error_description).toContain('Invalid Authorization header format');
  });

  test('rejects request with expired token', async () => {
    const token = await signAccessToken({ sub: 'test-client', scope: 'secrets:read' }, -1);

    // Wait to ensure expiration
    await new Promise(resolve => setTimeout(resolve, 100));

    const req = new Request('http://localhost/protected', {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(401);

    const json = await res.json() as any;
    expect(json.error).toBe('unauthorized');
  });

  test('rejects request with refresh token instead of access token', async () => {
    const token = await signRefreshToken({ sub: 'test-client' }, 604800);

    const req = new Request('http://localhost/protected', {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(401);

    const json = await res.json() as any;
    expect(json.error).toBe('unauthorized');
    expect(json.error_description).toContain('Invalid token type');
  });

  test('rejects request with invalid token', async () => {
    const req = new Request('http://localhost/protected', {
      headers: {
        'Authorization': 'Bearer invalid.token.here',
      },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(401);

    const json = await res.json() as any;
    expect(json.error).toBe('unauthorized');
  });
});
