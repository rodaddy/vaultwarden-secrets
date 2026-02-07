/**
 * MCP (Model Context Protocol) Server for Vaultwarden Secrets
 *
 * Exposes vault operations as MCP tools over Streamable HTTP transport.
 * Runs alongside the REST API on a separate port (MCP_PORT, default 3001).
 *
 * Tools:
 * - search_secrets: Fuzzy search for secrets by name
 * - get_secret: Get a secret value by name/path
 * - get_secret_fields: Get all fields for a secret item
 * - list_secrets: List available secrets with optional filter
 *
 * @module server/mcp
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { getSecret, getSecretObject, listSecrets } from '../index';
import { loadBearerTokens } from './middleware/bearer-auth';
import { FolderScope, loadFolderScopes } from './utils/folder-scope';

// ============================================================================
// Auth helper
// ============================================================================

const tokens = loadBearerTokens();
if (tokens.size === 0) {
  console.error('MCP: No API tokens configured. Set API_TOKEN_<CLIENT>=<token>');
  process.exit(1);
}

/**
 * Validate bearer token from request headers.
 * Returns the client ID if valid, null otherwise.
 */
function authenticateRequest(req: Request): string | null {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  return tokens.get(match[1]) ?? null;
}

// ============================================================================
// Folder scoping
// ============================================================================

const folderScopeConfig = loadFolderScopes();
const folderScope = new FolderScope(folderScopeConfig);
if (folderScopeConfig.size > 0) {
  await folderScope.initialize();
}

// ============================================================================
// MCP Server
// ============================================================================

const mcpServer = new McpServer({
  name: 'vaultwarden-secrets',
  version: '0.5.2',
});

// Register tools

mcpServer.tool(
  'search_secrets',
  'Fuzzy search for secrets by name',
  {
    query: z.string().describe('Search query'),
    limit: z.number().optional().default(20).describe('Max results'),
    vault: z.string().optional().describe('Vault ID (default: "default")'),
  },
  async ({ query, limit, vault }) => {
    try {
      let secrets = await listSecrets(undefined, { vault });
      const lowerQuery = query.toLowerCase();

      const scored = secrets
        .map((name) => {
          const lowerName = name.toLowerCase();
          let score = 0;
          let queryIdx = 0;

          for (const char of lowerName) {
            if (queryIdx < lowerQuery.length && char === lowerQuery[queryIdx]) {
              score += 10;
              queryIdx++;
            }
          }

          if (lowerName.includes(lowerQuery)) score += 50;
          if (lowerName.startsWith(lowerQuery)) score += 100;

          return { name, score, matched: queryIdx === lowerQuery.length };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(scored, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

mcpServer.tool(
  'get_secret',
  'Get a secret value by name',
  {
    name: z.string().describe('Secret name or path (e.g. "github-pat", "github-pat.login.password")'),
    vault: z.string().optional().describe('Vault ID (default: "default")'),
  },
  async ({ name, vault }) => {
    try {
      const value = await getSecret(name, { vault });
      return {
        content: [{ type: 'text' as const, text: value }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

mcpServer.tool(
  'get_secret_fields',
  'Get all fields for a secret item',
  {
    name: z.string().describe('Secret item name'),
    vault: z.string().optional().describe('Vault ID'),
  },
  async ({ name, vault }) => {
    try {
      const fields = await getSecretObject(name, { vault });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(fields, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

mcpServer.tool(
  'list_secrets',
  'List available secrets with optional filter',
  {
    filter: z.string().optional().describe('Filter string (case-insensitive)'),
    vault: z.string().optional().describe('Vault ID'),
  },
  async ({ filter, vault }) => {
    try {
      const secrets = await listSecrets(filter || undefined, { vault });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(secrets, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// Register a simple info resource
mcpServer.resource(
  'server-info',
  'vaultwarden://info',
  async () => ({
    contents: [
      {
        uri: 'vaultwarden://info',
        mimeType: 'application/json',
        text: JSON.stringify({
          name: 'vaultwarden-secrets',
          version: '0.5.2',
          tools: ['search_secrets', 'get_secret', 'get_secret_fields', 'list_secrets'],
        }),
      },
    ],
  })
);

// ============================================================================
// HTTP transport via Hono
// ============================================================================

const app = new Hono();
app.use('*', cors());

// Health check (no auth)
app.get('/health', (c) =>
  c.json({ status: 'ok', transport: 'mcp-streamable-http', timestamp: new Date().toISOString() })
);

// Per-session transport map
const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

// MCP endpoint - all methods handled by transport
app.all('/mcp', async (c) => {
  // Authenticate
  const clientId = authenticateRequest(c.req.raw);
  if (!clientId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // For POST with initialize method, create new transport
  if (c.req.method === 'POST') {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const isInit = !Array.isArray(body) && (body as any)?.method === 'initialize';

    if (isInit) {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };

      await mcpServer.connect(transport);

      const response = await transport.handleRequest(c.req.raw, { parsedBody: body });

      if (transport.sessionId) {
        transports.set(transport.sessionId, transport);
      }

      return response;
    }

    // Non-init POST: find existing transport by session header
    const sessionId = c.req.header('mcp-session-id');
    if (!sessionId || !transports.has(sessionId)) {
      return c.json({ error: 'Invalid or missing session. Send initialize first.' }, 400);
    }

    return transports.get(sessionId)!.handleRequest(c.req.raw, { parsedBody: body });
  }

  // GET (SSE stream) and DELETE (session termination)
  const sessionId = c.req.header('mcp-session-id');
  if (!sessionId || !transports.has(sessionId)) {
    return c.json({ error: 'Invalid or missing session' }, 400);
  }

  return transports.get(sessionId)!.handleRequest(c.req.raw);
});

// ============================================================================
// Start server
// ============================================================================

const port = parseInt(process.env.MCP_PORT || '3001', 10);
const host = process.env.MCP_HOST || '0.0.0.0';

console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`MCP Server: vaultwarden-secrets`);
console.log(`Transport:  Streamable HTTP`);
console.log(`Endpoint:   http://${host}:${port}/mcp`);
console.log(`Auth:       Bearer token (${tokens.size} client(s))`);
if (folderScopeConfig.size > 0) {
  console.log(`Scoping:    ${folderScopeConfig.size} folder scope(s)`);
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

export default {
  port,
  hostname: host,
  fetch: app.fetch,
};
