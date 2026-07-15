/**
 * server/__tests__/credential-resolver.test.ts
 *
 * Unit tests for the pure get_credential resolution logic. The MCP tool in
 * server/mcp.ts is a thin adapter over resolveCredential; testing the pure
 * function exercises the exact→fuzzy→deny/scope flow offline without a vault.
 * Field objects use the REAL flat-key shape (username/password/uri/notes +
 * custom fields) that index.ts buildFieldsObject emits, and the deny mock uses
 * the REAL canonicalizeFieldName so path→real-key reduction is exercised.
 */

import { expect, describe, test } from "bun:test";
import {
  rankCandidates,
  matchType,
  primaryValueKey,
  resolveCredential,
  type CredentialResolverDeps,
} from "../credential-resolver";
import { canonicalizeFieldName } from "../utils/folder-scope";

const NAMES = ["n8n-local", "grafana", "PostgreSQL n8n-ops", "redis-cache"];

/**
 * Build deps over an in-memory vault. `denied` is the set of REAL flat field
 * names the subject may not read (canonicalized, matching production).
 */
function makeDeps(opts?: {
  denied?: string[];
  values?: Record<string, string>;
  fields?: Record<string, Record<string, string>>;
  names?: string[];
}): CredentialResolverDeps {
  const names = opts?.names ?? NAMES;
  const denied = new Set((opts?.denied ?? []).map(canonicalizeFieldName));
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
    filterDenied: (obj) => {
      const out = { ...obj };
      for (const k of Object.keys(out)) {
        if (denied.has(canonicalizeFieldName(k))) delete out[k];
      }
      return out;
    },
    isDenied: (fieldRef) => denied.has(canonicalizeFieldName(fieldRef)),
  };
}

describe("rankCandidates / matchType / primaryValueKey", () => {
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

  test("primaryValueKey mirrors password → notes → first custom field", () => {
    expect(primaryValueKey({ password: "p", notes: "n" })).toBe("password");
    expect(primaryValueKey({ notes: "n", API_KEY: "k" })).toBe("notes");
    expect(primaryValueKey({ username: "u", API_KEY: "k" })).toBe("API_KEY");
    expect(primaryValueKey({ username: "u" })).toBeNull();
  });
});

describe("resolveCredential — exact match", () => {
  test("exact name resolves with matchType 'exact' and all real fields", async () => {
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
    expect(r.value.value).toBe("adminpw"); // primary (password) not denied
  });

  test("absent primary value is not an error", async () => {
    const deps = makeDeps({ fields: { grafana: { username: "u" } } });
    const r = await resolveCredential("grafana", undefined, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // primaryValueKey → null (only username), so no read attempted.
    expect(r.value.value).toBeUndefined();
    expect(r.value.fields).toEqual({ username: "u" });
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

describe("resolveCredential — field deny (fail closed)", () => {
  test("requesting a DENIED specific field → access-denied error, no read", async () => {
    let secretRead = false;
    const deps: CredentialResolverDeps = {
      ...makeDeps({ denied: ["password"] }),
      getSecret: async (path) => {
        secretRead = true;
        return `should-not-be-read:${path}`;
      },
    };
    const r = await resolveCredential("grafana", "login.password", deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("Access denied");
    expect(secretRead).toBe(false); // material never touched
  });

  test("requesting an ALLOWED specific field returns its value", async () => {
    const deps = makeDeps({
      denied: ["password"],
      values: { "grafana.username": "admin" },
    });
    const r = await resolveCredential("grafana", "username", deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.field).toBe("username");
    expect(r.value.value).toBe("admin");
  });

  test("all-fields path strips the denied real key", async () => {
    const deps = makeDeps({
      denied: ["password"],
      fields: { grafana: { username: "admin", password: "pw" } },
    });
    const r = await resolveCredential("grafana", undefined, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.fields).toEqual({ username: "admin" });
  });

  // The primary-value leak the review found: even when `password` is denied and
  // stripped from `fields`, the primary value (getSecret(name) → password) must
  // ALSO be withheld — otherwise `value` re-leaks it.
  test("primary value is WITHHELD when its underlying field is denied", async () => {
    const deps = makeDeps({
      denied: ["password"],
      values: { grafana: "adminpw" }, // primary read would return the password
      fields: { grafana: { username: "admin", password: "adminpw" } },
    });
    const r = await resolveCredential("grafana", undefined, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.fields).toEqual({ username: "admin" });
    // Primary maps to `password` (denied) → no value returned.
    expect(r.value.value).toBeUndefined();
  });

  test("primary value survives when a DIFFERENT field is denied", async () => {
    const deps = makeDeps({
      denied: ["username"],
      values: { grafana: "adminpw" },
      fields: { grafana: { username: "admin", password: "adminpw" } },
    });
    const r = await resolveCredential("grafana", undefined, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.value).toBe("adminpw"); // primary (password) not denied
    expect(r.value.fields).toEqual({ password: "adminpw" });
  });
});
