/**
 * Credential Proxy — Least-privilege credential access for agents.
 *
 * Exposes `GET /cred/:service` which returns env-var-formatted credentials
 * from the Bitwarden vault. Agents get only the fields they need, with no
 * visibility into vault structure, item enumeration, or metadata.
 *
 * Two access modes:
 * 1. Allowlist — config maps service names → vault items → env var names
 * 2. Folder fallback — searches a designated BW folder, auto-maps fields
 *
 * Environment:
 *   PROXY_TOKEN     - Bearer token for authentication (required)
 *   PROXY_PORT      - Listen port (default: 3003)
 *   BW_SESSION_FILE - Path to BW session file (for Linux/systemd)
 *
 * @module server/cred-proxy
 */

import { Hono } from "hono";
import { $ } from "bun";
import { getVaultSession } from "../keychain";
import { bwGetItem } from "./vault-client";
import {
  extractFields,
  autoMapFields,
  type ProxyConfig,
} from "./cred-proxy-extract";
import { workloadIdentity } from "./middleware/workload-identity";
import { resolveIngressTls } from "./utils/tls";

const PORT = parseInt(process.env.PROXY_PORT || "3003", 10);
// Legacy shared secret still accepted during migration (subject "legacy:proxy");
// new opaque vwsk_ tokens for audience "proxy" are additive (issue #15).
const PROXY_TOKEN = process.env.PROXY_TOKEN;

if (!PROXY_TOKEN) {
  console.warn(
    "[cred-proxy] PROXY_TOKEN not set (workload-identity tokens still accepted)",
  );
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const configPath = new URL("../proxy.config.json", import.meta.url).pathname;
let config: ProxyConfig;
try {
  config = await Bun.file(configPath).json();
} catch {
  console.error(`[cred-proxy] Failed to load config from ${configPath}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Folder fallback — resolve folder name → folder ID at startup
// ---------------------------------------------------------------------------

let fallbackFolderId: string | null = null;

async function resolveFolderFallback(session: string): Promise<void> {
  if (!config.folderFallback?.folder) return;

  try {
    const result = await $`BW_SESSION=${session} bw list folders`.quiet();
    const folders: Array<{ id: string; name: string }> = JSON.parse(
      result.text(),
    );
    const match = folders.find((f) => f.name === config.folderFallback!.folder);
    if (match) {
      fallbackFolderId = match.id;
      console.log(
        `[cred-proxy] Folder fallback: "${config.folderFallback!.folder}" → ${fallbackFolderId}`,
      );
    } else {
      console.warn(
        `[cred-proxy] Folder "${config.folderFallback!.folder}" not found — fallback disabled`,
      );
    }
  } catch (err) {
    console.warn(`[cred-proxy] Could not resolve folder fallback: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono();

// Auth middleware — one workload-identity decision (issue #15). Legacy
// PROXY_TOKEN kept as a shared legacy secret; sets clientId like bearer-auth.
app.use(
  "/cred/*",
  workloadIdentity({ audience: "proxy", legacyProxyToken: PROXY_TOKEN }),
);

app.get("/health", (c) => c.json({ status: "ok", service: "cred-proxy" }));

app.get("/cred/:service", async (c) => {
  const service = c.req.param("service");

  // Get vault session
  const session = await getVaultSession("default");
  if (!session) {
    return c.json({ error: "Vault session unavailable" }, 503);
  }

  // 1. Check allowlist
  const entry = config.allowlist[service];
  if (entry) {
    try {
      const item = await bwGetItem(session, entry.vaultItem);
      const creds = extractFields(item, entry.map);
      return c.json(creds);
    } catch (err) {
      console.error(
        `[cred-proxy] Failed to fetch "${entry.vaultItem}": ${err}`,
      );
      return c.json({ error: "Failed to retrieve credentials" }, 503);
    }
  }

  // 2. Folder fallback
  if (fallbackFolderId) {
    try {
      const result =
        await $`BW_SESSION=${session} bw list items --folderid ${fallbackFolderId}`.quiet();
      const items: Array<Record<string, any>> = JSON.parse(result.text());
      const match = items.find(
        (i) => i.name.toLowerCase() === service.toLowerCase(),
      );

      if (match) {
        const creds = autoMapFields(match);
        return c.json(creds);
      }
    } catch (err) {
      console.error(`[cred-proxy] Folder fallback error: ${err}`);
      return c.json({ error: "Failed to search folder" }, 503);
    }
  }

  return c.json({ error: "Service not allowed" }, 403);
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const session = await getVaultSession("default");
if (session) {
  await resolveFolderFallback(session);
} else {
  console.warn(
    "[cred-proxy] No vault session at startup — folder fallback deferred",
  );
}

// Encrypted ingress (issue #14): TLS when configured; fail-closed under
// VW_REQUIRE_TLS=1.
const tls = resolveIngressTls("proxy");

export default {
  port: PORT,
  hostname: "0.0.0.0",
  fetch: app.fetch,
  ...(tls ? { tls } : {}),
};

console.log(
  `[cred-proxy] Listening on ${tls ? "https" : "http"}://0.0.0.0:${PORT}`,
);
