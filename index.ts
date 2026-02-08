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
  CacheStats,
  Constants
} from './types';
import { secretCache } from './cache';
import { vaultManager } from './vault-config';
import { getVaultSession, setVaultSession } from './keychain';
import { snapshotManager } from './snapshot';

/**
 * Internal parsed secret path with custom field support
 */
interface ExtendedParsedPath {
  item: string;
  field?: string;
  customField?: string;
}

/**
 * Apply folder prefix to path if needed
 *
 * Rule: If path contains '/', use as-is (explicit folder).
 * Otherwise, prepend the default folder.
 *
 * @param path - Original path
 * @param folder - Default folder prefix
 * @returns Path with folder applied
 *
 * @example
 * applyFolder('postgres', 'Projects/myapp') // 'Projects/myapp/postgres'
 * applyFolder('work/postgres', 'Projects/myapp') // 'work/postgres' (explicit)
 * applyFolder('postgres.password', 'Projects/myapp') // 'Projects/myapp/postgres.password'
 */
function applyFolder(path: string, folder: string): string {
  if (!folder) return path;

  // Extract item part (before first dot) to check for slash
  const dotIndex = path.indexOf('.');
  const itemPart = dotIndex >= 0 ? path.slice(0, dotIndex) : path;
  const fieldPart = dotIndex >= 0 ? path.slice(dotIndex) : '';

  // If item already has a folder (contains /), use as-is
  if (itemPart.includes('/')) {
    return path;
  }

  // Prepend folder to item
  return `${folder}/${itemPart}${fieldPart}`;
}

/**
 * Parse secret path with support for standard and custom fields
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
  // Handle known field path patterns that can appear anywhere in the path
  // Pattern: something.fields.FIELD_NAME - look for .fields. as the delimiter
  const fieldsMatch = path.match(/^(.+)\.fields\.(.+)$/);
  if (fieldsMatch) {
    return {
      item: fieldsMatch[1],
      customField: fieldsMatch[2]
    };
  }

  // Pattern: something.login.xxx or something.notes (known BW fields)
  // Look for known field names at the end
  const knownFields = ['.login.password', '.login.username', '.login.totp', '.notes', '.uri'];
  for (const fieldSuffix of knownFields) {
    if (path.endsWith(fieldSuffix)) {
      return {
        item: path.slice(0, -fieldSuffix.length),
        field: fieldSuffix.slice(1) // remove leading dot
      };
    }
  }

  // Simple case: single segment or segment.field where segment has no dots
  const parts = path.split('.');
  if (parts.length === 1) {
    return { item: path };
  }

  // For ambiguous cases, assume everything except last part is item name
  // This handles "some.item.name.password" → item="some.item.name", field="password"
  // But also "simple-item.password" → item="simple-item", field="password"
  const lastPart = parts[parts.length - 1];
  const knownSimpleFields = ['password', 'username', 'uri', 'totp', 'notes'];

  if (knownSimpleFields.includes(lastPart)) {
    return {
      item: parts.slice(0, -1).join('.'),
      field: lastPart
    };
  }

  // Default: first part is item, rest is field path
  return {
    item: parts[0],
    field: parts.slice(1).join('.')
  };
}

/**
 * Build a Record<string, string> from all fields in a Vaultwarden item
 *
 * @param item - Vaultwarden item object
 * @returns Object with all fields as key-value pairs
 *
 * @example
 * buildFieldsObject(item) // { username: '...', password: '...', uri: '...', API_KEY: '...' }
 */
function buildFieldsObject(item: any): Record<string, string> {
  const result: Record<string, string> = {};

  // Add login fields
  if (item.login) {
    if (item.login.username) result.username = item.login.username;
    if (item.login.password) result.password = item.login.password;
    if (item.login.uris?.[0]?.uri) result.uri = item.login.uris[0].uri;
    if (item.login.totp) result.totp = item.login.totp;
  }

  // Add notes
  if (item.notes) result.notes = item.notes;

  // Add custom fields
  if (item.fields) {
    for (const field of item.fields) {
      result[field.name] = String(field.value);
    }
  }

  return result;
}

/**
 * Resolve a Vaultwarden item by exact name, handling BW CLI multi-result ambiguity.
 *
 * Fast path: `bw get item <name>` works for unambiguous names.
 * Fallback: On "More than one result", uses `bw list items --search` and
 * filters for exact name match.
 *
 * @param session - BW_SESSION token
 * @param name - Exact item name to look up
 * @returns Parsed item object
 * @throws {SecretError} If item not found
 * @throws Re-throws non-ambiguity BW errors
 *
 * @example
 * const item = await getItemByName(session, 'LiteLLM');
 * // Works even if "LiteLLM API Key" also exists
 */
export async function getItemByName(session: string, name: string): Promise<any> {
  // Fast path: try direct lookup
  try {
    const result = await $`BW_SESSION=${session} bw get item ${name}`.quiet();
    return JSON.parse(result.stdout.toString());
  } catch (error: any) {
    const stderr = error.stderr?.toString() || '';

    // Only handle multi-result — re-throw everything else
    if (!stderr.includes('More than one result')) {
      throw error;
    }
  }

  // Fallback: list + exact filter
  const listResult = await $`BW_SESSION=${session} bw list items --search ${name}`.quiet();
  const items = JSON.parse(listResult.stdout.toString());
  const exactMatches = items.filter((item: any) => item.name === name);

  if (exactMatches.length === 0) {
    throw new SecretError(`Item not found: ${name}`, ErrorCode.SECRET_NOT_FOUND);
  }

  if (exactMatches.length > 1) {
    console.error(`[warn] Multiple items named "${name}" — using first match (id: ${exactMatches[0].id})`);
  }

  return exactMatches[0];
}

/**
 * Extract field value from Vaultwarden item
 *
 * Handles custom fields, nested field paths, and smart fallback logic.
 *
 * @param item - Vaultwarden item object
 * @param parsed - Parsed path with field/customField specifiers
 * @returns Extracted field value
 * @throws {SecretError} If field not found
 *
 * @example
 * extractFieldFromItem(item, { customField: 'API_KEY' }) // from item.fields
 * extractFieldFromItem(item, { field: 'login.password' }) // from item.login.password
 * extractFieldFromItem(item, {}) // smart fallback: password → notes → first custom field
 */
export function extractFieldFromItem(item: any, parsed: { field?: string; customField?: string }): string {
  if (parsed.customField) {
    // Look in custom fields array
    const field = item.fields?.find((f: any) => f.name === parsed.customField);
    if (!field) {
      throw new SecretError(
        `Custom field not found: ${parsed.customField}`,
        ErrorCode.SECRET_NOT_FOUND
      );
    }
    return field.value;
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

    return typeof current === 'string' ? current : JSON.stringify(current);
  } else {
    // Smart fallback: try password → notes → first custom field
    if (item.login?.password) {
      return item.login.password;
    } else if (item.notes) {
      return item.notes;
    } else if (item.fields?.length > 0) {
      // Try first custom field
      return item.fields[0].value;
    } else {
      throw new SecretError(
        `No value found in item (no password, notes, or custom fields)`,
        ErrorCode.SECRET_NOT_FOUND
      );
    }
  }
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
  // Resolve alias first (e.g., OPENAI_API_KEY → "OpenAI API Key")
  const aliasedPath = await vaultManager.resolveAlias(path);

  // Apply folder prefix if path doesn't have explicit folder
  const folder = await vaultManager.getFolder();
  const resolvedPath = applyFolder(aliasedPath, folder);
  const parsed = parseSecretPath(resolvedPath);
  const vaultId = options.vault || await vaultManager.getActiveVault();

  // Check cache first (unless bypassed)
  if (!options.skipCache) {
    const cached = await secretCache.get(resolvedPath, vaultId);
    if (cached !== null) {
      return cached;
    }
  }

  // Get session token from Keychain
  const session = await getVaultSession(vaultId);

  // Try BW if session exists
  let bwError: Error | null = null;
  if (session) {
    try {
      const item = await getItemByName(session, parsed.item);

      // Extract field value using standalone function
      const value = extractFieldFromItem(item, parsed);

      // Cache the result
      await secretCache.set(resolvedPath, value, vaultId, options.category);

      return value;
    } catch (error) {
      if (error instanceof SecretError) throw error;

      // Store error for snapshot fallback
      bwError = error instanceof Error ? error : new Error(String(error));
    }
  }

  // No session OR BW failed - try snapshot fallback
  const snapshotItem = await snapshotManager.getItem(parsed.item);
  if (snapshotItem) {
    try {
      const value = extractFieldFromItem(snapshotItem, parsed);

      // Log warning about snapshot source
      const meta = await snapshotManager.getMetadata();
      if (meta) {
        const ageMs = Date.now() - new Date(meta.createdAt).getTime();
        if (ageMs > Constants.SNAPSHOT_STALE_AGE_MS) {
          console.error(`[snapshot] WARNING: serving stale data for "${parsed.item}" (age: ${Math.round(ageMs / 60000)}min)`);
        } else if (ageMs > Constants.SNAPSHOT_WARN_AGE_MS) {
          console.error(`[snapshot] INFO: serving from snapshot for "${parsed.item}" (age: ${Math.round(ageMs / 60000)}min)`);
        }
      }

      return value;
    } catch (snapshotError) {
      // Fall through to throw error
    }
  }

  // Both BW and snapshot failed - throw appropriate error
  if (!session) {
    throw new SecretError(
      `No session for vault: ${vaultId}. Run: bw unlock`,
      ErrorCode.VAULT_LOCKED
    );
  }

  // Had session but BW failed
  const message = bwError ? bwError.message : '';
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
    bwError || undefined
  );
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
  // Resolve alias first
  const aliasedItem = await vaultManager.resolveAlias(itemName);

  // Apply folder prefix if item doesn't have explicit folder
  const folder = await vaultManager.getFolder();
  const resolvedItem = aliasedItem.includes('/') ? aliasedItem : (folder ? `${folder}/${aliasedItem}` : aliasedItem);

  const vaultId = options.vault || await vaultManager.getActiveVault();
  const session = await getVaultSession(vaultId);

  // Try BW if session exists
  let bwError: Error | null = null;
  if (session) {
    try {
      const item = await getItemByName(session, resolvedItem);

      return buildFieldsObject(item);
    } catch (error) {
      if (error instanceof SecretError) throw error;

      // Store error for snapshot fallback
      bwError = error instanceof Error ? error : new Error(String(error));
    }
  }

  // No session OR BW failed - try snapshot fallback
  const snapshotItem = await snapshotManager.getItem(resolvedItem);
  if (snapshotItem) {
    try {
      // Log warning about snapshot source
      const meta = await snapshotManager.getMetadata();
      if (meta) {
        const ageMs = Date.now() - new Date(meta.createdAt).getTime();
        if (ageMs > Constants.SNAPSHOT_STALE_AGE_MS) {
          console.error(`[snapshot] WARNING: serving stale data for "${itemName}" (age: ${Math.round(ageMs / 60000)}min)`);
        } else if (ageMs > Constants.SNAPSHOT_WARN_AGE_MS) {
          console.error(`[snapshot] INFO: serving from snapshot for "${itemName}" (age: ${Math.round(ageMs / 60000)}min)`);
        }
      }

      return buildFieldsObject(snapshotItem);
    } catch (snapshotError) {
      // Fall through to throw error
    }
  }

  // Both BW and snapshot failed - throw appropriate error
  if (!session) {
    throw new SecretError(
      `No session for vault: ${vaultId}. Run: bw unlock`,
      ErrorCode.VAULT_LOCKED
    );
  }

  // Had session but BW failed
  const message = bwError ? bwError.message : '';
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
    bwError || undefined
  );
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

  // Try BW if session exists
  let bwError: Error | null = null;
  if (session) {
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

      // Store error for snapshot fallback
      bwError = error instanceof Error ? error : new Error(String(error));
    }
  }

  // No session OR BW failed - try snapshot fallback
  try {
    let names = await snapshotManager.listItems();

    // Apply filter if provided
    if (filter) {
      const lowerFilter = filter.toLowerCase();
      names = names.filter((name: string) =>
        name.toLowerCase().includes(lowerFilter)
      );
    }

    // Log warning about snapshot source
    const meta = await snapshotManager.getMetadata();
    if (meta) {
      const ageMs = Date.now() - new Date(meta.createdAt).getTime();
      if (ageMs > Constants.SNAPSHOT_STALE_AGE_MS) {
        console.error(`[snapshot] WARNING: serving stale list (age: ${Math.round(ageMs / 60000)}min)`);
      } else if (ageMs > Constants.SNAPSHOT_WARN_AGE_MS) {
        console.error(`[snapshot] INFO: serving list from snapshot (age: ${Math.round(ageMs / 60000)}min)`);
      }
    }

    return names.sort();
  } catch (snapshotError) {
    // Fall through to throw error
  }

  // Both BW and snapshot failed - throw appropriate error
  if (!session) {
    throw new SecretError(
      `No session for vault: ${vaultId}. Run: bw unlock`,
      ErrorCode.VAULT_LOCKED
    );
  }

  // Had session but BW failed
  const message = bwError ? bwError.message : '';
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
    bwError || undefined
  );
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
  // Store session in Keychain
  await setVaultSession(vaultId, token);

  // Also register vault in config if not already there
  const existingVault = await vaultManager.getVault(vaultId);
  if (!existingVault) {
    await vaultManager.setVault(vaultId, {
      name: vaultId,
      path: '',  // Not used for BW sessions
      keychainItem: `session-${vaultId}`,
    });
    // Set as default if it's the first vault
    const vaults = await vaultManager.listVaults();
    if (vaults.length === 1) {
      await vaultManager.switchVault(vaultId);
    }
  }
}

/**
 * List all configured vaults
 *
 * @returns Promise resolving to array of vault configurations
 *
 * @example
 * const vaults = await listVaults();
 * for (const vault of vaults) {
 *   console.log(`${vault.name}: ${vault.description}`);
 * }
 */
export async function listVaults() {
  return vaultManager.listVaults();
}

/**
 * Get default folder prefix
 *
 * @returns Promise resolving to folder prefix or empty string
 *
 * @example
 * const folder = await getFolder();
 * console.log(`Current folder: ${folder || '(none)'}`);
 */
export async function getFolder(): Promise<string> {
  return vaultManager.getFolder();
}

/**
 * Set default folder prefix
 *
 * When set, all secret lookups without explicit folder (no '/') will
 * use this prefix. e.g., getSecret('postgres') becomes getSecret('folder/postgres')
 *
 * @param folder - Folder path (e.g., "Projects/myapp")
 *
 * @example
 * await setFolder('Projects/myapp');
 * await getSecret('postgres'); // looks up "Projects/myapp/postgres"
 */
export async function setFolder(folder: string): Promise<void> {
  await vaultManager.setFolder(folder);
}

/**
 * Clear default folder prefix
 *
 * After clearing, all lookups use the exact path provided.
 *
 * @example
 * await clearFolder();
 * await getSecret('postgres'); // looks up "postgres" directly
 */
export async function clearFolder(): Promise<void> {
  await vaultManager.clearFolder();
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