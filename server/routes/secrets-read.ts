/**
 * server/routes/secrets-read.ts
 *
 * The get / list / fields REST read routes, extracted so their
 * enumeration-parity contract (docs/authz.md) can be tested at the boundary
 * without booting the full middleware stack.
 *
 * Enumeration parity: every authorization denial AND every backend/lookup
 * error on get/list/fields returns ONE canonical, byte-identical 404 body:
 * `{"error":"Secret not found"}`. No raw Error.message and no conditional
 * 503/500 may distinguish denied, not-found, and backend-error cases -- they
 * MUST be indistinguishable to callers so a secret's existence or a caller's
 * access cannot be enumerated. The single chokepoint is {@link notFound},
 * backed by `normalizeDenial`.
 */

import type { Hono, Context } from "hono";
import { normalizeDenial } from "../authz/authz";

export interface SecretReadDeps {
  getSecret: (name: string, opts: { vault: string }) => Promise<string>;
  getSecretObject: (
    name: string,
    opts: { vault: string },
  ) => Promise<Record<string, unknown>>;
  listSecrets: (
    filter: string | undefined,
    opts: { vault: string },
  ) => Promise<string[]>;
  /** Returns true if the client may see this secret name. */
  isAllowed: (clientId: string, name: string) => boolean;
  /** Filters a name list down to the client's allowed scope. */
  filterItems: (clientId: string, names: string[]) => string[];
}

/** The single canonical not-found/denial/lookup-error response. */
export function notFound(c: Context) {
  const denial = normalizeDenial("secret.get");
  return c.json(denial.body, denial.status);
}

export function registerSecretReadRoutes(
  app: Hono,
  deps: SecretReadDeps,
): void {
  app.get("/secret/:name", async (c: Context) => {
    const name = decodeURIComponent(c.req.param("name"));
    const vault = c.req.query("vault") || "default";
    const clientId = c.get("clientId") as string | undefined;

    if (clientId && !deps.isAllowed(clientId, name)) return notFound(c);

    try {
      const value = await deps.getSecret(name, { vault });
      return c.json({ value });
    } catch {
      return notFound(c);
    }
  });

  app.get("/secret/:name/fields", async (c: Context) => {
    const name = decodeURIComponent(c.req.param("name"));
    const vault = c.req.query("vault") || "default";
    const clientId = c.get("clientId") as string | undefined;

    if (clientId && !deps.isAllowed(clientId, name)) return notFound(c);

    try {
      const fields = await deps.getSecretObject(name, { vault });
      return c.json({ name, fields });
    } catch {
      return notFound(c);
    }
  });

  app.get("/secrets", async (c: Context) => {
    const filter = c.req.query("filter");
    const vault = c.req.query("vault") || "default";
    const clientId = c.get("clientId") as string | undefined;

    try {
      let secrets = await deps.listSecrets(filter || undefined, { vault });
      if (clientId) secrets = deps.filterItems(clientId, secrets);
      return c.json({ secrets, count: secrets.length });
    } catch {
      return notFound(c);
    }
  });
}
