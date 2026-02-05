/**
 * Bearer token authentication middleware
 * Simple API key validation for "I'm Aware" profile
 */

import type { Context, Next } from 'hono';

interface BearerAuthConfig {
  tokens: Map<string, string>; // token → clientId
  realm?: string;
}

/**
 * Bearer auth middleware factory
 */
export function bearerAuth(config: BearerAuthConfig) {
  const { tokens, realm = 'Vaultwarden Secrets' } = config;

  return async (c: Context, next: Next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader) {
      return c.json(
        { error: 'Missing Authorization header' },
        401,
        {
          'WWW-Authenticate': `Bearer realm="${realm}"`,
        }
      );
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return c.json(
        { error: 'Invalid Authorization header format. Expected: Bearer <token>' },
        401,
        {
          'WWW-Authenticate': `Bearer realm="${realm}"`,
        }
      );
    }

    const token = match[1];
    const clientId = tokens.get(token);

    if (!clientId) {
      console.warn(`Invalid bearer token attempted: ${token.substring(0, 8)}...`);
      return c.json({ error: 'Invalid token' }, 401);
    }

    // Store client ID in context for audit logging
    c.set('clientId', clientId);

    await next();
  };
}

/**
 * Load tokens from environment or config
 */
export function loadBearerTokens(): Map<string, string> {
  const tokens = new Map<string, string>();

  // Load from env vars (format: API_TOKEN_<CLIENT>=token)
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('API_TOKEN_')) {
      const clientId = key.replace('API_TOKEN_', '').toLowerCase();
      tokens.set(value!, clientId);
    }
  }

  return tokens;
}
