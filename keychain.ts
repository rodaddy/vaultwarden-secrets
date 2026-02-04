/**
 * macOS Keychain integration for secure storage
 *
 * Provides a type-safe interface to macOS Keychain using the `security` CLI.
 * Stores:
 * 1. Master encryption key for vault encryption (AES-256)
 * 2. BW_SESSION tokens per vault for Bitwarden CLI
 *
 * @module keychain
 */

import { $ } from 'bun';
import { SecretError, ErrorCode } from './types';

const SERVICE_PREFIX = 'pai-secrets';

/**
 * Store a value in macOS Keychain
 *
 * Uses `security add-generic-password` with -U flag to update if exists.
 *
 * @param account - Keychain account identifier (e.g., 'master-key', 'session-work')
 * @param value - Secret value to store
 * @param service - Keychain service name (default: 'pai-secrets')
 * @throws {SecretError} If keychain command fails
 *
 * @example
 * await keychainSet('master-key', masterKeyHex);
 * await keychainSet('session-work', bwSessionToken);
 */
export async function keychainSet(
  account: string,
  value: string,
  service: string = SERVICE_PREFIX
): Promise<void> {
  try {
    // -U: Update item if it already exists
    // -a: Account name
    // -s: Service name
    // -w: Password (the value we're storing)
    await $`security add-generic-password -a ${account} -s ${service} -w ${value} -U`.quiet();
  } catch (error) {
    throw new SecretError(
      `Failed to store value in Keychain for account '${account}'`,
      ErrorCode.KEYCHAIN_COMMAND_FAILED,
      false,
      error as Error
    );
  }
}

/**
 * Get a value from macOS Keychain
 *
 * Uses `security find-generic-password` to retrieve stored value.
 *
 * @param account - Keychain account identifier
 * @param service - Keychain service name (default: 'pai-secrets')
 * @returns Secret value, or null if not found
 * @throws {SecretError} If keychain command fails (non-44 exit code)
 *
 * @example
 * const masterKey = await keychainGet('master-key');
 * if (!masterKey) {
 *   // Generate new master key
 * }
 */
export async function keychainGet(
  account: string,
  service: string = SERVICE_PREFIX
): Promise<string | null> {
  try {
    // -a: Account name
    // -s: Service name
    // -w: Output only the password (no metadata)
    const result = await $`security find-generic-password -a ${account} -s ${service} -w`.text();
    return result.trim();
  } catch (error: any) {
    // Exit code 44: Item not found in keychain
    if (error.exitCode === 44) {
      return null;
    }

    // Exit code 51: Access denied (user clicked "Deny")
    if (error.exitCode === 51) {
      throw new SecretError(
        `Access denied to Keychain item '${account}' (user denied permission)`,
        ErrorCode.KEYCHAIN_ACCESS_DENIED,
        false,
        error as Error
      );
    }

    // Other errors are unexpected
    throw new SecretError(
      `Failed to retrieve value from Keychain for account '${account}'`,
      ErrorCode.KEYCHAIN_COMMAND_FAILED,
      false,
      error as Error
    );
  }
}

/**
 * Delete a value from macOS Keychain
 *
 * Uses `security delete-generic-password` to remove stored value.
 *
 * @param account - Keychain account identifier
 * @param service - Keychain service name (default: 'pai-secrets')
 * @returns true if deleted, false if not found
 * @throws {SecretError} If keychain command fails (non-44 exit code)
 *
 * @example
 * const deleted = await keychainDelete('session-work');
 * if (deleted) {
 *   console.log('Session token removed');
 * }
 */
export async function keychainDelete(
  account: string,
  service: string = SERVICE_PREFIX
): Promise<boolean> {
  try {
    // -a: Account name
    // -s: Service name
    await $`security delete-generic-password -a ${account} -s ${service}`.quiet();
    return true;
  } catch (error: any) {
    // Exit code 44: Item not found (not an error, just doesn't exist)
    if (error.exitCode === 44) {
      return false;
    }

    // Other errors are unexpected
    throw new SecretError(
      `Failed to delete value from Keychain for account '${account}'`,
      ErrorCode.KEYCHAIN_COMMAND_FAILED,
      false,
      error as Error
    );
  }
}

/**
 * Get or create master encryption key
 *
 * Master key is used to encrypt/decrypt vault files using AES-256-GCM.
 * If not found in Keychain, generates a new 32-byte (256-bit) random key.
 *
 * @returns Master key as Buffer (32 bytes)
 * @throws {SecretError} If keychain operations fail
 *
 * @example
 * const masterKey = await getMasterKey();
 * // Use masterKey for AES-256-GCM encryption
 */
export async function getMasterKey(): Promise<Buffer> {
  const account = 'master-key';

  // Try to get existing key from Keychain
  const existingKey = await keychainGet(account);
  if (existingKey) {
    // Stored as hex string, convert back to Buffer
    return Buffer.from(existingKey, 'hex');
  }

  // Generate new 32-byte (256-bit) random key for AES-256
  const newKey = Buffer.allocUnsafe(32);
  crypto.getRandomValues(newKey);

  // Store in Keychain as hex string for safe storage
  const keyHex = newKey.toString('hex');
  await keychainSet(account, keyHex);

  return newKey;
}

/**
 * Get BW session token for a vault
 *
 * Retrieves the BW_SESSION environment variable value for Bitwarden CLI.
 *
 * @param vaultId - Vault identifier (e.g., 'default', 'work')
 * @returns Session token, or null if not found
 * @throws {SecretError} If keychain operations fail
 *
 * @example
 * const session = await getVaultSession('work');
 * if (session) {
 *   process.env.BW_SESSION = session;
 * } else {
 *   // Need to unlock vault
 * }
 */
export async function getVaultSession(vaultId: string): Promise<string | null> {
  return keychainGet(`session-${vaultId}`);
}

/**
 * Store BW session token for a vault
 *
 * Saves the BW_SESSION token to Keychain for later retrieval.
 *
 * @param vaultId - Vault identifier (e.g., 'default', 'work')
 * @param token - BW_SESSION token from `bw unlock`
 * @throws {SecretError} If keychain operations fail
 *
 * @example
 * const session = await unlockVault('work');
 * await setVaultSession('work', session);
 */
export async function setVaultSession(vaultId: string, token: string): Promise<void> {
  await keychainSet(`session-${vaultId}`, token);
}

/**
 * Delete BW session for a vault
 *
 * Removes the BW_SESSION token from Keychain (called on lock/logout).
 *
 * @param vaultId - Vault identifier (e.g., 'default', 'work')
 * @returns true if deleted, false if not found
 * @throws {SecretError} If keychain operations fail
 *
 * @example
 * await deleteVaultSession('work');
 * // Vault is now locked, user must unlock again
 */
export async function deleteVaultSession(vaultId: string): Promise<boolean> {
  return keychainDelete(`session-${vaultId}`);
}
