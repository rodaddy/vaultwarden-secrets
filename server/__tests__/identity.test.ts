/**
 * Workload-identity contract tests (issue #15).
 *
 * Covers issuance, verify, expiry, wrong-audience, revocation, rotation
 * overlap, downgrade (missing auth), token format, and no-plaintext-at-rest.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { IdentityService, hashToken, parseTokenId } from "../identity/identity";
import { MemoryIdentityStore } from "../identity/store";

function svc(): { service: IdentityService; store: MemoryIdentityStore } {
  const store = new MemoryIdentityStore();
  return { service: new IdentityService(store), store };
}

describe("identity: issuance", () => {
  it("issues an opaque vwsk_<id>_<random> token", async () => {
    const { service } = svc();
    const { token, id } = await service.issueToken({
      subject: "svc:a",
      audiences: ["rest"],
    });
    expect(token.startsWith("vwsk_")).toBe(true);
    expect(parseTokenId(token)).toBe(id);
    expect(token.split("_").length).toBeGreaterThanOrEqual(3);
  });

  it("requires subject and at least one audience", async () => {
    const { service } = svc();
    await expect(
      service.issueToken({ subject: "", audiences: ["rest"] }),
    ).rejects.toThrow();
    await expect(
      service.issueToken({ subject: "x", audiences: [] }),
    ).rejects.toThrow();
  });

  it("persists only the sha256 hash, never the plaintext token", async () => {
    const { service, store } = svc();
    const { token, id } = await service.issueToken({
      subject: "svc:a",
      audiences: ["rest"],
    });
    const record = await store.findById(id);
    expect(record).not.toBeNull();
    expect(record!.tokenHash).toBe(hashToken(token));
    // No field on the record equals the plaintext token.
    const serialized = JSON.stringify(record);
    expect(serialized.includes(token)).toBe(false);
  });
});

describe("identity: verify", () => {
  it("verifies a valid token for the right audience", async () => {
    const { service } = svc();
    const { token } = await service.issueToken({
      subject: "svc:a",
      audiences: ["rest", "mcp"],
    });
    const id = await service.verifyToken(token, "rest");
    expect(id).not.toBeNull();
    expect(id!.subject).toBe("svc:a");
    expect(id!.audiences).toEqual(["rest", "mcp"]);
  });

  it("fails closed on wrong audience", async () => {
    const { service } = svc();
    const { token } = await service.issueToken({
      subject: "svc:a",
      audiences: ["rest"],
    });
    expect(await service.verifyToken(token, "mcp")).toBeNull();
  });

  it("fails closed on garbage / malformed token", async () => {
    const { service } = svc();
    expect(await service.verifyToken("not-a-token", "rest")).toBeNull();
    expect(await service.verifyToken("vwsk_", "rest")).toBeNull();
    expect(await service.verifyToken("", "rest")).toBeNull();
  });

  it("fails closed on unknown id even with valid shape", async () => {
    const { service } = svc();
    expect(await service.verifyToken("vwsk_deadbeef_zzzz", "rest")).toBeNull();
  });

  it("fails closed when a forged token shares an id but wrong secret", async () => {
    const { service } = svc();
    const { token, id } = await service.issueToken({
      subject: "svc:a",
      audiences: ["rest"],
    });
    const forged = `vwsk_${id}_forgedsecretvalue`;
    expect(forged).not.toBe(token);
    expect(await service.verifyToken(forged, "rest")).toBeNull();
  });
});

describe("identity: expiry", () => {
  it("rejects an expired token", async () => {
    const { service } = svc();
    const { token } = await service.issueToken({
      subject: "svc:a",
      audiences: ["rest"],
      ttlSeconds: -1, // already expired
    });
    expect(await service.verifyToken(token, "rest")).toBeNull();
  });

  it("accepts a token within its TTL and reports expiresAt", async () => {
    const { service } = svc();
    const { token } = await service.issueToken({
      subject: "svc:a",
      audiences: ["rest"],
      ttlSeconds: 3600,
    });
    const id = await service.verifyToken(token, "rest");
    expect(id).not.toBeNull();
    expect(id!.expiresAt).not.toBeNull();
  });

  it("non-expiring token has null expiresAt", async () => {
    const { service } = svc();
    const { token } = await service.issueToken({
      subject: "svc:a",
      audiences: ["rest"],
    });
    const id = await service.verifyToken(token, "rest");
    expect(id!.expiresAt).toBeNull();
  });
});

describe("identity: revocation", () => {
  it("rejects a revoked token", async () => {
    const { service } = svc();
    const { token, id } = await service.issueToken({
      subject: "svc:a",
      audiences: ["rest"],
    });
    expect(await service.verifyToken(token, "rest")).not.toBeNull();
    await service.revokeToken(id);
    expect(await service.verifyToken(token, "rest")).toBeNull();
  });

  it("revoking an unknown id is a no-op", async () => {
    const { service } = svc();
    await service.revokeToken("nope"); // must not throw
  });
});

describe("identity: rotation overlap", () => {
  it("issues a new token and keeps the old valid through the overlap window", async () => {
    const { service } = svc();
    const original = await service.issueToken({
      subject: "svc:a",
      audiences: ["rest"],
    });
    const rotated = await service.rotateToken(original.id, 60);

    expect(rotated.id).not.toBe(original.id);
    // Both valid during overlap.
    expect(await service.verifyToken(original.token, "rest")).not.toBeNull();
    expect(await service.verifyToken(rotated.token, "rest")).not.toBeNull();
  });

  it("old token dies immediately when overlap is zero", async () => {
    const { service } = svc();
    const original = await service.issueToken({
      subject: "svc:a",
      audiences: ["rest"],
    });
    const rotated = await service.rotateToken(original.id, 0);
    expect(await service.verifyToken(original.token, "rest")).toBeNull();
    expect(await service.verifyToken(rotated.token, "rest")).not.toBeNull();
  });

  it("rotated token inherits subject and audiences", async () => {
    const { service } = svc();
    const original = await service.issueToken({
      subject: "svc:a",
      audiences: ["rest", "proxy"],
    });
    const rotated = await service.rotateToken(original.id, 30);
    const id = await service.verifyToken(rotated.token, "proxy");
    expect(id!.subject).toBe("svc:a");
    expect(id!.audiences).toEqual(["rest", "proxy"]);
  });

  it("rotating an unknown id throws", async () => {
    const { service } = svc();
    await expect(service.rotateToken("nope", 10)).rejects.toThrow();
  });
});

describe("identity: listing is metadata-only", () => {
  it("never exposes tokenHash in the operator listing", async () => {
    const { service } = svc();
    await service.issueToken({ subject: "svc:a", audiences: ["rest"] });
    const records = await service.listRecords();
    expect(records.length).toBe(1);
    expect("tokenHash" in records[0]).toBe(false);
    expect(records[0].subject).toBe("svc:a");
  });
});
