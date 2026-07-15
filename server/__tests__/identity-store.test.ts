/**
 * FileIdentityStore tests (issue #15 storage contract).
 *
 * Asserts 0600 file perms, no plaintext token at rest, and CRUD round-trips.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { statSync, rmSync, readFileSync, existsSync } from "node:fs";
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
});
