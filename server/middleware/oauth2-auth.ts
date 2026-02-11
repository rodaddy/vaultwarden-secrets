/**
 * OAuth2 authentication middleware
 * Validates Bearer tokens for protected endpoints
 */

import { type Context, type MiddlewareHandler } from 'hono';
import { verifyToken, isAccessToken } from '../utils/jwt';

/**
 * OAuth2 Bearer authentication middleware
 * Validates Authorization header and attaches decoded payload to context
 */
export function oauth2Auth(): MiddlewareHandler {
  return async (c: Context, next) => {
    // Skip auth for /health and /auth endpoints
    const path = c.req.path;
    if (path === '/health' || path.startsWith('/auth/')) {
      return next();
    }

    // Extract Bearer token from Authorization header
    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'Missing Authorization header',
        },
        401
      );
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'Invalid Authorization header format. Expected: Bearer <token>',
        },
        401
      );
    }

    const token = match[1];

    try {
      // Verify token
      const payload = await verifyToken(token);

      // Ensure it's an access token (not refresh token)
      if (!isAccessToken(payload)) {
        return c.json(
          {
            error: 'unauthorized',
            error_description: 'Invalid token type. Use access token, not refresh token',
          },
          401
        );
      }

      // Attach payload to context for downstream use
      c.set('oauth2', payload);
      c.set('clientId', payload.sub);

      return next();
    } catch (error) {
      return c.json(
        {
          error: 'unauthorized',
          error_description: error instanceof Error ? error.message : 'Token validation failed',
        },
        401
      );
    }
  };
}
