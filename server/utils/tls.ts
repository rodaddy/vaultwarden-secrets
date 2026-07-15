/**
 * TLS ingress helpers (issue #14).
 *
 * Encrypted ingress for the Bun-served Hono apps. When TLS_CERT and TLS_KEY
 * are provided (file paths or inline PEM), the returned config carries a Bun
 * `tls` block so `export default { ..., tls }` serves HTTPS.
 *
 * `resolveIngressTls` is the AUTHORITATIVE fail-closed gate (SEC-1). It exits
 * non-zero — never serving plaintext — when TLS is required but cannot be fully
 * established:
 *   - VW_REQUIRE_TLS=1, or a profile tls level of 'required' / 'required+strict'
 *   - and either cert OR key is missing, unreadable, or not valid PEM
 *     (cert-but-no-key, or an invalid/garbage key, must fail — not downgrade).
 *
 * Plain HTTP stays allowed for localhost/LAN dev only when TLS is neither
 * required by the profile nor demanded via VW_REQUIRE_TLS.
 *
 * @module server/utils/tls
 */

import { existsSync, readFileSync } from "node:fs";

export interface BunTlsConfig {
  cert: string;
  key: string;
  ca?: string;
}

/** TLS levels a security profile can declare. */
export type ProfileTlsLevel =
  | boolean
  | "recommended"
  | "required"
  | "required+strict";

/** True when the operator has demanded TLS via VW_REQUIRE_TLS=1. */
export function tlsRequired(): boolean {
  return process.env.VW_REQUIRE_TLS === "1";
}

/** True when a profile TLS level hard-requires encrypted ingress. */
export function profileRequiresTls(
  level: ProfileTlsLevel | undefined,
): boolean {
  return level === "required" || level === "required+strict";
}

/**
 * A single PEM source: resolved text plus enough provenance to explain a
 * failure without leaking the material itself.
 */
interface PemLoad {
  /** Loaded PEM text, or null if the source was empty/unset. */
  text: string | null;
  /** True when a value was provided but could not be loaded/parsed. */
  invalid: boolean;
  /** Redacted reason for a failure (never the material). */
  reason?: string;
}

/**
 * Load a value that may be a file path OR inline PEM. Distinguishes "absent"
 * (text: null, invalid: false) from "present but broken" (invalid: true) so the
 * caller can fail closed on a garbage key instead of silently downgrading.
 */
function loadPem(envName: string): PemLoad {
  const value = process.env[envName];
  if (!value || value.trim().length === 0) {
    return { text: null, invalid: false };
  }

  let text: string;
  if (value.includes("-----BEGIN")) {
    text = value; // inline PEM
  } else if (existsSync(value)) {
    try {
      text = readFileSync(value, "utf8");
    } catch (e) {
      return {
        text: null,
        invalid: true,
        reason: `${envName}: file exists but is unreadable`,
      };
    }
  } else {
    return {
      text: null,
      invalid: true,
      reason: `${envName}: path does not exist`,
    };
  }

  // Minimal structural validation: must actually contain a PEM block.
  if (!text.includes("-----BEGIN")) {
    return {
      text: null,
      invalid: true,
      reason: `${envName}: content is not valid PEM`,
    };
  }

  return { text, invalid: false };
}

/**
 * Build a Bun TLS config from TLS_CERT / TLS_KEY (+ optional TLS_CA). Returns
 * a discriminated result so callers can tell "not configured" from "misconfigured".
 */
export function loadTlsConfig():
  | { kind: "ok"; tls: BunTlsConfig }
  | { kind: "absent" }
  | { kind: "invalid"; reason: string } {
  const cert = loadPem("TLS_CERT");
  const key = loadPem("TLS_KEY");
  const ca = loadPem("TLS_CA");

  // Any provided-but-broken source is a hard error (SEC-1: no silent downgrade).
  if (cert.invalid) return { kind: "invalid", reason: cert.reason! };
  if (key.invalid) return { kind: "invalid", reason: key.reason! };
  if (ca.invalid) return { kind: "invalid", reason: ca.reason! };

  // Partial config (cert without key, or key without cert) is misconfigured.
  if (cert.text && !key.text) {
    return { kind: "invalid", reason: "TLS_CERT set but TLS_KEY missing" };
  }
  if (key.text && !cert.text) {
    return { kind: "invalid", reason: "TLS_KEY set but TLS_CERT missing" };
  }

  if (!cert.text || !key.text) return { kind: "absent" };

  const tls: BunTlsConfig = ca.text
    ? { cert: cert.text, key: key.text, ca: ca.text }
    : { cert: cert.text, key: key.text };
  return { kind: "ok", tls };
}

/**
 * Resolve ingress TLS with the authoritative fail-closed contract (SEC-1).
 * Call once at startup.
 *
 * - Returns a Bun tls block when fully configured.
 * - Returns null (plain HTTP) ONLY when TLS is neither required nor demanded.
 * - Exits non-zero when TLS is required/demanded but cert+key cannot both be
 *   loaded, OR when any provided cert/key/ca is broken.
 *
 * @param serviceName label used in the fatal message
 * @param profileTlsLevel the active profile's tls level (optional)
 */
export function resolveIngressTls(
  serviceName: string,
  profileTlsLevel?: ProfileTlsLevel,
): BunTlsConfig | null {
  const result = loadTlsConfig();
  const mustHaveTls = tlsRequired() || profileRequiresTls(profileTlsLevel);

  // A broken cert/key/ca is always fatal — never downgrade to plaintext.
  if (result.kind === "invalid") {
    console.error(
      `[${serviceName}] TLS misconfigured — refusing to start: ${result.reason}`,
    );
    process.exit(1);
  }

  if (result.kind === "absent") {
    if (mustHaveTls) {
      const why = tlsRequired()
        ? "VW_REQUIRE_TLS=1"
        : `profile tls=${profileTlsLevel}`;
      console.error(
        `[${serviceName}] ${why} but no usable TLS_CERT/TLS_KEY — refusing to start on plaintext ingress.`,
      );
      process.exit(1);
    }
    console.log(
      `[${serviceName}] TLS ingress: disabled (plaintext — LAN/localhost dev only)`,
    );
    return null;
  }

  console.log(`[${serviceName}] TLS ingress: enabled`);
  return result.tls;
}
