/**
 * server/__tests__/credential-resolver.test.ts
 *
 * Unit tests for the pure get_credential resolution logic. The MCP tool in
 * server/mcp.ts is a thin adapter over resolveCredential; testing the pure
 * function exercises the exact→fuzzy→scope flow offline without a vault. Field
 * objects use the REAL flat-key shape (username/password/uri/notes + custom
 * fields) that index.ts buildFieldsObject emits.
 */

import { expect, describe, test } from "bun:test";
import {
  rankCandidates,
  matchType,
  resolveCredential,
  type CredentialResolverDeps,
} from "../credential-resolver";

const NAMES = ["n8n-local", "grafana", "PostgreSQL n8n-ops", "redis-cache"];

/** Build deps over an in-memory vault. */
function makeDeps(opts?: {
  values?: Record<string, string>;
  fields?: Record<string, Record<string, string>>;
  names?: string[];
}): CredentialResolverDeps {
  const names = opts?.names ?? NAMES;
  const values = opts?.values ?? {};
  const fields = opts?.fields ?? {};
  return {
    findScoped: async (name) => (names.includes(name) ? name : null),
    listScoped: async () => names,
    getSecret: async (path) => {
      if (path in values) return values[path]!;
      throw new Error(`no primary value: ${path}`);
    },
    getSecretObject: async (name) => fields[name] ?? { placeholder: "x" },
  };
}

describe("rankCandidates / matchType", () => {
  test("startsWith beats substring beats subsequence", () => {
    const ranked = rankCandidates(["xgrafana", "grafana-prod", "gfna"], "graf");
    expect(ranked[0]).toBe("grafana-prod"); // startsWith → +100
  });

  test("no positive-score candidate → empty", () => {
    expect(rankCandidates(NAMES, "zzzzz")).toEqual([]);
  });

  test("matchType is exact only on case-insensitive full-name equality", () => {
    expect(matchType("Grafana", "grafana")).toBe("exact");
    expect(matchType("grafana", "graf")).toBe("fuzzy");
  });
});

describe("resolveCredential — exact match", () => {
  test("exact name resolves with matchType 'exact' and all fields", async () => {
    const deps = makeDeps({
      values: { grafana: "adminpw" },
      fields: { grafana: { username: "admin", password: "adminpw" } },
    });
    const r = await resolveCredential("grafana", undefined, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.name).toBe("grafana");
    expect(r.value.matchType).toBe("exact");
    expect(r.value.fields).toEqual({ username: "admin", password: "adminpw" });
    expect(r.value.value).toBe("adminpw"); // best-effort primary
  });

  test("absent primary value is not an error", async () => {
    // getSecret(grafana) throws (no value entry) → value omitted, not an error.
    const deps = makeDeps({ fields: { grafana: { username: "u" } } });
    const r = await resolveCredential("grafana", undefined, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.value).toBeUndefined();
    expect(r.value.fields).toEqual({ username: "u" });
  });
});

describe("resolveCredential — specific field", () => {
  test("returns just the requested field's value", async () => {
    const deps = makeDeps({ values: { "grafana.username": "admin" } });
    const r = await resolveCredential("grafana", "username", deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.field).toBe("username");
    expect(r.value.value).toBe("admin");
    expect(r.value.fields).toBeUndefined(); // specific-field path omits `fields`
  });
});

describe("resolveCredential — fuzzy fallback", () => {
  test("non-exact query falls back to best fuzzy candidate", async () => {
    const deps = makeDeps({ fields: { "n8n-local": { username: "n8n" } } });
    const r = await resolveCredential("n8n loc", undefined, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.name).toBe("n8n-local");
    expect(r.value.matchType).toBe("fuzzy");
  });

  test("no candidate matches → not-found error (no material)", async () => {
    const r = await resolveCredential("zzzzz", undefined, makeDeps());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("No credentials found");
  });
});

describe("resolveCredential — enumeration parity", () => {
  test("out-of-scope best candidate is indistinguishable from no-match", async () => {
    const base = makeDeps();
    const deps: CredentialResolverDeps = {
      ...base,
      findScoped: async () => null, // exact miss AND candidate not in scope
      listScoped: async () => ["grafana"],
    };
    const outOfScope = await resolveCredential("graf", undefined, deps);
    const noMatch = await resolveCredential("graf", undefined, {
      ...deps,
      listScoped: async () => [],
    });
    expect(outOfScope.ok).toBe(false);
    expect(noMatch.ok).toBe(false);
    if (outOfScope.ok || noMatch.ok) return;
    // Same generic message → existence of the out-of-scope item is not leaked.
    expect(outOfScope.error).toBe(noMatch.error);
  });
});
