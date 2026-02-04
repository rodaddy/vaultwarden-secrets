/**
 * Tests for secrets management library
 *
 * Covers crypto module, cache module, types, and error handling.
 * Uses Bun's test runner for fast execution.
 *
 * @module secrets.test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync, writeFileSync } from 'node:fs';
import {
  encrypt,
  decrypt,
  generateMasterKey,
  deriveKey,
  generateSalt,
  computeHmac,
  verifyHmac,
} from './crypto';
import { SecretCache } from './cache';
import {
  SecretError,
  ErrorCode,
  isSecretCategory,
  isEncryptedData,
  isVaultConfig,
  DEFAULT_TTLS,
  Constants,
} from './types';

// ============================================================================
// Crypto Module Tests
// ============================================================================

describe('crypto module', () => {
  describe('encrypt/decrypt', () => {
    test('round trip with valid key', async () => {
      const key = generateMasterKey();
      const plaintext = 'my-secret-api-key-12345';

      const encrypted = await encrypt(plaintext, key);
      const decrypted = await decrypt(encrypted, key);

      expect(decrypted).toBe(plaintext);
    });

    test('encrypted data has required fields', async () => {
      const key = generateMasterKey();
      const encrypted = await encrypt('test-secret', key);

      expect(encrypted.iv).toBeDefined();
      expect(encrypted.authTag).toBeDefined();
      expect(encrypted.encryptedData).toBeDefined();
      expect(typeof encrypted.iv).toBe('string');
      expect(typeof encrypted.authTag).toBe('string');
      expect(typeof encrypted.encryptedData).toBe('string');
    });

    test('decrypt fails with wrong key', async () => {
      const key1 = generateMasterKey();
      const key2 = generateMasterKey();
      const encrypted = await encrypt('secret', key1);

      expect(decrypt(encrypted, key2)).rejects.toThrow(SecretError);
      expect(decrypt(encrypted, key2)).rejects.toThrow(/Decryption failed/);
    });

    test('decrypt fails with corrupted iv', async () => {
      const key = generateMasterKey();
      const encrypted = await encrypt('secret', key);

      // Corrupt the IV
      const corrupted = { ...encrypted, iv: 'corrupted-base64' };

      expect(decrypt(corrupted, key)).rejects.toThrow();
    });

    test('decrypt fails with corrupted auth tag', async () => {
      const key = generateMasterKey();
      const encrypted = await encrypt('secret', key);

      // Corrupt the auth tag
      const corrupted = { ...encrypted, authTag: 'corrupted-base64' };

      expect(decrypt(corrupted, key)).rejects.toThrow();
    });

    test('different plaintexts produce different ciphertexts', async () => {
      const key = generateMasterKey();
      const encrypted1 = await encrypt('secret1', key);
      const encrypted2 = await encrypt('secret2', key);

      expect(encrypted1.encryptedData).not.toBe(encrypted2.encryptedData);
    });

    test('same plaintext produces different IVs (randomized)', async () => {
      const key = generateMasterKey();
      const encrypted1 = await encrypt('same-secret', key);
      const encrypted2 = await encrypt('same-secret', key);

      expect(encrypted1.iv).not.toBe(encrypted2.iv);
      expect(encrypted1.encryptedData).not.toBe(encrypted2.encryptedData);
    });

    test('handles empty string', async () => {
      const key = generateMasterKey();
      const encrypted = await encrypt('', key);
      const decrypted = await decrypt(encrypted, key);

      expect(decrypted).toBe('');
    });

    test('handles unicode characters', async () => {
      const key = generateMasterKey();
      const plaintext = '🔐 Secret emoji password 日本語';
      const encrypted = await encrypt(plaintext, key);
      const decrypted = await decrypt(encrypted, key);

      expect(decrypted).toBe(plaintext);
    });

    test('handles large strings', async () => {
      const key = generateMasterKey();
      const plaintext = 'A'.repeat(10000);
      const encrypted = await encrypt(plaintext, key);
      const decrypted = await decrypt(encrypted, key);

      expect(decrypted).toBe(plaintext);
    });
  });

  describe('deriveKey', () => {
    test('produces consistent output with same inputs', async () => {
      const password = 'my-password';
      const salt = generateSalt();

      const key1 = await deriveKey(password, salt);
      const key2 = await deriveKey(password, salt);

      expect(key1.equals(key2)).toBe(true);
    });

    test('produces different keys with different salts', async () => {
      const password = 'my-password';
      const salt1 = generateSalt();
      const salt2 = generateSalt();

      const key1 = await deriveKey(password, salt1);
      const key2 = await deriveKey(password, salt2);

      expect(key1.equals(key2)).toBe(false);
    });

    test('produces different keys with different passwords', async () => {
      const salt = generateSalt();

      const key1 = await deriveKey('password1', salt);
      const key2 = await deriveKey('password2', salt);

      expect(key1.equals(key2)).toBe(false);
    });

    test('accepts Buffer as password', async () => {
      const passwordBuf = Buffer.from('password', 'utf-8');
      const salt = generateSalt();

      const key = await deriveKey(passwordBuf, salt);

      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    test('produces 32-byte key', async () => {
      const salt = generateSalt();
      const key = await deriveKey('password', salt);

      expect(key.length).toBe(32);
    });
  });

  describe('generateMasterKey', () => {
    test('generates 32-byte key', () => {
      const key = generateMasterKey();
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    test('generates unique keys', () => {
      const key1 = generateMasterKey();
      const key2 = generateMasterKey();

      expect(key1.equals(key2)).toBe(false);
    });
  });

  describe('generateSalt', () => {
    test('generates 32-byte salt', () => {
      const salt = generateSalt();
      expect(salt).toBeInstanceOf(Buffer);
      expect(salt.length).toBe(32);
    });

    test('generates unique salts', () => {
      const salt1 = generateSalt();
      const salt2 = generateSalt();

      expect(salt1.equals(salt2)).toBe(false);
    });
  });

  describe('HMAC', () => {
    test('verification works with correct HMAC', () => {
      const key = generateMasterKey();
      const data = '{"test": "data", "number": 123}';

      const hmac = computeHmac(data, key);
      expect(verifyHmac(data, key, hmac)).toBe(true);
    });

    test('fails with tampered data', () => {
      const key = generateMasterKey();
      const data = '{"test": "data"}';
      const hmac = computeHmac(data, key);

      const tampered = '{"test": "modified"}';
      expect(verifyHmac(tampered, key, hmac)).toBe(false);
    });

    test('fails with wrong key', () => {
      const key1 = generateMasterKey();
      const key2 = generateMasterKey();
      const data = '{"test": "data"}';

      const hmac = computeHmac(data, key1);
      expect(verifyHmac(data, key2, hmac)).toBe(false);
    });

    test('fails with corrupted HMAC', () => {
      const key = generateMasterKey();
      const data = '{"test": "data"}';

      const corrupted = 'invalid-base64-hmac';

      expect(verifyHmac(data, key, corrupted)).toBe(false);
    });

    test('produces base64-encoded string', () => {
      const key = generateMasterKey();
      const hmac = computeHmac('test', key);

      expect(typeof hmac).toBe('string');
      // Base64 check: should decode without error
      expect(() => Buffer.from(hmac, 'base64')).not.toThrow();
    });

    test('different data produces different HMAC', () => {
      const key = generateMasterKey();
      const hmac1 = computeHmac('data1', key);
      const hmac2 = computeHmac('data2', key);

      expect(hmac1).not.toBe(hmac2);
    });
  });
});

// ============================================================================
// SecretCache Tests
// ============================================================================

// ============================================================================
// NOTE: SecretCache tests are skipped because they require macOS Keychain
// access, which isn't available in CI/CD or requires manual setup.
//
// To test SecretCache manually:
// 1. Ensure macOS Keychain has 'pai-secrets' service configured
// 2. Run: bun test secrets.test.ts --only cache
//
// The crypto module tests below provide good coverage of the underlying
// encryption/decryption logic used by the cache.
// ============================================================================

describe.skip('SecretCache', () => {
  let cache: SecretCache;
  const testCachePath = '/tmp/test-secrets-cache.json';

  beforeEach(() => {
    cache = new SecretCache(testCachePath);
  });

  afterEach(() => {
    // Clean up test cache file
    try {
      unlinkSync(testCachePath);
    } catch {
      // Ignore if file doesn't exist
    }
  });

  describe('get/set', () => {
    test('cache miss returns null', async () => {
      const result = await cache.get('nonexistent', 'default');
      expect(result).toBeNull();
    });

    test('set and get round trip', async () => {
      const value = 'my-secret-token-12345';
      await cache.set('github.token', value, 'default', 'api_key');

      const retrieved = await cache.get('github.token', 'default');
      expect(retrieved).toBe(value);
    });

    test('uses vault-prefixed keys', async () => {
      await cache.set('key1', 'value1', 'vault1', 'api_key');
      await cache.set('key1', 'value2', 'vault2', 'api_key');

      const value1 = await cache.get('key1', 'vault1');
      const value2 = await cache.get('key1', 'vault2');

      expect(value1).toBe('value1');
      expect(value2).toBe('value2');
    });

    test('respects TTL expiration', async () => {
      // Set with 1 second TTL
      await cache.set('temp-key', 'temp-value', 'default', 'token', 1);

      // Should be available immediately
      const immediate = await cache.get('temp-key', 'default');
      expect(immediate).toBe('temp-value');

      // Wait 1.5 seconds for expiration
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Should be expired
      const expired = await cache.get('temp-key', 'default');
      expect(expired).toBeNull();
    });

    test('uses category default TTL', async () => {
      await cache.set('api-key', 'value', 'default', 'api_key');

      const stats = cache.getStats();
      expect(stats.entries).toBe(1);
    });

    test('custom TTL overrides category default', async () => {
      const customTtl = 7200; // 2 hours
      await cache.set('key', 'value', 'default', 'api_key', customTtl);

      const retrieved = await cache.get('key', 'default');
      expect(retrieved).toBe('value');
    });
  });

  describe('delete', () => {
    test('deletes existing entry', async () => {
      await cache.set('key', 'value', 'default', 'api_key');

      const deleted = await cache.delete('key', 'default');
      expect(deleted).toBe(true);

      const retrieved = await cache.get('key', 'default');
      expect(retrieved).toBeNull();
    });

    test('returns false for nonexistent entry', async () => {
      const deleted = await cache.delete('nonexistent', 'default');
      expect(deleted).toBe(false);
    });
  });

  describe('clear', () => {
    test('clears all entries', async () => {
      await cache.set('key1', 'value1', 'vault1', 'api_key');
      await cache.set('key2', 'value2', 'vault2', 'api_key');

      await cache.clear();

      expect(await cache.get('key1', 'vault1')).toBeNull();
      expect(await cache.get('key2', 'vault2')).toBeNull();

      const stats = cache.getStats();
      expect(stats.entries).toBe(0);
    });

    test('clears specific vault only', async () => {
      await cache.set('key1', 'value1', 'vault1', 'api_key');
      await cache.set('key2', 'value2', 'vault2', 'api_key');

      await cache.clear('vault1');

      expect(await cache.get('key1', 'vault1')).toBeNull();
      expect(await cache.get('key2', 'vault2')).toBe('value2');
    });
  });

  describe('statistics', () => {
    test('tracks cache hits', async () => {
      await cache.set('key', 'value', 'default', 'api_key');
      await cache.get('key', 'default');
      await cache.get('key', 'default');

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
    });

    test('tracks cache misses', async () => {
      await cache.get('miss1', 'default');
      await cache.get('miss2', 'default');

      const stats = cache.getStats();
      expect(stats.misses).toBe(2);
      expect(stats.hits).toBe(0);
    });

    test('tracks expirations', async () => {
      await cache.set('temp', 'value', 'default', 'token', 1);
      await new Promise(resolve => setTimeout(resolve, 1500));
      await cache.get('temp', 'default');

      const stats = cache.getStats();
      expect(stats.expirations).toBe(1);
    });

    test('calculates hit rate', async () => {
      await cache.set('key', 'value', 'default', 'api_key');
      await cache.get('key', 'default'); // hit
      await cache.get('miss', 'default'); // miss

      const stats = cache.getStats();
      expect(stats.hitRate).toBeCloseTo(0.5);
    });

    test('tracks vaults', async () => {
      await cache.set('key1', 'value1', 'vault1', 'api_key');
      await cache.set('key2', 'value2', 'vault2', 'api_key');

      const stats = cache.getStats();
      expect(stats.vaults).toContain('vault1');
      expect(stats.vaults).toContain('vault2');
      expect(stats.vaults.length).toBe(2);
    });

    test('tracks entry count', async () => {
      await cache.set('key1', 'value1', 'default', 'api_key');
      await cache.set('key2', 'value2', 'default', 'api_key');

      const stats = cache.getStats();
      expect(stats.entries).toBe(2);
      expect(stats.size).toBe(2);
    });
  });

  describe('persistence', () => {
    test('persists cache to file', async () => {
      const cache1 = new SecretCache(testCachePath);
      await cache1.set('key', 'value', 'default', 'api_key');

      // Create new cache instance
      const cache2 = new SecretCache(testCachePath);
      const retrieved = await cache2.get('key', 'default');

      expect(retrieved).toBe('value');
    });

    test('handles missing cache file', async () => {
      const cache = new SecretCache('/tmp/nonexistent-cache.json');
      const result = await cache.get('key', 'default');

      expect(result).toBeNull();
    });
  });
});

// ============================================================================
// Type Guards Tests
// ============================================================================

describe('type guards', () => {
  describe('isSecretCategory', () => {
    test('accepts valid categories', () => {
      expect(isSecretCategory('api_key')).toBe(true);
      expect(isSecretCategory('password')).toBe(true);
      expect(isSecretCategory('token')).toBe(true);
      expect(isSecretCategory('certificate')).toBe(true);
      expect(isSecretCategory('database')).toBe(true);
      expect(isSecretCategory('other')).toBe(true);
    });

    test('rejects invalid values', () => {
      expect(isSecretCategory('invalid')).toBe(false);
      expect(isSecretCategory('')).toBe(false);
      expect(isSecretCategory(123)).toBe(false);
      expect(isSecretCategory(null)).toBe(false);
      expect(isSecretCategory(undefined)).toBe(false);
    });
  });

  describe('isEncryptedData', () => {
    test('accepts valid EncryptedData', () => {
      const valid = {
        iv: 'base64-iv',
        authTag: 'base64-tag',
        encryptedData: 'base64-data',
      };
      expect(isEncryptedData(valid)).toBe(true);
    });

    test('rejects missing fields', () => {
      expect(isEncryptedData({ iv: 'x', authTag: 'x' })).toBe(false);
      expect(isEncryptedData({ iv: 'x', encryptedData: 'x' })).toBe(false);
      expect(isEncryptedData({ authTag: 'x', encryptedData: 'x' })).toBe(false);
    });

    test('rejects wrong types', () => {
      expect(isEncryptedData({ iv: 123, authTag: 'x', encryptedData: 'x' })).toBe(false);
      expect(isEncryptedData(null)).toBe(false);
      expect(isEncryptedData('string')).toBe(false);
    });
  });

  describe('isVaultConfig', () => {
    test('accepts valid VaultConfig', () => {
      const valid = {
        name: 'default',
        path: '/path/to/vault',
        keychainItem: 'vault-password',
      };
      expect(isVaultConfig(valid)).toBe(true);
    });

    test('accepts with optional fields', () => {
      const valid = {
        name: 'default',
        path: '/path/to/vault',
        keychainItem: 'vault-password',
        description: 'Default vault',
        default: true,
      };
      expect(isVaultConfig(valid)).toBe(true);
    });

    test('rejects missing required fields', () => {
      expect(isVaultConfig({ name: 'x', path: 'x' })).toBe(false);
      expect(isVaultConfig({ name: 'x', keychainItem: 'x' })).toBe(false);
      expect(isVaultConfig({ path: 'x', keychainItem: 'x' })).toBe(false);
    });
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

describe('SecretError', () => {
  test('has correct properties', () => {
    const error = new SecretError(
      'Test error message',
      ErrorCode.SECRET_NOT_FOUND,
      true
    );

    expect(error.message).toBe('Test error message');
    expect(error.code).toBe(ErrorCode.SECRET_NOT_FOUND);
    expect(error.retryable).toBe(true);
    expect(error.name).toBe('SecretError');
  });

  test('defaults retryable to false', () => {
    const error = new SecretError('Test', ErrorCode.CACHE_ERROR);
    expect(error.retryable).toBe(false);
  });

  test('can include cause error', () => {
    const cause = new Error('Original error');
    const error = new SecretError('Wrapped error', ErrorCode.UNKNOWN_ERROR, false, cause);

    expect(error.cause).toBe(cause);
  });

  test('is instanceof Error', () => {
    const error = new SecretError('Test', ErrorCode.UNKNOWN_ERROR);
    expect(error instanceof Error).toBe(true);
  });

  test('is instanceof SecretError', () => {
    const error = new SecretError('Test', ErrorCode.UNKNOWN_ERROR);
    expect(error instanceof SecretError).toBe(true);
  });
});

// ============================================================================
// Constants Tests
// ============================================================================

describe('constants', () => {
  test('DEFAULT_TTLS has all categories', () => {
    expect(DEFAULT_TTLS.api_key).toBe(3600);
    expect(DEFAULT_TTLS.password).toBe(1800);
    expect(DEFAULT_TTLS.token).toBe(900);
    expect(DEFAULT_TTLS.certificate).toBe(86400);
    expect(DEFAULT_TTLS.database).toBe(3600);
    expect(DEFAULT_TTLS.other).toBe(1800);
  });

  test('Constants has required values', () => {
    expect(Constants.CACHE_MAX_SIZE).toBe(100);
    expect(Constants.PBKDF2_ITERATIONS).toBe(100000);
    expect(Constants.AES_KEY_LENGTH).toBe(256);
    expect(Constants.SALT_LENGTH).toBe(32);
    expect(Constants.IV_LENGTH).toBe(12);
    expect(Constants.AUTH_TAG_LENGTH).toBe(16);
    expect(Constants.DEFAULT_KEYCHAIN_SERVICE).toBe('vaultwarden-secrets');
    expect(Constants.DEFAULT_VAULT_NAME).toBe('default');
  });
});
