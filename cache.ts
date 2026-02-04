/**
 * Encrypted file-based cache for secrets
 *
 * Provides persistent caching of decrypted secrets with TTL expiration,
 * LRU eviction, and HMAC integrity verification. Cache file is encrypted
 * using the master key from macOS Keychain.
 *
 * @module cache
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  CacheEntry,
  CacheStats,
  SecretError,
  ErrorCode,
  Constants,
  DEFAULT_TTLS,
  SecretCategory,
} from './types';
import { encrypt, decrypt, computeHmac, verifyHmac } from './crypto';
import { getMasterKey } from './keychain';

/**
 * Cache file structure
 *
 * Stored at: ~/.config/pai-private/.vw-cache.json
 *
 * Format:
 * {
 *   "version": 1,
 *   "entries": {
 *     "default:github-pat.token": { value, expiresAt, ... },
 *     "work:api-key.token": { value, expiresAt, ... }
 *   },
 *   "hmac": "base64-encoded-hmac-of-entries"
 * }
 */
interface CacheFile {
  /** Cache file format version */
  version: 1;

  /** Map of cache key to entry */
  entries: Record<string, CacheEntry>;

  /** HMAC-SHA256 of JSON.stringify(entries) for integrity */
  hmac: string;
}

/**
 * Encrypted file-based cache for secrets
 *
 * Features:
 * - Encrypted storage using master key from Keychain
 * - TTL-based expiration per secret category
 * - LRU eviction when cache exceeds max size
 * - HMAC integrity verification on load
 * - Vault-prefixed keys prevent collisions
 *
 * @example
 * const cache = new SecretCache();
 * await cache.set('github-pat.token', 'ghp_...', 'default', 'api_key');
 * const token = await cache.get('github-pat.token', 'default');
 */
export class SecretCache {
  private cachePath: string;
  private entries: Map<string, CacheEntry> = new Map();
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    expirations: 0,
  };
  private loaded = false;

  /**
   * Create a new cache instance
   *
   * @param cachePath - Path to cache file (default: ~/.config/pai-private/.vw-cache.json)
   */
  constructor(cachePath?: string) {
    this.cachePath =
      cachePath || join(homedir(), '.config/pai-private/.vw-cache.json');
  }

  /**
   * Load cache from encrypted file
   *
   * Verifies HMAC integrity before loading entries.
   * Creates empty cache if file doesn't exist.
   *
   * @throws {SecretError} If HMAC verification fails or file is corrupted
   */
  async load(): Promise<void> {
    if (this.loaded) return;

    if (!existsSync(this.cachePath)) {
      this.loaded = true;
      return;
    }

    try {
      const masterKey = await getMasterKey();
      const content = readFileSync(this.cachePath, 'utf-8');
      const cacheFile = JSON.parse(content) as CacheFile;

      // Verify HMAC integrity
      const entriesJson = JSON.stringify(cacheFile.entries);
      if (!verifyHmac(entriesJson, masterKey, cacheFile.hmac)) {
        throw new SecretError(
          'Cache integrity check failed',
          ErrorCode.CACHE_ERROR
        );
      }

      // Load entries
      for (const [key, entry] of Object.entries(cacheFile.entries)) {
        this.entries.set(key, entry);
      }

      this.loaded = true;
    } catch (error) {
      if (error instanceof SecretError) throw error;

      throw new SecretError(
        `Failed to load cache: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.CACHE_ERROR,
        false,
        error as Error
      );
    }
  }

  /**
   * Save cache to encrypted file
   *
   * Computes HMAC over entries for integrity verification.
   * Creates directory if it doesn't exist.
   *
   * @throws {SecretError} If file write fails
   */
  async save(): Promise<void> {
    try {
      const masterKey = await getMasterKey();
      const entriesObj = Object.fromEntries(this.entries);
      const entriesJson = JSON.stringify(entriesObj);

      const cacheFile: CacheFile = {
        version: 1,
        entries: entriesObj,
        hmac: computeHmac(entriesJson, masterKey),
      };

      const dir = dirname(this.cachePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(this.cachePath, JSON.stringify(cacheFile, null, 2));
    } catch (error) {
      throw new SecretError(
        `Failed to save cache: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ErrorCode.CACHE_ERROR,
        false,
        error as Error
      );
    }
  }

  /**
   * Get cached secret value
   *
   * Returns null if:
   * - Entry not found
   * - Entry expired (automatically removed)
   *
   * Updates access tracking on hit.
   *
   * @param key - Secret key (e.g., 'github-pat.token')
   * @param vaultId - Vault identifier (e.g., 'default', 'work')
   * @returns Decrypted secret value, or null if not cached
   *
   * @example
   * const token = await cache.get('github-pat.token', 'default');
   * if (token) {
   *   console.log('Cache hit');
   * } else {
   *   console.log('Cache miss - fetch from vault');
   * }
   */
  async get(key: string, vaultId: string): Promise<string | null> {
    await this.load();

    const cacheKey = `${vaultId}:${key}`;
    const entry = this.entries.get(cacheKey);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(cacheKey);
      this.stats.expirations++;
      this.stats.misses++;
      return null;
    }

    // Update access tracking
    entry.lastAccessed = Date.now();
    entry.accessCount++;
    this.stats.hits++;

    // Decrypt value
    const masterKey = await getMasterKey();
    return decrypt(entry.value, masterKey);
  }

  /**
   * Set cached secret value
   *
   * Encrypts value with master key before storing.
   * Triggers LRU eviction if cache exceeds max size.
   *
   * @param key - Secret key (e.g., 'github-pat.token')
   * @param value - Decrypted secret value to cache
   * @param vaultId - Vault identifier (e.g., 'default', 'work')
   * @param category - Secret category for TTL (default: 'other')
   * @param ttlSeconds - Custom TTL in seconds (overrides category default)
   *
   * @example
   * await cache.set('github-pat.token', 'ghp_...', 'default', 'api_key');
   * // Cached for 1 hour (DEFAULT_TTLS.api_key)
   *
   * await cache.set('temp-token', 'xyz', 'default', 'token', 300);
   * // Cached for 5 minutes (custom TTL)
   */
  async set(
    key: string,
    value: string,
    vaultId: string,
    category: SecretCategory = 'other',
    ttlSeconds?: number
  ): Promise<void> {
    await this.load();

    const masterKey = await getMasterKey();
    const encrypted = await encrypt(value, masterKey);

    const ttl = ttlSeconds || DEFAULT_TTLS[category];
    const cacheKey = `${vaultId}:${key}`;

    const entry: CacheEntry = {
      value: encrypted,
      category,
      expiresAt: Date.now() + ttl * 1000,
      lastAccessed: Date.now(),
      accessCount: 1,
    };

    this.entries.set(cacheKey, entry);

    // Check size and evict if needed
    await this.evictIfNeeded();
    await this.save();
  }

  /**
   * Delete cached entry
   *
   * @param key - Secret key
   * @param vaultId - Vault identifier
   * @returns true if entry was deleted, false if not found
   *
   * @example
   * const deleted = await cache.delete('github-pat.token', 'default');
   */
  async delete(key: string, vaultId: string): Promise<boolean> {
    await this.load();
    const cacheKey = `${vaultId}:${key}`;
    const deleted = this.entries.delete(cacheKey);
    if (deleted) await this.save();
    return deleted;
  }

  /**
   * Clear all entries (optionally for specific vault)
   *
   * @param vaultId - Optional vault ID to clear (clears all if not specified)
   *
   * @example
   * await cache.clear('work');  // Clear only work vault
   * await cache.clear();        // Clear all vaults
   */
  async clear(vaultId?: string): Promise<void> {
    await this.load();

    if (vaultId) {
      const keysToDelete = Array.from(this.entries.keys()).filter(key =>
        key.startsWith(`${vaultId}:`)
      );
      for (const key of keysToDelete) {
        this.entries.delete(key);
      }
    } else {
      this.entries.clear();
    }

    await this.save();
  }

  /**
   * Get cache statistics
   *
   * @returns Cache statistics including hit rate, entries, vaults
   *
   * @example
   * const stats = cache.getStats();
   * console.log(`Hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);
   * console.log(`Entries: ${stats.entries}`);
   * console.log(`Vaults: ${stats.vaults.join(', ')}`);
   */
  getStats(): CacheStats {
    const entries = this.entries.size;
    const hitRate =
      this.stats.hits + this.stats.misses > 0
        ? this.stats.hits / (this.stats.hits + this.stats.misses)
        : 0;

    let oldest: number | undefined;
    let newest: number | undefined;
    const vaults = new Set<string>();

    const entriesArray = Array.from(this.entries.entries());
    for (const [key, entry] of entriesArray) {
      const vault = key.split(':')[0];
      vaults.add(vault);
      if (!oldest || entry.expiresAt < oldest) oldest = entry.expiresAt;
      if (!newest || entry.expiresAt > newest) newest = entry.expiresAt;
    }

    return {
      entries,
      size: entries,
      maxSize: Constants.CACHE_MAX_SIZE,
      hitRate,
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions,
      expirations: this.stats.expirations,
      oldestEntry: oldest,
      newestEntry: newest,
      vaults: Array.from(vaults),
    };
  }

  /**
   * Evict LRU entries if cache too large
   *
   * Removes oldest 10% of entries when cache exceeds max size.
   * Uses lastAccessed timestamp for LRU ordering.
   *
   * @private
   */
  private async evictIfNeeded(): Promise<void> {
    if (this.entries.size <= Constants.CACHE_MAX_SIZE) return;

    // Sort by lastAccessed (LRU)
    const sorted = Array.from(this.entries.entries()).sort(
      ([, a], [, b]) => a.lastAccessed - b.lastAccessed
    );

    // Remove oldest 10%
    const toRemove = Math.ceil(sorted.length * 0.1);
    for (let i = 0; i < toRemove; i++) {
      this.entries.delete(sorted[i][0]);
      this.stats.evictions++;
    }
  }
}

/**
 * Singleton cache instance
 *
 * Used by default in getSecret() calls.
 *
 * @example
 * import { secretCache } from './cache';
 *
 * const token = await secretCache.get('github-pat.token', 'default');
 */
export const secretCache = new SecretCache();
