/**
 * TypeScript types and interfaces for secrets management library
 *
 * Provides type-safe interfaces for macOS Keychain integration,
 * encrypted vault storage, and in-memory caching with TTL.
 *
 * @module types
 */

// ============================================================================
// Error Handling
// ============================================================================

/**
 * Error codes for secret operations
 */
export enum ErrorCode {
  // Keychain errors
  KEYCHAIN_NOT_FOUND = 'KEYCHAIN_NOT_FOUND',
  KEYCHAIN_ACCESS_DENIED = 'KEYCHAIN_ACCESS_DENIED',
  KEYCHAIN_COMMAND_FAILED = 'KEYCHAIN_COMMAND_FAILED',

  // Vault errors
  VAULT_NOT_FOUND = 'VAULT_NOT_FOUND',
  VAULT_LOCKED = 'VAULT_LOCKED',
  VAULT_CORRUPTED = 'VAULT_CORRUPTED',
  VAULT_INVALID_FORMAT = 'VAULT_INVALID_FORMAT',

  // Encryption errors
  ENCRYPTION_FAILED = 'ENCRYPTION_FAILED',
  DECRYPTION_FAILED = 'DECRYPTION_FAILED',
  INVALID_KEY = 'INVALID_KEY',

  // Path/validation errors
  INVALID_PATH = 'INVALID_PATH',
  INVALID_CATEGORY = 'INVALID_CATEGORY',
  SECRET_NOT_FOUND = 'SECRET_NOT_FOUND',

  // General errors
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
  CACHE_ERROR = 'CACHE_ERROR',
  FILE_SYSTEM_ERROR = 'FILE_SYSTEM_ERROR',
}

/**
 * Custom error class for secret operations
 *
 * @example
 * throw new SecretError(
 *   'Secret not found in vault',
 *   ErrorCode.SECRET_NOT_FOUND,
 *   false
 * );
 */
export class SecretError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly retryable: boolean = false,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'SecretError';
  }
}

// ============================================================================
// Secret Categories
// ============================================================================

/**
 * Categories of secrets for TTL and access patterns
 */
export type SecretCategory =
  | 'api_key'      // External API keys (Claude, Gemini, GitHub)
  | 'password'     // User passwords, app passwords
  | 'token'        // Auth tokens, session tokens
  | 'certificate'  // SSL certs, signing certs
  | 'database'     // Database credentials
  | 'other';       // Uncategorized secrets

// ============================================================================
// Encrypted Data Structures
// ============================================================================

/**
 * AES-256-GCM encrypted data structure
 *
 * @example
 * {
 *   "iv": "base64-encoded-iv",
 *   "authTag": "base64-encoded-tag",
 *   "encryptedData": "base64-encoded-ciphertext"
 * }
 */
export interface EncryptedData {
  /** Initialization vector (base64) */
  iv: string;

  /** Authentication tag for GCM mode (base64) */
  authTag: string;

  /** Encrypted payload (base64) */
  encryptedData: string;
}

// ============================================================================
// Cache Structures
// ============================================================================

/**
 * Cache entry with TTL and access tracking
 */
export interface CacheEntry {
  /** Encrypted secret value (AES-256-GCM) */
  value: EncryptedData;

  /** Timestamp when entry expires (ms since epoch) */
  expiresAt: number;

  /** Timestamp of last access (ms since epoch) */
  lastAccessed: number;

  /** Number of times accessed */
  accessCount: number;

  /** Secret category for TTL management */
  category: SecretCategory;
}

/**
 * Cache statistics for monitoring
 */
export interface CacheStats {
  /** Total number of cache hits */
  hits: number;

  /** Total number of cache misses */
  misses: number;

  /** Current number of cached entries */
  entries: number;

  /** Current number of cached entries */
  size: number;

  /** Maximum cache size */
  maxSize: number;

  /** Number of entries evicted due to size limit */
  evictions: number;

  /** Number of entries expired due to TTL */
  expirations: number;

  /** Cache hit rate (0-1) */
  hitRate: number;

  /** Oldest entry expiration time (ms since epoch) */
  oldestEntry?: number;

  /** Newest entry expiration time (ms since epoch) */
  newestEntry?: number;

  /** List of vault IDs in cache */
  vaults: string[];
}

// ============================================================================
// Vault Configuration
// ============================================================================

/**
 * Vault configuration for a single vault
 */
export interface VaultConfig {
  /** Vault name (e.g., 'default', 'work') */
  name: string;

  /** Absolute path to vault file */
  path: string;

  /** Keychain item name for vault master password */
  keychainItem: string;

  /** Description of vault purpose */
  description?: string;

  /** Whether this is the default vault */
  default?: boolean;
}

/**
 * Full vault configuration file structure
 *
 * Located at: ~/.config/vaultwarden-secrets/config.json
 */
export interface VaultConfigFile {
  /** Map of vault name to vault config */
  vaults: Record<string, VaultConfig>;

  /** Default vault name (if not specified in config entries) */
  defaultVault?: string;

  /** Configuration version for migrations */
  version: string;
}

// ============================================================================
// Keychain Options
// ============================================================================

/**
 * Options for macOS Keychain operations
 */
export interface KeychainOptions {
  /** Keychain service name (default: 'pai-secrets') */
  service?: string;

  /** Keychain account name (default: process.env.USER) */
  account?: string;

  /** Keychain access group for app-specific keychain */
  accessGroup?: string;

  /** Whether to use iCloud Keychain sync */
  useICloud?: boolean;
}

// ============================================================================
// Secret Access Options
// ============================================================================

/**
 * Parsed secret path "Item.field"
 */
export interface ParsedSecretPath {
  /** Vault name (if specified as "vault:Item.field") */
  vault?: string;

  /** Item name (e.g., "github-pat") */
  item: string;

  /** Field name (e.g., "token", "username") */
  field: string;
}

/**
 * Options for getSecret() function
 *
 * @example
 * await getSecret('github-pat.token', {
 *   vault: 'work',
 *   category: 'api_key',
 *   ttl: 3600,
 *   required: true
 * });
 */
export interface SecretOptions {
  /** Vault name (default: 'default') */
  vault?: string;

  /** Secret category for TTL (default: 'other') */
  category?: SecretCategory;

  /** Custom TTL in seconds (overrides category default) */
  ttl?: number;

  /** Throw error if secret not found (default: true) */
  required?: boolean;

  /** Skip cache and always fetch fresh (default: false) */
  skipCache?: boolean;

  /** Additional metadata for audit logging */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Default TTLs by secret category (in seconds)
 */
export const DEFAULT_TTLS: Record<SecretCategory, number> = {
  api_key: 3600,      // 1 hour (external APIs, moderate change rate)
  password: 1800,     // 30 minutes (sensitive, shorter cache)
  token: 900,         // 15 minutes (session tokens, frequent rotation)
  certificate: 86400, // 24 hours (rarely change)
  database: 3600,     // 1 hour (connection strings, moderate)
  other: 1800,        // 30 minutes (default conservative)
};

/**
 * Get the configuration directory for vaultwarden-secrets.
 *
 * Detection order (deepest first):
 * 1. VAULTWARDEN_SECRETS_DIR env var (explicit override)
 * 2. ~/.config/pai-private/vaultwarden-secrets/ (PAI private - highest auto priority)
 * 3. ~/.config/pai/vaultwarden-secrets/ (PAI public)
 * 4. ~/.config/vaultwarden-secrets/ (standalone default)
 *
 * @example
 * // Default: ~/.config/vaultwarden-secrets
 * const dir = getConfigDir();
 *
 * @example
 * // PAI integration: auto-detects ~/.config/pai-private/vaultwarden-secrets
 * const dir = getConfigDir();
 *
 * @example
 * // Explicit override via env var
 * process.env.VAULTWARDEN_SECRETS_DIR = '~/.config/custom-dir';
 * const dir = getConfigDir(); // Returns ~/.config/custom-dir
 *
 * @returns Absolute path to config directory
 */
export function getConfigDir(): string {
  const { existsSync } = require('node:fs');
  const { homedir } = require('node:os');
  const { join } = require('node:path');

  // 1. Explicit override via env var
  const customDir = process.env.VAULTWARDEN_SECRETS_DIR;
  if (customDir) {
    // Expand ~ to home directory if present
    return customDir.replace(/^~/, homedir());
  }

  const home = homedir();

  // 2. Check PAI private directory (highest auto priority)
  const paiPrivate = join(home, '.config/pai-private/vaultwarden-secrets');
  if (existsSync(paiPrivate)) {
    return paiPrivate;
  }

  // 3. Check PAI public directory
  const paiPublic = join(home, '.config/pai/vaultwarden-secrets');
  if (existsSync(paiPublic)) {
    return paiPublic;
  }

  // 4. Default for standalone users
  return join(home, '.config/vaultwarden-secrets');
}

/**
 * System constants for secrets management
 */
export const Constants = {
  /** Maximum cache entries before LRU eviction */
  CACHE_MAX_SIZE: 100,

  /** PBKDF2 iterations for vault master key derivation */
  PBKDF2_ITERATIONS: 100000,

  /** AES key length in bits */
  AES_KEY_LENGTH: 256,

  /** Salt length for PBKDF2 in bytes */
  SALT_LENGTH: 32,

  /** IV length for AES-GCM in bytes */
  IV_LENGTH: 12,

  /** Auth tag length for AES-GCM in bytes */
  AUTH_TAG_LENGTH: 16,

  /** Default keychain service name */
  DEFAULT_KEYCHAIN_SERVICE: 'vaultwarden-secrets',

  /** Default vault name */
  DEFAULT_VAULT_NAME: 'default',

  /** Configuration directory (can be overridden via VAULTWARDEN_SECRETS_DIR env var) */
  get CONFIG_DIR() { return getConfigDir(); },

  /** Config file path */
  get CONFIG_PATH() { return require('node:path').join(getConfigDir(), 'config.json'); },

  /** Cache file path */
  get CACHE_PATH() { return require('node:path').join(getConfigDir(), 'cache.json'); },

  /** Default vaults directory */
  get VAULTS_DIR() { return require('node:path').join(getConfigDir(), 'vaults'); },
} as const;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for SecretCategory
 */
export function isSecretCategory(value: unknown): value is SecretCategory {
  return typeof value === 'string' && [
    'api_key',
    'password',
    'token',
    'certificate',
    'database',
    'other',
  ].includes(value);
}

/**
 * Type guard for EncryptedData
 */
export function isEncryptedData(value: unknown): value is EncryptedData {
  return (
    typeof value === 'object' &&
    value !== null &&
    'iv' in value &&
    'authTag' in value &&
    'encryptedData' in value &&
    typeof (value as EncryptedData).iv === 'string' &&
    typeof (value as EncryptedData).authTag === 'string' &&
    typeof (value as EncryptedData).encryptedData === 'string'
  );
}

/**
 * Type guard for VaultConfig
 */
export function isVaultConfig(value: unknown): value is VaultConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    'path' in value &&
    'keychainItem' in value &&
    typeof (value as VaultConfig).name === 'string' &&
    typeof (value as VaultConfig).path === 'string' &&
    typeof (value as VaultConfig).keychainItem === 'string'
  );
}
