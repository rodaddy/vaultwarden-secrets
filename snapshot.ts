/**
 * Encrypted vault snapshot for offline access
 *
 * Stores a complete, encrypted copy of vault items from Bitwarden
 * for fast offline lookup and MCP tool operations without repeated
 * API calls.
 *
 * @module snapshot
 */

import { existsSync, mkdirSync, renameSync, statSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { $ } from 'bun';
import { Constants, SecretError, ErrorCode, EncryptedData } from './types';
import { encrypt, decrypt, computeHmac, verifyHmac } from './crypto';
import { getMasterKey } from './keychain';

// ============================================================================
// Interfaces
// ============================================================================

export interface BitwVaultItem {
  id: string;
  name: string;
  type: number;  // 1=login, 2=secure_note, 3=card, 4=identity
  login?: { username?: string; password?: string; uris?: Array<{ uri: string }>; totp?: string };
  notes?: string;
  fields?: Array<{ name: string; value: string; type: number }>;
  folderId?: string;
  organizationId?: string;
  revisionDate: string;
}

export interface VaultSnapshot {
  version: 2;
  vaultId: string;
  createdAt: string;  // ISO timestamp
  itemCount: number;
  items: BitwVaultItem[];
}

export interface EncryptedSnapshot {
  format: 'vw-snapshot-v2';
  payload: EncryptedData;
  hmac: string;
}

export interface SnapshotMetadata {
  vaultId: string;
  createdAt: string;
  itemCount: number;
  fileSizeBytes: number;
  isStale: boolean;
}

// ============================================================================
// SnapshotManager Class
// ============================================================================

export class SnapshotManager {
  private snapshotPath: string;
  private cachedSnapshot: VaultSnapshot | null = null;

  constructor(snapshotPath?: string) {
    this.snapshotPath = snapshotPath || Constants.SNAPSHOT_PATH;
  }

  /**
   * Load snapshot from disk (cached in memory)
   */
  async load(): Promise<VaultSnapshot | null> {
    if (this.cachedSnapshot) return this.cachedSnapshot;

    if (!existsSync(this.snapshotPath)) return null;

    try {
      const masterKey = await getMasterKey();
      const content = await Bun.file(this.snapshotPath).text();
      const encrypted = JSON.parse(content) as EncryptedSnapshot;

      if (encrypted.format !== 'vw-snapshot-v2') return null;

      // Verify HMAC
      const payloadJson = JSON.stringify(encrypted.payload);
      if (!verifyHmac(payloadJson, masterKey, encrypted.hmac)) {
        // HMAC mismatch - master key changed or file corrupted
        return null;
      }

      // Decrypt
      const decrypted = await decrypt(encrypted.payload, masterKey);
      const snapshot = JSON.parse(decrypted) as VaultSnapshot;

      this.cachedSnapshot = snapshot;
      return snapshot;
    } catch {
      return null;
    }
  }

  /**
   * Clear cache and reload from disk
   */
  async reload(): Promise<VaultSnapshot | null> {
    this.cachedSnapshot = null;
    return this.load();
  }

  /**
   * Get item by name (case-insensitive)
   */
  async getItem(itemName: string): Promise<BitwVaultItem | null> {
    const snapshot = await this.load();
    if (!snapshot) return null;

    const lowerName = itemName.toLowerCase();
    return snapshot.items.find(item => item.name.toLowerCase() === lowerName) || null;
  }

  /**
   * List all item names (sorted)
   */
  async listItems(): Promise<string[]> {
    const snapshot = await this.load();
    if (!snapshot) return [];

    return snapshot.items.map(item => item.name).sort();
  }

  /**
   * Get metadata without loading all items
   */
  async getMetadata(): Promise<SnapshotMetadata | null> {
    const snapshot = await this.load();
    if (!snapshot) return null;

    const stats = statSync(this.snapshotPath);
    const ageMs = Date.now() - new Date(snapshot.createdAt).getTime();

    return {
      vaultId: snapshot.vaultId,
      createdAt: snapshot.createdAt,
      itemCount: snapshot.itemCount,
      fileSizeBytes: stats.size,
      isStale: ageMs > Constants.SNAPSHOT_STALE_AGE_MS,
    };
  }

  /**
   * Check if snapshot is stale
   */
  isStale(maxAgeMs?: number): boolean {
    if (!existsSync(this.snapshotPath)) return true;

    try {
      const stats = statSync(this.snapshotPath);
      const ageMs = Date.now() - stats.mtimeMs;
      const threshold = maxAgeMs || Constants.SNAPSHOT_STALE_AGE_MS;
      return ageMs > threshold;
    } catch {
      return true;
    }
  }

  /**
   * Create a new snapshot from vault
   */
  async createSnapshot(vaultId: string, session: string): Promise<SnapshotMetadata> {
    // Run bw sync
    try {
      await $`BW_SESSION=${session} bw sync`.quiet();
    } catch (error) {
      throw new SecretError(
        'Failed to sync vault before snapshot',
        ErrorCode.VAULT_LOCKED,
        true,
        error as Error
      );
    }

    // Fetch all items
    let items: BitwVaultItem[];
    try {
      const result = await $`BW_SESSION=${session} bw list items`.quiet();
      items = JSON.parse(result.text());
    } catch (error) {
      throw new SecretError(
        'Failed to list vault items',
        ErrorCode.VAULT_LOCKED,
        true,
        error as Error
      );
    }

    // Build snapshot
    const snapshot: VaultSnapshot = {
      version: 2,
      vaultId,
      createdAt: new Date().toISOString(),
      itemCount: items.length,
      items,
    };

    // Encrypt
    const masterKey = await getMasterKey();
    const snapshotJson = JSON.stringify(snapshot);
    const payload = await encrypt(snapshotJson, masterKey);

    const encryptedSnapshot: EncryptedSnapshot = {
      format: 'vw-snapshot-v2',
      payload,
      hmac: computeHmac(JSON.stringify(payload), masterKey),
    };

    // Atomic write
    const tmpPath = `${this.snapshotPath}.tmp`;
    const dir = dirname(this.snapshotPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    await Bun.write(tmpPath, JSON.stringify(encryptedSnapshot, null, 2));
    // Secure the temp file BEFORE rename to avoid race window
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, this.snapshotPath);

    // Update cache
    this.cachedSnapshot = snapshot;

    const stats = statSync(this.snapshotPath);
    return {
      vaultId,
      createdAt: snapshot.createdAt,
      itemCount: items.length,
      fileSizeBytes: stats.size,
      isStale: false,
    };
  }
}

// ============================================================================
// Singleton
// ============================================================================

export const snapshotManager = new SnapshotManager();
