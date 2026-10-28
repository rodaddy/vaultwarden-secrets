/**
 * server/__tests__/folder-scope-legacy.test.ts
 *
 * F4 regression: a legacy folder-scoped bearer token must NOT read outside its
 * folder on the REST read routes. The workload-identity middleware sets
 * clientId `legacy:<client>` while scopes are keyed `<client>` (from
 * API_FOLDERS_<CLIENT>); the FolderScope key normalization must reconcile the
 * two so a scoped legacy client fails CLOSED, returning the byte-identical
 * canonical 404 for an out-of-folder secret. Falsifiable: reverting the
 * scopeKey normalization makes the scoped client read out-of-folder (200).
 */

import { expect, describe, test } from "bun:test";
import { Hono } from "hono";
import { resolveIdentity } from "../middleware/workload-identity";
import { FolderScope, loadFolderScopes } from "../utils/folder-scope";
import { registerSecretReadRoutes } from "../routes/secrets-read";

const PAYROLL_TOKEN = "legacy-payroll-token-abc";
const RICO_TOKEN = "rico-full-token-xyz";

/** Real middleware resolution: legacy token -> subject "legacy:<client>". */
async function subjectFor(token: string): Promise<string | null> {
  return resolveIdentity(token, {
    audience: "rest",
    legacyTokens: new Map([
      [PAYROLL_TOKEN, "payroll"],
      [RICO_TOKEN, "rico"],
    ]),
  });
}

/**
 * Boot a real FolderScope with payroll scoped to the "Payroll" folder and rico
 * unrestricted (no API_FOLDERS_RICO). Uses loadFrom to inject vault data
 * offline (no `bw`).
 */
function bootFolderScope(): FolderScope {
  const prev = process.env.API_FOLDERS_PAYROLL;
  process.env.API_FOLDERS_PAYROLL = "Payroll";
  try {
    const fs = new FolderScope(loadFolderScopes());
    fs.loadFrom(
      [
        { id: "folder-payroll", name: "Payroll" },
        { id: "folder-infra", name: "Infrastructure" },
      ],
      [
        { name: "payroll-secret", folderId: "folder-payroll" },
        { name: "infra-secret", folderId: "folder-infra" },
      ],
    );
    return fs;
  } finally {
    if (prev === undefined) delete process.env.API_FOLDERS_PAYROLL;
    else process.env.API_FOLDERS_PAYROLL = prev;
  }
}

function makeApp(fs: FolderScope, subject: string): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("clientId", subject);
    await next();
  });
  registerSecretReadRoutes(app, {
    isAllowed: (clientId, name) => fs.isAllowed(clientId, name),
    filterItems: (clientId, names) => fs.filterItems(clientId, names),
    getSecret: async (name) => `value-of-${name}`,
    getSecretObject: async (name) => ({ field: `value-of-${name}` }),
    listSecrets: async () => ["payroll-secret", "infra-secret"],
  });
  return app;
}

async function capture(app: Hono, path: string) {
  const res = await app.request(path);
  return { status: res.status, bytes: await res.text() };
}

describe("F4: legacy folder-scoped token cannot read out of folder", () => {
  test("subject resolves to legacy:payroll (real middleware)", async () => {
    expect(await subjectFor(PAYROLL_TOKEN)).toBe("legacy:payroll");
  });

  test("out-of-folder secret -> canonical 404, identical to not-found", async () => {
    const fs = bootFolderScope();
    const subject = (await subjectFor(PAYROLL_TOKEN))!;
    const app = makeApp(fs, subject);

    const outOfFolder = await capture(app, "/secret/infra-secret");
    const nonexistent = await capture(app, "/secret/does-not-exist");

    expect(outOfFolder.status).toBe(404);
    expect(outOfFolder.bytes).toBe(
      JSON.stringify({ error: "Secret not found" }),
    );
    // Byte-identical to a genuine not-found (enumeration parity holds).
    expect(outOfFolder).toEqual(nonexistent);
  });

  test("in-folder secret is allowed (scope did not over-block)", async () => {
    const fs = bootFolderScope();
    const subject = (await subjectFor(PAYROLL_TOKEN))!;
    const app = makeApp(fs, subject);
    const inFolder = await capture(app, "/secret/payroll-secret");
    expect(inFolder.status).toBe(200);
    expect(inFolder.bytes).toBe(
      JSON.stringify({ value: "value-of-payroll-secret" }),
    );
  });

  test("list is filtered to the client's folder for a legacy scoped token", async () => {
    const fs = bootFolderScope();
    const subject = (await subjectFor(PAYROLL_TOKEN))!;
    const app = makeApp(fs, subject);
    const res = await app.request("/secrets");
    const body = (await res.json()) as { secrets: string[]; count: number };
    expect(body.secrets).toEqual(["payroll-secret"]);
    expect(body.count).toBe(1);
  });

  test("genuinely unrestricted client (rico) still sees everything", async () => {
    const fs = bootFolderScope();
    const subject = (await subjectFor(RICO_TOKEN))!; // legacy:rico, no scope
    expect(subject).toBe("legacy:rico");
    const app = makeApp(fs, subject);
    const infra = await capture(app, "/secret/infra-secret");
    expect(infra.status).toBe(200);
    const list = await app.request("/secrets");
    const body = (await list.json()) as { secrets: string[] };
    expect(body.secrets.sort()).toEqual(["infra-secret", "payroll-secret"]);
  });
});

/**
 * Build a FolderScope where payroll IS configured-restricted but its folder is
 * NOT present in the vault data (renamed/missing) — so it resolves to zero
 * allowed folders. Fail-closed: this client must deny ALL items, not fall
 * through to unrestricted.
 */
function bootUnresolvedScope(): FolderScope {
  const prev = process.env.API_FOLDERS_PAYROLL;
  process.env.API_FOLDERS_PAYROLL = "Payroll";
  try {
    const fs = new FolderScope(loadFolderScopes());
    // Vault has NO "Payroll" folder -> payroll resolves to zero folders.
    fs.loadFrom(
      [{ id: "folder-infra", name: "Infrastructure" }],
      [
        { name: "payroll-secret", folderId: "folder-infra" },
        { name: "infra-secret", folderId: "folder-infra" },
      ],
    );
    return fs;
  } finally {
    if (prev === undefined) delete process.env.API_FOLDERS_PAYROLL;
    else process.env.API_FOLDERS_PAYROLL = prev;
  }
}

describe("F4 second-order: configured-restricted-but-unresolved fails CLOSED", () => {
  test("unresolved-folder scoped client denies BOTH in- and out-of-folder", async () => {
    const fs = bootUnresolvedScope();
    // Sanity: still classified as restricted despite zero resolved folders.
    expect(fs.isRestricted("legacy:payroll")).toBe(true);
    const app = makeApp(fs, "legacy:payroll");

    // Every item is denied — no fall-through to unrestricted.
    for (const name of ["payroll-secret", "infra-secret", "anything"]) {
      const res = await capture(app, `/secret/${name}`);
      expect(res.status).toBe(404);
      expect(res.bytes).toBe(JSON.stringify({ error: "Secret not found" }));
    }
    // And list is empty (fail closed), not the full vault.
    const list = await app.request("/secrets");
    const body = (await list.json()) as { secrets: string[]; count: number };
    expect(body.secrets).toEqual([]);
    expect(body.count).toBe(0);
  });

  test("NOT-initialized scope: configured-restricted client denies (fail closed)", async () => {
    const prev = process.env.API_FOLDERS_PAYROLL;
    process.env.API_FOLDERS_PAYROLL = "Payroll";
    let fs: FolderScope;
    try {
      fs = new FolderScope(loadFolderScopes()); // never loadFrom()/initialize()
    } finally {
      if (prev === undefined) delete process.env.API_FOLDERS_PAYROLL;
      else process.env.API_FOLDERS_PAYROLL = prev;
    }
    // Pre-init: restricted classification holds; every access denied.
    expect(fs.isRestricted("legacy:payroll")).toBe(true);
    expect(fs.isAllowed("legacy:payroll", "payroll-secret")).toBe(false);
    expect(fs.filterItems("legacy:payroll", ["payroll-secret"])).toEqual([]);
    // Unconfigured client is still unrestricted even pre-init.
    expect(fs.isAllowed("legacy:rico", "anything")).toBe(true);
    expect(fs.filterItems("legacy:rico", ["a", "b"])).toEqual(["a", "b"]);
  });

  test("F4 P2: doubled legacy: prefix normalizes to the same scope key", () => {
    const fs = bootFolderScope();
    // legacy:legacy:payroll must key as payroll (defensive strip), so the
    // scoped decision matches — an out-of-folder item is still denied.
    expect(fs.isRestricted("legacy:legacy:payroll")).toBe(true);
    expect(fs.isAllowed("legacy:legacy:payroll", "infra-secret")).toBe(false);
    expect(fs.isAllowed("legacy:legacy:payroll", "payroll-secret")).toBe(true);
  });
});
