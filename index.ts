/**
 * Secrets Management Library - Public API
 *
 * Provides secure secrets management with macOS Keychain integration,
 * encrypted file caching, and Vaultwarden CLI integration.
 *
 * @module index
 */

import { $ } from 'bun';
import {
  SecretOptions,
  SecretError,
  ErrorCode,
  CacheStats
} from './types';
import { secretCache } from './cache';
import { vaultManager } from './vault-config';
import { getVaultSession, setVaultSession } from './keychain';

/**
 * Internal parsed secret path with custom field support
 */
interface ExtendedParsedPath {
  item: string;
  field?: string;
  customField?: string;
}

/**
 * Parse secret path like "Item.field" or "Item.fields.CUSTOM"
 *
 * @param path - Secret path to parse
 * @returns Parsed path components
 *
 * @example
 * parseSecretPath('github-pat') // { item: 'github-pat' }
 * parseSecretPath('github-pat.password') // { item: 'github-pat', field: 'password' }
 * parseSecretPath('github-pat.fields.API_KEY') // { item: 'github-pat', customField: 'API_KEY' }
 */
function parseSecretPath(path: string): ExtendedParsedPath {
  const parts = path.split('.');
  const item = parts[0];

  if (parts.length === 1) {
    return { item };
  }

  // Handle custom fields: Item.fields.CUSTOM_FIELD_NAME
  if (parts[1] === 'fields' && parts.length >= 3) {
    return {
      item,
      customField: parts.slice(2).join('.') // Handle nested field names
    };
  }

  // Handle regular fields: Item.field or Item.login.password
  return {
    item,
    field: parts.slice(1).join('.')
  };
}

/**
 * Get a secret from Vaultwarden with caching
 *
 * @param path - Secret path (e.g., "github-pat", "github-pat.password", "github-pat.fields.API_KEY")
 * @param options - Options for secret retrieval
 * @returns Promise resolving to secret value
 * @throws {SecretError} If vault is locked or secret not found
 *
 * @example
 * // Get password field (default)
 * const password = await getSecret('github-pat');
 *
 * // Get specific field
 * const username = await getSecret('github-pat.login.username');
 *
 * // Get custom field
 * const apiKey = await getSecret('github-pat.fields.API_KEY');
 *
 * // Skip cache for fresh value
 * const fresh = await getSecret('github-pat', { skipCache: true });
 *
 * // Use specific vault
 * const workSecret = await getSecret('work-token', { vault: 'work' });
 */
export async function getSecret(
  path: string,
  options: SecretOptions = {}
): Promise<string> {
  const parsed = parseSecretPath(path);
  const vaultId = options.vault || await vaultManager.getActiveVault();

  // Check cache first (unless bypassed)
  if (!options.skipCache) {
    const cached = await secretCache.get(path, vaultId);
    if (cached !== null) {
      return cached;
    }
  }

  // Get session token from Keychain
  const session = await getVaultSession(vaultId);
  if (!session) {
    throw new SecretError(
      `No session for vault: ${vaultId}. Run: bw unlock`,
      ErrorCode.VAULT_LOCKED
    );
  }

  // Fetch from Vaultwarden
  try {
    const result = await $`BW_SESSION=${session} bw get item ${parsed.item}`.quiet();
    const item = JSON.parse(result.stdout.toString());

    let value: string;

    if (parsed.customField) {
      // Look in custom fields array
      const field = item.fields?.find((f: any) => f.name === parsed.customField);
      if (!field) {
        throw new SecretError(
          `Custom field not found: ${parsed.customField}`,
          ErrorCode.SECRET_NOT_FOUND
        );
      }
      value = field.value;
    } else if (parsed.field) {
      // Navigate to nested field (e.g., "login.password", "login.username")
      const parts = parsed.field.split('.');
      let current: any = item;

      for (const part of parts) {
        current = current?.[part];
        if (current === undefined) {
          throw new SecretError(
            `Field not found: ${parsed.field}`,
            ErrorCode.SECRET_NOT_FOUND
          );
        }
      }

      value = typeof current === 'string' ? current : JSON.stringify(current);
    } else {
      // Return password by default
      if (!item.login?.password) {
        throw new SecretError(
          `No password field in item: ${parsed.item}`,
          ErrorCode.SECRET_NOT_FOUND
        );
      }
      value = item.login.password;
    }

    // Cache the result
    await secretCache.set(path, value, vaultId, options.category);

    return value;
  } catch (error) {
    if (error instanceof SecretError) throw error;

    // Check for common bw errors
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('vault is locked')) {
      throw new SecretError(
        `Vault is locked: ${vaultId}. Run: bw unlock`,
        ErrorCode.VAULT_LOCKED
      );
    }
    if (message.includes('not found')) {
      throw new SecretError(
        `Item not found: ${parsed.item}`,
        ErrorCode.SECRET_NOT_FOUND
      );
    }

    throw new SecretError(
      `Failed to get secret: ${path}`,
      ErrorCode.VAULT_CORRUPTED,
      true,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Get all fields from a Vaultwarden item as an object
 *
 * @param itemName - Name of the Vaultwarden item
 * @param options - Options for secret retrieval
 * @returns Promise resolving to object with all fields
 * @throws {SecretError} If vault is locked or item not found
 *
 * @example
 * const secrets = await getSecretObject('github-pat');
 * // Returns: { username: '...', password: '...', uri: '...', API_KEY: '...' }
 *
 * const workSecrets = await getSecretObject('work-token', { vault: 'work' });
 */
export async function getSecretObject(
  itemName: string,
  options: SecretOptions = {}
): Promise<Record<string, string>> {
  const vaultId = options.vault || await vaultManager.getActiveVault();
  const session = await getVaultSession(vaultId);

  if (!session) {
    throw new SecretError(
      `No session for vault: ${vaultId}. Run: bw unlock`,
      ErrorCode.VAULT_LOCKED
    );
  }

  try {
    const result = await $`BW_SESSION=${session} bw get item ${itemName}`.quiet();
    const item = JSON.parse(result.stdout.toString());

    const obj: Record<string, string> = {};

    // Add login fields
    if (item.login) {
      if (item.login.username) obj.username = item.login.username;
      if (item.login.password) obj.password = item.login.password;
      if (item.login.uris?.[0]?.uri) obj.uri = item.login.uris[0].uri;
    }

    // Add notes
    if (item.notes) obj.notes = item.notes;

    // Add custom fields
    if (item.fields) {
      for (const field of item.fields) {
        obj[field.name] = field.value;
      }
    }

    return obj;
  } catch (error) {
    if (error instanceof SecretError) throw error;

    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('vault is locked')) {
      throw new SecretError(
        `Vault is locked: ${vaultId}. Run: bw unlock`,
        ErrorCode.VAULT_LOCKED
      );
    }
    if (message.includes('not found')) {
      throw new SecretError(
        `Item not found: ${itemName}`,
        ErrorCode.SECRET_NOT_FOUND
      );
    }

    throw new SecretError(
      `Failed to get item: ${itemName}`,
      ErrorCode.VAULT_CORRUPTED,
      true,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * List available secrets (items) from Vaultwarden
 *
 * @param filter - Optional filter string (case-insensitive)
 * @param options - Options for listing
 * @returns Promise resolving to sorted array of item names
 * @throws {SecretError} If vault is locked
 *
 * @example
 * // List all secrets
 * const allSecrets = await listSecrets();
 *
 * // List filtered secrets
 * const githubSecrets = await listSecrets('github');
 *
 * // List from specific vault
 * const workSecrets = await listSecrets(undefined, { vault: 'work' });
 */
export async function listSecrets(
  filter?: string,
  options: SecretOptions = {}
): Promise<string[]> {
  const vaultId = options.vault || await vaultManager.getActiveVault();
  const session = await getVaultSession(vaultId);

  if (!session) {
    throw new SecretError(
      `No session for vault: ${vaultId}. Run: bw unlock`,
      ErrorCode.VAULT_LOCKED
    );
  }

  try {
    const result = await $`BW_SESSION=${session} bw list items`.quiet();
    const items = JSON.parse(result.stdout.toString());

    let names = items.map((item: any) => item.name);

    // Apply filter if provided
    if (filter) {
      const lowerFilter = filter.toLowerCase();
      names = names.filter((name: string) =>
        name.toLowerCase().includes(lowerFilter)
      );
    }

    return names.sort();
  } catch (error) {
    if (error instanceof SecretError) throw error;

    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('vault is locked')) {
      throw new SecretError(
        `Vault is locked: ${vaultId}. Run: bw unlock`,
        ErrorCode.VAULT_LOCKED
      );
    }

    throw new SecretError(
      `Failed to list secrets`,
      ErrorCode.VAULT_CORRUPTED,
      true,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Clear the encrypted cache
 *
 * @param vaultId - Optional vault ID to clear (clears all if not specified)
 *
 * @example
 * // Clear all cached secrets
 * await clearCache();
 *
 * // Clear only work vault cache
 * await clearCache('work');
 */
export async function clearCache(vaultId?: string): Promise<void> {
  await secretCache.clear(vaultId);
}

/**
 * Get cache statistics
 *
 * @returns Cache statistics including hit rate, entries, and vaults
 *
 * @example
 * const stats = getCacheStats();
 * console.log(`Cache hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);
 * console.log(`Cached entries: ${stats.entries}`);
 * console.log(`Active vaults: ${stats.vaults.join(', ')}`);
 */
export function getCacheStats(): CacheStats {
  return secretCache.getStats();
}

/**
 * Switch active vault
 *
 * @param vaultId - ID of vault to activate
 * @throws {SecretError} If vault not found
 *
 * @example
 * await switchVault('work');
 * // Now getSecret() uses 'work' vault by default
 */
export async function switchVault(vaultId: string): Promise<void> {
  await vaultManager.switchVault(vaultId);
  // Clear cache for old vault context to avoid confusion
  await secretCache.clear();
}

/**
 * Get active vault ID
 *
 * @returns Promise resolving to active vault ID
 *
 * @example
 * const activeVault = await getActiveVault();
 * console.log(`Using vault: ${activeVault}`);
 */
export async function getActiveVault(): Promise<string> {
  return vaultManager.getActiveVault();
}

/**
 * Store a session token for a vault (after bw unlock)
 *
 * @param vaultId - Vault identifier
 * @param token - BW_SESSION token from bw unlock
 *
 * @example
 * const result = await $`bw unlock`.text();
 * const match = result.match(/BW_SESSION="([^"]+)"/);
 * if (match) {
 *   await setSession('default', match[1]);
 * }
 */
export async function setSession(vaultId: string, token: string): Promise<void> {
  await setVaultSession(vaultId, token);
}

// Re-export types and values for consumers
export {
  SecretError,
  ErrorCode,
  DEFAULT_TTLS,
  Constants
} from './types';

export type {
  SecretOptions,
  CacheStats,
  VaultConfig,
  VaultConfigFile,
  CacheEntry,
  EncryptedData,
  SecretCategory
} from './types';

// Re-export vault manager for advanced usage
export { vaultManager } from './vault-config';
export { secretCache } from './cache';