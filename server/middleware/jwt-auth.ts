/**
 * JWT authentication middleware for OpenClaw profile
 * Similar to oauth2-auth but optimized for machine-to-machine authentication
 */

import { type Context, type MiddlewareHandler } from 'hono';
import { verifyToken, isAccessToken } from '../utils/jwt';

export interface JWTAuthConfig {
  requireScopes?: string[];
  requireClaims?: Record<string, unknown>;
}

/**
 * JWT Bearer authentication middleware
 * Validates Authorization header and attaches decoded payload to context
 */
export function jwtAuth(config?: JWTAuthConfig): MiddlewareHandler {
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
          hint: 'Include header: Authorization: Bearer <jwt>',
        },
        401
      );
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return c.json(
        {
          error: 'unauthorized',
          error_description: 'Invalid Authorization header format',
          hint: 'Expected format: Authorization: Bearer <jwt>',
        },
        401
      );
    }

    const token = match[1];

    try {
      // Verify token signature and expiry
      const payload = await verifyToken(token);

      // Ensure it's an access token (not refresh token)
      if (!isAccessToken(payload)) {
        return c.json(
          {
            error: 'unauthorized',
            error_description: 'Invalid token type',
            hint: 'Use access token, not refresh token',
          },
          401
        );
      }

      // Validate required scopes if configured
      if (config?.requireScopes && config.requireScopes.length > 0) {
        const tokenScopes = payload.scope.split(' ');
        const hasAllScopes = config.requireScopes.every(required =>
          tokenScopes.includes(required)
        );

        if (!hasAllScopes) {
          return c.json(
            {
              error: 'forbidden',
              error_description: 'Insufficient scopes',
              required: config.requireScopes,
              provided: tokenScopes,
            },
            403
          );
        }
      }

      // Validate required claims if configured
      if (config?.requireClaims) {
        for (const [claim, expectedValue] of Object.entries(config.requireClaims)) {
          const actualValue = payload[claim];
          if (actualValue !== expectedValue) {
            return c.json(
              {
                error: 'forbidden',
                error_description: `Invalid claim: ${claim}`,
                expected: expectedValue,
                actual: actualValue,
              },
              403
            );
          }
        }
      }

      // Attach payload to context for downstream use
      c.set('jwt', payload);
      c.set('clientId', payload.sub);
      c.set('scopes', payload.scope.split(' '));

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
