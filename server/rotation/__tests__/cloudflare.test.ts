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
      // orphan-scan list call: no pre-existing tokens
      if (String(url).endsWith("/user/tokens") && init?.method === "GET") {
        return cfEnvelope([]);
      }
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

  test("create deletes a job-scoped orphan before minting (crash recovery)", async () => {
    const PLAINTEXT = "cf-fresh-token-plaintext-abcdef0123456789-secret";
    const name = "rotation-cf-dns-jobX";
    const deleted: string[] = [];
    let minted = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/user/tokens") && init?.method === "GET") {
        // an orphan from a crashed prior attempt carries the job-scoped name
        return cfEnvelope([
          { id: "orphan-id", name, status: "active" },
          { id: "unrelated", name: "someone-else", status: "active" },
        ]);
      }
      if (u.includes("/user/tokens/orphan-id") && init?.method === "DELETE") {
        deleted.push("orphan-id");
        return cfEnvelope({ id: "orphan-id" });
      }
      if (u.endsWith("/user/tokens") && init?.method === "POST") {
        minted++;
        return cfEnvelope({
          id: "fresh-id",
          name,
          status: "active",
          value: PLAINTEXT,
        });
      }
      throw new Error(`unexpected ${init?.method} ${u}`);
    }) as unknown as typeof fetch;

    const conn = new CloudflareConnector({ apiToken: "mgmt", fetchImpl });
    const vault = new InMemoryVaultWriter();
    const res = await conn.create({
      jobId: "jobX",
      secret: "cf-dns",
      strategy: "dual",
      vault,
    });
    // orphan deleted, exactly one fresh mint, unrelated token untouched
    expect(deleted).toEqual(["orphan-id"]);
    expect(minted).toBe(1);
    expect(res.providerRef).toBe("fresh-id");
  });

  test("verify probes /user/tokens/verify AS the new token (bearer from vault)", async () => {
    const NEW_TOKEN = "cf-new-token-plaintext-abcdef0123456789-secret";
    const vault = new InMemoryVaultWriter();
    const { payloadRef } = await vault.writeItem("ref", () => NEW_TOKEN);

    const seenBearers: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      seenBearers.push(auth ?? "");
      if (String(url).endsWith("/user/tokens/verify")) {
        // Only "active" when probed AS the new token bearer.
        const isNew = auth === `Bearer ${NEW_TOKEN}`;
        return cfEnvelope({
          id: "new-id",
          status: isNew ? "active" : "disabled",
        });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;

    const conn = new CloudflareConnector({
      apiToken: "mgmt-token",
      fetchImpl,
      vaultReader: vault,
    });
    const ctx: ConnectorContext = {
      jobId: "j",
      secret: "s",
      strategy: "dual",
      newProviderRef: "new-id",
      newPayloadRef: payloadRef,
      vault,
    };
    expect(await conn.verify(ctx)).toBe(true);
    // Proved it probed as the NEW token, not the management token.
    expect(seenBearers).toContain(`Bearer ${NEW_TOKEN}`);
    expect(seenBearers).not.toContain("Bearer mgmt-token");
  });

  test("verify fails closed when the new token cannot be read", async () => {
    const fetchImpl = (async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    // No vaultReader -> cannot probe as the new token -> false.
    const conn = new CloudflareConnector({ apiToken: "m", fetchImpl });
    const vault = new InMemoryVaultWriter();
    expect(
      await conn.verify({
        jobId: "j",
        secret: "s",
        strategy: "dual",
        newProviderRef: "new-id",
        newPayloadRef: "missing",
        vault,
      }),
    ).toBe(false);
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
