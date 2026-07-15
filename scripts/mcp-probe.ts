#!/usr/bin/env bun
/**
 * Non-secret MCP health probe (issue #23, Phase 0).
 *
 * Performs an MCP `initialize` handshake and a `tools/list` call against a
 * Streamable-HTTP MCP endpoint and reports health. Suitable for cron, systemd
 * timers, and cutover gates. Prints ONLY redacted, non-secret metadata:
 * tool COUNT and tool NAMES (which are public contract, not secrets). It never
 * calls any vault read/write tool and never prints a payload value.
 *
 * Configuration (env):
 *   VW_MCP_BASE_URL   Base MCP URL, e.g. http://the-production-host:3001/mcp
 *                     A bare origin (…:3001) is accepted; `/mcp` is appended.
 *   VW_MCP_TOKEN      Optional bearer token. If unset, the probe verifies that
 *                     the endpoint enforces auth (401) and reports AUTH_ENFORCED.
 *                     AUTH_ENFORCED is NOT full health — a real cutover gate
 *                     must probe WITH a token and require HEALTHY.
 *   VW_MCP_TIMEOUT_MS Per-request timeout (default 5000).
 *
 * Flags:
 *   --allow-auth-enforced   Treat AUTH_ENFORCED as success (exit 0). By default
 *                           AUTH_ENFORCED exits 5 so an un-tokened probe cannot
 *                           silently pass a health gate that intends HEALTHY.
 *
 * Exit-code contract (documented for cutover gates):
 *   0  HEALTHY        initialize + tools/list succeeded; tool count > 0.
 *   5  AUTH_ENFORCED  no token supplied and endpoint returned 401 (auth is up).
 *                     Only becomes exit 0 with --allow-auth-enforced.
 *   2  UNHEALTHY      endpoint reachable but handshake/list failed or empty.
 *   3  UNREACHABLE    connection/timeout/DNS failure.
 *   4  CONFIG_ERROR   missing/invalid VW_MCP_BASE_URL.
 */

export {}; // ensure this file is treated as a module (top-level await)

const EXIT = {
  HEALTHY: 0,
  UNHEALTHY: 2,
  UNREACHABLE: 3,
  CONFIG_ERROR: 4,
  AUTH_ENFORCED: 5,
} as const;

const ALLOW_AUTH_ENFORCED = process.argv.includes("--allow-auth-enforced");

interface ProbeResult {
  ok: boolean;
  status:
    | "HEALTHY"
    | "AUTH_ENFORCED"
    | "UNHEALTHY"
    | "UNREACHABLE"
    | "CONFIG_ERROR";
  detail: string;
  toolCount?: number;
  toolNames?: string[];
}

function resolveUrl(): string {
  const raw = process.env.VW_MCP_BASE_URL?.trim();
  if (!raw) throw new Error("VW_MCP_BASE_URL is not set");
  const u = new URL(raw); // throws on invalid
  if (!/\/mcp\/?$/.test(u.pathname)) {
    u.pathname = u.pathname.replace(/\/$/, "") + "/mcp";
  }
  return u.toString();
}

function jsonHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function parseEnvelope(raw: string): any {
  const t = raw.trim();
  if (t.startsWith("{") || t.startsWith("[")) return JSON.parse(t);
  const dataLine = t
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("data:"));
  if (!dataLine) throw new Error("Unparseable MCP envelope");
  return JSON.parse(dataLine.slice("data:".length).trim());
}

async function probe(): Promise<ProbeResult> {
  let url: string;
  try {
    url = resolveUrl();
  } catch (e) {
    return { ok: false, status: "CONFIG_ERROR", detail: (e as Error).message };
  }

  const token = process.env.VW_MCP_TOKEN?.trim() || undefined;
  const timeoutMs = parseInt(process.env.VW_MCP_TIMEOUT_MS || "5000", 10);
  const headers = jsonHeaders(token);

  // 1) initialize
  let initRes: Response;
  try {
    initRes = await fetch(url, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "mcp-probe", version: "1.0" },
        },
      }),
    });
  } catch (e) {
    return {
      ok: false,
      status: "UNREACHABLE",
      detail: `initialize: ${(e as Error).message}`,
    };
  }

  if (initRes.status === 401) {
    if (!token) {
      // No token supplied but auth is enforced → the auth layer is healthy.
      return {
        ok: true,
        status: "AUTH_ENFORCED",
        detail: "endpoint enforces bearer auth (401)",
      };
    }
    return {
      ok: false,
      status: "UNHEALTHY",
      detail: "supplied token rejected (401)",
    };
  }
  if (!initRes.ok) {
    return {
      ok: false,
      status: "UNHEALTHY",
      detail: `initialize HTTP ${initRes.status}`,
    };
  }

  const sessionId = initRes.headers.get("mcp-session-id");
  if (!sessionId) {
    return {
      ok: false,
      status: "UNHEALTHY",
      detail: "no mcp-session-id on initialize",
    };
  }

  // 2) notifications/initialized (complete handshake)
  try {
    await fetch(url, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
  } catch (e) {
    return {
      ok: false,
      status: "UNHEALTHY",
      detail: `initialized notif: ${(e as Error).message}`,
    };
  }

  // 3) tools/list
  let listRes: Response;
  try {
    listRes = await fetch(url, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
  } catch (e) {
    return {
      ok: false,
      status: "UNREACHABLE",
      detail: `tools/list: ${(e as Error).message}`,
    };
  }
  if (!listRes.ok) {
    return {
      ok: false,
      status: "UNHEALTHY",
      detail: `tools/list HTTP ${listRes.status}`,
    };
  }

  let body: any;
  try {
    body = parseEnvelope(await listRes.text());
  } catch (e) {
    return {
      ok: false,
      status: "UNHEALTHY",
      detail: `tools/list parse: ${(e as Error).message}`,
    };
  }

  const tools: Array<{ name: string }> = body?.result?.tools ?? [];
  if (!Array.isArray(tools) || tools.length === 0) {
    return {
      ok: false,
      status: "UNHEALTHY",
      detail: "tools/list returned no tools",
    };
  }

  const toolNames = tools.map((t) => t.name).sort();
  return {
    ok: true,
    status: "HEALTHY",
    detail: "initialize + tools/list ok",
    toolCount: toolNames.length,
    toolNames,
  };
}

// Tool names are public contract (never secret); safe to print.
const result = await probe();
console.log(JSON.stringify(result));

// The process exit code is the source of truth for gates. Do not wrap this in a
// shell that appends `; echo $?` on the same line — a trailing echo would exit 0
// and mask this code. Gates read the exit code directly.
switch (result.status) {
  case "HEALTHY":
    process.exit(EXIT.HEALTHY);
  case "AUTH_ENFORCED":
    process.exit(ALLOW_AUTH_ENFORCED ? EXIT.HEALTHY : EXIT.AUTH_ENFORCED);
  case "UNREACHABLE":
    process.exit(EXIT.UNREACHABLE);
  case "CONFIG_ERROR":
    process.exit(EXIT.CONFIG_ERROR);
  default:
    process.exit(EXIT.UNHEALTHY);
}
