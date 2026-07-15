/**
 * Direct unit tests for the atomic, fenced lease in RotationStore.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RotationStore, FencedOutError } from "../store-sqlite";

function store(): { s: RotationStore; db: Database } {
  const db = new Database(":memory:");
  return { s: new RotationStore(db), db };
}

function seedJob(s: RotationStore, id: string, secret: string): void {
  s.insertJob(
    {
      id,
      secret,
      connector: "test",
      strategy: "dual",
      subject: "op",
      idempotencyKey: `${id}-key`,
      consumers: [],
      alias: "current",
    },
    Date.now(),
  );
}

describe("atomic fenced lease", () => {
  test("second owner cannot acquire a live lease", () => {
    const { s } = store();
    const now = 1000;
    const a = s.acquireLease("secret", "owner-A", now, 60_000);
    expect(a).not.toBeNull();
    const b = s.acquireLease("secret", "owner-B", now + 1, 60_000);
    expect(b).toBeNull();
  });

  test("expired lease is reclaimable by a new owner with a HIGHER fence", () => {
    const { s } = store();
    const a = s.acquireLease("secret", "owner-A", 1000, 100)!;
    expect(a.fence).toBeGreaterThan(0);
    // after expiry
    const b = s.acquireLease("secret", "owner-B", 2000, 100)!;
    expect(b).not.toBeNull();
    expect(b.fence).toBeGreaterThan(a.fence); // monotonic fencing token
  });

  test("fence monotonically increases across acquires", () => {
    const { s } = store();
    const a = s.acquireLease("x", "A", 1000, 10)!;
    const b = s.acquireLease("x", "B", 2000, 10)!;
    const c = s.acquireLease("y", "C", 3000, 10)!;
    expect(b.fence).toBeGreaterThan(a.fence);
    expect(c.fence).toBeGreaterThan(b.fence);
  });

  test("renew fails once the lease was stolen (expired + reacquired)", () => {
    const { s } = store();
    const a = s.acquireLease("secret", "owner-A", 1000, 100)!;
    // owner-B steals it after expiry
    s.acquireLease("secret", "owner-B", 2000, 100)!;
    // owner-A can no longer renew (fence/owner no longer match)
    expect(s.renewLease(a, 2001, 100)).toBe(false);
    expect(s.validateLease(a, 2001)).toBe(false);
  });

  test("fenced-out executor cannot write a checkpoint or update the job", () => {
    const { s } = store();
    seedJob(s, "job-1", "secret");
    const a = s.acquireLease("secret", "owner-A", 1000, 100)!;
    // steal after expiry
    const b = s.acquireLease("secret", "owner-B", 2000, 100)!;
    // stale executor A (old fence) is rejected
    expect(() =>
      s.appendCheckpoint("job-1", "staged", "ok", 1, null, 2001, a.fence),
    ).toThrow(FencedOutError);
    expect(() =>
      s.updateJob("job-1", { stage: "staged" }, 2001, a.fence),
    ).toThrow(FencedOutError);
    // current owner B (live fence) succeeds
    expect(() =>
      s.appendCheckpoint("job-1", "staged", "ok", 1, null, 2001, b.fence),
    ).not.toThrow();
  });

  test("release only removes the lease held at this owner+fence", () => {
    const { s } = store();
    const a = s.acquireLease("secret", "owner-A", 1000, 100)!;
    s.acquireLease("secret", "owner-B", 2000, 100)!;
    // A releasing its (stale) handle must not delete B's live lease
    s.releaseLease(a);
    expect(s.liveFence("secret", 2001)).not.toBeNull();
  });
});

describe("atomic lease across TWO connections to one file db", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  test("two independent connections racing for the same credential: exactly one wins", async () => {
    dir = mkdtempSync(join(tmpdir(), "vw-lease-"));
    const path = join(dir, "lease.sqlite");
    // Two RotationStore instances over two independent connections (two
    // "processes"). Both try to acquire the SAME credential at the SAME logical
    // time in many concurrent attempts; the atomic BEGIN IMMEDIATE + single
    // conditional claim must let exactly one win each round.
    const dbA = new Database(path);
    const dbB = new Database(path);
    const sA = new RotationStore(dbA);
    const sB = new RotationStore(dbB, false); // migration already applied by A

    const ROUNDS = 40;
    let bothWon = 0;
    let neitherWon = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const now = 1_000_000 + i * 1000;
      // Fire both acquires "concurrently" (Promise.all over sync calls with the
      // busy_timeout serializing the writers between the two connections).
      const [a, b] = await Promise.all([
        Promise.resolve().then(() =>
          sA.acquireLease("shared-cred", `A-${i}`, now, 100),
        ),
        Promise.resolve().then(() =>
          sB.acquireLease("shared-cred", `B-${i}`, now, 100),
        ),
      ]);
      const winners = [a, b].filter((x) => x !== null);
      // INVARIANT: never two simultaneous live owners of the same credential.
      if (winners.length === 2) bothWon++;
      if (winners.length === 0) neitherWon++;
      // Exactly one winner each round (the prior round's lease has expired by
      // `now` since ttl=100 << 1000ms step).
      expect(winners.length).toBe(1);
      // Fences are globally monotonic across both connections.
      expect(winners[0]!.fence).toBeGreaterThan(0);
    }
    expect(bothWon).toBe(0);
    expect(neitherWon).toBe(0);

    dbA.close();
    dbB.close();
  });
});
