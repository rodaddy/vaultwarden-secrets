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
  openSync,
  closeSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

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

/** On-disk container. Bare-array files (legacy) are read transparently. */
interface StoreContainer {
  version: number;
  records: TokenRecord[];
}

/** Lock acquisition tuning (SEC-3). */
const LOCK_STALE_MS = 10_000; // a lock older than this is considered abandoned
const LOCK_RETRY_MS = 25; // poll interval while waiting
const LOCK_TIMEOUT_MS = 5_000; // give up acquiring after this

function sleepMs(ms: number): void {
  // Synchronous sleep so a mutation critical section is not interleaved with
  // other async ticks. Bun's blocking sleep keeps the lock window tight.
  Bun.sleepSync(ms);
}

/**
 * JSON-file backed store with a 0600 file, atomic writes, and an exclusive
 * lockfile guarding the load-mutate-persist critical section (SEC-3) so
 * concurrent writers cannot lose each other's changes (e.g. a revocation).
 */
export class FileIdentityStore implements IdentityStore {
  private readonly filePath: string;
  private readonly lockPath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? join(resolveStateDir(), "identities.json");
    this.lockPath = `${this.filePath}.lock`;
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
      writeFileSync(
        this.filePath,
        JSON.stringify({ version: 0, records: [] }),
        {
          mode: 0o600,
        },
      );
    }
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // best-effort
    }
  }

  /** Read + normalize the container. Tolerates legacy bare-array files. */
  private readContainer(): StoreContainer {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return { version: 0, records: parsed as TokenRecord[] };
      }
      if (parsed && Array.isArray(parsed.records)) {
        return {
          version: Number.isFinite(parsed.version) ? parsed.version : 0,
          records: parsed.records as TokenRecord[],
        };
      }
      return { version: 0, records: [] };
    } catch {
      return { version: 0, records: [] };
    }
  }

  private readAll(): TokenRecord[] {
    return this.readContainer().records;
  }

  /** Atomically persist a container: unique temp file + fsync-ish rename. */
  private writeContainer(container: StoreContainer): void {
    const tmp = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(container, null, 2), { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // best-effort
    }
    renameSync(tmp, this.filePath);
  }

  /**
   * Acquire the exclusive lock via O_EXCL create. Breaks a stale lock whose
   * mtime is older than LOCK_STALE_MS. Throws on timeout.
   */
  private acquireLock(): number {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        // wx = O_CREAT | O_EXCL | O_WRONLY — fails if the lockfile exists.
        const fd = openSync(this.lockPath, "wx", 0o600);
        return fd;
      } catch (err: any) {
        if (err?.code !== "EEXIST") throw err;
        // Lock held — break it if stale, else wait.
        try {
          const age = Date.now() - statSync(this.lockPath).mtimeMs;
          if (age > LOCK_STALE_MS) {
            unlinkSync(this.lockPath);
            continue; // retry immediately after breaking the stale lock
          }
        } catch {
          // Lock vanished between stat and unlink — retry the create.
        }
        if (Date.now() > deadline) {
          throw new Error(
            `identity store: could not acquire lock ${this.lockPath} within ${LOCK_TIMEOUT_MS}ms`,
          );
        }
        sleepMs(LOCK_RETRY_MS);
      }
    }
  }

  private releaseLock(fd: number): void {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
    try {
      unlinkSync(this.lockPath);
    } catch {
      // ignore — a stale-lock breaker may have removed it
    }
  }

  /**
   * Run a mutation inside the exclusive lock: load the freshest container,
   * apply `mutate`, bump the monotonic version, and persist atomically. This is
   * the load-mutate-persist critical section that prevents lost updates.
   */
  private withLockedMutation(mutate: (records: TokenRecord[]) => void): void {
    const fd = this.acquireLock();
    try {
      const container = this.readContainer();
      mutate(container.records);
      this.writeContainer({
        version: container.version + 1,
        records: container.records,
      });
    } finally {
      this.releaseLock(fd);
    }
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
    this.withLockedMutation((records) => {
      records.push(record);
    });
  }

  async update(id: string, patch: Partial<TokenRecord>): Promise<void> {
    this.withLockedMutation((records) => {
      const idx = records.findIndex((r) => r.id === id);
      if (idx === -1) return;
      records[idx] = { ...records[idx], ...patch, id: records[idx].id };
    });
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
