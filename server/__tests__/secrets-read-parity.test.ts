/**
 * server/__tests__/secrets-read-parity.test.ts
 *
 * REST-boundary byte-equivalence tests for the enumeration-parity guarantee
 * (docs/authz.md acceptance criteria, PR-D deferred item). Proves that on
 * get / list / fields a denied-existing-secret, a nonexistent secret, and a
 * backend/lookup error all produce the IDENTICAL status code and IDENTICAL
 * response-body bytes. Falsifiable: reverting the handlers to leak
 * `Error.message` or a conditional 503/500 breaks these assertions.
 */

import { expect, describe, test } from "bun:test";
import { Hono } from "hono";
import {
  registerSecretReadRoutes,
  type SecretReadDeps,
} from "../routes/secrets-read";

const CLIENT = "client-a";

/**
 * Build an app whose deps model three scenarios by secret name:
 *  - "denied"  : exists, but the client is NOT allowed (authorization denial)
 *  - "missing" : does not exist (lookup returns not-found error)
 *  - "boom"    : backend error (lookup throws a non-not-found error)
 *  - "ok"      : allowed + present (happy path, for contrast)
 */
function makeApp(): Hono {
  const app = new Hono();
  // Simulate an authenticated client on every request.
  app.use("*", async (c, next) => {
    c.set("clientId", CLIENT);
    await next();
  });
  const deps: SecretReadDeps = {
    isAllowed: (_clientId, name) => name !== "denied",
    filterItems: (_clientId, names) => names.filter((n) => n !== "denied"),
    getSecret: async (name) => {
      if (name === "missing") throw new Error("Secret not found: missing");
      if (name === "boom") throw new Error("vault is locked");
      return "value-abc";
    },
    getSecretObject: async (name) => {
      if (name === "missing") throw new Error("Item not found: missing");
      if (name === "boom") throw new Error("database error: connection reset");
      return { field: "value-abc" };
    },
    listSecrets: async (_filter, _opts) => {
      // Signal a backend error via a sentinel name through the query filter.
      throw new Error("vault is locked");
    },
  };
  registerSecretReadRoutes(app, deps);
  return app;
}

/** Capture status + exact response body bytes. */
async function capture(
  app: Hono,
  path: string,
): Promise<{ status: number; bytes: string }> {
  const res = await app.request(path);
  const bytes = await res.text();
  return { status: res.status, bytes };
}

describe("GET /secret/:name enumeration parity", () => {
  test("denied, missing, and backend-error are byte-identical", async () => {
    const app = makeApp();
    const denied = await capture(app, "/secret/denied");
    const missing = await capture(app, "/secret/missing");
    const boom = await capture(app, "/secret/boom");

    // Canonical response.
    expect(denied.status).toBe(404);
    expect(denied.bytes).toBe(JSON.stringify({ error: "Secret not found" }));

    // Byte-for-byte equivalence across all three cases.
    expect(missing).toEqual(denied);
    expect(boom).toEqual(denied);
  });

  test("allowed present secret returns a DISTINCT 200 (guards over-redaction)", async () => {
    const app = makeApp();
    const ok = await capture(app, "/secret/ok");
    const denied = await capture(app, "/secret/denied");
    expect(ok.status).toBe(200);
    expect(ok.bytes).not.toBe(denied.bytes);
  });
});

describe("GET /secret/:name/fields enumeration parity", () => {
  test("denied, missing, and backend-error are byte-identical", async () => {
    const app = makeApp();
    const denied = await capture(app, "/secret/denied/fields");
    const missing = await capture(app, "/secret/missing/fields");
    const boom = await capture(app, "/secret/boom/fields");

    expect(denied.status).toBe(404);
    expect(denied.bytes).toBe(JSON.stringify({ error: "Secret not found" }));
    expect(missing).toEqual(denied);
    // No conditional 503 for a "locked"/backend error -- must match not-found.
    expect(boom).toEqual(denied);
  });
});

describe("GET /secrets enumeration parity", () => {
  test("backend/lookup error is the canonical 404, not 500/503", async () => {
    const app = makeApp();
    const listErr = await capture(app, "/secrets");
    const getDenied = await capture(app, "/secret/denied");
    expect(listErr.status).toBe(404);
    expect(listErr.bytes).toBe(JSON.stringify({ error: "Secret not found" }));
    // Same canonical body as the get denial path.
    expect(listErr).toEqual(getDenied);
  });
});
