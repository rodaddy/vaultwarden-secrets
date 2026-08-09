/**
 * MCP 2026-07-28 (SDK v2) stateless streamable-HTTP variant.
 *
 * ADDITIVE AND UNWIRED BY DESIGN. This module does NOT replace `server/mcp.ts`,
 * does not bind a port on import, and is not referenced by any systemd unit.
 * The live deployment (CT 109 `vaultwarden-secrets-mcp.service`, :3002, SDK v1)
 * is untouched by this file's existence. Wiring/deployment is a separate
 * ticket's decision.
 *
 * Truth state: WRITTEN + locally RUNNING under `bun test`. NOT deployed.
 *
 * Why a parallel module instead of an in-place port (recipe §4): the v1 server
 * is sessionful (`transports` map + auto-reconnect). The sanctioned pattern for
 * an existing sessionful deployment is additive — leave the sessionful path
 * alone, add a modern `createMcpHandler` entry, and route on `isLegacyRequest`.
 * This file supplies the modern leg and the router; it does not remove the
 * legacy one.
 *
 * ---------------------------------------------------------------------------
 * Behaviors below were PROBED against `@modelcontextprotocol/server@2.0.0` on
 * 2026-08-09 (bun), not copied from documentation:
 *
 *  1. `server.tool()` DOES NOT EXIST in v2 — it is `registerTool(name, config,
 *     handler)`. A v1->v2 port that keeps `.tool()` fails at request time, not
 *     at import time: the factory throws inside `serveModern`, which the
 *     handler converts to an opaque `-32603 Internal server error`. The tool
 *     list looks empty rather than broken. Pass `{ onerror }` to see the real
 *     cause. This is NOT in the migration recipe; it is the first wall.
 *  2. `inputSchema` MUST be a Zod/Standard Schema — a raw JSON Schema object
 *     (`{type:"object",properties:{...},additionalProperties:false}`) is
 *     REJECTED with "must be a Standard Schema ... or a raw Zod shape", again
 *     surfacing as -32603. Strictness is therefore expressed as
 *     `z.object({...}).strict()`, which emits `additionalProperties:false` into
 *     the advertised 2020-12 schema AND keeps the flat argument wire shape
 *     (handler receives `{name}`, not `{args:{name}}`) — the shape constraint
 *     the recipe's dev#110 addendum requires.
 *  3. The permissive-schema SILENT PARAM DROP reproduces in TypeScript. A bare
 *     `z.object({...})` (or raw Zod shape) accepts and silently discards an
 *     undeclared property, returning success. The recipe recorded this for
 *     Python only; it is cross-language. With `.strict()` the undeclared param
 *     becomes `isError:true` — a TOOL-EXECUTION error the model can correct
 *     (recipe §6), not a protocol error.
 *  4. Handshake-free `tools/call` works: a single POST carrying the `_meta`
 *     version envelope returns `resultType:"complete"` with no `initialize`
 *     and no `Mcp-Session-Id`.
 *  5. Header/body mismatch returns HTTP 400 + JSON-RPC `-32020` with a `data`
 *     mismatch payload — the renumbered `HeaderMismatch` (recipe §7).
 *  6. GET is answered `405` by the modern leg (recipe §4).
 *
 * AUDIT SAFETY (mcp2cli#71): this module logs tool NAMES, param KEY names, and
 * byte counts only. It never logs an argument value, a response body, or any
 * credential material.
 *
 * @module server/mcp-v2
 */

import {
  createMcpHandler,
  McpServer,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import { z } from "zod";

/** Server identity advertised on the modern leg. */
export const V2_SERVER_INFO = {
  name: "vaultwarden-secrets",
  version: "0.7.0",
} as const;

/**
 * Redaction-safe audit record for one modern tool call.
 *
 * Deliberately carries NO values: `paramKeys` are key names only and
 * `argsBytes` is the serialized length. This is the shape mcp2cli#71 permits.
 */
export interface V2AuditRecord {
  tool: string;
  paramKeys: string[];
  argsBytes: number;
}

/**
 * Build an audit record from raw tool arguments without retaining any value.
 *
 * @param tool - Tool name being invoked.
 * @param args - Raw argument object; values are measured, never copied.
 * @returns Key names and a byte count only.
 */
export function auditRecord(tool: string, args: unknown): V2AuditRecord {
  const isPlainObject =
    typeof args === "object" && args !== null && !Array.isArray(args);
  return {
    tool,
    paramKeys: isPlainObject ? Object.keys(args as object).sort() : [],
    argsBytes: args === undefined ? 0 : JSON.stringify(args).length,
  };
}

/**
 * A tool exposed on the modern leg.
 *
 * `inputSchema` is a strict Zod object so that undeclared properties are
 * rejected instead of silently dropped (see module note 3).
 */
export interface V2ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  readOnly: boolean;
  handler: (args: Record<string, unknown>, subject: string) => Promise<unknown>;
}

/**
 * Assert a tool's schema actually REJECTS an undeclared property.
 *
 * A non-strict schema is a silent-data-loss defect on a SECRETS server: a
 * caller's typo'd parameter is discarded and the tool runs with defaults rather
 * than refusing. Fail at construction, not at request time.
 *
 * The check is BEHAVIORAL, and it has to be. On Zod 4 (4.3.6 here)
 * `z.toJSONSchema()` emits `additionalProperties: false` for a PERMISSIVE
 * `z.object({...})` as well as for a `.strict()` one — the advertised schema is
 * identical while the runtime behavior is not. Introspecting the emitted JSON
 * Schema therefore passes a permissive schema through, which is the exact
 * silent-drop defect this guard exists to prevent. Verified 2026-08-09:
 * `z.object({a}).safeParse({a,b})` succeeds and returns `{a}` with `b` dropped,
 * while the `.strict()` variant fails. So: probe with a sentinel key instead.
 *
 * @param name - Tool name, for the error message.
 * @param schema - Candidate input schema.
 * @returns The emitted JSON Schema.
 * @throws If the schema accepts (and silently drops) an undeclared property.
 */
export function assertStrictSchema(
  name: string,
  schema: z.ZodObject<z.ZodRawShape>,
): Record<string, unknown> {
  // A key no real tool declares; only its ACCEPTANCE is meaningful.
  const sentinel = "__vw_strictness_probe__";
  const probe = schema.safeParse({ [sentinel]: true });

  // The probe is expected to fail — either because the sentinel is rejected
  // (strict) or because required fields are missing (also a failure). Only a
  // failure that does NOT mention the sentinel while the sentinel was dropped
  // indicates permissiveness, so inspect the parsed data when it succeeded.
  const acceptsUndeclared =
    probe.success && !(sentinel in (probe.data as Record<string, unknown>));

  // When required fields make the sentinel-only probe fail, re-probe with the
  // declared keys filled in so the ONLY reason to fail is the sentinel.
  let permissive = acceptsUndeclared;
  if (!probe.success) {
    const filled: Record<string, unknown> = { [sentinel]: true };
    for (const key of Object.keys(schema.shape)) filled[key] = "probe";
    const second = schema.safeParse(filled);
    permissive =
      second.success && !(sentinel in (second.data as Record<string, unknown>));
  }

  if (permissive) {
    throw new Error(
      `tool "${name}": inputSchema must be strict (z.object({...}).strict()); ` +
        `a permissive schema silently drops undeclared params`,
    );
  }

  return z.toJSONSchema(schema) as Record<string, unknown>;
}

/**
 * Build the modern (2026-07-28) MCP server for one authenticated subject.
 *
 * Invoked PER REQUEST by `createMcpHandler`. Anything closed over here is
 * per-request state; shared resources (DB pools, the snapshot manager) must be
 * created outside the factory (recipe §2b).
 *
 * @param tools - Tool definitions to register.
 * @param subject - Resolved workload identity, forwarded to each handler.
 * @param onAudit - Optional redaction-safe audit sink (names/counts only).
 */
export function createV2Server(
  tools: V2ToolDef[],
  subject: string,
  onAudit?: (rec: V2AuditRecord) => void,
): McpServer {
  const server = new McpServer(V2_SERVER_INFO);

  for (const tool of tools) {
    // Fail closed at build time if a schema is permissive.
    assertStrictSchema(tool.name, tool.inputSchema);

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.readOnly
          ? { readOnlyHint: true }
          : { destructiveHint: true },
      },
      async (args: Record<string, unknown>) => {
        onAudit?.(auditRecord(tool.name, args));
        try {
          const result = await tool.handler(args, subject);
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result, null, 2) },
            ],
          };
        } catch (error) {
          // Tool-execution error (recipe §6): the model can self-correct.
          // Deliberately NOT a protocol error. The message carries the failure
          // reason only — never an argument value or vault material.
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true as const,
          };
        }
      },
    );
  }

  return server;
}

/** Options for {@link createV2Handler}. */
export interface V2HandlerOptions {
  /** Resolve a request to a subject; return null to reject with 401. */
  authenticate: (req: Request) => Promise<string | null>;
  tools: V2ToolDef[];
  onAudit?: (rec: V2AuditRecord) => void;
  /** Surfaces factory/handler faults that would otherwise be opaque -32603. */
  onerror?: (err: unknown) => void;
}

/**
 * Create the modern-leg fetch handler.
 *
 * Auth is enforced BEFORE the MCP handler sees the request, matching the v1
 * `/mcp` boundary: an unauthenticated caller gets 401 and never reaches a
 * factory. Because the modern leg is stateless, there is no session to bind the
 * subject to — it is resolved per request and closed over per request.
 */
export function createV2Handler(options: V2HandlerOptions): {
  fetch: (req: Request) => Promise<Response>;
  close: () => Promise<void>;
} {
  // One handler; the factory runs per request and reads the subject resolved
  // for THAT request via the closure below.
  let currentSubject = "";

  const handler = createMcpHandler(
    () => createV2Server(options.tools, currentSubject, options.onAudit),
    options.onerror ? { onerror: options.onerror } : undefined,
  );

  return {
    async fetch(req: Request): Promise<Response> {
      const subject = await options.authenticate(req);
      if (!subject) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      currentSubject = subject;
      return handler.fetch(req);
    },
    close: () => handler.close(),
  };
}

/**
 * Route one request between the legacy (sessionful, SDK v1) leg and the modern
 * (stateless, 2026-07-28) leg — recipe §4's additive dual-stack pattern.
 *
 * `isLegacyRequest(request, body)` is true when the request carries no modern
 * `_meta` version claim, which is exactly the existing deployment's traffic.
 * Keeping the legacy leg is REQUIRED, not optional: today's clients still open
 * sessions, and load-balancer session affinity must stay in place for them.
 *
 * `isLegacyRequest` returns a PROMISE, not a boolean. Calling it without
 * `await` yields a truthy Promise, so a naive `isLegacyRequest(...) ? ... : ...`
 * classifies EVERY request as legacy — including modern ones — and silently
 * routes 2026-07-28 traffic into the sessionful leg. Caught here by the
 * era-routing test; this function is async for that reason.
 *
 * @returns "legacy" or "modern".
 */
export async function routeEra(
  req: Request,
  body: unknown,
): Promise<"legacy" | "modern"> {
  return (await isLegacyRequest(req, body)) ? "legacy" : "modern";
}
