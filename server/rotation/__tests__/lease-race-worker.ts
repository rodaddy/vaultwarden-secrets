/**
 * lease-race-worker.ts — subprocess for the genuine multi-PROCESS lease race
 * test. Each worker opens its OWN connection to a shared on-disk DB and hammers
 * acquireLease for the same secret across ROUNDS rounds, synchronized to a
 * shared barrier so both processes contend on the SAME round at the SAME time.
 *
 * Invoked by lease.test.ts via Bun.spawn. Not a test file itself (no bun:test
 * import), so it will not be collected by the runner.
 *
 * Barrier: a `race_barrier(round, worker)` table. Each worker, per round r,
 * marks itself ready, then waits until BOTH workers are ready for r, then fires
 * acquire "simultaneously". The wait is BOUNDED: if the peer never shows up
 * within a budget it exits with a clear error (never an unbounded hang -- that
 * unbounded spin was the original flake/timeout root cause).
 *
 * Output: one JSON line per round to stdout:
 *   {"round":r,"result":"acquired"|"notacquired","fence":n}
 *   {"round":r,"result":"busyerror","error":"..."}   <-- must never happen
 * On a barrier timeout it prints {"fatal":"barrier timeout ..."} and exits 3.
 *
 * argv: <dbPath> <workerId 0|1> <secret> <rounds>
 */

import { Database } from "bun:sqlite";
import { RotationStore } from "../store-sqlite";

const [dbPath, workerIdRaw, secret, roundsRaw] = process.argv.slice(2);
const workerId = Number(workerIdRaw);
const rounds = Number(roundsRaw);
const owner = `worker-${workerId}-${process.pid}`;

// Total wall budget for the whole worker; well under the test's own timeout so
// the worker fails fast with a message instead of letting the test hit 60s.
const WORKER_BUDGET_MS = 20_000;
// Per-round barrier wait budget. Generous enough to absorb cold-start skew
// under full-suite load, bounded so a missing peer never hangs.
const BARRIER_WAIT_MS = 8_000;
const startedAt = Date.now();

const db = new Database(dbPath!);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 2000");
db.run(
  "CREATE TABLE IF NOT EXISTS race_barrier (round INTEGER, worker INTEGER, PRIMARY KEY(round, worker))",
);

// autoMigrate=false: the parent created the schema; we only add pragmas.
const store = new RotationStore(db, false);

/** Short synchronous sleep without an unbounded spin. */
function napMs(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin fallback */
    }
  }
}

function markReady(round: number): void {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      db.query(
        "INSERT OR IGNORE INTO race_barrier (round, worker) VALUES (?, ?)",
      ).run(round, workerId);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/locked/i.test(msg) && Date.now() < deadline) {
        napMs(3);
        continue;
      }
      throw err;
    }
  }
}

function readyCount(round: number): number {
  const r = db
    .query("SELECT COUNT(*) AS n FROM race_barrier WHERE round = ?")
    .get(round) as { n: number };
  return r.n;
}

/**
 * BOUNDED barrier: wait until both workers are ready for `round`, or fail with
 * a clear message. Returns normally on success; throws on timeout so the caller
 * prints a fatal line and exits non-zero (never a silent hang).
 */
function awaitBoth(round: number): void {
  const deadline = Date.now() + BARRIER_WAIT_MS;
  while (readyCount(round) < 2) {
    if (Date.now() > deadline) {
      throw new Error(
        `barrier timeout: worker ${workerId} waited ${BARRIER_WAIT_MS}ms for peer at round ${round} (peer never arrived)`,
      );
    }
    napMs(2);
  }
}

const lines: string[] = [];
try {
  for (let round = 0; round < rounds; round++) {
    if (Date.now() - startedAt > WORKER_BUDGET_MS) {
      throw new Error(
        `worker budget exceeded (${WORKER_BUDGET_MS}ms) at round ${round}`,
      );
    }
    // Logical clock: rounds are 1000ms apart; ttl 50ms so the prior round's
    // lease is always expired -> exactly one winner per round.
    const now = 1_000_000 + round * 1000;

    markReady(round);
    awaitBoth(round); // bounded; throws on a missing peer

    try {
      const handle = store.acquireLease(secret!, owner, now, 50);
      lines.push(
        handle
          ? JSON.stringify({ round, result: "acquired", fence: handle.fence })
          : JSON.stringify({ round, result: "notacquired" }),
      );
    } catch (err) {
      // A thrown BUSY here is the FAILURE the test hunts for: busy must be a
      // loss, not an error.
      lines.push(
        JSON.stringify({
          round,
          result: "busyerror",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  process.stdout.write(lines.join("\n") + "\n");
  db.close();
} catch (err) {
  // Emit whatever rounds completed, then a fatal marker, and exit non-zero so
  // the test surfaces a clear failure instead of timing out.
  if (lines.length) process.stdout.write(lines.join("\n") + "\n");
  process.stdout.write(
    JSON.stringify({
      fatal: err instanceof Error ? err.message : String(err),
    }) + "\n",
  );
  db.close();
  process.exit(3);
}
