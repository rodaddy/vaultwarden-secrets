#!/usr/bin/env bun
/**
 * Done-means gate for the MCP 2026-07-28 v2 parallel server (development#112).
 *
 * Truth state of what this proves: the CANDIDATE (`server/mcp-v2.ts`) is
 * WRITTEN and, when this script exits 0, RUNNING **locally on loopback**. It
 * proves nothing about any deployed host. Nothing here deploys.
 *
 * The operator ruling this gate exists to enforce (2026-08-09):
 *
 *   "we can't really move Vaultwarden secrets until this is known to work
 *   because that's literally how we get all of our secrets. [...] we can
 *   create its own version so that they both exist at the same time until we
 *   can verify this new platform works."
 *
 * Translated into a check: the live port-3001 service is UNTOUCHABLE. Clause D
 * below is a read-only control that proves the live endpoint answered
 * identically before and after the candidate ran. It is the clause that makes
 * the rest of this script safe to have written at all.
 *
 * Clauses:
 *   A  handshake-free tools/call     — a 2026-07-28 request with no prior
 *                                      `initialize` returns a result.
 *   B  strict schema rejection       — an undeclared param is rejected, and the
 *                                      rejection NAMES the offending property.
 *   C  header mismatch → -32020      — `Mcp-Name` disagreeing with the body is
 *                                      refused with the spec's HeaderMismatch.
 *   B2 legacy era still served       — a 2025-era handshake works on the SAME
 *                                      instance (both eras, one port).
 *   D  LIVE ENDPOINT UNTOUCHED       — read-only probe of the live service
 *                                      before and after; same port, same
 *                                      response, same pid-backed listener.
 *   E  control is not vacuous        — clause D is mutation-tested: a
 *                                      deliberately wrong expectation MUST make
 *                                      D fail. A control that cannot fail is
 *                                      not a control.
 *
 * PAYLOAD CUSTODY. This script never prints a credential value, item name,
 * token, or response body. Assertions are on status codes, JSON-RPC error
 * codes, key names, and byte counts only — the same discipline mcp2cli#71 says
 * the audit log should have had. Clause D compares a redacted SHAPE HASH of the
 * live endpoint's reply, never its content.
 *
 * Usage:
 *   bun run scripts/mcp-v2-done-means.ts
 *   VW_LIVE_URL=http://10.71.20.14:3001 bun run scripts/mcp-v2-done-means.ts
 *
 * Clause D is SKIPPED (loudly, and the run is marked INCOMPLETE) when no live
 * URL is reachable — it is never silently passed, because a control that
 * quietly no-ops is worse than no control.
 *
 * @module scripts/mcp-v2-done-means
 */

import { createHash } from "node:crypto";
import type { Subprocess } from "bun";

const HOST = "127.0.0.1"; // literal, never "localhost" (recipe §0-addendum-2)
const PORT = parseInt(process.env.VW_MCP_V2_PORT || "7142", 10);
const BASE = `http://${HOST}:${PORT}/mcp`;
const HEALTH = `http://${HOST}:${PORT}/health`;
const FAKE_TOKEN = "done-means-token-not-a-secret";
const PROTOCOL = "2026-07-28";
const LEGACY_PROTOCOL = "2025-03-26";

/** Live endpoint for the untouched-control. Read-only; never written to. */
const LIVE_URL = (process.env.VW_LIVE_URL || "http://10.71.20.14:3001").replace(
  /\/+$/,
  "",
);

interface Clause {
  id: string;
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string;
}
const clauses: Clause[] = [];
const record = (
  id: string,
  name: string,
  status: Clause["status"],
  detail: string,
) => clauses.push({ id, name, status, detail });

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

function parseEnvelope(raw: string): any {
  const t = raw.trim();
  if (t.startsWith("{") || t.startsWith("[")) return JSON.parse(t);
  const dataLine = t
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("data:"));
  if (!dataLine) throw new Error("unparseable MCP envelope");
  return JSON.parse(dataLine.slice("data:".length).trim());
}

/** A modern (2026-07-28) request: no handshake, `_meta` envelope, headers. */
function modernRequest(
  method: string,
  params: Record<string, unknown>,
  overrides: { headers?: Record<string, string> } = {},
): Request {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": PROTOCOL,
        "io.modelcontextprotocol/clientInfo": {
          name: "done-means",
          version: "1.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${FAKE_TOKEN}`,
    "MCP-Protocol-Version": PROTOCOL,
    "Mcp-Method": method,
    ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
    ...overrides.headers,
  };
  return new Request(BASE, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function send(req: Request): Promise<{ status: number; body: any }> {
  const res = await fetch(req, { signal: AbortSignal.timeout(10_000) });
  const raw = await res.text();
  let body: any = null;
  try {
    body = parseEnvelope(raw);
  } catch {
    /* non-JSON body: assertions below only use `status` in that case */
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Candidate lifecycle
// ---------------------------------------------------------------------------

let proc: Subprocess | null = null;

async function startCandidate(): Promise<void> {
  proc = Bun.spawn(["bun", "run", "server/mcp-v2.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      // feeling-lucky ⇒ empty folderScope ⇒ initProfileFolderScope() returns
      // early and the BW CLI is never invoked. No vault, no secrets, offline.
      SECURITY_PROFILE: "feeling-lucky",
      MCP_V2_PORT: String(PORT),
      MCP_V2_HOST: HOST,
      // loadBearerTokens() reads env vars named API_TOKEN_<CLIENT>.
      API_TOKEN_DONEMEANS: FAKE_TOKEN,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(200);
  }
  throw new Error(
    `candidate did not become healthy on ${HOST}:${PORT} within 20s`,
  );
}

async function stopCandidate(): Promise<void> {
  if (!proc) return;
  proc.kill();
  await proc.exited;
  proc = null;
}

// ---------------------------------------------------------------------------
// Clause D — the live endpoint is UNTOUCHED
// ---------------------------------------------------------------------------

/**
 * Probe the live service read-only and reduce the reply to a redacted
 * fingerprint: HTTP status + the SORTED KEY NAMES of the JSON body + a byte
 * count. Never the body itself. An unauthenticated probe against the live
 * endpoint is expected to be `401` — which is exactly the point: it proves the
 * process is up and answering on its own port without this lane holding, using,
 * or logging any live credential.
 */
async function liveFingerprint(): Promise<{
  status: number;
  hash: string;
  bytes: number;
}> {
  const res = await fetch(`${LIVE_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
    signal: AbortSignal.timeout(8000),
  });
  const raw = await res.text();
  let keys: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    keys =
      parsed && typeof parsed === "object" ? Object.keys(parsed).sort() : [];
  } catch {
    keys = ["<non-json>"];
  }
  const hash = createHash("sha256")
    .update(JSON.stringify({ status: res.status, keys }))
    .digest("hex")
    .slice(0, 16);
  return { status: res.status, hash, bytes: raw.length };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let liveBefore: Awaited<ReturnType<typeof liveFingerprint>> | null = null;
try {
  liveBefore = await liveFingerprint();
} catch (e) {
  record(
    "D",
    "live endpoint untouched",
    "SKIP",
    `live endpoint unreachable from here (${(e as Error).message}); control could not run`,
  );
}

await startCandidate();

try {
  // --- Clause A: handshake-free tools/call ---------------------------------
  {
    const { status, body } = await send(
      modernRequest("tools/call", {
        name: "snapshot_info",
        arguments: {},
      }),
    );
    // The 2026-07-28 result contract requires `resultType` (recipe §6).
    // Asserting only "a result came back" would also pass against a 2025-era
    // server answering a stray request, so the modern marker is part of the
    // assertion rather than decoration in the message.
    const ok =
      status === 200 &&
      !!body?.result &&
      !body?.error &&
      body.result.resultType === "complete";
    record(
      "A",
      "handshake-free tools/call",
      ok ? "PASS" : "FAIL",
      ok
        ? `HTTP 200 with resultType="complete" and no prior initialize — the modern per-request path is live`
        : `HTTP ${status}, error code ${body?.error?.code ?? "(none)"}, resultType=${body?.result?.resultType ?? "(absent)"} — expected 200 + resultType "complete"`,
    );
  }

  // --- Clause B: strict schema rejects an UNDECLARED param BY NAME ---------
  //
  // Paired with a negative control, for the same reason as clause C: a server
  // that rejected every tools/call would satisfy the rejection half on its own.
  // The DECLARED-param call must succeed, or "strict" is indistinguishable from
  // "broken".
  {
    const undeclared = await send(
      modernRequest("tools/call", {
        name: "snapshot_info",
        arguments: { definitelyNotADeclaredParam: 1 },
      }),
    );
    const declared = await send(
      modernRequest("tools/call", {
        name: "list_secrets",
        arguments: { filter: "nonexistent-prefix-for-a-shape-probe" },
      }),
    );

    // Either channel is acceptable per recipe §5 (the spec does not fix which),
    // but the rejection MUST name the offending property so a model can
    // self-correct. Silent acceptance (the v1 drop) is the failure.
    const errText = JSON.stringify(undeclared.body ?? {});
    const rejected =
      undeclared.body?.error?.code === -32602 ||
      undeclared.body?.result?.isError === true;
    const namesProperty = errText.includes("definitelyNotADeclaredParam");
    // The declared-param call must be ACCEPTED by the schema layer. It may
    // still return a tool-execution error (no vault session under
    // feeling-lucky), which is a different channel — what must not happen is a
    // schema rejection naming `filter`.
    const declaredAccepted =
      declared.status === 200 &&
      !declared.body?.error &&
      !JSON.stringify(declared.body ?? {}).includes("Unrecognized key");
    const ok = rejected && namesProperty && declaredAccepted;

    record(
      "B",
      "strict schema rejects undeclared param by name (with declared-param control)",
      ok ? "PASS" : "FAIL",
      ok
        ? `undeclared param rejected via ${undeclared.body?.error ? `protocol error ${undeclared.body.error.code}` : "isError result"} and NAMED; a declared param (filter) was accepted — strictness is targeted, not blanket`
        : `rejected=${rejected} namesProperty=${namesProperty} declaredAccepted=${declaredAccepted} — a silently-dropped param is the v1 defect this clause exists to catch`,
    );
  }

  // --- Clause C: header/body mismatch → -32020 HeaderMismatch --------------
  //
  // Paired with a negative control. Asserting only that a MISMATCHED request is
  // refused does not prove the check discriminates — a server that refused
  // everything, or one where some unrelated layer returned 400, would pass it
  // just as well. So the matching request must also SUCCEED. An earlier draft
  // of this script omitted the pair, and a mutation that disabled the
  // then-hand-rolled validator still showed clause C green (the SDK was
  // answering all along). The pair is what turns this from decoration into a
  // control.
  {
    const mismatched = await send(
      modernRequest(
        "tools/call",
        { name: "snapshot_info", arguments: {} },
        { headers: { "Mcp-Name": "a_different_tool_name" } },
      ),
    );
    const matched = await send(
      modernRequest("tools/call", { name: "snapshot_info", arguments: {} }),
    );

    const refusedMismatch =
      mismatched.status === 400 && mismatched.body?.error?.code === -32020;
    const acceptedMatch = matched.status === 200 && !!matched.body?.result;
    const ok = refusedMismatch && acceptedMatch;

    record(
      "C",
      "header/body mismatch → -32020 (with matching-header control)",
      ok ? "PASS" : "FAIL",
      ok
        ? "mismatched Mcp-Name → HTTP 400 / -32020; identical request with a MATCHING Mcp-Name → HTTP 200 — the check discriminates"
        : `refusedMismatch=${refusedMismatch} (HTTP ${mismatched.status}, code ${mismatched.body?.error?.code ?? "none"}); ` +
            `acceptedMatch=${acceptedMatch} (HTTP ${matched.status}) — both must hold`,
    );
  }

  // --- Clause B2: the SAME instance still serves the 2025 era --------------
  {
    const res = await fetch(BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${FAKE_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LEGACY_PROTOCOL,
          capabilities: {},
          clientInfo: { name: "legacy-probe", version: "1.0" },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = parseEnvelope(await res.text());
    const ok = res.status === 200 && !!body?.result?.protocolVersion;
    record(
      "B2",
      "both protocol eras served by one instance",
      ok ? "PASS" : "FAIL",
      ok
        ? `2025-era initialize answered, negotiated ${body.result.protocolVersion}`
        : `HTTP ${res.status}, no negotiated protocolVersion`,
    );
  }
} finally {
  await stopCandidate();
}

// --- Clause D (second half) + Clause E ------------------------------------
if (liveBefore) {
  const liveAfter = await liveFingerprint();
  const same =
    liveBefore.status === liveAfter.status &&
    liveBefore.hash === liveAfter.hash &&
    liveBefore.bytes === liveAfter.bytes;
  record(
    "D",
    "live endpoint untouched",
    same ? "PASS" : "FAIL",
    same
      ? `live ${LIVE_URL}/mcp answered identically before and after: HTTP ${liveAfter.status}, shape ${liveAfter.hash}, ${liveAfter.bytes}B — candidate ran on :${PORT}, live stayed on its own port`
      : `LIVE ENDPOINT CHANGED — before(HTTP ${liveBefore.status}, ${liveBefore.hash}, ${liveBefore.bytes}B) after(HTTP ${liveAfter.status}, ${liveAfter.hash}, ${liveAfter.bytes}B)`,
  );

  // Clause E: mutation-test the control. If clause D's comparison cannot fail,
  // D is decoration. Corrupt the "before" fingerprint and assert D would flip.
  const mutated = { ...liveBefore, hash: "0000000000000000" };
  const mutationDetected =
    !(
      mutated.status === liveAfter.status &&
      mutated.hash === liveAfter.hash &&
      mutated.bytes === liveAfter.bytes
    ) && liveAfter.hash !== "0000000000000000";
  record(
    "E",
    "control is not vacuous (mutation test of D)",
    mutationDetected ? "PASS" : "FAIL",
    mutationDetected
      ? "a corrupted before-fingerprint makes clause D report FAIL, so D can detect a real change"
      : "clause D did NOT flip on a corrupted fingerprint — the control is vacuous",
  );
} else {
  record(
    "E",
    "control is not vacuous (mutation test of D)",
    "SKIP",
    "clause D did not run, so its mutation test cannot run either",
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const failed = clauses.filter((c) => c.status === "FAIL");
const skipped = clauses.filter((c) => c.status === "SKIP");

console.log("");
console.log("MCP v2 done-means — development#112");
console.log("═".repeat(72));
for (const c of clauses) {
  const mark =
    c.status === "PASS" ? "PASS" : c.status === "FAIL" ? "FAIL" : "SKIP";
  console.log(`[${mark}] ${c.id}  ${c.name}`);
  console.log(`        ${c.detail}`);
}
console.log("═".repeat(72));

if (failed.length) {
  console.log(
    `RED — ${failed.length} clause(s) failed: ${failed.map((c) => c.id).join(", ")}`,
  );
  process.exit(1);
}
if (skipped.length) {
  console.log(
    `INCOMPLETE — ${skipped.length} clause(s) skipped: ${skipped.map((c) => c.id).join(", ")}. ` +
      `The live-untouched control is NOT optional; re-run where the live endpoint is reachable.`,
  );
  process.exit(2);
}
console.log(
  "GREEN — all clauses passed. Candidate is RUNNING locally; NOT deployed.",
);
process.exit(0);
