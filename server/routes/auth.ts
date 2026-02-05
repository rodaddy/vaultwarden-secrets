/**
 * OAuth2 authentication routes
 * Implements client_credentials and refresh_token grants
 */

import { Hono } from 'hono';
import { signAccessToken, signRefreshToken } from '../utils/jwt';
import type { Context } from 'hono';

interface OAuthClient {
  id: string;
  secret: string;
  name: string;
}

/**
 * Load OAuth2 clients from config file or environment variables
 */
export function loadOAuthClients(): Map<string, OAuthClient> {
  const clients = new Map<string, OAuthClient>();

  // Option 1: Load from JSON file (if OAUTH_CLIENTS_FILE is set)
  const clientsFile = process.env.OAUTH_CLIENTS_FILE;
  if (clientsFile) {
    try {
      const file = Bun.file(clientsFile);
      const data = JSON.parse(file.toString());

      if (Array.isArray(data.clients)) {
        for (const client of data.clients) {
          clients.set(client.id, {
            id: client.id,
            secret: client.secret,
            name: client.name || client.id,
          });
        }
      }
    } catch (error) {
      console.error(`Failed to load OAuth clients from ${clientsFile}:`, error);
    }
  }

  // Option 2: Load single client from env vars (OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET)
  const clientId = process.env.OAUTH_CLIENT_ID;
  const clientSecret = process.env.OAUTH_CLIENT_SECRET;

  if (clientId && clientSecret) {
    clients.set(clientId, {
      id: clientId,
      secret: clientSecret,
      name: 'Default Client',
    });
  }

  return clients;
}

/**
 * Validate client credentials
 */
function validateClient(
  clients: Map<string, OAuthClient>,
  clientId: string,
  clientSecret: string
): OAuthClient | null {
  const client = clients.get(clientId);
  if (!client || client.secret !== clientSecret) {
    return null;
  }
  return client;
}

/**
 * Parse x-www-form-urlencoded body
 */
async function parseFormBody(c: Context): Promise<Record<string, string>> {
  const body = await c.req.text();
  const params = new URLSearchParams(body);
  const result: Record<string, string> = {};

  for (const [key, value] of params) {
    result[key] = value;
  }

  return result;
}

/**
 * Create OAuth2 auth router
 */
export function createAuthRouter(clients: Map<string, OAuthClient>): Hono {
  const router = new Hono();

  /**
   * POST /auth/token - Token endpoint
   * Supports:
   * - client_credentials grant
   * - refresh_token grant
   */
  router.post('/token', async (c) => {
    const params = await parseFormBody(c);
    const grantType = params.grant_type;

    // Client Credentials Grant
    if (grantType === 'client_credentials') {
      const clientId = params.client_id;
      const clientSecret = params.client_secret;

      if (!clientId || !clientSecret) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Missing client_id or client_secret',
          },
          400
        );
      }

      const client = validateClient(clients, clientId, clientSecret);
      if (!client) {
        return c.json(
          {
            error: 'invalid_client',
            error_description: 'Invalid client credentials',
          },
          401
        );
      }

      // Generate tokens
      const accessToken = await signAccessToken(
        { sub: client.id, scope: 'secrets:read' },
        900 // 15 minutes
      );

      const refreshToken = await signRefreshToken(
        { sub: client.id },
        604800 // 7 days
      );

      return c.json({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: 900,
        scope: 'secrets:read',
      });
    }

    // Refresh Token Grant
    if (grantType === 'refresh_token') {
      const refreshToken = params.refresh_token;

      if (!refreshToken) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Missing refresh_token',
          },
          400
        );
      }

      try {
        // Verify refresh token
        const { verifyToken, isRefreshToken } = await import('../utils/jwt');
        const payload = await verifyToken(refreshToken);

        if (!isRefreshToken(payload)) {
          return c.json(
            {
              error: 'invalid_grant',
              error_description: 'Invalid token type',
            },
            400
          );
        }

        // Verify client still exists
        const client = clients.get(payload.sub);
        if (!client) {
          return c.json(
            {
              error: 'invalid_grant',
              error_description: 'Client no longer exists',
            },
            401
          );
        }

        // Generate new tokens
        const newAccessToken = await signAccessToken(
          { sub: client.id, scope: 'secrets:read' },
          900
        );

        const newRefreshToken = await signRefreshToken(
          { sub: client.id },
          604800
        );

        return c.json({
          access_token: newAccessToken,
          refresh_token: newRefreshToken,
          token_type: 'Bearer',
          expires_in: 900,
          scope: 'secrets:read',
        });
      } catch (error) {
        return c.json(
          {
            error: 'invalid_grant',
            error_description: error instanceof Error ? error.message : 'Invalid refresh token',
          },
          401
        );
      }
    }

    // Unsupported grant type
    return c.json(
      {
        error: 'unsupported_grant_type',
        error_description: `Grant type '${grantType}' is not supported`,
      },
      400
    );
  });

  return router;
}
