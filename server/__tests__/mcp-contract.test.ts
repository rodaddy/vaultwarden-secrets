/**
 * MCP compatibility contract tests (issue #23, Phase 0).
 *
 * These tests pin the *current* wire contract of the MCP service so that any
 * runtime redesign (#14) or cutover (#22) can be shadow-checked against a
 * frozen baseline. They boot the REAL `server/mcp.ts` module as a subprocess
 * on an ephemeral loopback port with a fake bearer token and the
 * `feeling-lucky` profile (empty folderScope → no vault calls at startup),
 * then drive it over local HTTP using the JSON-response Streamable HTTP mode.
 *
 * Offline guarantees:
 * - No live vault: `feeling-lucky` has an empty folderScope, so the server's
 *   `initProfileFolderScope()` returns early and never invokes the BW CLI.
 * - No network: everything is loopback (127.0.0.1) on an ephemeral port.
 * - No secrets: the only token is an obviously-fake constant; no read tool that
 *   touches the vault is exercised for its payload — only contract SHAPES
 *   (tool list, schemas, JSON-RPC error envelopes) are asserted.
 *
 * Tools that read/write the vault (get_secret, list_secrets, get_service, …)
 * are NOT driven for real payloads here; doing so would require a live session.
 * Their INPUT contract (name, required fields) is pinned from tools/list, and
 * their runtime error behavior is documented in docs/compat/mcp-baseline.md.
 *
 * @module server/__tests__/mcp-contract
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";

// ---------------------------------------------------------------------------
// Test harness: boot the real mcp.ts as a subprocess
// ---------------------------------------------------------------------------

const FAKE_TOKEN = "contract-test-token-abc";
const HOST = "127.0.0.1";
// Ephemeral-ish port in the dynamic range; unlikely to collide in CI.
const PORT = 39000 + Math.floor(Math.random() * 900);
const BASE = `http://${HOST}:${PORT}/mcp`;
const HEALTH = `http://${HOST}:${PORT}/health`;

const JSON_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
const AUTH_HEADERS = { ...JSON_HEADERS, Authorization: `Bearer ${FAKE_TOKEN}` };

let proc: Subprocess;

/** Parse a Streamable-HTTP response body that may be JSON or an SSE frame. */
function parseEnvelope(raw: string): any {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("["))
    return JSON.parse(trimmed);
  // SSE fallback: last `data:` line carries the JSON-RPC payload.
  const dataLine = trimmed
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("data:"));
  if (!dataLine) throw new Error(`Unparseable envelope: ${raw.slice(0, 120)}`);
  return JSON.parse(dataLine.slice("data:".length).trim());
}

async function rpc(
  method: string,
  params: unknown,
  sessionId?: string,
  headers: Record<string, string> = AUTH_HEADERS,
  id: number | string = 1,
): Promise<{ status: number; sessionId: string | null; body: any }> {
  const h: Record<string, string> = { ...headers };
  if (sessionId) h["mcp-session-id"] = sessionId;
  const isNotification = method.startsWith("notifications/");
  const payload: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (!isNotification) payload.id = id;
  if (params !== undefined) payload.params = params;

  const res = await fetch(BASE, {
    method: "POST",
    headers: h,
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return {
    status: res.status,
    sessionId: res.headers.get("mcp-session-id"),
    body: text ? parseEnvelope(text) : null,
  };
}

/** Full initialize handshake; returns the session id for subsequent calls. */
async function initSession(): Promise<string> {
  const init = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "contract-test", version: "1.0" },
  });
  expect(init.status).toBe(200);
  const sid = init.sessionId;
  if (!sid) throw new Error("No session id from initialize");
  await rpc("notifications/initialized", undefined, sid);
  return sid;
}

beforeAll(async () => {
  proc = Bun.spawn(["bun", "run", "server/mcp.ts"], {
    cwd: new URL("../../", import.meta.url).pathname,
    env: {
      ...process.env,
      API_TOKEN_CONTRACT: FAKE_TOKEN,
      SECURITY_PROFILE: "feeling-lucky",
      MCP_PORT: String(PORT),
      MCP_HOST: HOST,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for the health endpoint to come up (bounded).
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(HEALTH, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(150);
  }
  throw new Error("MCP server did not become healthy within 8s");
});

afterAll(() => {
  proc?.kill();
});

// ---------------------------------------------------------------------------
// Baseline: the frozen tool contract for SECURITY_PROFILE with allowWrites.
// feeling-lucky exposes the full 10-tool superset (6 read + 4 write).
// ---------------------------------------------------------------------------

const READ_TOOLS = [
  "search_secrets",
  "get_secret",
  "get_secret_fields",
  "list_secrets",
  "snapshot_info",
  "get_service",
] as const;

const WRITE_TOOLS = [
  "refresh_snapshot",
  "create_secret",
  "update_secret",
  "delete_secret",
] as const;

const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];

/** Required input fields per tool, pinned from the live JSON schema. */
const REQUIRED_INPUT: Record<string, string[]> = {
  search_secrets: ["query"],
  get_secret: ["name"],
  get_secret_fields: ["name"],
  list_secrets: [],
  snapshot_info: [],
  get_service: ["service"],
  refresh_snapshot: [],
  create_secret: ["name"],
  update_secret: ["name"],
  delete_secret: ["name"],
};

// ---------------------------------------------------------------------------
// Health / transport
// ---------------------------------------------------------------------------

describe("MCP transport & health", () => {
  test("health endpoint reports mcp-streamable-http", async () => {
    const res = await fetch(HEALTH);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.transport).toBe("mcp-streamable-http");
  });

  test("initialize returns protocol version and a session id", async () => {
    const init = await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "contract-test", version: "1.0" },
    });
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();
    expect(init.body.result.protocolVersion).toBe("2025-03-26");
    expect(init.body.result.capabilities.tools).toBeDefined();
    expect(init.body.result.serverInfo.name).toBe("vaultwarden-secrets");
  });
});

// ---------------------------------------------------------------------------
// Authorization contract
// ---------------------------------------------------------------------------

describe("authorization contract", () => {
  test("missing bearer token → 401 Unauthorized", async () => {
    const res = await fetch(BASE, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("invalid bearer token → 401 Unauthorized", async () => {
    const res = await rpc(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
      undefined,
      { ...JSON_HEADERS, Authorization: "Bearer wrong-token-xyz" },
    );
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });
});

// ---------------------------------------------------------------------------
// tools/list contract
// ---------------------------------------------------------------------------

describe("tools/list contract", () => {
  let tools: Array<{ name: string; description?: string; inputSchema: any }>;

  beforeAll(async () => {
    const sid = await initSession();
    const res = await rpc("tools/list", {}, sid, AUTH_HEADERS, 2);
    expect(res.status).toBe(200);
    tools = res.body.result.tools;
  });

  test("exposes exactly the 10 baseline tools", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...ALL_TOOLS].sort());
  });

  test("all read tools are present", () => {
    const names = new Set(tools.map((t) => t.name));
    for (const t of READ_TOOLS) expect(names.has(t)).toBe(true);
  });

  test("all write tools are present (allowWrites profile)", () => {
    const names = new Set(tools.map((t) => t.name));
    for (const t of WRITE_TOOLS) expect(names.has(t)).toBe(true);
  });

  test("each tool carries a JSON-schema inputSchema of type object", () => {
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  test("required input fields match the frozen baseline", () => {
    for (const tool of tools) {
      const required: string[] = tool.inputSchema.required ?? [];
      const expected = REQUIRED_INPUT[tool.name] ?? [];
      expect(required.sort()).toEqual([...expected].sort());
    }
  });

  test("write tool schemas expose the custom-fields contract", () => {
    const create = tools.find((t) => t.name === "create_secret")!;
    expect(create.inputSchema.properties.fields).toBeDefined();
    expect(create.inputSchema.properties.type).toBeDefined();
    const update = tools.find((t) => t.name === "update_secret")!;
    expect(update.inputSchema.properties.fields).toBeDefined();
    expect(update.inputSchema.properties.fieldStrategy).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Error-envelope contract (JSON-RPC level)
// ---------------------------------------------------------------------------

describe("error envelope contract", () => {
  let sid: string;
  beforeAll(async () => {
    sid = await initSession();
  });

  test("unknown tool → JSON-RPC error (not a thrown 500)", async () => {
    const res = await rpc(
      "tools/call",
      { name: "no_such_tool", arguments: {} },
      sid,
      AUTH_HEADERS,
      10,
    );
    expect(res.status).toBe(200);
    // MCP SDK reports unknown tools as a JSON-RPC error object.
    expect(res.body.error ?? res.body.result?.isError).toBeTruthy();
  });

  test("bad args (missing required field) → error, never a silent success", async () => {
    // get_secret requires `name`; omit it.
    const res = await rpc(
      "tools/call",
      { name: "get_secret", arguments: {} },
      sid,
      AUTH_HEADERS,
      11,
    );
    expect(res.status).toBe(200);
    expect(res.body.error ?? res.body.result?.isError).toBeTruthy();
  });

  test("unknown method → JSON-RPC error envelope", async () => {
    const res = await rpc("this/does-not-exist", {}, sid, AUTH_HEADERS, 12);
    expect(res.status).toBe(200);
    expect(res.body.error).toBeDefined();
    expect(typeof res.body.error.code).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Read-tool envelope shape (offline: no vault payload asserted)
// ---------------------------------------------------------------------------

describe("read-tool response envelope", () => {
  let sid: string;
  beforeAll(async () => {
    sid = await initSession();
  });

  test("snapshot_info returns a text-content envelope (no secrets asserted)", async () => {
    // With no snapshot present offline this returns either "No snapshot exists"
    // or an error envelope; both are valid MCP content shapes. We assert only
    // the envelope structure, never a payload value.
    const res = await rpc(
      "tools/call",
      { name: "snapshot_info", arguments: {} },
      sid,
      AUTH_HEADERS,
      20,
    );
    expect(res.status).toBe(200);
    const result = res.body.result;
    expect(result).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0].type).toBe("text");
    expect(typeof result.content[0].text).toBe("string");
  });
});
