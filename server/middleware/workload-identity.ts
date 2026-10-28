/**
 * Workload-identity Hono middleware (issue #15).
 *
 * One authentication decision applied identically across REST, MCP and proxy.
 * Fail-closed: any request without a valid credential for the given audience
 * gets 401.
 *
 * Resolution order (additive — legacy keeps working during migration):
 *   1. New opaque workload token (`vwsk_<id>_<random>`) → verified against the
 *      identity service for the required audience. Sets clientId = subject.
 *   2. Legacy bearer token (API_TOKEN_<CLIENT>) → subject "legacy:<client>".
 *      Scoped per interface: REST + MCP only (never the proxy).
 *   3. Legacy PROXY_TOKEN (proxy audience only) → subject "legacy:proxy".
 *      Never cross-honored on REST/MCP.
 *
 * Kill-switch (SEC-2): VW_LEGACY_TOKENS=off disables ALL legacy acceptance —
 * only new vwsk_ tokens authenticate. Any other value (or unset) keeps legacy
 * acceptance enabled for the migration window.
 *
 * clientId is set on the context EXACTLY like bearer-auth does, so downstream
 * folder-scoping and audit logging keep working unchanged.
 *
 * No token value is ever logged.
 *
 * @module server/middleware/workload-identity
 */

import type { Context, Next } from "hono";
import { getIdentityService, type IdentityService } from "../identity/identity";

/** SEC-2 kill-switch: true unless VW_LEGACY_TOKENS is explicitly "off". */
export function legacyTokensEnabled(): boolean {
  return (process.env.VW_LEGACY_TOKENS ?? "").toLowerCase() !== "off";
}

export interface WorkloadIdentityConfig {
  /** Required audience for this interface: "rest" | "mcp" | "proxy". */
  audience: string;
  /** Legacy bearer tokens (token → clientId). Optional, additive. */
  legacyTokens?: Map<string, string>;
  /** Legacy proxy token (single shared secret). Optional, proxy only. */
  legacyProxyToken?: string;
  /** Override the identity service (tests). */
  service?: IdentityService;
  realm?: string;
}

function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Resolve a presented bearer token to a subject, or null. Pure enough to reuse
 * outside Hono (MCP raw-Request path). Fail-closed.
 */
export async function resolveIdentity(
  token: string | null,
  config: WorkloadIdentityConfig,
): Promise<string | null> {
  if (!token) return null;

  const service = config.service ?? getIdentityService();

  // 1. New opaque workload token (always accepted).
  if (token.startsWith("vwsk_")) {
    const identity = await service.verifyToken(token, config.audience);
    return identity ? identity.subject : null;
  }

  // Legacy acceptance is disabled entirely by the kill-switch (SEC-2).
  if (!legacyTokensEnabled()) return null;

  // 2. Legacy per-client bearer tokens (REST + MCP interfaces only).
  if (config.legacyTokens) {
    const client = config.legacyTokens.get(token);
    if (client) return `legacy:${client}`;
  }

  // 3. Legacy proxy shared token (proxy interface only).
  if (config.legacyProxyToken && token === config.legacyProxyToken) {
    return "legacy:proxy";
  }

  return null;
}

/**
 * Hono middleware factory. Returns 401 fail-closed on any auth failure and sets
 * c.set('clientId', subject) on success.
 */
export function workloadIdentity(config: WorkloadIdentityConfig) {
  const realm = config.realm ?? "Vaultwarden Secrets";

  return async (c: Context, next: Next) => {
    const token = extractBearer(c.req.header("Authorization"));
    const subject = await resolveIdentity(token, config);

    if (!subject) {
      return c.json({ error: "Unauthorized" }, 401, {
        "WWW-Authenticate": `Bearer realm="${realm}"`,
      });
    }

    c.set("clientId", subject);
    await next();
  };
}
