/**
 * lease-race-worker.ts — subprocess for the genuine multi-PROCESS lease race
 * test. Each worker opens its OWN connection to a shared on-disk DB and hammers
 * acquireLease for the same secret across ROUNDS rounds, synchronized to a
 * shared barrier so both processes contend on the SAME round at the SAME time.
 *
 * Invoked by lease.test.ts via Bun.spawn. Not a test file itself (no bun:test
 * import), so it will not be collected by the runner.
 *
 * Barrier: a tiny SQLite table `race_barrier(round INTEGER)` in the same DB.
 * Each worker, per round r: bumps its "ready" flag, then busy-waits until BOTH
 * workers are ready for round r, then fires acquire simultaneously. This forces
 * true cross-process write contention on rotation_leases.
 *
 * Output: one JSON line per round to stdout:
 *   {"round":r,"result":"acquired"|"notacquired","fence":n}
 *   {"round":r,"result":"busyerror","error":"..."}   <-- must never happen
 *
 * argv: <dbPath> <workerId 0|1> <secret> <rounds>
 */

import { Database } from "bun:sqlite";
import { RotationStore } from "../store-sqlite";

const [dbPath, workerIdRaw, secret, roundsRaw] = process.argv.slice(2);
const workerId = Number(workerIdRaw);
const rounds = Number(roundsRaw);
const owner = `worker-${workerId}-${process.pid}`;

const db = new Database(dbPath!);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 2000");
// Barrier table: (round, worker) rows mark readiness.
db.run(
  "CREATE TABLE IF NOT EXISTS race_barrier (round INTEGER, worker INTEGER, PRIMARY KEY(round, worker))",
);

// autoMigrate=false: the parent created the schema; we only add pragmas.
const store = new RotationStore(db, false);

function markReady(round: number): void {
  for (;;) {
    try {
      db.query(
        "INSERT OR IGNORE INTO race_barrier (round, worker) VALUES (?, ?)",
      ).run(round, workerId);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/locked/i.test(msg)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);
        continue;
      }
      throw err;
    }
  }
}

function bothReady(round: number): boolean {
  const r = db
    .query("SELECT COUNT(*) AS n FROM race_barrier WHERE round = ?")
    .get(round) as { n: number };
  return r.n >= 2;
}

const lines: string[] = [];
for (let round = 0; round < rounds; round++) {
  // Logical clock: each round is 1000ms apart; ttl 50ms so the prior round's
  // lease is always expired by the time this round starts -> exactly one winner.
  const now = 1_000_000 + round * 1000;

  markReady(round);
  // Spin until BOTH workers have marked ready for this round -> simultaneous fire.
  while (!bothReady(round)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
  }

  try {
    const handle = store.acquireLease(secret!, owner, now, 50);
    if (handle) {
      lines.push(
        JSON.stringify({ round, result: "acquired", fence: handle.fence }),
      );
    } else {
      lines.push(JSON.stringify({ round, result: "notacquired" }));
    }
  } catch (err) {
    // A thrown BUSY here is the FAILURE the test hunts for: busy must be a loss,
    // not an error.
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
