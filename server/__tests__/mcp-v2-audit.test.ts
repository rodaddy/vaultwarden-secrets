/**
 * Contract tests for the MCP 2026-07-28 (SDK v2) audit + strictness boundary.
 *
 * Ported from the dev#113 lane (PR #40) and ADAPTED to this branch's
 * implementation. #40 carried its own `server/mcp-v2.ts`; only one v2 server
 * survives (ledger 21), so what is preserved here is the COVERAGE, re-pointed
 * at `server/mcp-v2-audit.ts` — the module this branch's entry point actually
 * calls.
 *
 * These are unit tests over pure functions. The wire-level behaviors (handshake
 * -free `tools/call`, `-32020` header mismatch, both-eras-one-instance, the live
 * endpoint staying untouched) are covered end-to-end against a REAL running
 * server by `scripts/mcp-v2-done-means.ts` clauses A/B/C/B2/D/E, which is where
 * they belong — a protocol assertion against a mock proves the mock agrees with
 * itself.
 *
 * SAFETY: no vault session, no `bw` invocation, no credential material, no
 * network, no live endpoint. Every value below is a literal fixture.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  assertStrictSchema,
  auditKeys,
  auditRecord,
  logRequest,
} from "../mcp-v2-audit";

describe("audit key derivation (mcp2cli#71 / ledger 16)", () => {
  test("records the supplied key NAMES, sorted", () => {
    expect(auditKeys({ vault: "default", name: "x" })).toEqual([
      "name",
      "vault",
    ]);
  });

  // The defect this guards is specific and was live on this branch before the
  // port: every tool derived its keys as `Object.keys({ filter, vault })` over
  // DESTRUCTURED optionals, which reports a key whose value is `undefined`.
  // A caller sending `{}` was audited as having sent `["filter","vault"]`.
  test("an optional the caller omitted is NOT reported as supplied", () => {
    const filter = undefined;
    const vault = undefined;
    expect(auditKeys({ filter, vault })).toEqual([]);
  });

  test("a supplied optional IS reported alongside omitted siblings", () => {
    const filter = "api";
    const vault = undefined;
    expect(auditKeys({ filter, vault })).toEqual(["filter"]);
  });

  test("a zero-arg tool's undefined/empty args yield no keys", () => {
    expect(auditKeys(undefined)).toEqual([]);
    expect(auditKeys({})).toEqual([]);
  });

  // Ported from #40's nested/non-object coverage. Nesting must not be walked:
  // recursion would descend into VALUES, and a nested key can itself be
  // sensitive.
  test("nested and non-object args never leak a value", () => {
    const rec = auditKeys({ token: "abc123", nested: { deep: "xyz" } });
    expect(rec).toEqual(["nested", "token"]);
    expect(JSON.stringify(rec)).not.toContain("abc123");
    expect(JSON.stringify(rec)).not.toContain("xyz");

    expect(auditKeys("a-bare-string")).toEqual([]);
    expect(auditKeys(["an", "array"])).toEqual([]);
    expect(auditKeys(null)).toEqual([]);
  });
});

describe("audit record redaction", () => {
  test("no argument VALUE appears anywhere in the serialized record", () => {
    const rec = auditRecord(
      "get_secret",
      { name: "super-secret-item-name", vault: "default" },
      42,
      "ok",
    );

    expect(rec.tool).toBe("get_secret");
    expect(rec.argKeys).toEqual(["name", "vault"]);
    expect(rec.responseBytes).toBe(42);
    expect(rec.outcome).toBe("ok");

    const serialized = JSON.stringify(rec);
    expect(serialized).not.toContain("super-secret-item-name");
    // "default" is a vault VALUE; only the key `vault` may survive.
    expect(JSON.parse(serialized).vault).toBeUndefined();
  });

  test("a deeply nested credential value never reaches the record", () => {
    const rec = auditRecord(
      "get_credential",
      { service: { token: "PRIVATE-KEY-MATERIAL" } },
      0,
      "error",
    );
    expect(JSON.stringify(rec)).not.toContain("PRIVATE-KEY-MATERIAL");
    expect(rec.argKeys).toEqual(["service"]);
  });

  test("logRequest emits exactly the record, and no value, to stdout", () => {
    const written: string[] = [];
    const original = console.log;
    console.log = (line: string) => written.push(line);
    try {
      logRequest("get_secret", { name: "leak-me-if-broken" }, 7, "ok");
    } finally {
      console.log = original;
    }

    expect(written).toHaveLength(1);
    expect(written[0]).not.toContain("leak-me-if-broken");
    const parsed = JSON.parse(written[0]);
    expect(parsed.tool).toBe("get_secret");
    expect(parsed.argKeys).toEqual(["name"]);
    expect(parsed.responseBytes).toBe(7);
  });
});

describe("schema strictness guard", () => {
  // The positive control. Per the lane contract's dev#112 tightening, a
  // rejection assertion without a matching acceptance assertion cannot tell a
  // working check from a check that rejects everything.
  test("a strict schema is accepted and emits 2020-12 additionalProperties:false", () => {
    const emitted = assertStrictSchema(
      "tight",
      z.strictObject({ name: z.string() }),
    );
    expect(emitted.additionalProperties).toBe(false);
    expect(emitted.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
  });

  test("a permissive schema is rejected at registration time", () => {
    expect(() =>
      assertStrictSchema("loose", z.object({ name: z.string() })),
    ).toThrow(/must be strict/);
  });

  // #40's finding, preserved because it is the reason the guard is behavioral:
  // the ADVERTISED schema cannot distinguish the two, so a guard that inspects
  // `z.toJSONSchema()` output would pass the permissive one straight through.
  test("the emitted JSON Schema alone cannot distinguish strict from permissive", () => {
    const loose = z.toJSONSchema(z.object({ name: z.string() })) as Record<
      string,
      unknown
    >;
    const tight = z.toJSONSchema(
      z.strictObject({ name: z.string() }),
    ) as Record<string, unknown>;
    expect(loose.additionalProperties).toEqual(tight.additionalProperties);
    // ...while the RUNTIME behavior differs, which is what the guard probes.
    expect(
      z.object({ name: z.string() }).safeParse({ name: "a", x: 1 }).success,
    ).toBe(true);
    expect(
      z.strictObject({ name: z.string() }).safeParse({ name: "a", x: 1 })
        .success,
    ).toBe(false);
  });

  test("a schema with required fields is still classified correctly", () => {
    // Required fields make the sentinel-only probe fail for the WRONG reason;
    // the guard must re-probe with declared keys filled in.
    expect(() =>
      assertStrictSchema("required-strict", z.strictObject({ q: z.string() })),
    ).not.toThrow();
    expect(() =>
      assertStrictSchema("required-loose", z.object({ q: z.string() })),
    ).toThrow(/must be strict/);
  });
});
