/**
 * Workload-identity middleware + cross-interface equivalence (issue #15).
 *
 * Proves REST / MCP / proxy make the SAME auth decision for the same token,
 * that legacy bearer + PROXY_TOKEN keep working (subject legacy:<...>), and
 * that missing/downgraded auth fails closed with 401.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { IdentityService } from "../identity/identity";
import { MemoryIdentityStore } from "../identity/store";
import {
  workloadIdentity,
  resolveIdentity,
} from "../middleware/workload-identity";

function newService(): IdentityService {
  return new IdentityService(new MemoryIdentityStore());
}

/** Minimal Hono app that echoes clientId after the middleware. */
function appFor(
  service: IdentityService,
  audience: string,
  opts: {
    legacyTokens?: Map<string, string>;
    legacyProxyToken?: string;
  } = {},
) {
  const app = new Hono();
  app.use("*", workloadIdentity({ audience, service, ...opts }));
  app.get("/whoami", (c) => c.json({ clientId: c.get("clientId") }));
  return app;
}

async function callWhoami(app: Hono, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return app.request("/whoami", { headers });
}

describe("workload-identity middleware", () => {
  it("sets clientId = subject on a valid new token", async () => {
    const service = newService();
    const { token } = await service.issueToken({
      subject: "svc:deployer",
      audiences: ["rest"],
    });
    const app = appFor(service, "rest");
    const res = await callWhoami(app, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clientId: "svc:deployer" });
  });

  it("fails closed 401 on missing auth (downgrade)", async () => {
    const service = newService();
    const app = appFor(service, "rest");
    const res = await callWhoami(app);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("fails closed 401 on wrong audience", async () => {
    const service = newService();
    const { token } = await service.issueToken({
      subject: "svc:a",
      audiences: ["mcp"],
    });
    const app = appFor(service, "rest"); // token is mcp-only
    const res = await callWhoami(app, token);
    expect(res.status).toBe(401);
  });

  it("fails closed 401 on revoked token", async () => {
    const service = newService();
    const { token, id } = await service.issueToken({
      subject: "svc:a",
      audiences: ["rest"],
    });
    await service.revokeToken(id);
    const app = appFor(service, "rest");
    expect((await callWhoami(app, token)).status).toBe(401);
  });
});

describe("back-compat: legacy tokens keep working", () => {
  it("legacy bearer token → subject legacy:<client>", async () => {
    const service = newService();
    const legacyTokens = new Map([["legacy-abc-123", "lxc200"]]);
    const app = appFor(service, "rest", { legacyTokens });
    const res = await callWhoami(app, "legacy-abc-123");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clientId: "legacy:lxc200" });
  });

  it("legacy PROXY_TOKEN → subject legacy:proxy", async () => {
    const service = newService();
    const app = appFor(service, "proxy", {
      legacyProxyToken: "proxy-secret-xyz",
    });
    const res = await callWhoami(app, "proxy-secret-xyz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clientId: "legacy:proxy" });
  });

  it("a new vwsk_ token and a legacy token both authenticate additively", async () => {
    const service = newService();
    const { token } = await service.issueToken({
      subject: "svc:new",
      audiences: ["rest"],
    });
    const legacyTokens = new Map([["old-token", "lxc202"]]);
    const app = appFor(service, "rest", { legacyTokens });
    expect(await (await callWhoami(app, token)).json()).toEqual({
      clientId: "svc:new",
    });
    expect(await (await callWhoami(app, "old-token")).json()).toEqual({
      clientId: "legacy:lxc202",
    });
  });
});

describe("cross-interface equivalence (REST / MCP / proxy)", () => {
  it("a multi-audience token resolves identically across all three interfaces", async () => {
    const service = newService();
    const { token } = await service.issueToken({
      subject: "svc:omni",
      audiences: ["rest", "mcp", "proxy"],
    });

    // REST (Hono middleware)
    const restApp = appFor(service, "rest");
    const restId = (await (await callWhoami(restApp, token)).json()).clientId;

    // MCP path uses resolveIdentity directly (raw Request path in mcp.ts).
    const mcpSubject = await resolveIdentity(token, {
      audience: "mcp",
      service,
    });

    // Proxy path (Hono middleware, proxy audience).
    const proxyApp = appFor(service, "proxy");
    const proxyId = (await (await callWhoami(proxyApp, token)).json()).clientId;

    expect(restId).toBe("svc:omni");
    expect(mcpSubject).toBe("svc:omni");
    expect(proxyId).toBe("svc:omni");
    expect(restId).toBe(mcpSubject);
    expect(mcpSubject).toBe(proxyId);
  });

  it("an audience-scoped token is rejected identically on the wrong interface", async () => {
    const service = newService();
    const { token } = await service.issueToken({
      subject: "svc:rest-only",
      audiences: ["rest"],
    });

    // Accepted on REST.
    const restApp = appFor(service, "rest");
    expect((await callWhoami(restApp, token)).status).toBe(200);

    // Rejected on MCP (resolveIdentity → null) and proxy (401) — same decision.
    expect(
      await resolveIdentity(token, { audience: "mcp", service }),
    ).toBeNull();
    const proxyApp = appFor(service, "proxy");
    expect((await callWhoami(proxyApp, token)).status).toBe(401);
  });

  it("a revoked token is rejected identically across interfaces", async () => {
    const service = newService();
    const { token, id } = await service.issueToken({
      subject: "svc:x",
      audiences: ["rest", "mcp", "proxy"],
    });
    await service.revokeToken(id);

    const restApp = appFor(service, "rest");
    const proxyApp = appFor(service, "proxy");
    expect((await callWhoami(restApp, token)).status).toBe(401);
    expect(
      await resolveIdentity(token, { audience: "mcp", service }),
    ).toBeNull();
    expect((await callWhoami(proxyApp, token)).status).toBe(401);
  });
});
