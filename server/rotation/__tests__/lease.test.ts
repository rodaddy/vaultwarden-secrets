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

describe("genuine multi-PROCESS lease race (two subprocesses, one file db)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  test("two OS processes hammer acquire for the same secret; exactly one wins per round, no BUSY thrown", async () => {
    dir = mkdtempSync(join(tmpdir(), "vw-lease-mp-"));
    const path = join(dir, "lease.sqlite");
    const worker = join(import.meta.dir, "lease-race-worker.ts");
    const ROUNDS = 40;
    const SECRET = "shared-cred";

    // Parent creates the schema once (so both workers see it), then spawns two
    // real subprocesses that each open their OWN connection and contend.
    const setup = new Database(path);
    new RotationStore(setup); // applies migration + pragmas
    setup.close();

    const spawnWorker = (id: number) =>
      Bun.spawn(["bun", worker, path, String(id), SECRET, String(ROUNDS)], {
        stdout: "pipe",
        stderr: "pipe",
      });

    const p0 = spawnWorker(0);
    const p1 = spawnWorker(1);
    const [out0, out1, err0, err1] = await Promise.all([
      new Response(p0.stdout).text(),
      new Response(p1.stdout).text(),
      new Response(p0.stderr).text(),
      new Response(p1.stderr).text(),
    ]);
    await Promise.all([p0.exited, p1.exited]);

    // Neither subprocess may have crashed.
    expect(err0.trim()).toBe("");
    expect(err1.trim()).toBe("");
    expect(p0.exitCode).toBe(0);
    expect(p1.exitCode).toBe(0);

    type Line = {
      round: number;
      result: "acquired" | "notacquired" | "busyerror";
      fence?: number;
      error?: string;
    };
    const parse = (s: string): Line[] =>
      s
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Line);
    const r0 = parse(out0);
    const r1 = parse(out1);
    expect(r0.length).toBe(ROUNDS);
    expect(r1.length).toBe(ROUNDS);

    // KEY ASSERTION A: a thrown "database is locked" out of acquire is a test
    // FAILURE -- busy must be handled as a LOSS, not an error.
    const busyErrors = [...r0, ...r1].filter((x) => x.result === "busyerror");
    expect(busyErrors).toEqual([]);

    // KEY ASSERTION B: per round, EXACTLY ONE process acquired, the other got a
    // clean "notacquired" -- across two real OS processes contending on one DB.
    const winners: Array<{ round: number; owner: number; fence: number }> = [];
    for (let round = 0; round < ROUNDS; round++) {
      const a = r0.find((x) => x.round === round)!;
      const b = r1.find((x) => x.round === round)!;
      const acquired = [
        { owner: 0, line: a },
        { owner: 1, line: b },
      ].filter((x) => x.line.result === "acquired");
      const notAcquired = [a, b].filter((x) => x.result === "notacquired");
      expect(acquired.length).toBe(1); // exactly one winner
      expect(notAcquired.length).toBe(1); // the other cleanly lost
      winners.push({
        round,
        owner: acquired[0]!.owner,
        fence: acquired[0]!.line.fence!,
      });
    }

    // KEY ASSERTION C: fences are monotonic (non-decreasing), and strictly
    // increase whenever ownership actually changes between rounds -- proving the
    // fencing token advances on every takeover.
    for (let i = 1; i < winners.length; i++) {
      expect(winners[i]!.fence).toBeGreaterThanOrEqual(winners[i - 1]!.fence);
      if (winners[i]!.owner !== winners[i - 1]!.owner) {
        expect(winners[i]!.fence).toBeGreaterThan(winners[i - 1]!.fence);
      }
    }
  }, 30_000);
});
