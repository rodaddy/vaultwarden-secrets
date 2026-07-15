/**
 * Workload-identity token store.
 *
 * Persists ONLY hashed token records — never plaintext token values. The store
 * is deliberately a small injectable interface so the JSON-file backend can be
 * swapped for SQLite (or anything else) later without touching identity logic.
 *
 * File backend: a single 0600 JSON file under VW_STATE_DIR. Writes are atomic
 * (temp file + rename) and the file is created with owner-only permissions.
 *
 * @module server/identity/store
 */

import {
  mkdirSync,
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * A single persisted identity record. Contains NO plaintext token — only the
 * sha256 hash of the opaque token string.
 */
export interface TokenRecord {
  /** Public identifier embedded in the token (vwsk_<id>_...). */
  id: string;
  /** sha256 hex of the full opaque token. Used for constant-time lookup. */
  tokenHash: string;
  /** Workload subject (e.g. "svc:deployer" or "legacy:lxc200"). */
  subject: string;
  /** Audiences this token is valid for (e.g. ["rest","mcp"]). */
  audiences: string[];
  /** ISO expiry, or null for non-expiring. */
  expiresAt: string | null;
  /** ISO issue time. */
  issuedAt: string;
  /** Set when revoked (ISO); record kept for audit/fail-closed. */
  revokedAt?: string | null;
  /**
   * For rotation overlap: if this record was superseded by a rotate, the old
   * record's hard cutoff (ISO). After this instant the old token is invalid
   * even if expiresAt is later. Absent for normal records.
   */
  supersededAt?: string | null;
}

/**
 * Injectable persistence contract. Keep this minimal and swappable.
 */
export interface IdentityStore {
  list(): Promise<TokenRecord[]>;
  /** Look up by the token's sha256 hash. */
  findByHash(tokenHash: string): Promise<TokenRecord | null>;
  findById(id: string): Promise<TokenRecord | null>;
  put(record: TokenRecord): Promise<void>;
  update(id: string, patch: Partial<TokenRecord>): Promise<void>;
}

/**
 * Resolve the state directory. VW_STATE_DIR wins; otherwise
 * ~/.vaultwarden-secrets/state.
 */
export function resolveStateDir(): string {
  const envDir = process.env.VW_STATE_DIR;
  if (envDir && envDir.trim().length > 0) return envDir;
  return join(homedir(), ".vaultwarden-secrets", "state");
}

/**
 * JSON-file backed store. All records live in one 0600 file.
 */
export class FileIdentityStore implements IdentityStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? join(resolveStateDir(), "identities.json");
    this.ensureFile();
  }

  private ensureFile(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    try {
      chmodSync(dir, 0o700);
    } catch {
      // best-effort; non-fatal on platforms that reject chmod
    }
    if (!existsSync(this.filePath)) {
      writeFileSync(this.filePath, "[]", { mode: 0o600 });
    }
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // best-effort
    }
  }

  private readAll(): TokenRecord[] {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as TokenRecord[]) : [];
    } catch {
      return [];
    }
  }

  private writeAll(records: TokenRecord[]): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // best-effort
    }
    renameSync(tmp, this.filePath);
  }

  async list(): Promise<TokenRecord[]> {
    return this.readAll();
  }

  async findByHash(tokenHash: string): Promise<TokenRecord | null> {
    return this.readAll().find((r) => r.tokenHash === tokenHash) ?? null;
  }

  async findById(id: string): Promise<TokenRecord | null> {
    return this.readAll().find((r) => r.id === id) ?? null;
  }

  async put(record: TokenRecord): Promise<void> {
    const records = this.readAll();
    records.push(record);
    this.writeAll(records);
  }

  async update(id: string, patch: Partial<TokenRecord>): Promise<void> {
    const records = this.readAll();
    const idx = records.findIndex((r) => r.id === id);
    if (idx === -1) return;
    records[idx] = { ...records[idx], ...patch, id: records[idx].id };
    this.writeAll(records);
  }
}

/**
 * In-memory store — used by tests and legacy-only deployments. Not persisted.
 */
export class MemoryIdentityStore implements IdentityStore {
  private records: TokenRecord[] = [];

  async list(): Promise<TokenRecord[]> {
    return [...this.records];
  }
  async findByHash(tokenHash: string): Promise<TokenRecord | null> {
    return this.records.find((r) => r.tokenHash === tokenHash) ?? null;
  }
  async findById(id: string): Promise<TokenRecord | null> {
    return this.records.find((r) => r.id === id) ?? null;
  }
  async put(record: TokenRecord): Promise<void> {
    this.records.push(record);
  }
  async update(id: string, patch: Partial<TokenRecord>): Promise<void> {
    const idx = this.records.findIndex((r) => r.id === id);
    if (idx === -1) return;
    this.records[idx] = {
      ...this.records[idx],
      ...patch,
      id: this.records[idx].id,
    };
  }
}
