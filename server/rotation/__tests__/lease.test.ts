/**
 * Direct unit tests for the atomic, fenced lease in RotationStore.
 */

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
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
