/**
 * TLS ingress helpers (issue #14).
 *
 * Encrypted ingress for the Bun-served Hono apps. When TLS_CERT and TLS_KEY
 * are provided (file paths or inline PEM), the returned config carries a Bun
 * `tls` block so `export default { ..., tls }` serves HTTPS.
 *
 * Fail-closed guard: if VW_REQUIRE_TLS=1 and no cert/key are configured, the
 * process exits non-zero. Plain HTTP stays allowed for localhost/LAN dev when
 * VW_REQUIRE_TLS is unset.
 *
 * @module server/utils/tls
 */

import { existsSync, readFileSync } from "node:fs";

export interface BunTlsConfig {
  cert: string;
  key: string;
  ca?: string;
}

/** True when the operator has demanded TLS via VW_REQUIRE_TLS=1. */
export function tlsRequired(): boolean {
  return process.env.VW_REQUIRE_TLS === "1";
}

/** Read a value that may be a file path OR inline PEM. Returns null if absent. */
function readPemLike(value: string | undefined): string | null {
  if (!value || value.trim().length === 0) return null;
  if (value.includes("-----BEGIN")) return value; // inline PEM
  if (existsSync(value)) return readFileSync(value, "utf8");
  return null;
}

/**
 * Build a Bun TLS config from TLS_CERT / TLS_KEY (+ optional TLS_CA), or null
 * when TLS is not configured.
 */
export function loadTlsConfig(): BunTlsConfig | null {
  const cert = readPemLike(process.env.TLS_CERT);
  const key = readPemLike(process.env.TLS_KEY);
  if (!cert || !key) return null;
  const ca = readPemLike(process.env.TLS_CA) ?? undefined;
  return ca ? { cert, key, ca } : { cert, key };
}

/**
 * Resolve ingress TLS with the fail-closed contract. Call once at startup.
 *
 * - Returns a Bun tls block when configured.
 * - Returns null (plain HTTP) when not configured AND not required.
 * - Exits non-zero when VW_REQUIRE_TLS=1 but no usable cert/key.
 *
 * @param serviceName label used in the fatal message
 */
export function resolveIngressTls(serviceName: string): BunTlsConfig | null {
  const tls = loadTlsConfig();

  if (!tls && tlsRequired()) {
    console.error(
      `[${serviceName}] VW_REQUIRE_TLS=1 but no usable TLS_CERT/TLS_KEY — refusing to start on plaintext ingress.`,
    );
    process.exit(1);
  }

  if (tls) {
    console.log(`[${serviceName}] TLS ingress: enabled`);
  } else {
    console.log(
      `[${serviceName}] TLS ingress: disabled (plaintext — LAN/localhost dev only)`,
    );
  }

  return tls;
}
