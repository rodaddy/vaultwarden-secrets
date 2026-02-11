/**
 * MCP (Model Context Protocol) Server for Vaultwarden Secrets
 *
 * Exposes vault operations as MCP tools over Streamable HTTP transport.
 * Runs alongside the REST API on a separate port (MCP_PORT, default 3001).
 *
 * Tools (read):
 * - search_secrets: Fuzzy search for secrets by name
 * - get_secret: Get a secret value by name/path
 * - get_secret_fields: Get all fields for a secret item
 * - list_secrets: List available secrets with optional filter
 * - snapshot_info: Get vault snapshot metadata (age, item count, staleness)
 *
 * Tools (write — gated by SecurityProfile.allowWrites):
 * - refresh_snapshot: Force snapshot refresh from vault
 * - create_secret: Create a new secret (scoped to allowed folders)
 * - update_secret: Update an existing secret (destructiveHint)
 * - delete_secret: Delete a secret (destructiveHint)
 *
 * @module server/mcp
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { $ } from 'bun';
import { z } from 'zod';
import { getSecret, getSecretObject, listSecrets } from '../index';
import { snapshotManager, type BitwVaultItem } from '../snapshot';
import { getVaultSession } from '../keychain';
import { loadBearerTokens } from './middleware/bearer-auth';
import { getProfile } from './profiles';

// ============================================================================
// Auth helper
// ============================================================================

const tokens = loadBearerTokens();
if (tokens.size === 0) {
  console.error('MCP: No API tokens configured. Set API_TOKEN_<CLIENT>=<token>');
  process.exit(1);
}

function authenticateRequest(req: Request): string | null {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return tokens.get(match[1]) ?? null;
}

// ============================================================================
// Security profile + folder scoping
// ============================================================================

const SECURITY_PROFILE = process.env.SECURITY_PROFILE || 'im-aware';
const profile = getProfile(SECURITY_PROFILE);

/** Resolved folder IDs the MCP is allowed to access. null = unrestricted. */
let allowedFolderIds: Set<string> | null = null;
/** Primary folder ID for creating new items (first folder in scope). */
let writeFolderId: string | null = null;

async function initProfileFolderScope(): Promise<void> {
  if (!profile.folderScope?.length) return;

  const session = await getVaultSession('default');
  if (!session) {
    console.warn('  ⚠  MCP FolderScope: No vault session, scoping disabled');
    return;
  }

  try {
    const foldersResult = await $`BW_SESSION=${session} bw list folders`.quiet();
    const folders: Array<{ id: string; name: string }> = JSON.parse(foldersResult.text());

    allowedFolderIds = new Set();
    for (const scopeName of profile.folderScope) {
      const folder = folders.find(f => f.name.toLowerCase() === scopeName.toLowerCase());
      if (folder) {
        allowedFolderIds.add(folder.id);
        if (!writeFolderId) writeFolderId = folder.id;
      } else {
        console.warn(`  ⚠  MCP FolderScope: Folder "${scopeName}" not found in vault`);
      }
    }

    if (allowedFolderIds.size === 0) {
      console.warn('  ⚠  MCP FolderScope: No folders resolved, scoping disabled');
      allowedFolderIds = null;
    }
  } catch (error) {
    console.warn(`  ⚠  MCP FolderScope: Init failed — ${error instanceof Error ? error.message : error}`);
  }
}

await initProfileFolderScope();

/** Check if an item is in an allowed folder */
function isItemAllowed(item: BitwVaultItem): boolean {
  if (!allowedFolderIds) return true;
  return item.folderId != null && allowedFolderIds.has(item.folderId);
}

/** Filter a list of item names to only those in allowed folders */
async function filterByScope(names: string[]): Promise<string[]> {
  if (!allowedFolderIds) return names;

  const snapshot = await snapshotManager.load();
  if (!snapshot) return names;

  const allowedNames = new Set<string>();
  for (const item of snapshot.items) {
    if (isItemAllowed(item)) allowedNames.add(item.name);
  }
  return names.filter(n => allowedNames.has(n));
}

/** Find an item in the snapshot, respecting folder scope */
async function findScopedItem(name: string): Promise<BitwVaultItem | null> {
  const item = await snapshotManager.getItem(name);
  if (!item) return null;
  return isItemAllowed(item) ? item : null;
}

// ============================================================================
// Tool result helpers
// ============================================================================

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (obj: unknown) => text(JSON.stringify(obj, null, 2));
const err = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true as const });

// ============================================================================
// MCP Server factory
// ============================================================================

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'vaultwarden-secrets',
    version: '0.6.0',
  });

  // ------------------------------------------------------------------
  // READ TOOLS
  // ------------------------------------------------------------------

  server.tool(
    'search_secrets',
    'Fuzzy search for secrets by name',
    {
      query: z.string().describe('Search query'),
      limit: z.number().optional().default(20).describe('Max results'),
      vault: z.string().optional().describe('Vault ID (default: "default")'),
    },
    { readOnlyHint: true },
    async ({ query, limit, vault }) => {
      try {
        let secrets = await listSecrets(undefined, { vault });
        secrets = await filterByScope(secrets);
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

        return json(scored);
      } catch (error) {
        return err(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    'get_secret',
    'Get a secret value by name',
    {
      name: z.string().describe('Secret name or path (e.g. "github-pat", "github-pat.login.password")'),
      vault: z.string().optional().describe('Vault ID (default: "default")'),
    },
    { readOnlyHint: true },
    async ({ name, vault }) => {
      try {
        const baseName = name.split('.')[0] || name;
        const item = await findScopedItem(baseName);
        if (!item) return err(`Error: Secret "${baseName}" not found or not in allowed folder scope`);

        const value = await getSecret(name, { vault });
        return text(value);
      } catch (error) {
        return err(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    'get_secret_fields',
    'Get all fields for a secret item',
    {
      name: z.string().describe('Secret item name'),
      vault: z.string().optional().describe('Vault ID'),
    },
    { readOnlyHint: true },
    async ({ name, vault }) => {
      try {
        const item = await findScopedItem(name);
        if (!item) return err(`Error: Secret "${name}" not found or not in allowed folder scope`);

        const fields = await getSecretObject(name, { vault });
        return json(fields);
      } catch (error) {
        return err(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    'list_secrets',
    'List available secrets with optional filter',
    {
      filter: z.string().optional().describe('Filter string (case-insensitive)'),
      vault: z.string().optional().describe('Vault ID'),
    },
    { readOnlyHint: true },
    async ({ filter, vault }) => {
      try {
        let secrets = await listSecrets(filter || undefined, { vault });
        secrets = await filterByScope(secrets);
        return json(secrets);
      } catch (error) {
        return err(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    'snapshot_info',
    'Get vault snapshot metadata (age, item count, staleness)',
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const metadata = await snapshotManager.getMetadata();
        if (!metadata) return text('No snapshot exists');
        return json(metadata);
      } catch (error) {
        return err(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ------------------------------------------------------------------
  // WRITE TOOLS (gated by profile.allowWrites)
  // ------------------------------------------------------------------

  if (profile.allowWrites) {
    server.tool(
      'refresh_snapshot',
      'Force a snapshot refresh from the live vault. Use when snapshot_info shows stale data.',
      {},
      { readOnlyHint: false, idempotentHint: true },
      async () => {
        try {
          const session = await getVaultSession('default');
          if (!session) return err('Error: No vault session available. Run: bw unlock');

          const metadata = await snapshotManager.createSnapshot('default', session);
          return json({ refreshed: true, ...metadata });
        } catch (error) {
          return err(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    );

    server.tool(
      'create_secret',
      'Create a new secret in the vault (Infrastructure folder). Triggers snapshot refresh after creation.',
      {
        name: z.string().describe('Name for the new secret'),
        username: z.string().optional().describe('Login username'),
        password: z.string().optional().describe('Login password'),
        uri: z.string().optional().describe('Login URI (e.g. https://example.com)'),
        notes: z.string().optional().describe('Notes field'),
      },
      { destructiveHint: false, idempotentHint: false },
      async ({ name, username, password, uri, notes }) => {
        try {
          if (!writeFolderId) return err('Error: No write folder configured. Check folderScope in security profile.');

          const session = await getVaultSession('default');
          if (!session) return err('Error: No vault session available. Run: bw unlock');

          // Build BW item template
          const item: Record<string, unknown> = {
            type: 1, // login
            name,
            folderId: writeFolderId,
            login: {
              username: username || null,
              password: password || null,
              uris: uri ? [{ match: null, uri }] : [],
            },
            notes: notes || null,
          };

          const encoded = Buffer.from(JSON.stringify(item)).toString('base64');
          const result = await $`BW_SESSION=${session} bw create item ${encoded}`.quiet();
          const created = JSON.parse(result.text());

          // Refresh snapshot to include the new item
          await snapshotManager.createSnapshot('default', session);

          return json({ created: true, id: created.id, name: created.name });
        } catch (error) {
          return err(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    );

    server.tool(
      'update_secret',
      'Update an existing secret. Only secrets in allowed folders can be modified. Triggers snapshot refresh.',
      {
        name: z.string().describe('Name of the secret to update'),
        username: z.string().optional().describe('New username (omit to keep current)'),
        password: z.string().optional().describe('New password (omit to keep current)'),
        uri: z.string().optional().describe('New URI (omit to keep current)'),
        notes: z.string().optional().describe('New notes (omit to keep current)'),
      },
      { destructiveHint: true, idempotentHint: true },
      async ({ name, username, password, uri, notes }) => {
        try {
          const session = await getVaultSession('default');
          if (!session) return err('Error: No vault session available. Run: bw unlock');

          const item = await findScopedItem(name);
          if (!item) return err(`Error: Secret "${name}" not found or not in allowed folder scope`);

          // Fetch the full item from BW CLI (snapshot may be slightly stale)
          const getResult = await $`BW_SESSION=${session} bw get item ${item.id}`.quiet();
          const fullItem = JSON.parse(getResult.text());

          // Merge updates
          if (username !== undefined) fullItem.login = { ...fullItem.login, username };
          if (password !== undefined) fullItem.login = { ...fullItem.login, password };
          if (uri !== undefined) {
            fullItem.login = {
              ...fullItem.login,
              uris: [{ match: null, uri }],
            };
          }
          if (notes !== undefined) fullItem.notes = notes;

          const encoded = Buffer.from(JSON.stringify(fullItem)).toString('base64');
          await $`BW_SESSION=${session} bw edit item ${item.id} ${encoded}`.quiet();

          // Refresh snapshot
          await snapshotManager.createSnapshot('default', session);

          return json({ updated: true, id: item.id, name: item.name });
        } catch (error) {
          return err(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    );

    server.tool(
      'delete_secret',
      'Delete a secret from the vault. Only secrets in allowed folders can be deleted. Triggers snapshot refresh.',
      {
        name: z.string().describe('Name of the secret to delete'),
      },
      { destructiveHint: true, idempotentHint: false },
      async ({ name }) => {
        try {
          const session = await getVaultSession('default');
          if (!session) return err('Error: No vault session available. Run: bw unlock');

          const item = await findScopedItem(name);
          if (!item) return err(`Error: Secret "${name}" not found or not in allowed folder scope`);

          await $`BW_SESSION=${session} bw delete item ${item.id}`.quiet();

          // Refresh snapshot
          await snapshotManager.createSnapshot('default', session);

          return json({ deleted: true, id: item.id, name: item.name });
        } catch (error) {
          return err(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    );
  }

  // ------------------------------------------------------------------
  // Resources
  // ------------------------------------------------------------------

  const toolList = [
    'search_secrets', 'get_secret', 'get_secret_fields', 'list_secrets', 'snapshot_info',
    ...(profile.allowWrites ? ['refresh_snapshot', 'create_secret', 'update_secret', 'delete_secret'] : []),
  ];

  server.resource(
    'server-info',
    'vaultwarden://info',
    async () => ({
      contents: [
        {
          uri: 'vaultwarden://info',
          mimeType: 'application/json',
          text: JSON.stringify({
            name: 'vaultwarden-secrets',
            version: '0.6.0',
            profile: profile.name,
            folderScope: profile.folderScope || [],
            allowWrites: profile.allowWrites || false,
            tools: toolList,
          }),
        },
      ],
    })
  );

  return server;
}

// ============================================================================
// HTTP transport via Hono
// ============================================================================

const app = new Hono();
app.use('*', cors());

app.get('/health', (c) =>
  c.json({ status: 'ok', transport: 'mcp-streamable-http', timestamp: new Date().toISOString() })
);

const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

app.all('/mcp', async (c) => {
  const clientId = authenticateRequest(c.req.raw);
  if (!clientId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

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

      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);

      const response = await transport.handleRequest(c.req.raw, { parsedBody: body });

      if (transport.sessionId) {
        transports.set(transport.sessionId, transport);
      }

      return response;
    }

    const sessionId = c.req.header('mcp-session-id');
    if (!sessionId || !transports.has(sessionId)) {
      return c.json({ error: 'Invalid or missing session. Send initialize first.' }, 400);
    }

    return transports.get(sessionId)!.handleRequest(c.req.raw, { parsedBody: body });
  }

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
console.log(`MCP Server: vaultwarden-secrets v0.6.0`);
console.log(`Transport:  Streamable HTTP`);
console.log(`Endpoint:   http://${host}:${port}/mcp`);
console.log(`Auth:       Bearer token (${tokens.size} client(s))`);
console.log(`Profile:    ${profile.name}`);
if (profile.folderScope?.length) {
  console.log(`Scoping:    ${profile.folderScope.join(', ')}`);
}
if (profile.allowWrites) {
  console.log(`Writes:     Enabled (confirmation: ${profile.writeConfirmation ? 'required' : 'none'})`);
} else {
  console.log(`Writes:     Disabled`);
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

export default {
  port,
  hostname: host,
  fetch: app.fetch,
};
