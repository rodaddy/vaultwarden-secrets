import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { RotationEngine, type RotateRequest } from "../engine";
import type { EngineDeps, ConsumerAllowlist } from "../deps";
import { TestConnector } from "../connectors/test-connector";
import {
  InMemoryVaultWriter,
  InMemoryControlPlaneStore,
  InMemoryAudit,
  InMemoryOutbox,
  RecordingConsumerReloader,
  allowAllAuthorize,
} from "../fakes";

const SENTINEL = "CRASH-RESUME-secret-material-abcdef0123456789";

function baseDeps(over: Partial<EngineDeps> = {}, connOpts = {}): EngineDeps {
  const consumerAllowlist: ConsumerAllowlist = {
    caddy: { kind: "systemd", unit: "caddy.service" },
  };
  return {
    store: new InMemoryControlPlaneStore(),
    authorize: allowAllAuthorize(),
    audit: new InMemoryAudit(),
    outbox: new InMemoryOutbox(),
    connector: new TestConnector({ material: SENTINEL, ...connOpts }),
    vault: new InMemoryVaultWriter(),
    consumerAllowlist,
    consumerReloader: new RecordingConsumerReloader(),
    ...over,
  };
}

function req(): RotateRequest {
  return {
    credential: "svc-token",
    connector: "test",
    strategy: "dual",
    consumers: ["caddy"],
    idempotencyKey: "resume-1",
    subject: "operator",
  };
}

describe("crash-resume", () => {
  test("step-wise drive then resumePending completes the job", async () => {
    // Share ONE db + ONE set of deps across the two "process lifetimes" so
    // durable state survives the simulated crash. (Control plane / vault are
    // external services in reality; here in-memory instances stand in.)
    const db = new Database(":memory:");
    const deps = baseDeps();
    const engine1 = new RotationEngine(db, deps);

    // Manually create the job + drive a few steps, then "crash" (stop stepping).
    // We use step() to advance stage by stage.
    // First start via rotate() is atomic to completion, so instead we mimic a
    // partial run by constructing the job through a short-circuited engine:
    // step() requires an existing job, so seed one by starting rotate in a
    // connector that stalls verify -> we instead drive manually.

    // Seed a job at 'requested' using the store directly is not exposed; use
    // rotate() with a connector that throws AFTER consumers to leave a
    // non-terminal, resumable state is complex. Simplest faithful simulation:
    // run rotate() to completion is NOT a crash. So drive step-by-step here.

    // Insert job by calling the private path via a fresh engine that we stop.
    // We expose step(): but we need a job id first. Create one by running the
    // first transition only. Use a connector that blocks verify indefinitely
    // is overkill; instead we drive with step() after seeding.

    // Seed: start a rotation whose connector fails at 'consumers-reloaded'
    // verify by making verify hang is not allowed offline. Use failOn verify
    // with retries exhausted would go terminal. Instead: use a connector that
    // succeeds, but drive with step() so WE control stopping.

    // To get a job id we call an internal seed: run rotate with a connector
    // that throws a sentinel we catch, leaving job persisted mid-way.
    const jobId = "resume-job-1";
    // Use step-based driving: first we must persist the job. Do it by calling
    // rotate() but with maxAttempts high and a connector that we stop via
    // step. Since rotate() runs to terminal, we instead reach into a fresh
    // engine and drive purely by step() after seeding the requested row.

    // Seed the requested row through a throw-away rotate that fails fast and
    // is resumable: connector fails verify with retries so it lands terminal.
    // -> Not resumable. Therefore we drive step-wise from the very start using
    // a dedicated seeding helper on the engine: startJob.
    const seeded = await engine1.startJob({ ...req(), jobId });
    expect(seeded.stage).toBe("requested");

    // Advance two stages then "crash".
    await engine1.step(jobId); // -> provider-created
    await engine1.step(jobId); // -> staged
    const mid = engine1.getReceipt(jobId);
    expect(mid.stage).toBe("staged");
    expect(mid.stage).not.toBe("done");

    // New engine instance (new "process"), SAME durable db + deps.
    const engine2 = new RotationEngine(db, deps);
    const resumed = await engine2.resumePending();
    expect(resumed.length).toBe(1);
    expect(resumed[0]!.stage).toBe("done");

    // Verify the material still lives only in the vault, never in job rows.
    const rows = JSON.stringify(db.query("SELECT * FROM rotation_jobs").all());
    const cks = JSON.stringify(
      db.query("SELECT * FROM rotation_checkpoints").all(),
    );
    expect(rows.includes(SENTINEL)).toBe(false);
    expect(cks.includes(SENTINEL)).toBe(false);
  });
});
