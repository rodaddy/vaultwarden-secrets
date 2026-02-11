/**
 * Tests for snapshot module
 *
 * Covers SnapshotManager, encryption/decryption round-trip,
 * HMAC integrity verification, and field extraction logic.
 *
 * @module snapshot.test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SnapshotManager,
  BitwVaultItem,
  VaultSnapshot,
  EncryptedSnapshot,
} from './snapshot';
import { encrypt, computeHmac, generateMasterKey } from './crypto';
import { extractFieldFromItem } from './index';
import { getMasterKey, keychainSet } from './keychain';
import { Constants, SecretError, ErrorCode } from './types';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a temp directory for test files
 */
function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'snapshot-test-'));
}

/**
 * Create a test VaultSnapshot with sample data
 */
function createTestSnapshot(): VaultSnapshot {
  const items: BitwVaultItem[] = [
    {
      id: '1',
      name: 'GitHub PAT',
      type: 1,
      login: {
        username: 'testuser',
        password: 'FAKE_TEST_VALUE',
      },
      fields: [
        { name: 'API_KEY', value: 'test-api-key-value', type: 0 },
      ],
      revisionDate: '2024-01-01T00:00:00.000Z',
    },
    {
      id: '2',
      name: 'Database Creds',
      type: 1,
      login: {
        username: 'dbuser',
        password: 'FAKE_TEST_VALUE',
      },
      notes: 'Connection string in notes',
      revisionDate: '2024-01-01T00:00:00.000Z',
    },
    {
      id: '3',
      name: 'API Token',
      type: 2, // secure note
      notes: 'token-in-notes-field',
      revisionDate: '2024-01-01T00:00:00.000Z',
    },
  ];

  return {
    version: 2,
    vaultId: 'test-vault',
    createdAt: new Date().toISOString(),
    itemCount: items.length,
    items,
  };
}

/**
 * Write an encrypted snapshot to a file
 */
async function writeEncryptedSnapshot(
  path: string,
  snapshot: VaultSnapshot,
  masterKey: Buffer
): Promise<void> {
  const snapshotJson = JSON.stringify(snapshot);
  const payload = await encrypt(snapshotJson, masterKey);

  const encrypted: EncryptedSnapshot = {
    format: 'vw-snapshot-v2',
    payload,
    hmac: computeHmac(JSON.stringify(payload), masterKey),
  };

  writeFileSync(path, JSON.stringify(encrypted, null, 2));
}

// ============================================================================
// SnapshotManager Tests
// ============================================================================

describe('SnapshotManager', () => {
  let tempDir: string;
  let snapshotPath: string;
  let manager: SnapshotManager;
  let masterKey: Buffer;
  let originalMasterKeyFile: string | undefined;

  beforeEach(async () => {
    tempDir = createTempDir();
    snapshotPath = join(tempDir, 'snapshot.enc');
    manager = new SnapshotManager(snapshotPath);

    // Generate test master key and configure env to use temp file
    masterKey = generateMasterKey();
    originalMasterKeyFile = process.env.MASTER_KEY_FILE;
    const masterKeyFile = join(tempDir, 'master-key.bin');
    writeFileSync(masterKeyFile, masterKey.toString('hex'));
    process.env.MASTER_KEY_FILE = masterKeyFile;
  });

  afterEach(() => {
    // Restore original env
    if (originalMasterKeyFile !== undefined) {
      process.env.MASTER_KEY_FILE = originalMasterKeyFile;
    } else {
      delete process.env.MASTER_KEY_FILE;
    }

    // Clean up temp files
    try {
      unlinkSync(snapshotPath);
    } catch {
      // Ignore if file doesn't exist
    }

    try {
      const masterKeyFile = join(tempDir, 'master-key.bin');
      unlinkSync(masterKeyFile);
    } catch {
      // Ignore
    }
  });

  describe('load()', () => {
    test('returns null when no snapshot file exists', async () => {
      const result = await manager.load();
      expect(result).toBeNull();
    });

    test('loads valid snapshot from disk', async () => {
      const testSnapshot = createTestSnapshot();
      await writeEncryptedSnapshot(snapshotPath, testSnapshot, masterKey);

      const loaded = await manager.load();
      expect(loaded).not.toBeNull();
      expect(loaded?.vaultId).toBe('test-vault');
      expect(loaded?.itemCount).toBe(3);
      expect(loaded?.items.length).toBe(3);
      expect(loaded?.items[0].name).toBe('GitHub PAT');
    });

    test('caches snapshot in memory', async () => {
      const testSnapshot = createTestSnapshot();
      await writeEncryptedSnapshot(snapshotPath, testSnapshot, masterKey);

      const first = await manager.load();
      const second = await manager.load();

      // Should return same instance (cached)
      expect(first).toBe(second);
    });

    test('returns null for invalid format', async () => {
      const invalidSnapshot = {
        format: 'wrong-format',
        payload: await encrypt('{}', masterKey),
        hmac: computeHmac('{}', masterKey),
      };

      writeFileSync(snapshotPath, JSON.stringify(invalidSnapshot));

      const loaded = await manager.load();
      expect(loaded).toBeNull();
    });

    test('returns null for HMAC mismatch', async () => {
      const testSnapshot = createTestSnapshot();
      const snapshotJson = JSON.stringify(testSnapshot);
      const payload = await encrypt(snapshotJson, masterKey);

      // Create snapshot with wrong HMAC
      const encrypted: EncryptedSnapshot = {
        format: 'vw-snapshot-v2',
        payload,
        hmac: 'invalid-hmac-base64==',
      };

      writeFileSync(snapshotPath, JSON.stringify(encrypted));

      const loaded = await manager.load();
      expect(loaded).toBeNull();
    });

    test('returns null for corrupted file', async () => {
      writeFileSync(snapshotPath, 'not-valid-json');

      const loaded = await manager.load();
      expect(loaded).toBeNull();
    });
  });

  describe('reload()', () => {
    test('clears cache and reloads from disk', async () => {
      const testSnapshot = createTestSnapshot();
      await writeEncryptedSnapshot(snapshotPath, testSnapshot, masterKey);

      const first = await manager.load();
      expect(first).not.toBeNull();

      // Modify the snapshot on disk
      const modified = { ...testSnapshot, vaultId: 'modified-vault' };
      await writeEncryptedSnapshot(snapshotPath, modified, masterKey);

      // Without reload, should return cached version
      const cached = await manager.load();
      expect(cached?.vaultId).toBe('test-vault');

      // After reload, should get new version
      const reloaded = await manager.reload();
      expect(reloaded?.vaultId).toBe('modified-vault');
    });
  });

  describe('getItem()', () => {
    test('returns null when no snapshot exists', async () => {
      const item = await manager.getItem('GitHub PAT');
      expect(item).toBeNull();
    });

    test('finds item by exact name', async () => {
      const testSnapshot = createTestSnapshot();
      await writeEncryptedSnapshot(snapshotPath, testSnapshot, masterKey);

      const item = await manager.getItem('GitHub PAT');
      expect(item).not.toBeNull();
      expect(item?.name).toBe('GitHub PAT');
      expect(item?.login?.username).toBe('testuser');
    });

    test('finds item case-insensitively', async () => {
      const testSnapshot = createTestSnapshot();
      await writeEncryptedSnapshot(snapshotPath, testSnapshot, masterKey);

      const item = await manager.getItem('github pat');
      expect(item).not.toBeNull();
      expect(item?.name).toBe('GitHub PAT');
    });

    test('returns null for non-existent item', async () => {
      const testSnapshot = createTestSnapshot();
      await writeEncryptedSnapshot(snapshotPath, testSnapshot, masterKey);

      const item = await manager.getItem('Non-Existent Item');
      expect(item).toBeNull();
    });
  });

  describe('listItems()', () => {
    test('returns empty array when no snapshot exists', async () => {
      const items = await manager.listItems();
      expect(items).toEqual([]);
    });

    test('returns sorted list of item names', async () => {
      const testSnapshot = createTestSnapshot();
      await writeEncryptedSnapshot(snapshotPath, testSnapshot, masterKey);

      const items = await manager.listItems();
      expect(items).toEqual(['API Token', 'Database Creds', 'GitHub PAT']);
    });
  });

  describe('getMetadata()', () => {
    test('returns null when no snapshot exists', async () => {
      const meta = await manager.getMetadata();
      expect(meta).toBeNull();
    });

    test('returns metadata for existing snapshot', async () => {
      const testSnapshot = createTestSnapshot();
      await writeEncryptedSnapshot(snapshotPath, testSnapshot, masterKey);

      const meta = await manager.getMetadata();
      expect(meta).not.toBeNull();
      expect(meta?.vaultId).toBe('test-vault');
      expect(meta?.itemCount).toBe(3);
      expect(meta?.fileSizeBytes).toBeGreaterThan(0);
      expect(meta?.isStale).toBe(false);
    });

    test('marks old snapshot as stale', async () => {
      const testSnapshot = createTestSnapshot();
      // Set createdAt to 3 hours ago (past stale threshold)
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
      testSnapshot.createdAt = threeHoursAgo.toISOString();

      await writeEncryptedSnapshot(snapshotPath, testSnapshot, masterKey);

      const meta = await manager.getMetadata();
      expect(meta?.isStale).toBe(true);
    });
  });

  describe('isStale()', () => {
    test('returns true when no snapshot exists', () => {
      expect(manager.isStale()).toBe(true);
    });

    test('returns false for fresh snapshot', async () => {
      const testSnapshot = createTestSnapshot();
      await writeEncryptedSnapshot(snapshotPath, testSnapshot, masterKey);

      expect(manager.isStale()).toBe(false);
    });

    test('returns true for stale snapshot', async () => {
      const testSnapshot = createTestSnapshot();
      await writeEncryptedSnapshot(snapshotPath, testSnapshot, masterKey);

      // Wait a bit to ensure file is stale
      await new Promise(resolve => setTimeout(resolve, 10));

      // Check with very short maxAge (1ms)
      expect(manager.isStale(1)).toBe(true);
    });

    test('respects custom maxAgeMs', async () => {
      const testSnapshot = createTestSnapshot();
      await writeEncryptedSnapshot(snapshotPath, testSnapshot, masterKey);

      // Fresh with 1 hour max age
      expect(manager.isStale(60 * 60 * 1000)).toBe(false);

      // Stale with 1ms max age
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(manager.isStale(1)).toBe(true);
    });

    test('uses default SNAPSHOT_STALE_AGE_MS when maxAgeMs not provided', async () => {
      const testSnapshot = createTestSnapshot();
      await writeEncryptedSnapshot(snapshotPath, testSnapshot, masterKey);

      // Should use Constants.SNAPSHOT_STALE_AGE_MS (2 hours)
      expect(manager.isStale()).toBe(false);
    });
  });
});

// ============================================================================
// Encryption Round-Trip Tests
// ============================================================================

describe('SnapshotManager encryption round-trip', () => {
  let tempDir: string;
  let snapshotPath: string;
  let manager: SnapshotManager;
  let masterKey: Buffer;
  let originalMasterKeyFile: string | undefined;

  beforeEach(async () => {
    tempDir = createTempDir();
    snapshotPath = join(tempDir, 'snapshot.enc');
    manager = new SnapshotManager(snapshotPath);

    // Generate test master key
    masterKey = generateMasterKey();
    originalMasterKeyFile = process.env.MASTER_KEY_FILE;
    const masterKeyFile = join(tempDir, 'master-key.bin');
    writeFileSync(masterKeyFile, masterKey.toString('hex'));
    process.env.MASTER_KEY_FILE = masterKeyFile;
  });

  afterEach(() => {
    // Restore env
    if (originalMasterKeyFile !== undefined) {
      process.env.MASTER_KEY_FILE = originalMasterKeyFile;
    } else {
      delete process.env.MASTER_KEY_FILE;
    }

    // Cleanup
    try {
      unlinkSync(snapshotPath);
    } catch {
      // Ignore
    }
    try {
      unlinkSync(join(tempDir, 'master-key.bin'));
    } catch {
      // Ignore
    }
  });

  test('can write and read back snapshot data', async () => {
    const original = createTestSnapshot();
    await writeEncryptedSnapshot(snapshotPath, original, masterKey);

    const loaded = await manager.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.version).toBe(2);
    expect(loaded?.vaultId).toBe('test-vault');
    expect(loaded?.itemCount).toBe(3);
    expect(loaded?.items.length).toBe(3);

    // Verify item data integrity
    const githubItem = loaded?.items.find(i => i.name === 'GitHub PAT');
    expect(githubItem).toBeDefined();
    expect(githubItem?.login?.username).toBe('testuser');
    expect(githubItem?.login?.password).toBe('FAKE_TEST_VALUE');
    expect(githubItem?.fields?.[0].name).toBe('API_KEY');
    expect(githubItem?.fields?.[0].value).toBe('test-api-key-value');
  });

  test('HMAC verification detects tampering', async () => {
    const original = createTestSnapshot();
    await writeEncryptedSnapshot(snapshotPath, original, masterKey);

    // Read and tamper with HMAC
    const content = Bun.file(snapshotPath);
    const encrypted = JSON.parse(await content.text()) as EncryptedSnapshot;

    // Corrupt HMAC
    encrypted.hmac = 'tampered-hmac-value==';

    // Write back
    writeFileSync(snapshotPath, JSON.stringify(encrypted));

    // Should return null due to HMAC mismatch
    const loaded = await manager.load();
    expect(loaded).toBeNull();
  });

  test('decryption fails with wrong master key', async () => {
    const original = createTestSnapshot();
    await writeEncryptedSnapshot(snapshotPath, original, masterKey);

    // Replace master key with a different one
    const wrongKey = generateMasterKey();
    const masterKeyFile = join(tempDir, 'master-key.bin');
    writeFileSync(masterKeyFile, wrongKey.toString('hex'));

    // Should return null (decryption fails)
    const loaded = await manager.load();
    expect(loaded).toBeNull();
  });

  test('preserves all item fields through round-trip', async () => {
    const complexItem: BitwVaultItem = {
      id: 'complex-id',
      name: 'Complex Item',
      type: 1,
      login: {
        username: 'user@example.com',
        password: 'FAKE_TEST_VALUE',
        uris: [{ uri: 'https://example.com' }],
        totp: 'TOTP_SECRET_BASE32',
      },
      notes: 'Multi-line\nnotes\nwith special chars: 🔐',
      fields: [
        { name: 'Custom1', value: 'value1', type: 0 },
        { name: 'Custom2', value: 'value2', type: 1 },
      ],
      folderId: 'folder-123',
      organizationId: 'org-456',
      revisionDate: '2024-01-15T12:34:56.789Z',
    };

    const snapshot: VaultSnapshot = {
      version: 2,
      vaultId: 'test',
      createdAt: new Date().toISOString(),
      itemCount: 1,
      items: [complexItem],
    };

    await writeEncryptedSnapshot(snapshotPath, snapshot, masterKey);

    const loaded = await manager.load();
    const loadedItem = loaded?.items[0];

    expect(loadedItem).toEqual(complexItem);
  });
});

// ============================================================================
// extractFieldFromItem Tests
// ============================================================================

describe('extractFieldFromItem', () => {
  const testItem: BitwVaultItem = {
    id: '1',
    name: 'Test Item',
    type: 1,
    login: {
      username: 'testuser',
      password: 'testpass',
      totp: 'TOTP_SECRET',
    },
    notes: 'These are notes',
    fields: [
      { name: 'API_KEY', value: 'api-key-value', type: 0 },
      { name: 'Custom Field', value: 'custom-value', type: 0 },
    ],
    revisionDate: '2024-01-01T00:00:00.000Z',
  };

  describe('custom field extraction', () => {
    test('extracts custom field by name', () => {
      const value = extractFieldFromItem(testItem, { customField: 'API_KEY' });
      expect(value).toBe('api-key-value');
    });

    test('extracts custom field with spaces', () => {
      const value = extractFieldFromItem(testItem, { customField: 'Custom Field' });
      expect(value).toBe('custom-value');
    });

    test('throws on missing custom field', () => {
      expect(() => {
        extractFieldFromItem(testItem, { customField: 'NonExistent' });
      }).toThrow(SecretError);

      expect(() => {
        extractFieldFromItem(testItem, { customField: 'NonExistent' });
      }).toThrow(/Custom field not found/);
    });
  });

  describe('nested field path extraction', () => {
    test('extracts login.password', () => {
      const value = extractFieldFromItem(testItem, { field: 'login.password' });
      expect(value).toBe('testpass');
    });

    test('extracts login.username', () => {
      const value = extractFieldFromItem(testItem, { field: 'login.username' });
      expect(value).toBe('testuser');
    });

    test('extracts login.totp', () => {
      const value = extractFieldFromItem(testItem, { field: 'login.totp' });
      expect(value).toBe('TOTP_SECRET');
    });

    test('extracts notes field', () => {
      const value = extractFieldFromItem(testItem, { field: 'notes' });
      expect(value).toBe('These are notes');
    });

    test('throws on missing nested field', () => {
      expect(() => {
        extractFieldFromItem(testItem, { field: 'login.nonexistent' });
      }).toThrow(SecretError);

      expect(() => {
        extractFieldFromItem(testItem, { field: 'missing.field' });
      }).toThrow(/Field not found/);
    });
  });

  describe('smart fallback logic', () => {
    test('falls back to password when no field specified', () => {
      const value = extractFieldFromItem(testItem, {});
      expect(value).toBe('testpass');
    });

    test('falls back to notes when no password', () => {
      const itemNoPassword: BitwVaultItem = {
        id: '2',
        name: 'No Password',
        type: 2,
        notes: 'Secret in notes',
        revisionDate: '2024-01-01T00:00:00.000Z',
      };

      const value = extractFieldFromItem(itemNoPassword, {});
      expect(value).toBe('Secret in notes');
    });

    test('falls back to first custom field when no password or notes', () => {
      const itemOnlyCustom: BitwVaultItem = {
        id: '3',
        name: 'Only Custom',
        type: 1,
        fields: [
          { name: 'Token', value: 'token-value', type: 0 },
        ],
        revisionDate: '2024-01-01T00:00:00.000Z',
      };

      const value = extractFieldFromItem(itemOnlyCustom, {});
      expect(value).toBe('token-value');
    });

    test('throws when no value found anywhere', () => {
      const emptyItem: BitwVaultItem = {
        id: '4',
        name: 'Empty',
        type: 1,
        revisionDate: '2024-01-01T00:00:00.000Z',
      };

      expect(() => {
        extractFieldFromItem(emptyItem, {});
      }).toThrow(SecretError);

      expect(() => {
        extractFieldFromItem(emptyItem, {});
      }).toThrow(/No value found/);
    });
  });

  describe('edge cases', () => {
    test('handles item with uri field', () => {
      const itemWithUri: BitwVaultItem = {
        id: '5',
        name: 'With URI',
        type: 1,
        login: {
          username: 'user',
          password: 'pass',
          uris: [{ uri: 'https://example.com' }],
        },
        revisionDate: '2024-01-01T00:00:00.000Z',
      };

      // Can't extract uris directly via field path (it's an array)
      // But password fallback should work
      const value = extractFieldFromItem(itemWithUri, {});
      expect(value).toBe('pass');
    });

    test('handles empty notes field', () => {
      const itemEmptyNotes: BitwVaultItem = {
        id: '6',
        name: 'Empty Notes',
        type: 1,
        login: { password: 'pass' },
        notes: '',
        revisionDate: '2024-01-01T00:00:00.000Z',
      };

      // Should fall back to password, not empty notes
      const value = extractFieldFromItem(itemEmptyNotes, {});
      expect(value).toBe('pass');
    });

    test('handles non-string field values as JSON', () => {
      const itemWithObject: any = {
        id: '7',
        name: 'Object Field',
        type: 1,
        login: {
          username: 'user',
          password: 'pass',
          customObject: { key: 'value' },
        },
        revisionDate: '2024-01-01T00:00:00.000Z',
      };

      const value = extractFieldFromItem(itemWithObject, { field: 'login.customObject' });
      expect(value).toBe('{"key":"value"}');
    });
  });
});
