/**
 * TLS ingress fail-closed tests (SEC-1).
 *
 * loadTlsConfig is the load/validation core behind the authoritative
 * resolveIngressTls gate. These tests prove it never silently downgrades:
 * cert-but-no-key, invalid key, and unreadable/missing paths all report
 * "invalid" (which resolveIngressTls turns into a non-zero exit).
 */

import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTlsConfig, profileRequiresTls, tlsRequired } from "../utils/tls";

const PEM_CERT =
  "-----BEGIN CERTIFICATE-----\nMIIFAKECERT\n-----END CERTIFICATE-----\n";
const PEM_KEY =
  "-----BEGIN PRIVATE KEY-----\nMIIFAKEKEY\n-----END PRIVATE KEY-----\n";

const saved = {
  TLS_CERT: process.env.TLS_CERT,
  TLS_KEY: process.env.TLS_KEY,
  TLS_CA: process.env.TLS_CA,
  VW_REQUIRE_TLS: process.env.VW_REQUIRE_TLS,
};

const tmpDirs: string[] = [];
function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "vwsk-tls-"));
  tmpDirs.push(dir);
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

afterEach(() => {
  for (const k of [
    "TLS_CERT",
    "TLS_KEY",
    "TLS_CA",
    "VW_REQUIRE_TLS",
  ] as const) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("loadTlsConfig (SEC-1)", () => {
  it("returns absent when neither cert nor key set", () => {
    delete process.env.TLS_CERT;
    delete process.env.TLS_KEY;
    expect(loadTlsConfig().kind).toBe("absent");
  });

  it("returns ok with inline cert + key", () => {
    process.env.TLS_CERT = PEM_CERT;
    process.env.TLS_KEY = PEM_KEY;
    const r = loadTlsConfig();
    expect(r.kind).toBe("ok");
  });

  it("returns ok reading cert + key from files", () => {
    process.env.TLS_CERT = tmpFile("cert.pem", PEM_CERT);
    process.env.TLS_KEY = tmpFile("key.pem", PEM_KEY);
    expect(loadTlsConfig().kind).toBe("ok");
  });

  it("FAILS (invalid) on cert-but-no-key — no silent downgrade", () => {
    process.env.TLS_CERT = PEM_CERT;
    delete process.env.TLS_KEY;
    const r = loadTlsConfig();
    expect(r.kind).toBe("invalid");
  });

  it("FAILS (invalid) on key-but-no-cert", () => {
    process.env.TLS_KEY = PEM_KEY;
    delete process.env.TLS_CERT;
    expect(loadTlsConfig().kind).toBe("invalid");
  });

  it("FAILS (invalid) on a garbage (non-PEM) key value", () => {
    process.env.TLS_CERT = PEM_CERT;
    process.env.TLS_KEY = "not a pem at all";
    const r = loadTlsConfig();
    expect(r.kind).toBe("invalid");
  });

  it("FAILS (invalid) on a cert path that does not exist", () => {
    process.env.TLS_CERT = "/nonexistent/path/cert.pem";
    process.env.TLS_KEY = PEM_KEY;
    expect(loadTlsConfig().kind).toBe("invalid");
  });
});

describe("TLS requirement predicates (SEC-1)", () => {
  it("profileRequiresTls is true for required / required+strict", () => {
    expect(profileRequiresTls("required")).toBe(true);
    expect(profileRequiresTls("required+strict")).toBe(true);
  });

  it("profileRequiresTls is false for recommended / false / undefined", () => {
    expect(profileRequiresTls("recommended")).toBe(false);
    expect(profileRequiresTls(false)).toBe(false);
    expect(profileRequiresTls(undefined)).toBe(false);
  });

  it("tlsRequired reflects VW_REQUIRE_TLS=1", () => {
    process.env.VW_REQUIRE_TLS = "1";
    expect(tlsRequired()).toBe(true);
    process.env.VW_REQUIRE_TLS = "0";
    expect(tlsRequired()).toBe(false);
  });
});
