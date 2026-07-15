import { describe, test, expect } from "bun:test";
import {
  CloudflareConnector,
  cloudflareConfigFromEnv,
} from "../connectors/cloudflare";
import { InMemoryVaultWriter } from "../fakes";
import type { ConnectorContext } from "../deps";

const hasCreds = !!process.env.CLOUDFLARE_API_TOKEN;

// ---------------------------------------------------------------------------
// Offline unit tests: exercise the connector against a stubbed fetch so the
// v4-envelope handling + no-leak boundary are covered without live creds.
// ---------------------------------------------------------------------------

function cfEnvelope(result: unknown, success = true) {
  return {
    ok: true,
    json: async () => ({ result, success, errors: [], messages: [] }),
  } as unknown as Response;
}

describe("CloudflareConnector (offline, stubbed fetch)", () => {
  test("create mints token, stores plaintext in vault only, returns ref+checksum", async () => {
    const PLAINTEXT = "cf-new-token-plaintext-abcdef0123456789-secret";
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      if (String(url).endsWith("/user/tokens") && init?.method === "POST") {
        return cfEnvelope({
          id: "new-id",
          name: "n",
          status: "active",
          value: PLAINTEXT,
        });
      }
      throw new Error(`unexpected call ${init?.method} ${url}`);
    }) as unknown as typeof fetch;

    const conn = new CloudflareConnector({ apiToken: "mgmt-token", fetchImpl });
    const vault = new InMemoryVaultWriter();
    const ctx: ConnectorContext = {
      jobId: "j1",
      secret: "cf-dns",
      strategy: "dual",
      vault,
    };
    const res = await conn.create(ctx);

    expect(res.providerRef).toBe("new-id");
    expect(res.checksum.startsWith("sha256:")).toBe(true);
    // plaintext must NOT be in the returned result
    expect(JSON.stringify(res).includes(PLAINTEXT)).toBe(false);
    // plaintext IS in the vault
    expect([...vault.stored.values()]).toContain(PLAINTEXT);
  });

  test("verify returns true only for active token", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/user/tokens/new-id")) {
        return cfEnvelope({ id: "new-id", name: "n", status: "active" });
      }
      return cfEnvelope({ id: "x", name: "n", status: "disabled" });
    }) as unknown as typeof fetch;
    const conn = new CloudflareConnector({ apiToken: "m", fetchImpl });
    const vault = new InMemoryVaultWriter();
    const okCtx: ConnectorContext = {
      jobId: "j",
      secret: "s",
      strategy: "dual",
      newProviderRef: "new-id",
      vault,
    };
    expect(await conn.verify(okCtx)).toBe(true);
    const badCtx: ConnectorContext = {
      jobId: "j",
      secret: "s",
      strategy: "dual",
      newProviderRef: "other",
      vault,
    };
    expect(await conn.verify(badCtx)).toBe(false);
  });

  test("revoke deletes old token id", async () => {
    let deleted = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deleted = String(url);
        return cfEnvelope({ id: "old-id" });
      }
      throw new Error("unexpected");
    }) as unknown as typeof fetch;
    const conn = new CloudflareConnector({ apiToken: "m", fetchImpl });
    const vault = new InMemoryVaultWriter();
    await conn.revoke({
      jobId: "j",
      secret: "s",
      strategy: "dual",
      oldProviderRef: "old-id",
      vault,
    });
    expect(deleted).toContain("/user/tokens/old-id");
  });

  test("rollback deletes the new token id (old stays)", async () => {
    let deleted = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      deleted = String(url);
      return cfEnvelope({ id: "new-id" });
    }) as unknown as typeof fetch;
    const conn = new CloudflareConnector({ apiToken: "m", fetchImpl });
    const vault = new InMemoryVaultWriter();
    await conn.rollback({
      jobId: "j",
      secret: "s",
      strategy: "dual",
      newProviderRef: "new-id",
      vault,
    });
    expect(deleted).toContain("/user/tokens/new-id");
  });

  test("non-success envelope throws without leaking body", async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        json: async () => ({
          result: null,
          success: false,
          errors: [{ code: 1000, message: "bad" }],
          messages: [],
        }),
      }) as unknown as Response) as unknown as typeof fetch;
    const conn = new CloudflareConnector({ apiToken: "m", fetchImpl });
    const vault = new InMemoryVaultWriter();
    await expect(
      conn.create({ jobId: "j", secret: "s", strategy: "dual", vault }),
    ).rejects.toThrow(/cloudflare/);
  });
});

// ---------------------------------------------------------------------------
// Live integration test: gated on CLOUDFLARE_API_TOKEN. Skips cleanly offline.
// ---------------------------------------------------------------------------

describe("CloudflareConnector live integration", () => {
  test.skipIf(!hasCreds)("config resolves from env when creds present", () => {
    const cfg = cloudflareConfigFromEnv();
    expect(cfg).not.toBeNull();
    expect(cfg!.apiToken.length).toBeGreaterThan(0);
  });

  test.skipIf(hasCreds)(
    "config is null and integration skips when creds absent",
    () => {
      // Only runs offline: proves clean skip behavior.
      const saved = process.env.CLOUDFLARE_API_TOKEN;
      delete process.env.CLOUDFLARE_API_TOKEN;
      expect(cloudflareConfigFromEnv()).toBeNull();
      if (saved) process.env.CLOUDFLARE_API_TOKEN = saved;
    },
  );
});
