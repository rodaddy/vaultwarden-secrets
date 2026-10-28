/**
 * MCP 2026-07-28 (SDK v2) server for Vaultwarden Secrets — PARALLEL VARIANT.
 *
 * **Truth state: WRITTEN. Not deployed. Not merged.** This module has been run
 * only on loopback by `scripts/mcp-v2-done-means.ts`. No claim here is RUNNING
 * on any production host.
 *
 * ## Why this is a separate file and not an edit to `server/mcp.ts`
 *
 * Operator ruling, 2026-08-09:
 *
 *   "we can't really move Vaultwarden secrets until this is known to work
 *    because that's literally how we get all of our secrets. I wouldn't say we
 *    can live migrate it, but we can create its own version so that they both
 *    exist at the same time until we can verify this new platform works."
 *
 * `server/mcp.ts` is the file the LIVE process on the production host (`MainPID` observed
 * 2026-08-09, up since 2026-08-05) executes. Editing it — even in a way that
 * looks safe — puts a change into the path that every agent uses to obtain
 * every credential, before the replacement has been proven. So this is a NEW
 * entry point on a NEW port. Both can run at once. The live one is not
 * modified, restarted, reconfigured, or moved by anything in this branch. The
 * cutover is a LATER ticket that happens only after this platform is proven.
 *
 * The deployed unit `deploy/systemd/vaultwarden-secrets-mcp.service` already
 * carries the same instruction in its own header: "Protected compatibility
 * service — do not stop before a proven replacement."
 *
 * ## What is different from v1 (`server/mcp.ts`)
 *
 * | Concern            | v1 (live, untouched)               | v2 (this file)                     |
 * | ------------------ | ---------------------------------- | ---------------------------------- |
 * | SDK                | `@modelcontextprotocol/sdk@1.26`   | `@modelcontextprotocol/server@2.0` |
 * | Wire revision      | 2025-03-26 only                    | 2026-07-28 **and** 2025-era        |
 * | Handshake          | required; synthesized on reconnect | none on the modern path            |
 * | Session state      | `Map<sessionId, transport>`        | none — per-request instances       |
 * | Arg validation     | permissive (undeclared args drop)  | strict; undeclared args rejected   |
 * | Header validation  | none                               | `Mcp-Method`/`Mcp-Name` → `-32020` |
 *
 * The session map in v1 is the reason v1 needs LB affinity and v2 does not.
 * Per recipe §4, affinity must NOT be removed at cutover while 2025-era clients
 * still exist — they are still most of the traffic.
 *
 * ## Audit safety (mcp2cli#71)
 *
 * mcp2cli#71 recorded a live `get_credential` response — a complete private key
 * — in cleartext in an unencrypted audit file. This server's request log is
 * built so that defect is not expressible: `logRequest` accepts only a tool
 * name, the arguments it derives KEY NAMES from, and a response BYTE COUNT. It
 * has no parameter to pass a value or a body through, so there is no call site
 * that could leak one even by mistake. Cardinality, not content.
 *
 * `logRequest` and `assertStrictSchema` live in `./mcp-v2-audit` because THIS
 * module is an entry point — it resolves folder scope in a top-level `await`
 * and binds a port, so a test cannot import it (observed: a `bun test` import
 * hangs). Keeping those units importable is what lets them be asserted on
 * directly; see `server/__tests__/mcp-v2-audit.test.ts`.
 *
 * ## Reconciliation with PR #40 (dev#113)
 *
 * Two lanes wrote `server/mcp-v2.ts` in this repo. Per ledger item 21 this file
 * is the surviving implementation and #40's unique value was ported onto it —
 * the behavioral strictness guard and the audit-record coverage. Rationale and
 * the not-ported list are recorded in the project history.
 *
 * @module server/mcp-v2
 */

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { getSecret, getSecretObject, listSecrets } from "../index";
import { snapshotManager, type BitwVaultItem } from "../snapshot";
import { loadBearerTokens } from "./middleware/bearer-auth";
import { resolveIdentity } from "./middleware/workload-identity";
import { getProfile } from "./profiles";
import { resolveService } from "./service-resolver";
import { resolveCredential } from "./credential-resolver";
import { assertStrictSchema, logRequest } from "./mcp-v2-audit";

// ============================================================================
// Audit-safe request logging (mcp2cli#71)
// ============================================================================
//
// `logRequest` and the strictness guard live in `./mcp-v2-audit` so they can be
// unit-tested without importing THIS module, which resolves folder scope in a
// top-level `await` and binds a port on import. See that module's header for
// why the audit key derivation drops absent optionals.

// ============================================================================
// Auth — identical backend to v1
// ============================================================================

const tokens = loadBearerTokens();

/**
 * Resolve a request to a workload identity. Fail-closed: null on anything
 * invalid. Same decision function as the v1 MCP, the REST API, and the proxy —
 * v2 deliberately does not introduce a second credential backend.
 */
async function authenticateRequest(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  const match = authHeader?.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1] : null;
  return resolveIdentity(token, { audience: "mcp", legacyTokens: tokens });
}

// ============================================================================
// Security profile + folder scoping — identical semantics to v1
// ============================================================================

const SECURITY_PROFILE = process.env.SECURITY_PROFILE || "im-aware";
const profile = getProfile(SECURITY_PROFILE);

/**
 * Resolved folder IDs this server may access; null = unrestricted.
 *
 * v2 resolves scope ONCE at startup exactly as v1 does. This is process-scoped
 * state and therefore lives OUTSIDE the per-request factory (recipe §2b):
 * anything closed over inside the factory would be rebuilt on every request,
 * which for a `bw list folders` shell-out would be a per-request subprocess.
 */
let allowedFolderIds: Set<string> | null = null;

async function initProfileFolderScope(): Promise<void> {
  if (!profile.folderScope?.length) return;

  const { getVaultSession } = await import("../keychain");
  const { $ } = await import("bun");

  const session = await getVaultSession("default");
  if (!session) {
    console.warn("  MCP v2 FolderScope: no vault session, scoping disabled");
    return;
  }

  try {
    const foldersResult =
      await $`BW_SESSION=${session} bw list folders`.quiet();
    const folders: Array<{ id: string; name: string }> = JSON.parse(
      foldersResult.text(),
    );

    allowedFolderIds = new Set();
    for (const scopeName of profile.folderScope) {
      const folder = folders.find(
        (f) => f.name.toLowerCase() === scopeName.toLowerCase(),
      );
      if (folder) allowedFolderIds.add(folder.id);
      else
        console.warn(
          `  MCP v2 FolderScope: folder "${scopeName}" not found in vault`,
        );
    }

    if (allowedFolderIds.size === 0) {
      console.warn(
        "  MCP v2 FolderScope: no folders resolved, scoping disabled",
      );
      allowedFolderIds = null;
    }
  } catch (error) {
    console.warn(
      `  MCP v2 FolderScope: init failed — ${error instanceof Error ? error.message : error}`,
    );
  }
}

await initProfileFolderScope();

function isItemAllowed(item: BitwVaultItem): boolean {
  if (!allowedFolderIds) return true;
  return item.folderId != null && allowedFolderIds.has(item.folderId);
}

async function filterByScope(names: string[]): Promise<string[]> {
  if (!allowedFolderIds) return names;
  const snapshot = await snapshotManager.load();
  if (!snapshot) return names;
  const allowedNames = new Set<string>();
  for (const item of snapshot.items) {
    if (isItemAllowed(item)) allowedNames.add(item.name);
  }
  return names.filter((n) => allowedNames.has(n));
}

async function findScopedItem(name: string): Promise<BitwVaultItem | null> {
  const item = await snapshotManager.getItem(name);
  if (!item) return null;
  return isItemAllowed(item) ? item : null;
}

// ============================================================================
// Result helpers — 2026-07-28 shapes
// ============================================================================

/**
 * `resultType` is REQUIRED on 2026-07-28 results (recipe §6). Clients treat an
 * omitted value from an older server as `"complete"`, but this server declares
 * it explicitly rather than relying on that fallback.
 */
const text = (t: string) => ({
  resultType: "complete" as const,
  content: [{ type: "text" as const, text: t }],
});
const json = (obj: unknown) => text(JSON.stringify(obj, null, 2));

/**
 * A TOOL EXECUTION error, not a protocol error (recipe §6). Business and
 * validation failures go in the result with `isError: true` so the model can
 * read them and retry; raising them as JSON-RPC protocol errors would strip
 * that ability. Picking the wrong channel here is a behavioral bug.
 */
const err = (msg: string) => ({
  resultType: "complete" as const,
  content: [{ type: "text" as const, text: msg }],
  isError: true as const,
});

/**
 * Fail closed on any non-default vault.
 *
 * Carried forward verbatim from v1 (SECURITY P1). Folder scope is resolved only
 * against the DEFAULT vault's snapshot; a tool that accepted `vault:"other"`
 * would satisfy the default-vault scope check and then read out-of-scope
 * material from a different vault. The v2 rewrite is exactly the kind of change
 * where a guard like this gets dropped, so it is re-asserted per tool.
 */
function rejectNonDefaultVault(vault: string | undefined) {
  if (vault !== undefined && vault !== "default") {
    return err(
      "Error: cross-vault access is not supported; folder scope is enforced only for the default vault.",
    );
  }
  return null;
}

// ============================================================================
// Strict schemas
// ============================================================================

/**
 * `z.strictObject` — undeclared properties are REJECTED and the error names the
 * offending key.
 *
 * Per recipe §5 this is a TOOL-AUTHOR CHOICE, not a spec mandate: SEP-2106
 * loosened schemas rather than tightening them, and there is no protocol
 * "strict mode". It is chosen here because the v1 permissive behavior silently
 * DROPS an undeclared argument (confirmed still present in v2 SDKs by the
 * dev#110 lane), and silently ignoring an argument on a credential tool is the
 * failure mode worth spending strictness on: a caller who misspells `field`
 * gets the whole item instead of the one field they asked for, and never learns.
 *
 * Strictness must not change the wire shape (recipe §0-addendum): arguments stay
 * FLAT under `arguments`, not nested under an `args` key.
 */
const VaultParam = z
  .string()
  .optional()
  .describe('Vault ID (default: "default")');

// ============================================================================
// Server factory — invoked PER REQUEST (recipe §2b)
// ============================================================================

/**
 * Build a server instance for one request.
 *
 * Everything expensive and process-scoped (`tokens`, `allowedFolderIds`, the
 * snapshot manager) is captured from module scope; nothing is constructed here
 * that should be shared, because this runs on every single request.
 */
function buildServer(subject: string): McpServer {
  const server = new McpServer(
    { name: "vaultwarden-secrets", version: "0.8.0-v2" },
    {
      capabilities: { tools: {} },
      // 2026-07-28 requires cache hints on cacheable list results (recipe §2c).
      // RESOLVED THIS LANE: the TS type is `CacheScope = 'public' | 'private'`,
      // read from the installed 2.0.0 d.mts. The migration doc's `'shared'`
      // example does not typecheck — same correction the dev#110 lane made for
      // Python. `private` because the tool list is scoped per security profile
      // and must not be cached in a shared intermediary.
      cacheHints: { "tools/list": { ttlMs: 60_000, cacheScope: "private" } },
    },
  );

  // Every tool below is registered through the SDK's own `registerTool`, but
  // routed past `assertStrictSchema` first so a schema that only LOOKS strict
  // cannot reach the wire. The advertised JSON Schema is not sufficient
  // evidence: on the installed Zod a permissive `z.object({...})` emits the
  // same `additionalProperties: false` as a strict one, so this probes runtime
  // parse behavior instead (see `./mcp-v2-audit`). Registration-time failure is
  // deliberate — a silently-dropped param on a SECRETS tool is the defect this
  // whole server tightened against, and catching it at request time would mean
  // shipping it.
  const registerTool: typeof server.registerTool = (name, config, handler) => {
    assertStrictSchema(
      name as string,
      (config as { inputSchema: z.ZodObject<z.ZodRawShape> }).inputSchema,
    );
    return server.registerTool(
      name as never,
      config as never,
      handler as never,
    );
  };

  // ------------------------------------------------------------------
  // READ TOOLS
  // ------------------------------------------------------------------

  registerTool(
    "snapshot_info",
    {
      description: "Get vault snapshot metadata (age, item count, staleness)",
      annotations: { readOnlyHint: true },
      // Zero-arg tool: `strictObject` with no properties is the spec's
      // RECOMMENDED shape for the no-parameter case (recipe §5) — it accepts
      // only an empty object rather than anything at all.
      inputSchema: z.strictObject({}),
    },
    async (args) => {
      const auditArgs = args ?? {};
      try {
        const metadata = await snapshotManager.getMetadata();
        const out = metadata ? json(metadata) : text("No snapshot exists");
        logRequest(
          "snapshot_info",
          auditArgs,
          JSON.stringify(out).length,
          "ok",
        );
        return out;
      } catch (error) {
        const out = err(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
        logRequest(
          "snapshot_info",
          auditArgs,
          JSON.stringify(out).length,
          "error",
        );
        return out;
      }
    },
  );

  registerTool(
    "list_secrets",
    {
      description: "List available secrets with optional filter",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        filter: z
          .string()
          .optional()
          .describe("Filter string (case-insensitive)"),
        vault: VaultParam,
      }),
    },
    async ({ filter, vault }) => {
      const auditArgs = { filter, vault };
      try {
        const vaultErr = rejectNonDefaultVault(vault);
        if (vaultErr) {
          logRequest(
            "list_secrets",
            auditArgs,
            JSON.stringify(vaultErr).length,
            "error",
          );
          return vaultErr;
        }
        let secrets = await listSecrets(filter || undefined, { vault });
        secrets = await filterByScope(secrets);
        const out = json(secrets);
        logRequest("list_secrets", auditArgs, JSON.stringify(out).length, "ok");
        return out;
      } catch (error) {
        const out = err(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
        logRequest(
          "list_secrets",
          auditArgs,
          JSON.stringify(out).length,
          "error",
        );
        return out;
      }
    },
  );

  registerTool(
    "search_secrets",
    {
      description: "Fuzzy search for secrets by name",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        query: z.string().describe("Search query"),
        limit: z.number().optional().default(20).describe("Max results"),
        vault: VaultParam,
      }),
    },
    async ({ query, limit, vault }) => {
      const auditArgs = { query, limit, vault };
      try {
        const vaultErr = rejectNonDefaultVault(vault);
        if (vaultErr) {
          logRequest(
            "search_secrets",
            auditArgs,
            JSON.stringify(vaultErr).length,
            "error",
          );
          return vaultErr;
        }

        let secrets = await listSecrets(undefined, { vault });
        secrets = await filterByScope(secrets);
        const lowerQuery = query.toLowerCase();

        const scored = secrets
          .map((name) => {
            const lowerName = name.toLowerCase();
            let score = 0;
            let queryIdx = 0;
            for (const char of lowerName) {
              if (
                queryIdx < lowerQuery.length &&
                char === lowerQuery[queryIdx]
              ) {
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

        const out = json(scored);
        logRequest(
          "search_secrets",
          auditArgs,
          JSON.stringify(out).length,
          "ok",
        );
        return out;
      } catch (error) {
        const out = err(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
        logRequest(
          "search_secrets",
          auditArgs,
          JSON.stringify(out).length,
          "error",
        );
        return out;
      }
    },
  );

  registerTool(
    "get_secret",
    {
      description: "Get a secret value by name",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        name: z
          .string()
          .describe(
            'Secret name or path (e.g. "github-pat", "github-pat.login.password")',
          ),
        vault: VaultParam,
      }),
    },
    async ({ name, vault }) => {
      const auditArgs = { name, vault };
      try {
        const vaultErr = rejectNonDefaultVault(vault);
        if (vaultErr) {
          logRequest(
            "get_secret",
            auditArgs,
            JSON.stringify(vaultErr).length,
            "error",
          );
          return vaultErr;
        }

        const baseName = name.split(".")[0] || name;
        const item = await findScopedItem(baseName);
        if (!item) {
          const out = err(
            `Error: Secret "${baseName}" not found or not in allowed folder scope`,
          );
          logRequest(
            "get_secret",
            auditArgs,
            JSON.stringify(out).length,
            "error",
          );
          return out;
        }

        const value = await getSecret(name, { vault });
        const out = text(value);
        // Byte count only. The value never reaches the log.
        logRequest("get_secret", auditArgs, JSON.stringify(out).length, "ok");
        return out;
      } catch (error) {
        const out = err(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
        logRequest(
          "get_secret",
          auditArgs,
          JSON.stringify(out).length,
          "error",
        );
        return out;
      }
    },
  );

  registerTool(
    "get_secret_fields",
    {
      description: "Get all fields for a secret item",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        name: z.string().describe("Secret item name"),
        vault: VaultParam,
      }),
    },
    async ({ name, vault }) => {
      const auditArgs = { name, vault };
      try {
        const vaultErr = rejectNonDefaultVault(vault);
        if (vaultErr) {
          logRequest(
            "get_secret_fields",
            auditArgs,
            JSON.stringify(vaultErr).length,
            "error",
          );
          return vaultErr;
        }

        const item = await findScopedItem(name);
        if (!item) {
          const out = err(
            `Error: Secret "${name}" not found or not in allowed folder scope`,
          );
          logRequest(
            "get_secret_fields",
            auditArgs,
            JSON.stringify(out).length,
            "error",
          );
          return out;
        }

        const fields = await getSecretObject(name, { vault });
        const out = json(fields);
        logRequest(
          "get_secret_fields",
          auditArgs,
          JSON.stringify(out).length,
          "ok",
        );
        return out;
      } catch (error) {
        const out = err(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
        logRequest(
          "get_secret_fields",
          auditArgs,
          JSON.stringify(out).length,
          "error",
        );
        return out;
      }
    },
  );

  registerTool(
    "get_service",
    {
      description:
        "Get all vault items for a service (API credentials + per-host entries). Uses naming convention: SERVICE_API for shared credentials, service01/02/etc for hosts.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        service: z
          .string()
          .describe('Service name prefix (e.g. "proxmox", "redis", "github")'),
      }),
    },
    async ({ service }) => {
      const auditArgs = { service };
      try {
        const snapshot = await snapshotManager.load();
        if (!snapshot) {
          const out = err(
            "Error: No snapshot available. Run refresh_snapshot first.",
          );
          logRequest(
            "get_service",
            auditArgs,
            JSON.stringify(out).length,
            "error",
          );
          return out;
        }

        const allowedItems = snapshot.items.filter(isItemAllowed);
        const result = resolveService(service, allowedItems);

        if (result.itemCount === 0) {
          const out = err(
            `No items found for service "${service}". Check the service name or folder scope.`,
          );
          logRequest(
            "get_service",
            auditArgs,
            JSON.stringify(out).length,
            "error",
          );
          return out;
        }

        const out = json(result);
        logRequest("get_service", auditArgs, JSON.stringify(out).length, "ok");
        return out;
      } catch (error) {
        const out = err(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
        logRequest(
          "get_service",
          auditArgs,
          JSON.stringify(out).length,
          "error",
        );
        return out;
      }
    },
  );

  registerTool(
    "get_credential",
    {
      description:
        "Smart single-call credential lookup. Tries exact name match first, falls back to fuzzy search. Returns value, all fields, and item metadata in one response. Use this instead of chaining search_secrets -> get_secret_fields -> get_secret.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        query: z
          .string()
          .describe(
            'Secret name (exact) or search term (fuzzy). Examples: "n8n local", "grafana", "PostgreSQL n8n-ops"',
          ),
        field: z
          .string()
          .optional()
          .describe(
            'Specific field to extract (e.g. "login.password", "login.username", "notes"). Omit to get all fields.',
          ),
        vault: VaultParam,
      }),
    },
    async ({ query, field, vault }) => {
      const auditArgs = { query, field, vault };
      try {
        const vaultErr = rejectNonDefaultVault(vault);
        if (vaultErr) {
          logRequest(
            "get_credential",
            auditArgs,
            JSON.stringify(vaultErr).length,
            "error",
          );
          return vaultErr;
        }

        const outcome = await resolveCredential(query, field, {
          findScoped: async (name) => {
            const item = await findScopedItem(name);
            return item ? item.name : null;
          },
          listScoped: async () =>
            filterByScope(await listSecrets(undefined, { vault })),
          getSecret: (path) => getSecret(path, { vault }),
          getSecretObject: (name) => getSecretObject(name, { vault }),
        });
        const out = outcome.ok ? json(outcome.value) : err(outcome.error);
        // This is the exact call mcp2cli#71 caught leaking a private key into
        // an audit file. Byte count only — the resolved material never reaches
        // any log line here.
        logRequest(
          "get_credential",
          auditArgs,
          JSON.stringify(out).length,
          outcome.ok ? "ok" : "error",
        );
        return out;
      } catch (error) {
        const out = err(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
        logRequest(
          "get_credential",
          auditArgs,
          JSON.stringify(out).length,
          "error",
        );
        return out;
      }
    },
  );

  void subject; // reserved: write tools (authz-gated) are not ported in #112

  return server;
}

// ============================================================================
// Header/body validation — `Mcp-Method` / `Mcp-Name` (recipe §8)
// ============================================================================
//
// NOT IMPLEMENTED HERE ON PURPOSE. The SDK v2 handler validates header/body
// agreement itself and answers a mismatch with HTTP 400 + JSON-RPC -32020,
// including a `data.mismatch` detail naming both sides. Verified live on
// 2.0.0 this lane (see the note below); an earlier draft of this file
// hand-rolled ~90 lines of the same check, and a mutation test that disabled
// it still passed clause C — because the SDK was answering all along.
//
// Observed reply to a deliberate `Mcp-Name` mismatch:
//   HTTP 400
//   {"jsonrpc":"2.0","error":{"code":-32020,
//     "message":"Bad Request: the request headers and body disagree: the body
//                carries params.name=\"snapshot_info\" but the Mcp-Name header
//                names \"a_different_tool_name\"", "data":{"mismatch":{...}}},
//    "id":1}
//
// This corrects recipe §8, which reads as though a server author must
// implement the comparison. On the TS SDK, `createMcpHandler` owns it; a
// server that adds its own is duplicating a solved problem and risks
// diverging from the spec's decode-then-compare rules for base64-sentinel
// values.

// ============================================================================
// HTTP wiring
// ============================================================================

const app = new Hono();
app.use("*", cors());

app.get("/health", (c) =>
  c.json({
    status: "ok",
    transport: "mcp-streamable-http",
    protocol: "2026-07-28",
    variant: "v2-parallel",
    timestamp: new Date().toISOString(),
  }),
);

/**
 * One handler, both protocol eras.
 *
 * `legacy: 'stateless'` is the DEFAULT and is what makes this instance able to
 * eventually take ALL traffic: a 2026-07-28 request is answered per-request
 * with no session, and a 2025-era `initialize` is answered from the same
 * factory. Routing is body-driven.
 *
 * The documented limitation is deliberate and belongs in the cutover ticket,
 * not hidden here: the stateless legacy leg answers GET/DELETE with 405 and does
 * NOT preserve 2025 session semantics — pushed elicitation/sampling/roots,
 * resumability, replay, and session deletion are unavailable. v1's own clients
 * are simple request/response callers (mcp2cli, the skills), so this is believed
 * sufficient; that belief is PROPOSED and is what the cutover ticket must
 * verify against real traffic before the live service is retired.
 */
const mcpHandler = createMcpHandler(
  (ctx) => buildServer((ctx as any)?.subject ?? "unknown"),
  {
    legacy: "stateless",
    onerror: (error) => {
      // Reporting only. Message text of an SDK-level error, never a payload.
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          scope: "mcp-handler",
          message: error.message,
        }),
      );
    },
  },
);

app.all("/mcp", async (c) => {
  const subject = await authenticateRequest(c.req.raw);
  if (!subject) return c.json({ error: "Unauthorized" }, 401);

  // Everything past authentication belongs to the SDK handler: protocol-era
  // classification, header/body agreement (-32020), argument validation, and
  // the 405 answer to the 2025 session verbs GET/DELETE on a per-request
  // server. This route deliberately adds no parsing of its own — reading the
  // body here to re-check something the handler already checks is how the two
  // drift apart, and a duplicated check that silently never fires is worse
  // than none (it reads as coverage).
  return mcpHandler.fetch(c.req.raw);
});

// ============================================================================
// Start — PARALLEL PORT, never the live one
// ============================================================================

/**
 * Default 7142: inside the 7100-7199 local-development band, and deliberately
 * NOT 3001.
 *
 * Intended parallel port on the production host when a later ticket deploys this: **3011**.
 * Observed in use on that host 2026-08-09 (read-only `ss -lntp`): 3000 (REST),
 * 3001 (live MCP — untouchable), 3003. 3011 is free there and keeps the
 * 30xx grouping. Choosing it is PROPOSED; nothing in this branch deploys.
 */
const port = parseInt(process.env.MCP_V2_PORT || "7142", 10);
// Bind the literal, never the name "localhost": on macOS that resolves ::1
// first and the server ends up IPv6-only while every 127.0.0.1 client gets
// ECONNREFUSED (recipe §0-addendum-2).
const host = process.env.MCP_V2_HOST || "127.0.0.1";

if (port === 3001) {
  throw new Error(
    "refusing to start: 3001 is the LIVE vaultwarden-secrets MCP port. " +
      "This is the parallel v2 variant and must never bind the live port.",
  );
}

console.log("");
console.log("━".repeat(48));
console.log("MCP Server: vaultwarden-secrets v2 (PARALLEL VARIANT)");
console.log("Protocol:   2026-07-28 + 2025-era (legacy: stateless)");
console.log(`Endpoint:   http://${host}:${port}/mcp`);
console.log(`Profile:    ${profile.name}`);
console.log("Live 3001:  untouched — this is a separate process");
console.log("━".repeat(48));
console.log("");

export default {
  port,
  hostname: host,
  fetch: app.fetch,
};
