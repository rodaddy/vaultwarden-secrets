/**
 * Test helper: generate a throwaway self-signed cert + key (inline PEM).
 *
 * Used by integration tests that must exercise a required-TLS profile under the
 * authoritative TLS gate (SEC-1). Never used in production code.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function generateSelfSignedPem(): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), "vwsk-selfsigned-"));
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
      ],
      { stdio: "ignore" },
    );
    return {
      cert: readFileSync(certPath, "utf8"),
      key: readFileSync(keyPath, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
