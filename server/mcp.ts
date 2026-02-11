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
 * - get_service: Get all vault items for a multi-host service
 *
 * Tools (write — gated by SecurityProfile.allowWrites):
 * - refresh_snapshot: Force snapshot refresh from vault
 * - create_secret: Create a new secret with optional type + custom fields
 * - update_secret: Update an existing secret with custom field merge/replace
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
import { resolveService } from './service-resolver';
import { buildCreateTemplate, mergeUpdateFields, bwCreateItem, bwGetItem, bwEditItem, bwDeleteItem } from './vault-client';

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
    version: '0.7.0',
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

  server.tool(
    'get_service',
    'Get all vault items for a service (API credentials + per-host entries). Uses naming convention: SERVICE_API for shared credentials, service01/02/etc for hosts.',
    {
      service: z.string().describe('Service name prefix (e.g. "proxmox", "redis", "github")'),
    },
    { readOnlyHint: true },
    async ({ service }) => {
      try {
        const snapshot = await snapshotManager.load();
        if (!snapshot) return err('Error: No snapshot available. Run refresh_snapshot first.');

        const allowedItems = snapshot.items.filter(isItemAllowed);
        const result = resolveService(service, allowedItems);

        if (result.itemCount === 0) {
          return err(`No items found for service "${service}". Check the service name or folder scope.`);
        }

        return json(result);
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
      'Create a new secret in the vault (Infrastructure folder). Supports login items (type 1) and secure notes (type 2) with custom fields. Triggers snapshot refresh after creation.',
      {
        name: z.string().describe('Name for the new secret'),
        type: z.number().optional().describe('Item type: 1=login (default), 2=secure note. Use type 2 with custom fields for API tokens.'),
        username: z.string().optional().describe('Login username (type 1 only)'),
        password: z.string().optional().describe('Login password (type 1 only)'),
        uri: z.string().optional().describe('Login URI (type 1 only, e.g. https://example.com)'),
        notes: z.string().optional().describe('Notes field'),
        fields: z.array(z.object({
          name: z.string().describe('Field name'),
          value: z.string().describe('Field value'),
          type: z.number().optional().describe('Field type: 0=text (default), 1=hidden'),
        })).optional().describe('Custom fields (e.g. API tokens on secure notes)'),
      },
      { destructiveHint: false, idempotentHint: false },
      async ({ name, type, username, password, uri, notes, fields }) => {
        try {
          if (!writeFolderId) return err('Error: No write folder configured. Check folderScope in security profile.');

          const session = await getVaultSession('default');
          if (!session) return err('Error: No vault session available. Run: bw unlock');

          const template = buildCreateTemplate({ name, type, folderId: writeFolderId, username, password, uri, notes, fields });
          const created = await bwCreateItem(session, template);

          await snapshotManager.createSnapshot('default', session);

          return json({ created: true, id: created.id, name: created.name });
        } catch (error) {
          return err(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    );

    server.tool(
      'update_secret',
      'Update an existing secret. Supports login fields and custom fields. Only secrets in allowed folders can be modified. Triggers snapshot refresh.',
      {
        name: z.string().describe('Name of the secret to update'),
        username: z.string().optional().describe('New username (omit to keep current)'),
        password: z.string().optional().describe('New password (omit to keep current)'),
        uri: z.string().optional().describe('New URI (omit to keep current)'),
        notes: z.string().optional().describe('New notes (omit to keep current)'),
        fields: z.array(z.object({
          name: z.string().describe('Field name'),
          value: z.string().describe('Field value'),
          type: z.number().optional().describe('Field type: 0=text (default), 1=hidden'),
        })).optional().describe('Custom fields to add/update'),
        fieldStrategy: z.enum(['merge', 'replace']).optional().describe("'merge' (default): update existing fields by name, append new. 'replace': overwrite all fields."),
      },
      { destructiveHint: true, idempotentHint: true },
      async ({ name, username, password, uri, notes, fields, fieldStrategy }) => {
        try {
          const session = await getVaultSession('default');
          if (!session) return err('Error: No vault session available. Run: bw unlock');

          const item = await findScopedItem(name);
          if (!item) return err(`Error: Secret "${name}" not found or not in allowed folder scope`);

          const fullItem = await bwGetItem(session, item.id);
          const merged = mergeUpdateFields(fullItem, { username, password, uri, notes, fields, fieldStrategy });
          await bwEditItem(session, item.id, merged);

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

          await bwDeleteItem(session, item.id);

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
    'search_secrets', 'get_secret', 'get_secret_fields', 'list_secrets', 'snapshot_info', 'get_service',
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
            version: '0.7.0',
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

/**
 * Create a new MCP transport + server, run the initialize handshake internally,
 * and store in the transports map. Used for both explicit init requests and
 * auto-reconnection when a client sends a stale session ID.
 */
async function createInitializedTransport(requestUrl: string): Promise<WebStandardStreamableHTTPServerTransport> {
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

  // Synthesize initialize handshake so the server is ready for tool calls
  const initBody = {
    jsonrpc: '2.0', id: '_auto_init', method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'auto-reconnect', version: '1.0' },
    },
  };
  const initReq = new Request(requestUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(initBody),
  });
  await transport.handleRequest(initReq, { parsedBody: initBody });

  // Complete handshake with initialized notification
  const notifBody = { jsonrpc: '2.0', method: 'notifications/initialized' };
  const notifReq = new Request(requestUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'mcp-session-id': transport.sessionId!,
    },
    body: JSON.stringify(notifBody),
  });
  await transport.handleRequest(notifReq, { parsedBody: notifBody });

  if (transport.sessionId) {
    transports.set(transport.sessionId, transport);
  }

  return transport;
}

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
      // Explicit init: create fresh transport and let the client's request do the handshake
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);

      const response = await transport.handleRequest(c.req.raw, { parsedBody: body });
      if (transport.sessionId) transports.set(transport.sessionId, transport);
      return response;
    }

    // Look up existing session, or auto-reconnect if stale/missing
    const sessionId = c.req.header('mcp-session-id');
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      console.log(`[MCP] Auto-reconnecting stale session ${sessionId ?? '(none)'}`);
      transport = await createInitializedTransport(c.req.url);
    }

    return transport.handleRequest(c.req.raw, { parsedBody: body });
  }

  // GET/DELETE — SSE streaming, no auto-reconnect
  const sessionId = c.req.header('mcp-session-id');
  if (!sessionId || !transports.has(sessionId)) {
    return c.json({ error: 'Session not found. Re-initialize required.' }, 404);
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
console.log(`MCP Server: vaultwarden-secrets v0.7.0`);
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
