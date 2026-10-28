/**
 * Audit-safe request logging and schema-strictness assertion for the MCP
 * 2026-07-28 (SDK v2) parallel server.
 *
 * **Truth state: WRITTEN.** Exercised by `server/__tests__/mcp-v2-audit.test.ts`
 * and, through the running candidate, by `scripts/mcp-v2-done-means.ts`.
 * Nothing here is deployed.
 *
 * ## Why this is a separate module from `server/mcp-v2.ts`
 *
 * `server/mcp-v2.ts` is an ENTRY POINT, not a library: it resolves folder scope
 * with a top-level `await` (which shells out to `bw`) and default-exports a
 * bound server object. Importing it from a test therefore starts a server and
 * hangs — observed 2026-08-09, a `bun test` import of that module timed out at
 * 5000ms without reaching a single assertion.
 *
 * The units below are the ones worth asserting on directly — the audit
 * redaction boundary and the schema-strictness guard — so they live here, where
 * a test can import them without booting anything. `server/mcp-v2.ts` imports
 * them rather than keeping private copies; two copies of an audit redactor is
 * how one of them quietly stops matching the other.
 *
 * ## Audit safety (mcp2cli#71)
 *
 * mcp2cli#71 recorded a live `get_credential` response — a complete private key
 * — in cleartext in an unencrypted audit file. {@link logRequest} accepts only a
 * tool name, SORTED KEY NAMES, and a response BYTE COUNT. It has no parameter
 * that can carry a value or a body, so no call site can leak one even by
 * mistake. Cardinality, not content.
 *
 * Do not add a `value`, `payload`, `body`, or `result` parameter to
 * {@link logRequest}. That is precisely the change that produced mcp2cli#71.
 *
 * @module server/mcp-v2-audit
 */

import { z } from "zod";

/**
 * One audit line: what was called, which parameter NAMES came with it, and how
 * large the reply was. No values, ever.
 */
export interface V2AuditRecord {
  ts: string;
  tool: string;
  argKeys: string[];
  responseBytes: number;
  outcome: "ok" | "error";
}

/**
 * Derive the audit key list from raw tool arguments.
 *
 * Returns the SORTED names of properties the caller actually supplied. Values
 * are never read, copied, measured per-key, or returned.
 *
 * Two behaviors here are load-bearing, and both are pinned by tests:
 *
 * 1. **A key whose value is `undefined` is NOT a supplied parameter.** The
 *    obvious spelling at a call site is `Object.keys({ filter, vault })` over
 *    destructured optionals, and that reports `["filter","vault"]` even when the
 *    caller sent `{}` — the audit log then claims parameters that were never on
 *    the wire (verified on this runtime 2026-08-09). Audit fidelity is the
 *    entire point of the record (ledger 16), so inflating it is a defect. It is
 *    corrected here at the owning boundary rather than at each of the seven
 *    call sites, because seven copies of a rule is seven chances to drift.
 * 2. **Nesting is not traversed.** Only top-level names are taken. Recursing
 *    would walk into values, and a nested key name can itself be sensitive.
 *
 * @param args - Raw argument object; may be `undefined` for a zero-arg tool.
 * @returns Sorted top-level key names of the supplied arguments.
 */
export function auditKeys(args: unknown): string[] {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return [];
  }
  return Object.entries(args as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
    .sort();
}

/**
 * Build one audit record as CARDINALITY ONLY.
 *
 * Separated from {@link logRequest} so a test can assert on the record itself
 * rather than on stdout — redaction is a property of the RECORD, and checking a
 * string scraped from a console is the weaker check.
 *
 * @param tool - Tool name being invoked.
 * @param args - Raw arguments; names are taken, values are not.
 * @param responseBytes - Serialized length of the reply.
 * @param outcome - Whether the tool call succeeded.
 * @returns A record containing no argument value and no response body.
 */
export function auditRecord(
  tool: string,
  args: unknown,
  responseBytes: number,
  outcome: "ok" | "error",
): V2AuditRecord {
  return {
    ts: new Date().toISOString(),
    tool,
    argKeys: auditKeys(args),
    responseBytes,
    outcome,
  };
}

/**
 * Log one tool call as CARDINALITY ONLY.
 *
 * The signature is the enforcement: there is deliberately no parameter that can
 * carry an argument value or a response body. `argKeys` are property NAMES (a
 * schema fact, already public in `tools/list`); `responseBytes` is a length.
 * Neither can reconstruct a credential.
 *
 * @param tool - Tool name being invoked.
 * @param args - Raw arguments; only supplied top-level NAMES are recorded.
 * @param responseBytes - Serialized length of the reply.
 * @param outcome - Whether the tool call succeeded.
 */
export function logRequest(
  tool: string,
  args: unknown,
  responseBytes: number,
  outcome: "ok" | "error",
): void {
  console.log(JSON.stringify(auditRecord(tool, args, responseBytes, outcome)));
}

/**
 * Assert a tool's schema actually REJECTS an undeclared property.
 *
 * A non-strict schema is a silent-data-loss defect on a SECRETS server: a
 * caller's typo'd parameter is discarded and the tool runs with defaults rather
 * than refusing. A caller who misspells `field` gets the WHOLE item back instead
 * of the one field they asked for, and never learns. Fail at construction, not
 * at request time.
 *
 * The check is BEHAVIORAL, and it has to be. On the installed Zod,
 * `z.toJSONSchema()` emits `additionalProperties: false` for a PERMISSIVE
 * `z.object({...})` as well as for a strict one — the advertised schema is
 * identical while the runtime behavior is not (verified 2026-08-09).
 * Introspecting the emitted JSON Schema would therefore pass a permissive schema
 * through, which is the exact silent-drop defect this guard exists to prevent.
 * So it probes with a sentinel key and inspects what survives parsing.
 *
 * Carried over from the dev#113 lane (PR #40), which established the Zod
 * finding this function encodes.
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

  let permissive =
    probe.success && !(sentinel in (probe.data as Record<string, unknown>));

  // When required fields make the sentinel-only probe fail, re-probe with the
  // declared keys filled in so the ONLY reason left to fail is the sentinel.
  if (!probe.success) {
    const filled: Record<string, unknown> = { [sentinel]: true };
    for (const key of Object.keys(schema.shape)) filled[key] = "probe";
    const second = schema.safeParse(filled);
    permissive =
      second.success && !(sentinel in (second.data as Record<string, unknown>));
  }

  if (permissive) {
    throw new Error(
      `tool "${name}": inputSchema must be strict (z.strictObject({...})); ` +
        `a permissive schema silently drops undeclared params`,
    );
  }

  return z.toJSONSchema(schema) as Record<string, unknown>;
}
