#!/usr/bin/env bun
/**
 * scripts/rotate.ts
 *
 * Manual rotation entry point. Mirrors epic #10's direct-call contract:
 * identifiers only, never secret material.
 *
 *   bun run scripts/rotate.ts \
 *     --credential "Cloudflare - DNS API" \
 *     --connector cloudflare \
 *     --strategy dual \
 *     --consumers caddy,certbot \
 *     --idempotency-key operator-supplied-request-id
 *
 * Until the control plane / authz / audit / outbox / vault streams are wired,
 * this defaults to --dry-run: it runs the full state machine against IN-MEMORY
 * fakes and a temp SQLite db, then prints a redacted receipt. Pass --no-dry-run
 * only once the real deps are injected at integration (currently errors out to
 * prevent accidental live rotation).
 *
 * NOTE: no secret values are ever accepted as arguments, printed, or logged.
 * Errors surfaced to stderr are either pre-flight failures (authorization,
 * allowlist, validation -- which never carry material) or stage errors that the
 * engine has already run through its LeakGuard sanitizer, so a generated
 * payload cannot reach this catch. The receipt printed on success is redacted
 * (identifiers + checksums only).
 */

import { Database } from "bun:sqlite";
import { RotationEngine, type RotateRequest } from "../server/rotation/engine";
import type {
  EngineDeps,
  ConsumerAllowlist,
  RotationStrategy,
} from "../server/rotation/deps";
import { TestConnector } from "../server/rotation/connectors/test-connector";
import {
  InMemoryVaultWriter,
  InMemoryControlPlaneStore,
  InMemoryAudit,
  InMemoryOutbox,
  RecordingConsumerReloader,
  allowAllAuthorize,
} from "../server/rotation/fakes";

interface Args {
  credential: string;
  connector: string;
  strategy: RotationStrategy;
  consumers: string[];
  idempotencyKey: string;
  subject: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  let dryRun = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") dryRun = true;
    else if (a === "--no-dry-run") dryRun = false;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith("--")) {
        map.set(key, val);
        i++;
      } else {
        map.set(key, "true");
      }
    }
  }
  const need = (k: string): string => {
    const v = map.get(k);
    if (!v) throw new Error(`missing required --${k}`);
    return v;
  };
  const strategy = (map.get("strategy") ?? "dual") as RotationStrategy;
  if (strategy !== "dual" && strategy !== "single") {
    throw new Error(`invalid --strategy ${strategy} (dual|single)`);
  }
  return {
    credential: need("credential"),
    connector: map.get("connector") ?? "test",
    strategy,
    consumers: (map.get("consumers") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    idempotencyKey: need("idempotency-key"),
    subject: map.get("subject") ?? "cli-operator",
    dryRun,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.dryRun) {
    console.error(
      "Live rotation requires integrated control-plane/authz/audit/outbox/vault deps, " +
        "which are wired at integration. Refusing to run --no-dry-run in this build.",
    );
    process.exit(2);
  }

  // Dry-run wiring: in-memory fakes + temp SQLite. Nothing touches a provider.
  const db = new Database(":memory:");
  const allowlist: ConsumerAllowlist = Object.fromEntries(
    args.consumers.map((c) => [
      c,
      { kind: "systemd", unit: `${c}.service` } as const,
    ]),
  );
  const deps: EngineDeps = {
    store: new InMemoryControlPlaneStore(),
    authorize: allowAllAuthorize(),
    audit: new InMemoryAudit(),
    outbox: new InMemoryOutbox(),
    connector: new TestConnector(),
    vault: new InMemoryVaultWriter(),
    consumerAllowlist: allowlist,
    consumerReloader: new RecordingConsumerReloader(),
  };

  const engine = new RotationEngine(db, deps);
  const req: RotateRequest = {
    credential: args.credential,
    connector: args.connector,
    strategy: args.strategy,
    consumers: args.consumers,
    idempotencyKey: args.idempotencyKey,
    subject: args.subject,
  };

  const receipt = await engine.rotate(req);
  console.log(JSON.stringify({ mode: "dry-run", receipt }, null, 2));
  if (receipt.stage !== "done") process.exitCode = 1;
}

main().catch((err) => {
  console.error(
    "rotation failed:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
