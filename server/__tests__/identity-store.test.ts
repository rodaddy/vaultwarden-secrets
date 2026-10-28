/**
 * FileIdentityStore tests (issue #15 storage contract).
 *
 * Asserts 0600 file perms, no plaintext token at rest, and CRUD round-trips.
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  statSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileIdentityStore } from "../identity/store";
import { IdentityService } from "../identity/identity";

const tmpFiles: string[] = [];

function tmpStorePath(): string {
  const p = join(
    tmpdir(),
    `vwsk-store-${crypto.randomUUID()}`,
    "identities.json",
  );
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try {
      rmSync(join(f, ".."), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("FileIdentityStore", () => {
  it("creates the state file with 0600 permissions", () => {
    const path = tmpStorePath();
    new FileIdentityStore(path);
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("creates the state directory with 0700 permissions", () => {
    const path = tmpStorePath();
    new FileIdentityStore(path);
    const dirMode = statSync(join(path, "..")).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });

  it("round-trips records and never writes the plaintext token", async () => {
    const path = tmpStorePath();
    const service = new IdentityService(new FileIdentityStore(path));
    const { token, id } = await service.issueToken({
      subject: "svc:file",
      audiences: ["rest"],
    });

    const onDisk = readFileSync(path, "utf8");
    expect(onDisk.includes(token)).toBe(false);

    // Fresh store instance reads the same record.
    const store2 = new FileIdentityStore(path);
    const record = await store2.findById(id);
    expect(record).not.toBeNull();
    expect(record!.subject).toBe("svc:file");
  });

  it("verify works against a reloaded store (persistence)", async () => {
    const path = tmpStorePath();
    const svc1 = new IdentityService(new FileIdentityStore(path));
    const { token } = await svc1.issueToken({
      subject: "svc:persist",
      audiences: ["mcp"],
    });

    const svc2 = new IdentityService(new FileIdentityStore(path));
    const identity = await svc2.verifyToken(token, "mcp");
    expect(identity).not.toBeNull();
    expect(identity!.subject).toBe("svc:persist");
  });

  it("reads legacy bare-array files transparently", async () => {
    const path = tmpStorePath();
    new FileIdentityStore(path); // creates wrapped container
    // Overwrite with a legacy bare-array record.
    writeFileSync(
      path,
      JSON.stringify([
        {
          id: "legacyid",
          tokenHash: "x".repeat(64),
          subject: "svc:legacy",
          audiences: ["rest"],
          expiresAt: null,
          issuedAt: new Date().toISOString(),
        },
      ]),
    );
    const store = new FileIdentityStore(path);
    const rec = await store.findById("legacyid");
    expect(rec).not.toBeNull();
    expect(rec!.subject).toBe("svc:legacy");
  });
});

describe("FileIdentityStore concurrency (SEC-3)", () => {
  it("does not lose a revocation under concurrent writes", async () => {
    const path = tmpStorePath();
    // Two independent service instances sharing one file — models two processes.
    const a = new IdentityService(new FileIdentityStore(path));
    const b = new IdentityService(new FileIdentityStore(path));

    // Seed several tokens.
    const issued = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        a.issueToken({ subject: `svc:${i}`, audiences: ["rest"] }),
      ),
    );

    // Concurrently: revoke one token via A while B issues more tokens.
    const target = issued[3];
    await Promise.all([
      a.revokeToken(target.id),
      ...Array.from({ length: 8 }, (_, i) =>
        b.issueToken({ subject: `svc:new-${i}`, audiences: ["rest"] }),
      ),
    ]);

    // The revocation must survive the interleaved writes (fail closed).
    const c = new IdentityService(new FileIdentityStore(path));
    expect(await c.verifyToken(target.token, "rest")).toBeNull();

    // And no records were lost: 8 seed + 8 new = 16 present.
    const records = await c.listRecords();
    expect(records.length).toBe(16);
  });

  it("bumps a monotonic version on each mutation", async () => {
    const path = tmpStorePath();
    const svc = new IdentityService(new FileIdentityStore(path));
    await svc.issueToken({ subject: "svc:v", audiences: ["rest"] });
    const v1 = JSON.parse(readFileSync(path, "utf8")).version;
    await svc.issueToken({ subject: "svc:v2", audiences: ["rest"] });
    const v2 = JSON.parse(readFileSync(path, "utf8")).version;
    expect(typeof v1).toBe("number");
    expect(v2).toBeGreaterThan(v1);
  });
});

describe("verify fails closed on corrupt timestamps (SEC-4)", () => {
  it("rejects a record with an unparseable expiresAt", async () => {
    const path = tmpStorePath();
    const svc = new IdentityService(new FileIdentityStore(path));
    const { token, id } = await svc.issueToken({
      subject: "svc:nan",
      audiences: ["rest"],
    });

    // Corrupt the persisted expiresAt to a non-date string.
    const container = JSON.parse(readFileSync(path, "utf8"));
    const rec = container.records.find((r: any) => r.id === id);
    rec.expiresAt = "not-a-date";
    writeFileSync(path, JSON.stringify(container));

    const reloaded = new IdentityService(new FileIdentityStore(path));
    expect(await reloaded.verifyToken(token, "rest")).toBeNull();
  });

  it("rejects a record with an unparseable supersededAt", async () => {
    const path = tmpStorePath();
    const svc = new IdentityService(new FileIdentityStore(path));
    const { token, id } = await svc.issueToken({
      subject: "svc:nan2",
      audiences: ["rest"],
    });

    const container = JSON.parse(readFileSync(path, "utf8"));
    const rec = container.records.find((r: any) => r.id === id);
    rec.supersededAt = "garbage";
    writeFileSync(path, JSON.stringify(container));

    const reloaded = new IdentityService(new FileIdentityStore(path));
    expect(await reloaded.verifyToken(token, "rest")).toBeNull();
  });

  it("rejects a record whose audiences field is corrupt", async () => {
    const path = tmpStorePath();
    const svc = new IdentityService(new FileIdentityStore(path));
    const { token, id } = await svc.issueToken({
      subject: "svc:aud",
      audiences: ["rest"],
    });

    const container = JSON.parse(readFileSync(path, "utf8"));
    const rec = container.records.find((r: any) => r.id === id);
    rec.audiences = "rest"; // string, not array
    writeFileSync(path, JSON.stringify(container));

    const reloaded = new IdentityService(new FileIdentityStore(path));
    expect(await reloaded.verifyToken(token, "rest")).toBeNull();
  });
});
