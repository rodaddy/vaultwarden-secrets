/**
 * server/rotation/connectors/cloudflare.ts
 *
 * Real Cloudflare API-token rotation connector.
 *
 * Rotation flow for a Cloudflare user API token:
 *   create()  -> POST /user/tokens (mirrors the old token's policies) to mint
 *                a replacement, then persist the plaintext through the injected
 *                VaultWriter. Only the token id + checksum come back to the
 *                engine; the plaintext never leaves the vault-writer boundary.
 *   verify()  -> GET /user/tokens/verify using the NEW token as bearer; a live,
 *                active token proves the replacement works.
 *   revoke()  -> DELETE /user/tokens/{oldId} to retire the superseded token.
 *   rollback()-> DELETE /user/tokens/{newId} to remove a failed replacement,
 *                leaving the old token untouched.
 *
 * Requires env creds (CLOUDFLARE_API_TOKEN for the management call, plus the
 * token ids). Its integration test is gated on CLOUDFLARE_API_TOKEN presence
 * and skips cleanly offline.
 *
 * Uses Cloudflare's v4 REST envelope: { result, success, errors, messages }.
 * No new dependencies -- fetch + the injected VaultWriter only.
 */

import type {
  Connector,
  ConnectorContext,
  ConnectorCreateResult,
  VaultReader,
  VaultWriter,
} from "../deps";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

interface CfEnvelope<T> {
  result: T;
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: unknown[];
}

interface CfTokenPolicy {
  effect: "allow" | "deny";
  resources: Record<string, string>;
  permission_groups: Array<{ id: string }>;
}

interface CfToken {
  id: string;
  name: string;
  status: string;
  value?: string; // plaintext, present only on create
  policies?: CfTokenPolicy[];
}

export interface CloudflareConnectorConfig {
  /** Management token used to create/revoke tokens (least-privilege). */
  apiToken: string;
  /** Vault ref prefix for the new token's plaintext. */
  vaultRefPrefix?: string;
  /** Injected fetch for testability; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Reads the NEW token plaintext back from the vault so verify() can probe AS
   * that token (calling /user/tokens/verify with it as bearer). Without this,
   * verify() cannot prove the new credential works and MUST fail closed.
   */
  vaultReader?: VaultReader;
}

/**
 * Reads Cloudflare config from env. Returns null if creds are absent so the
 * integration test can skip cleanly offline.
 */
export function cloudflareConfigFromEnv(): CloudflareConnectorConfig | null {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) return null;
  return { apiToken };
}

export class CloudflareConnector implements Connector {
  private fetch: typeof fetch;

  constructor(private cfg: CloudflareConnectorConfig) {
    this.fetch = cfg.fetchImpl ?? fetch;
  }

  private async call<T>(
    method: string,
    path: string,
    bearer: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetch(`${CF_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const env = (await res.json()) as CfEnvelope<T>;
    if (!res.ok || !env.success) {
      const msg =
        env.errors?.map((e) => `${e.code}:${e.message}`).join(", ") ||
        `http ${res.status}`;
      // Never include response bodies that could carry material.
      throw new Error(`cloudflare ${method} ${path} failed: ${msg}`);
    }
    return env.result;
  }

  /**
   * Delete any pre-existing tokens carrying the deterministic job-scoped name
   * (orphans left by a crashed prior attempt). Safe: such a token was never
   * staged / verified / published, so removing it cannot affect a live
   * consumer. Idempotent -- a no-op when none exist.
   */
  private async deleteOrphansByName(name: string): Promise<void> {
    const existing = await this.call<CfToken[]>(
      "GET",
      "/user/tokens",
      this.cfg.apiToken,
    );
    for (const tok of existing) {
      if (tok.name === name) {
        await this.call<{ id: string }>(
          "DELETE",
          `/user/tokens/${tok.id}`,
          this.cfg.apiToken,
        );
      }
    }
  }

  /**
   * Create a replacement token that mirrors the old token's policies. The old
   * token id is carried on ctx.oldProviderRef so we can read its policy set;
   * a fresh name is derived from the job id.
   */
  async create(ctx: ConnectorContext): Promise<ConnectorCreateResult> {
    const oldId = ctx.oldProviderRef;
    let policies: CfTokenPolicy[] | undefined;
    if (!ctx.firstIssuance && oldId) {
      const old = await this.call<CfToken>(
        "GET",
        `/user/tokens/${oldId}`,
        this.cfg.apiToken,
      );
      policies = old.policies;
    }
    // Deterministic job-scoped name. Crash-safe minting: if a prior attempt
    // crashed AFTER minting but BEFORE the engine recorded the provider ref, an
    // orphan token with THIS name is left at Cloudflare. Cloudflare returns a
    // token's plaintext ONLY once (at create), so we cannot adopt the orphan's
    // secret -- instead we DELETE it (it was never staged/verified/published,
    // so removal is safe) and mint exactly one fresh token. Net effect: at most
    // one LIVE token per job, regardless of crashes.
    const name = `rotation-${ctx.secret}-${ctx.jobId}`.slice(0, 120);
    await this.deleteOrphansByName(name);

    const created = await this.call<CfToken>(
      "POST",
      "/user/tokens",
      this.cfg.apiToken,
      {
        name,
        policies: policies ?? [],
      },
    );

    if (!created.value) {
      throw new Error("cloudflare create returned no token value");
    }
    // Bind plaintext into a local so it can be closed over by the generator
    // and dropped immediately after the vault write. The engine never sees it.
    const plaintext = created.value;
    const prefix = this.cfg.vaultRefPrefix ?? ctx.secret;
    const written = await writeToVault(
      ctx.vault,
      `${prefix}#${created.id}`,
      plaintext,
    );

    return {
      payloadRef: written.payloadRef,
      checksum: written.checksum,
      providerRef: created.id,
    };
  }

  /**
   * Verify the NEW token by probing /user/tokens/verify AS that token (the new
   * bearer read transiently from the vault). This proves the replacement is
   * live and usable -- reading metadata with the management token would only
   * prove it EXISTS, not that it authenticates. Any inability to read or probe
   * the new token returns false so the engine fails closed (no publish, no
   * revoke of the old credential).
   */
  async verify(ctx: ConnectorContext): Promise<boolean> {
    if (!ctx.newPayloadRef || !this.cfg.vaultReader) return false;
    let bearer: string | null;
    try {
      bearer = await this.cfg.vaultReader.readItem(ctx.newPayloadRef);
    } catch {
      return false;
    }
    if (!bearer) return false;
    try {
      const res = await this.call<{ id: string; status: string }>(
        "GET",
        "/user/tokens/verify",
        bearer, // probe AS the new token
      );
      return res.status === "active";
    } catch {
      return false;
    } finally {
      // Drop the transient bearer reference promptly.
      bearer = null;
    }
  }

  /** Revoke the OLD token after verification passes. */
  async revoke(ctx: ConnectorContext): Promise<void> {
    if (ctx.firstIssuance) return; // no prior credential to revoke
    const oldId = ctx.oldProviderRef;
    if (!oldId) return; // nothing to revoke
    await this.call<{ id: string }>(
      "DELETE",
      `/user/tokens/${oldId}`,
      this.cfg.apiToken,
    );
  }

  /** Roll back a failed rotation by deleting the NEW token; old stays valid. */
  async rollback(ctx: ConnectorContext): Promise<void> {
    const newId = ctx.newProviderRef;
    if (!newId) return;
    await this.call<{ id: string }>(
      "DELETE",
      `/user/tokens/${newId}`,
      this.cfg.apiToken,
    );
  }
}

/**
 * Write plaintext into the vault via the injected writer. Isolated so the
 * plaintext string is confined to the smallest possible scope.
 */
async function writeToVault(
  vault: VaultWriter,
  ref: string,
  plaintext: string,
) {
  return vault.writeItem(ref, () => plaintext);
}
