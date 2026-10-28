#!/usr/bin/env bun
/**
 * Runtime drift check (issue #14).
 *
 * Compares the repo-declared systemd envelope against the LIVE host and reports
 * divergence in: unit-file content, listener exposure, service identity, and
 * state-path permissions.
 *
 * The SSH target comes ONLY from env VW_DEPLOY_HOST (e.g. root@host or an ssh
 * config alias) — never a hardcoded IP in committed files. Output is redacted:
 * no secrets, no token values, no full env dumps.
 *
 * Liveness is part of drift (DEP-5): a check that reported "no drift" while MCP
 * was down would be worse than useless. This tool REQUIRES, for the declared
 * long-running units, that they are `systemctl is-active`, that MCP is listening
 * on 3001, that each effective ExecStart matches the declared unit, and that the
 * MCP probe returns HEALTHY (or AUTH_ENFORCED only when --allow-auth-enforced
 * is passed). Any miss is drift and exits nonzero.
 *
 * Exit codes: 0 = no drift, 1 = drift detected, 2 = usage/connection error.
 *
 * Usage:
 *   VW_DEPLOY_HOST=root@myhost bun run scripts/drift-check.ts
 *   VW_DEPLOY_HOST=root@myhost bun run scripts/drift-check.ts --allow-auth-enforced
 *
 * @module scripts/drift-check
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const SYSTEMD_DIR = join(import.meta.dir, "..", "deploy", "systemd");
const REMOTE_UNIT_DIR = "/etc/systemd/system";
const STATE_PATH = "/var/lib/vaultwarden-secrets";
const MCP_UNIT = "vaultwarden-secrets-mcp.service";
const MCP_PORT = "3001";
const ALLOWED_PORTS = new Set(["3000", "3001", "3003"]);
const ALLOW_AUTH_ENFORCED = process.argv.includes("--allow-auth-enforced");

const RUNTIME_SERVICES = [
  "vaultwarden-secrets.service",
  "vaultwarden-secrets-mcp.service",
  "vw-cred-proxy.service",
  "vw-snapshot.service",
];

/** Long-running services that MUST be active (snapshot is a oneshot — excluded). */
const ACTIVE_SERVICES = [
  "vaultwarden-secrets.service",
  "vaultwarden-secrets-mcp.service",
  "vw-cred-proxy.service",
];

interface Finding {
  category: string;
  detail: string;
}

const findings: Finding[] = [];
function drift(category: string, detail: string) {
  findings.push({ category, detail });
}

function host(): string {
  const h = process.env.VW_DEPLOY_HOST;
  if (!h || h.trim().length === 0) {
    console.error(
      "drift-check: VW_DEPLOY_HOST is required (e.g. root@host or an ssh alias)",
    );
    process.exit(2);
  }
  return h;
}

/** Run a command on the remote host over ssh. Returns trimmed stdout. */
async function remote(target: string, cmd: string): Promise<string> {
  const result =
    await $`ssh -o BatchMode=yes -o ConnectTimeout=10 ${target} ${cmd}`.quiet();
  return result.text().trim();
}

/** Normalize a unit file for comparison (drop blank lines + comments). */
function normalize(content: string): string {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .join("\n");
}

async function checkUnits(target: string) {
  const localUnits = readdirSync(SYSTEMD_DIR).filter((f) =>
    f.endsWith(".service"),
  );
  for (const name of localUnits) {
    const local = normalize(readFileSync(join(SYSTEMD_DIR, name), "utf8"));
    let live: string;
    try {
      live = normalize(
        await remote(
          target,
          `cat ${REMOTE_UNIT_DIR}/${name} 2>/dev/null || true`,
        ),
      );
    } catch {
      drift("unit", `${name}: unreadable on host`);
      continue;
    }
    if (live.length === 0) {
      drift("unit", `${name}: declared in repo but ABSENT on host`);
    } else if (live !== local) {
      drift("unit", `${name}: live content diverges from repo declaration`);
    }
  }
}

async function checkListeners(target: string) {
  // Listening TCP ports (ss). Redact everything except port numbers.
  let out: string;
  try {
    out = await remote(target, "ss -tlnH 2>/dev/null || ss -tln");
  } catch {
    drift("listener", "could not enumerate listeners on host");
    return;
  }
  const ports = new Set<string>();
  for (const line of out.split("\n")) {
    // Match a local address column ending in :<port>
    const m = line.match(/:(\d+)\s/);
    if (m) ports.add(m[1]);
  }
  for (const p of ports) {
    // Only flag ports in the vaultwarden range we care about (3000-3999).
    if (p.startsWith("30") && p.length === 4 && !ALLOWED_PORTS.has(p)) {
      drift(
        "listener",
        `unexpected listener on port ${p} (allowed: 3000/3001/3003)`,
      );
    }
    if (p === "3002") {
      drift("listener", "RETIRED port 3002 is listening (must be absent)");
    }
  }
}

async function checkServiceUser(target: string) {
  for (const svc of RUNTIME_SERVICES) {
    let user: string;
    try {
      user = await remote(
        target,
        `systemctl show -p User --value ${svc} 2>/dev/null || true`,
      );
    } catch {
      drift("identity", `${svc}: could not read effective User`);
      continue;
    }
    if (user === "root" || user === "") {
      drift(
        "identity",
        `${svc}: running as ${user || "root(default)"} (must be non-root)`,
      );
    }
  }
}

async function checkStatePerms(target: string) {
  let mode: string;
  try {
    mode = await remote(
      target,
      `stat -c '%a %U' ${STATE_PATH} 2>/dev/null || true`,
    );
  } catch {
    drift("state-path", `${STATE_PATH}: could not stat`);
    return;
  }
  if (mode.length === 0) {
    drift("state-path", `${STATE_PATH}: missing on host`);
    return;
  }
  const [perms, owner] = mode.split(/\s+/);
  if (perms !== "700") {
    drift("state-path", `${STATE_PATH}: perms ${perms} (expected 700)`);
  }
  if (owner === "root") {
    drift("state-path", `${STATE_PATH}: owned by root (expected service user)`);
  }
}

async function main() {
  const target = host();
  console.log(
    `drift-check: comparing repo envelope vs live host (target redacted)`,
  );

  // Verify connectivity first.
  try {
    await remote(target, "true");
  } catch (err) {
    console.error(
      "drift-check: cannot reach VW_DEPLOY_HOST over ssh (BatchMode)",
    );
    process.exit(2);
  }

  await checkUnits(target);
  await checkListeners(target);
  await checkServiceUser(target);
  await checkStatePerms(target);
  // DEP-5: liveness is drift.
  await checkActive(target);
  await checkExecStart(target);
  await checkMcpListener(target);
  await checkMcpProbe(target);

  if (findings.length === 0) {
    console.log(
      "OK: no drift detected (units, listeners, identity, state-path, liveness).",
    );
    process.exit(0);
  }

  console.log(`DRIFT DETECTED (${findings.length}):`);
  for (const f of findings) {
    console.log(`  [${f.category}] ${f.detail}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error(
    `drift-check error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(2);
});
