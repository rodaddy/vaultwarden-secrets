/**
 * One workload-identity transport contract (issue #15).
 *
 * A single coherent identity model shared by REST, MCP and the credential
 * proxy. Tokens are OPAQUE (`vwsk_<id>_<random>`); only their sha256 hash is
 * persisted. Verification is fail-closed: any invalid / expired / revoked /
 * wrong-audience / superseded token returns null.
 *
 * This exact public API is pinned — parallel workers build against it:
 *   issueToken({subject, audiences, ttlSeconds?})
 *   verifyToken(token, audience)
 *   revokeToken(id)
 *   rotateToken(id, overlapSeconds)
 *
 * No plaintext token is ever written to disk or logs.
 *
 * @module server/identity/identity
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  FileIdentityStore,
  type IdentityStore,
  type TokenRecord,
} from "./store";

/** Public identity view returned by verifyToken. */
export interface WorkloadIdentity {
  subject: string;
  audiences: string[];
  expiresAt: string | null;
}

/** Result of issuing / rotating a token — the plaintext value is returned ONCE. */
export interface IssuedToken {
  token: string;
  id: string;
}

export interface IssueTokenParams {
  subject: string;
  audiences: string[];
  ttlSeconds?: number;
}

const TOKEN_PREFIX = "vwsk";

/** sha256 hex of the full opaque token string. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time hex-string compare (equal length assumed for sha256 hex). */
function safeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Parse the id segment out of an opaque token. Returns null if malformed. */
export function parseTokenId(token: string): string | null {
  // vwsk_<id>_<random>
  const parts = token.split("_");
  if (parts.length < 3) return null;
  if (parts[0] !== TOKEN_PREFIX) return null;
  const id = parts[1];
  if (!id) return null;
  return id;
}

/**
 * The identity service. Holds an injectable store so the JSON-file backend can
 * be replaced with SQLite later.
 */
export class IdentityService {
  constructor(private readonly store: IdentityStore) {}

  async issueToken(params: IssueTokenParams): Promise<IssuedToken> {
    const { subject, audiences, ttlSeconds } = params;
    if (!subject) throw new Error("issueToken: subject is required");
    if (!audiences || audiences.length === 0) {
      throw new Error("issueToken: at least one audience is required");
    }

    const id = randomBytes(9).toString("hex"); // 18 hex chars, no separators
    const secret = randomBytes(24).toString("base64url");
    const token = `${TOKEN_PREFIX}_${id}_${secret}`;

    const now = new Date();
    // ttlSeconds undefined => non-expiring. Any number (incl. <= 0) sets an
    // expiry; <= 0 yields an already-expired token (used in tests / instant
    // cutoffs).
    const expiresAt =
      ttlSeconds === undefined
        ? null
        : new Date(now.getTime() + ttlSeconds * 1000).toISOString();

    const record: TokenRecord = {
      id,
      tokenHash: hashToken(token),
      subject,
      audiences: [...audiences],
      expiresAt,
      issuedAt: now.toISOString(),
      revokedAt: null,
      supersededAt: null,
    };

    await this.store.put(record);
    return { token, id };
  }

  /**
   * Verify an opaque token against a required audience. Fail-closed: returns
   * null for any invalid / expired / revoked / superseded / wrong-audience.
   */
  async verifyToken(
    token: string,
    audience: string,
  ): Promise<WorkloadIdentity | null> {
    if (!token || !audience) return null;

    const id = parseTokenId(token);
    if (!id) return null;

    const record = await this.store.findById(id);
    if (!record) return null;

    // Constant-time hash comparison.
    const presentedHash = hashToken(token);
    if (!safeHexEqual(presentedHash, record.tokenHash)) return null;

    const now = Date.now();

    if (record.revokedAt) return null;

    if (record.expiresAt && Date.parse(record.expiresAt) <= now) return null;

    // Rotation overlap cutoff: a superseded token dies at supersededAt even if
    // its own expiresAt is later.
    if (record.supersededAt && Date.parse(record.supersededAt) <= now) {
      return null;
    }

    if (!record.audiences.includes(audience)) return null;

    return {
      subject: record.subject,
      audiences: [...record.audiences],
      expiresAt: record.expiresAt,
    };
  }

  async revokeToken(id: string): Promise<void> {
    const record = await this.store.findById(id);
    if (!record) return;
    await this.store.update(id, { revokedAt: new Date().toISOString() });
  }

  /**
   * Rotate a token. Issues a fresh token inheriting subject + audiences of the
   * old record, then marks the OLD record superseded with a hard cutoff
   * `overlapSeconds` into the future. The old token keeps working only through
   * that overlap window.
   */
  async rotateToken(id: string, overlapSeconds: number): Promise<IssuedToken> {
    const record = await this.store.findById(id);
    if (!record) throw new Error(`rotateToken: unknown id ${id}`);

    // Remaining TTL for the new token: mirror the original relative TTL if the
    // old one had an expiry; otherwise non-expiring.
    let ttlSeconds: number | undefined;
    if (record.expiresAt) {
      const remaining = Math.floor(
        (Date.parse(record.expiresAt) - Date.now()) / 1000,
      );
      ttlSeconds = remaining > 0 ? remaining : 1;
    }

    const issued = await this.issueToken({
      subject: record.subject,
      audiences: record.audiences,
      ttlSeconds,
    });

    const cutoff = new Date(
      Date.now() + Math.max(0, overlapSeconds) * 1000,
    ).toISOString();
    await this.store.update(id, { supersededAt: cutoff });

    return issued;
  }

  /** Metadata-only listing for the operator CLI. Never exposes token values. */
  async listRecords(): Promise<Omit<TokenRecord, "tokenHash">[]> {
    const records = await this.store.list();
    return records.map(({ tokenHash, ...rest }) => rest);
  }
}

// ---------------------------------------------------------------------------
// Default singleton (file-backed). Used by servers + CLI.
// ---------------------------------------------------------------------------

let defaultService: IdentityService | null = null;

/** Lazily-constructed process-wide file-backed identity service. */
export function getIdentityService(): IdentityService {
  if (!defaultService) {
    defaultService = new IdentityService(new FileIdentityStore());
  }
  return defaultService;
}

/** Test/override hook. */
export function setIdentityService(service: IdentityService): void {
  defaultService = service;
}
