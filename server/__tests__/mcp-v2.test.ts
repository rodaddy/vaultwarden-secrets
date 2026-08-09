/**
 * Contract tests for the MCP 2026-07-28 (SDK v2) stateless variant.
 *
 * These drive `server/mcp-v2.ts` through the real
 * `@modelcontextprotocol/server@2.0.0` handler — no protocol mocking — so a
 * green run is evidence the wire behavior holds on the installed SDK, not that
 * a stub agreed with itself.
 *
 * SAFETY: every tool here is a STUB over in-memory fixtures. No vault session,
 * no `bw` invocation, no credential material, no network. The live CT 109
 * deployment is not contacted.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  assertStrictSchema,
  auditRecord,
  createV2Handler,
  routeEra,
  type V2AuditRecord,
  type V2ToolDef,
} from "../mcp-v2";

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

const GOOD_TOKEN = "Bearer test-subject-token";

/** Non-secret stub standing in for a vault read. */
const stubTools: V2ToolDef[] = [
  {
    name: "get_secret",
    description: "Stub read tool",
    inputSchema: z.object({ name: z.string() }).strict(),
    readOnly: true,
    handler: async ({ name }, subject) => ({
      name,
      subject,
      value: "STUB-NOT-A-SECRET",
    }),
  },
  {
    name: "explode",
    description: "Stub tool that always throws",
    inputSchema: z.object({}).strict(),
    readOnly: true,
    handler: async () => {
      throw new Error("upstream unavailable");
    },
  },
];

function buildHandler(audits: V2AuditRecord[] = []) {
  return createV2Handler({
    authenticate: async (req) =>
      req.headers.get("Authorization") === GOOD_TOKEN ? "test-subject" : null,
    tools: stubTools,
    onAudit: (rec) => audits.push(rec),
    onerror: (e) => {
      // Surface factory faults; an opaque -32603 otherwise hides the cause.
      console.error("v2 handler error:", (e as Error)?.message);
    },
  });
}

async function post(
  handler: { fetch: (r: Request) => Promise<Response> },
  body: unknown,
  headers: Record<string, string> = {},
) {
  const res = await handler.fetch(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: GOOD_TOKEN,
        "MCP-Protocol-Version": "2026-07-28",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return {
    status: res.status,
    json: text ? JSON.parse(text) : null,
    sessionHeader: res.headers.get("mcp-session-id"),
  };
}

const callBody = (
  id: number,
  name: string,
  args: Record<string, unknown> = {},
) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args, _meta: MODERN_META },
});

describe("handshake-free tools/call", () => {
  test("a single POST returns a result with no initialize and no session id", async () => {
    const handler = buildHandler();
    const res = await post(handler, callBody(1, "get_secret", { name: "x" }), {
      "Mcp-Method": "tools/call",
      "Mcp-Name": "get_secret",
    });

    expect(res.status).toBe(200);
    expect(res.json.error).toBeUndefined();
    expect(res.json.result.resultType).toBe("complete");
    // Stateless: the server must never mint or echo a session id.
    expect(res.sessionHeader).toBeNull();
    await handler.close();
  });

  test("tools/list advertises the strict 2020-12 schema", async () => {
    const handler = buildHandler();
    const res = await post(
      handler,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: { _meta: MODERN_META },
      },
      { "Mcp-Method": "tools/list" },
    );

    expect(res.status).toBe(200);
    const tool = res.json.result.tools.find(
      (t: { name: string }) => t.name === "get_secret",
    );
    expect(tool.inputSchema.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(tool.inputSchema.additionalProperties).toBe(false);
    await handler.close();
  });
});

describe("strict schemas", () => {
  test("an undeclared param is rejected as a tool-execution error, not dropped", async () => {
    const handler = buildHandler();
    const res = await post(
      handler,
      callBody(3, "get_secret", { name: "x", bogus: "surprise" }),
      { "Mcp-Method": "tools/call", "Mcp-Name": "get_secret" },
    );

    expect(res.status).toBe(200);
    // Tool-execution channel (isError), NOT a protocol error: the model can retry.
    expect(res.json.result.isError).toBe(true);
    expect(res.json.error).toBeUndefined();
    expect(res.json.result.content[0].text).toContain("bogus");
    await handler.close();
  });

  test("the declared param still resolves with a flat argument shape", async () => {
    const handler = buildHandler();
    const res = await post(
      handler,
      callBody(4, "get_secret", { name: "abc" }),
      {
        "Mcp-Method": "tools/call",
        "Mcp-Name": "get_secret",
      },
    );

    const payload = JSON.parse(res.json.result.content[0].text);
    // Flat, not nested under `args` — the wire shape existing clients expect.
    expect(payload.name).toBe("abc");
    expect(payload.subject).toBe("test-subject");
    await handler.close();
  });

  test("assertStrictSchema rejects a permissive schema at build time", () => {
    expect(() =>
      assertStrictSchema("loose", z.object({ a: z.string() })),
    ).toThrow(/must be strict/);
    expect(() =>
      assertStrictSchema("tight", z.object({ a: z.string() }).strict()),
    ).not.toThrow();
  });
});

describe("-32020 header mismatch", () => {
  test("Mcp-Name disagreeing with the body is rejected 400 / -32020", async () => {
    const handler = buildHandler();
    const res = await post(handler, callBody(5, "get_secret", { name: "x" }), {
      "Mcp-Method": "tools/call",
      "Mcp-Name": "explode", // header names a different tool than the body
    });

    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe(-32020);
    await handler.close();
  });

  test("matching headers are accepted (mutation control for the test above)", async () => {
    const handler = buildHandler();
    const res = await post(handler, callBody(6, "get_secret", { name: "x" }), {
      "Mcp-Method": "tools/call",
      "Mcp-Name": "get_secret",
    });

    expect(res.status).toBe(200);
    expect(res.json.error).toBeUndefined();
    await handler.close();
  });
});

describe("error channels", () => {
  test("a throwing tool yields isError, not a protocol error", async () => {
    const handler = buildHandler();
    const res = await post(handler, callBody(7, "explode"), {
      "Mcp-Method": "tools/call",
      "Mcp-Name": "explode",
    });

    expect(res.status).toBe(200);
    expect(res.json.error).toBeUndefined();
    expect(res.json.result.isError).toBe(true);
    expect(res.json.result.content[0].text).toContain("upstream unavailable");
    await handler.close();
  });
});

describe("auth boundary", () => {
  test("an unauthenticated request is 401 and never reaches a tool", async () => {
    const audits: V2AuditRecord[] = [];
    const handler = buildHandler(audits);
    const res = await handler.fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(callBody(8, "get_secret", { name: "x" })),
      }),
    );

    expect(res.status).toBe(401);
    expect(audits).toHaveLength(0);
    await handler.close();
  });
});

describe("stateless transport rules", () => {
  test("GET is answered 405 by the modern leg", async () => {
    const handler = buildHandler();
    const res = await handler.fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "GET",
        headers: { Authorization: GOOD_TOKEN },
      }),
    );

    expect(res.status).toBe(405);
    await handler.close();
  });
});

describe("era routing", () => {
  test("a body with no modern _meta claim routes legacy", async () => {
    const req = new Request("http://127.0.0.1/mcp", { method: "POST" });
    const legacyBody = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {} },
    };
    expect(await routeEra(req, legacyBody)).toBe("legacy");
  });

  test("a body carrying the modern _meta claim routes modern", async () => {
    const req = new Request("http://127.0.0.1/mcp", { method: "POST" });
    expect(await routeEra(req, callBody(1, "get_secret", { name: "x" }))).toBe(
      "modern",
    );
  });

  // Regression guard: `isLegacyRequest` is async. An unawaited call returns a
  // truthy Promise, which classifies modern traffic as legacy and routes
  // 2026-07-28 requests into the sessionful leg.
  test("routeEra is async and does not leak a Promise into the verdict", async () => {
    const req = new Request("http://127.0.0.1/mcp", { method: "POST" });
    const verdict = routeEra(req, callBody(1, "get_secret", { name: "x" }));
    expect(verdict).toBeInstanceOf(Promise);
    expect(await verdict).toBe("modern");
  });
});

describe("audit safety (mcp2cli#71)", () => {
  test("the audit record carries key names and byte counts, never values", async () => {
    const audits: V2AuditRecord[] = [];
    const handler = buildHandler(audits);
    await post(
      handler,
      callBody(9, "get_secret", { name: "super-secret-item-name" }),
      { "Mcp-Method": "tools/call", "Mcp-Name": "get_secret" },
    );

    expect(audits).toHaveLength(1);
    expect(audits[0].tool).toBe("get_secret");
    expect(audits[0].paramKeys).toEqual(["name"]);
    expect(audits[0].argsBytes).toBeGreaterThan(0);

    // No argument VALUE may appear anywhere in the serialized audit record.
    const serialized = JSON.stringify(audits[0]);
    expect(serialized).not.toContain("super-secret-item-name");
    await handler.close();
  });

  test("auditRecord copies no values for nested or non-object args", () => {
    const rec = auditRecord("t", { token: "abc123", nested: { deep: "xyz" } });
    expect(rec.paramKeys).toEqual(["nested", "token"]);
    expect(JSON.stringify(rec)).not.toContain("abc123");
    expect(JSON.stringify(rec)).not.toContain("xyz");
    expect(auditRecord("t", undefined).paramKeys).toEqual([]);
  });
});
