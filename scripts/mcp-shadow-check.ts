#!/usr/bin/env bun
/**
 * MCP shadow-check harness (issue #23, Phase 0).
 *
 * Runs the SAME non-secret read operations against two MCP endpoints — a
 * BASELINE (the current live port-3001 service) and a CANDIDATE (a replacement
 * built by #14 / staged by #22) — and compares NORMALIZED SHAPES, never values.
 *
 * What it compares (shape only, redacted):
 *   - tools/list        → the set of tool names + each tool's required inputs.
 *   - snapshot_info      → the KEY SET of the returned metadata object and the
 *                          TYPE of each value (never the values themselves).
 *   - list_secrets       → the response ENVELOPE shape and the RESULT TYPE
 *                          (array vs error), plus a size-bucket, never names.
 *
 * Payload custody: this harness deliberately does not call get_secret,
 * get_secret_fields, or get_service, and it never prints any vault value, item
 * name, token, or IP. Divergences are reported as structural diffs and stable
 * SHA-256 hashes of the normalized shape (not the content).
 *
 * Configuration (env or args):
 *   VW_BASELINE_URL / --baseline    Baseline MCP base URL.
 *   VW_CANDIDATE_URL / --candidate   Candidate MCP base URL.
 *   VW_BASELINE_TOKEN               Bearer token for baseline (optional).
 *   VW_CANDIDATE_TOKEN               Bearer token for candidate (optional).
 *   VW_SHADOW_QUERY                  Benign list filter (default: "" = list all
 *                                    names, but only the COUNT bucket is used).
 *   VW_MCP_TIMEOUT_MS                Per-request timeout (default 5000).
 *
 * Exit codes:
 *   0  MATCH       both endpoints produced identical normalized shapes.
 *   2  DIVERGENCE  at least one operation's shape differs.
 *   3  UNREACHABLE one endpoint could not be probed.
 *   4  CONFIG_ERROR missing/invalid URLs.
 */

import { createHash } from "node:crypto";

const EXIT = {
  MATCH: 0,
  DIVERGENCE: 2,
  UNREACHABLE: 3,
  CONFIG_ERROR: 4,
} as const;

interface Endpoint {
  label: "baseline" | "candidate";
  url: string;
  token?: string;
}

function argOrEnv(flag: string, envName: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env[envName]?.trim() || undefined;
}

function resolveMcpUrl(raw: string): string {
  const u = new URL(raw);
  if (!/\/mcp\/?$/.test(u.pathname)) {
    u.pathname = u.pathname.replace(/\/$/, "") + "/mcp";
  }
  return u.toString();
}

const TIMEOUT = parseInt(process.env.VW_MCP_TIMEOUT_MS || "5000", 10);

function headers(token?: string, sessionId?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  if (sessionId) h["mcp-session-id"] = sessionId;
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

/** Establish an MCP session, returns the session id. Throws on failure. */
async function connect(ep: Endpoint): Promise<string> {
  const res = await fetch(ep.url, {
    method: "POST",
    headers: headers(ep.token),
    signal: AbortSignal.timeout(TIMEOUT),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "shadow-check", version: "1.0" },
      },
    }),
  });
  if (res.status === 401)
    throw new Error(
      `${ep.label}: unauthorized (supply VW_${ep.label.toUpperCase()}_TOKEN)`,
    );
  if (!res.ok) throw new Error(`${ep.label}: initialize HTTP ${res.status}`);
  const sid = res.headers.get("mcp-session-id");
  if (!sid) throw new Error(`${ep.label}: no session id`);
  await fetch(ep.url, {
    method: "POST",
    headers: headers(ep.token, sid),
    signal: AbortSignal.timeout(TIMEOUT),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });
  return sid;
}

async function call(
  ep: Endpoint,
  sid: string,
  method: string,
  params: unknown,
  id: number,
): Promise<any> {
  const res = await fetch(ep.url, {
    method: "POST",
    headers: headers(ep.token, sid),
    signal: AbortSignal.timeout(TIMEOUT),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!res.ok) throw new Error(`${ep.label}: ${method} HTTP ${res.status}`);
  return parseEnvelope(await res.text());
}

// ---------------------------------------------------------------------------
// Shape normalizers — reduce a response to a redacted structural fingerprint.
// ---------------------------------------------------------------------------

/** Recursively describe a value by its shape (types + key sets), never values. */
function shapeOf(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    // Represent arrays by a size bucket + the shape of the first element.
    return {
      array: true,
      bucket: sizeBucket(value.length),
      of: value.length ? shapeOf(value[0]) : "empty",
    };
  }
  const t = typeof value;
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = shapeOf(obj[k]);
    return out;
  }
  return t; // 'string' | 'number' | 'boolean' | ...
}

/** Bucket sizes so counts do not leak exact inventory. */
function sizeBucket(n: number): string {
  if (n === 0) return "0";
  if (n <= 5) return "1-5";
  if (n <= 20) return "6-20";
  if (n <= 100) return "21-100";
  return "100+";
}

function toolsShape(listResult: any): unknown {
  const tools: Array<{ name: string; inputSchema?: any }> =
    listResult?.result?.tools ?? [];
  return tools
    .map((t) => ({
      name: t.name,
      required: (t.inputSchema?.required ?? []).slice().sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** For a tools/call result, describe the content envelope + parsed-payload shape. */
function callShape(callResult: any): unknown {
  const result = callResult?.result;
  if (!result) {
    return {
      error: callResult?.error
        ? { code: typeof callResult.error.code }
        : "unknown",
    };
  }
  const content = result.content;
  if (!Array.isArray(content) || !content[0])
    return { envelope: "non-content", isError: !!result.isError };
  const first = content[0];
  const base: Record<string, unknown> = {
    type: first.type,
    isError: !!result.isError,
  };
  // If the text is JSON, describe its structural shape (never its values).
  if (first.type === "text" && typeof first.text === "string") {
    try {
      base.payloadShape = shapeOf(JSON.parse(first.text));
    } catch {
      base.payloadShape = "text";
    }
  }
  return base;
}

function hashShape(shape: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(shape))
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function gather(ep: Endpoint) {
  const sid = await connect(ep);
  const filter = process.env.VW_SHADOW_QUERY ?? "";
  const [tools, snap, list] = await Promise.all([
    call(ep, sid, "tools/list", {}, 2),
    call(ep, sid, "tools/call", { name: "snapshot_info", arguments: {} }, 3),
    call(
      ep,
      sid,
      "tools/call",
      { name: "list_secrets", arguments: { filter } },
      4,
    ),
  ]);
  return {
    tools: toolsShape(tools),
    snapshot_info: callShape(snap),
    list_secrets: callShape(list),
  };
}

const baselineRaw = argOrEnv("--baseline", "VW_BASELINE_URL");
const candidateRaw = argOrEnv("--candidate", "VW_CANDIDATE_URL");

if (!baselineRaw || !candidateRaw) {
  console.error(
    "CONFIG_ERROR: set VW_BASELINE_URL and VW_CANDIDATE_URL (or --baseline/--candidate)",
  );
  process.exit(EXIT.CONFIG_ERROR);
}

let baseline: Endpoint, candidate: Endpoint;
try {
  baseline = {
    label: "baseline",
    url: resolveMcpUrl(baselineRaw),
    token: process.env.VW_BASELINE_TOKEN?.trim(),
  };
  candidate = {
    label: "candidate",
    url: resolveMcpUrl(candidateRaw),
    token: process.env.VW_CANDIDATE_TOKEN?.trim(),
  };
} catch (e) {
  console.error(`CONFIG_ERROR: ${(e as Error).message}`);
  process.exit(EXIT.CONFIG_ERROR);
}

// Guard (finding P1): shadow-checking an endpoint against ITSELF would always
// report MATCH and give a false sense of cutover safety. If the normalized URLs
// are identical, refuse to run and exit CONFIG_ERROR rather than a bogus MATCH.
if (baseline.url === candidate.url) {
  console.error(
    JSON.stringify({
      status: "CONFIG_ERROR",
      detail:
        "baseline and candidate resolve to the same MCP URL; supply two distinct endpoints",
    }),
  );
  process.exit(EXIT.CONFIG_ERROR);
}

let baselineShapes: Awaited<ReturnType<typeof gather>>;
let candidateShapes: Awaited<ReturnType<typeof gather>>;
try {
  [baselineShapes, candidateShapes] = await Promise.all([
    gather(baseline),
    gather(candidate),
  ]);
} catch (e) {
  console.error(
    JSON.stringify({ status: "UNREACHABLE", detail: (e as Error).message }),
  );
  process.exit(EXIT.UNREACHABLE);
}

const ops = ["tools", "snapshot_info", "list_secrets"] as const;
const report: Record<
  string,
  { baseline: string; candidate: string; match: boolean }
> = {};
let allMatch = true;
for (const op of ops) {
  const b = hashShape(baselineShapes[op]);
  const c = hashShape(candidateShapes[op]);
  const match = b === c;
  if (!match) allMatch = false;
  report[op] = { baseline: b, candidate: c, match };
}

console.log(
  JSON.stringify(
    {
      status: allMatch ? "MATCH" : "DIVERGENCE",
      // Only redacted shape hashes are printed — never payload values.
      operations: report,
    },
    null,
    2,
  ),
);

process.exit(allMatch ? EXIT.MATCH : EXIT.DIVERGENCE);
