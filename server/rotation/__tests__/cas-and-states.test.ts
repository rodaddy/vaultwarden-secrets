import { describe, test, expect } from "bun:test";
import {
  canTransition,
  isTerminal,
  nextHappyStage,
  HAPPY_PATH,
  TRANSITIONS,
  type RotationStage,
} from "../states";
import { InMemoryControlPlaneStore, CasViolationError } from "../fakes";
import { LeakGuard, SecretLeakError } from "../guard";

describe("state machine graph", () => {
  test("happy path stages chain legally", () => {
    for (let i = 0; i < HAPPY_PATH.length - 1; i++) {
      expect(canTransition(HAPPY_PATH[i]!, HAPPY_PATH[i + 1]!)).toBe(true);
    }
  });

  test("terminal stages have no outbound transitions", () => {
    for (const t of [
      "done",
      "rolled-back",
      "reconcile-required",
    ] as RotationStage[]) {
      expect(isTerminal(t)).toBe(true);
      expect(TRANSITIONS[t].length).toBe(0);
    }
  });

  test("illegal jumps are rejected", () => {
    expect(canTransition("requested", "done")).toBe(false);
    expect(canTransition("staged", "old-revoked")).toBe(false);
    expect(canTransition("verified", "old-revoked")).toBe(false);
  });

  test("every non-terminal stage can reach a terminal outcome", () => {
    // reachability: BFS from each stage must hit a terminal
    const terminals = new Set(["done", "rolled-back", "reconcile-required"]);
    for (const start of Object.keys(TRANSITIONS) as RotationStage[]) {
      const seen = new Set<RotationStage>();
      const q: RotationStage[] = [start];
      let reached = false;
      while (q.length) {
        const s = q.shift()!;
        if (terminals.has(s)) {
          reached = true;
          break;
        }
        if (seen.has(s)) continue;
        seen.add(s);
        q.push(...TRANSITIONS[s]);
      }
      expect(reached).toBe(true);
    }
  });

  test("nextHappyStage", () => {
    expect(nextHappyStage("requested")).toBe("provider-created");
    expect(nextHappyStage("old-revoked")).toBe("done");
    expect(nextHappyStage("done")).toBe(null);
  });
});

describe("alias CAS guard", () => {
  test("move rejected when live alias drifted from expected", async () => {
    const store = new InMemoryControlPlaneStore();
    await store.addVersion({
      secret: "s",
      payloadRef: "r1",
      checksum: "c1",
      idempotencyKey: "k1",
    }); // v1
    await store.addVersion({
      secret: "s",
      payloadRef: "r2",
      checksum: "c2",
      idempotencyKey: "k2",
    }); // v2
    // set alias to v1
    await store.moveAlias({
      secret: "s",
      alias: "current",
      toVersion: 1,
      expectedFromVersion: null,
    });
    // a stale retry expects alias still unset (null) -> must be rejected
    await expect(
      store.moveAlias({
        secret: "s",
        alias: "current",
        toVersion: 2,
        expectedFromVersion: null,
      }),
    ).rejects.toBeInstanceOf(CasViolationError);
    // correct expectation succeeds
    await store.moveAlias({
      secret: "s",
      alias: "current",
      toVersion: 2,
      expectedFromVersion: 1,
    });
    expect(store.aliasVersion("s", "current")).toBe(2);
  });
});

describe("LeakGuard", () => {
  test("throws when armed sentinel appears in serialized value", () => {
    const g = new LeakGuard();
    g.arm("SENTINEL-secret-value-123456");
    expect(() => g.assertClean({ a: 1 }, "ok")).not.toThrow();
    expect(() =>
      g.assertClean({ leaked: "x SENTINEL-secret-value-123456 y" }, "bad"),
    ).toThrow(SecretLeakError);
  });

  test("ignores short sentinels", () => {
    const g = new LeakGuard();
    g.arm("short");
    expect(() => g.assertClean({ v: "short" }, "ok")).not.toThrow();
  });
});
