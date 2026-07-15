/**
 * server/__tests__/credential-resolver.test.ts
 *
 * Unit tests for the pure get_credential resolution logic. The MCP tool in
 * server/mcp.ts is a thin adapter over resolveCredential; testing the pure
 * function exercises the exact→fuzzy→deny/scope flow offline without a vault.
 */

import { expect, describe, test } from "bun:test";
import {
  rankCandidates,
  matchType,
  resolveCredential,
  type CredentialResolverDeps,
} from "../credential-resolver";

const NAMES = ["n8n-local", "grafana", "PostgreSQL n8n-ops", "redis-cache"];

/**
 * Build deps over an in-memory vault. `denied` is the set of field names the
 * subject may not read (models filterDeniedFields for one client).
 */
function makeDeps(opts?: {
  denied?: string[];
  values?: Record<string, string>;
  fields?: Record<string, Record<string, unknown>>;
  names?: string[];
}): CredentialResolverDeps {
  const names = opts?.names ?? NAMES;
  const denied = new Set(opts?.denied ?? []);
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
      for (const f of denied) delete out[f];
      return out;
    },
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
      fields: {
        grafana: { "login.username": "admin", "login.password": "adminpw" },
      },
    });
    const r = await resolveCredential("grafana", undefined, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.name).toBe("grafana");
    expect(r.value.matchType).toBe("exact");
    expect(r.value.fields).toEqual({
      "login.username": "admin",
      "login.password": "adminpw",
    });
    expect(r.value.value).toBe("adminpw"); // best-effort primary
  });

  test("absent primary value is not an error", async () => {
    const deps = makeDeps({ fields: { grafana: { notes: "n" } } });
    const r = await resolveCredential("grafana", undefined, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.value).toBeUndefined();
    expect(r.value.fields).toEqual({ notes: "n" });
  });
});

describe("resolveCredential — fuzzy fallback", () => {
  test("non-exact query falls back to best fuzzy candidate", async () => {
    const deps = makeDeps({ fields: { "n8n-local": { host: "127.0.0.1" } } });
    // "n8n local" is not an exact item name → fuzzy resolves to "n8n-local".
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

describe("resolveCredential — field deny (fail closed)", () => {
  test("requesting a DENIED specific field → access-denied error, no read", async () => {
    let secretRead = false;
    const deps: CredentialResolverDeps = {
      ...makeDeps({ denied: ["login.password"] }),
      getSecret: async (path) => {
        secretRead = true;
        return `should-not-be-read:${path}`;
      },
    };
    const r = await resolveCredential("grafana", "login.password", deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("Access denied");
    expect(r.error).toContain("login.password");
    // Material was never touched.
    expect(secretRead).toBe(false);
  });

  test("requesting an ALLOWED specific field returns its value", async () => {
    const deps = makeDeps({
      denied: ["login.password"],
      values: { "grafana.login.username": "admin" },
    });
    const r = await resolveCredential("grafana", "login.username", deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.field).toBe("login.username");
    expect(r.value.value).toBe("admin");
  });

  test("all-fields path strips denied fields", async () => {
    const deps = makeDeps({
      denied: ["login.password"],
      fields: {
        grafana: { "login.username": "admin", "login.password": "pw" },
      },
    });
    const r = await resolveCredential("grafana", undefined, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.fields).toEqual({ "login.username": "admin" });
  });
});
