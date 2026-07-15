/**
 * Runtime envelope tripwire (issue #14).
 *
 * Parses deploy/systemd/*.service and asserts the declared hardened runtime:
 *   - no unit runs as root (no User=root)
 *   - runtime workload services carry the hardening directives + non-root user
 *   - no unit references the retired deploy trigger port 3002
 *   - runtime workload services declare explicit PATH and HOME
 *
 * This is the "undeclared runtime change" catch: editing a unit to drop
 * hardening or reintroduce root/3002 fails CI here.
 */

import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SYSTEMD_DIR = join(import.meta.dir, "..", "..", "deploy", "systemd");

/** Runtime workload services that must be non-root + hardened. */
const RUNTIME_SERVICES = new Set([
  "vaultwarden-secrets.service",
  "vaultwarden-secrets-mcp.service",
  "vw-cred-proxy.service",
  "vw-snapshot.service",
]);

/**
 * The deploy orchestrator is a privileged oneshot (runs systemctl / writes
 * /etc/systemd) and is intentionally exempt from the non-root workload rule.
 * It must still never literally declare User=root or reference port 3002.
 */
const PRIVILEGED_ORCHESTRATORS = new Set(["vw-deploy.service"]);

function serviceFiles(): string[] {
  return readdirSync(SYSTEMD_DIR).filter((f) => f.endsWith(".service"));
}

function read(name: string): string {
  return readFileSync(join(SYSTEMD_DIR, name), "utf8");
}

/** Parse `Key=Value` and `Environment=K=V` lines (ignores comments). */
function directives(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

describe("runtime envelope: systemd units", () => {
  it("discovers the expected runtime service files", () => {
    const files = serviceFiles();
    for (const svc of RUNTIME_SERVICES) {
      expect(files).toContain(svc);
    }
  });

  it("no unit runs as root (no User=root)", () => {
    for (const f of serviceFiles()) {
      const lines = directives(read(f));
      const rootLine = lines.find((l) => /^User=root$/i.test(l));
      expect(rootLine, `${f} must not declare User=root`).toBeUndefined();
    }
  });

  it("no unit references the retired deploy trigger port 3002", () => {
    for (const f of serviceFiles()) {
      expect(
        read(f).includes("3002"),
        `${f} must not reference port 3002`,
      ).toBe(false);
    }
  });

  describe("runtime workload services are hardened + non-root", () => {
    for (const svc of RUNTIME_SERVICES) {
      it(`${svc} declares a non-root User/Group`, () => {
        const lines = directives(read(svc));
        const user = lines.find((l) => l.startsWith("User="));
        const group = lines.find((l) => l.startsWith("Group="));
        expect(user, `${svc} must declare User=`).toBeDefined();
        expect(user).not.toBe("User=root");
        expect(group, `${svc} must declare Group=`).toBeDefined();
      });

      it(`${svc} declares the hardening directives`, () => {
        const content = read(svc);
        expect(content).toContain("NoNewPrivileges=true");
        expect(content).toContain("ProtectSystem=strict");
        expect(content).toContain("ProtectHome=true");
        expect(content).toContain("PrivateTmp=true");
        expect(content).toContain("StateDirectory=vaultwarden-secrets");
        expect(content).toMatch(/StateDirectoryMode=0700/);
      });

      it(`${svc} declares explicit PATH and HOME`, () => {
        const content = read(svc);
        expect(content, `${svc} must set PATH`).toMatch(/Environment=PATH=/);
        expect(content, `${svc} must set HOME`).toMatch(/Environment=HOME=/);
        // bw lives at /usr/local/bin — its parent must be on PATH.
        expect(content).toMatch(/Environment=PATH=[^\n]*\/usr\/local\/bin/);
      });
    }
  });

  it("privileged orchestrators exist and stay clean of root/3002", () => {
    for (const svc of PRIVILEGED_ORCHESTRATORS) {
      const content = read(svc);
      expect(content.includes("3002")).toBe(false);
      const lines = directives(content);
      expect(lines.find((l) => /^User=root$/i.test(l))).toBeUndefined();
    }
  });
});
