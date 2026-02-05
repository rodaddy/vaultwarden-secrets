# vaultwarden-secrets

Secure secrets management library with Vaultwarden/Bitwarden CLI integration, encrypted caching, and macOS Keychain storage.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.0+-orange.svg)](https://bun.sh/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## Features

- **Zero Plaintext Storage** – Master encryption key stored in macOS Keychain, cache encrypted with AES-256-GCM
- **Fast Retrieval** – Sub-100ms cached secret access with configurable TTL-based expiration
- **Multi-Vault Support** – Switch between personal, work, and project vaults at runtime
- **Type-Safe API** – Full TypeScript support with comprehensive error handling
- **Integrity Verification** – HMAC-SHA256 protection against cache tampering
- **LRU Eviction** – Automatic memory management with configurable cache size limits
- **Category-Based TTL** – Different expiration times for API keys, passwords, tokens, and certificates

## Prerequisites

- **macOS** (Keychain is required for master key storage)
- **Bun** ≥ 1.0.0 ([install](https://bun.sh/))
- **Vaultwarden/Bitwarden CLI** – `bw` command installed and configured

```bash
# Install Bitwarden CLI
brew install bitwarden-cli

# Initialize Bitwarden (create account/login)
bw login
```

## Installation

### Quick Install

```bash
# Clone the repository
git clone https://github.com/yourusername/vaultwarden-secrets.git
cd vaultwarden-secrets

# Install dependencies
bun install

# Set up configuration directory
bun run install-config
```

### PAI Users

If you're using this with PAI (Personal AI) framework:

```bash
# Install to PAI private directory
bun run install-pai
```

This automatically detects and uses `~/.config/pai-private/vaultwarden-secrets/` for all configuration.

### Installation Options

```bash
# Preview what would be installed (dry-run)
bun run install-config --dry-run

# Install to custom directory
bun run install.ts --path ~/.my-secrets

# Uninstall
bun run uninstall
```

### From npm (when published)

```bash
bun add vaultwarden-secrets
```

### Development/Local

```bash
# Clone the repository
git clone https://github.com/yourusername/vaultwarden-secrets.git
cd vaultwarden-secrets

# Install dependencies and set up config
bun install
bun run install-config

# Link for local development
bun link
bun link vaultwarden-secrets
```

## Quick Start

### 1. Unlock Your Vault

Before using the library, unlock the Bitwarden CLI:

```bash
bw unlock
# Follow prompts and copy the BW_SESSION token
```

### 2. Store Session in Keychain

```typescript
import { setSession } from 'vaultwarden-secrets';

// After bw unlock, copy the BW_SESSION token
await setSession('default', 'eyJleHAiOjE2NzcwODEyNDYsImFsZyI6IkhTMjU2In0...');
```

### 3. Get Secrets

```typescript
import { getSecret, getSecretObject } from 'vaultwarden-secrets';

// Get a password field (default)
const password = await getSecret('github-pat');

// Get a specific field
const username = await getSecret('github-pat.login.username');

// Get a custom field
const apiKey = await getSecret('github-pat.fields.API_KEY');

// Get all fields as an object
const allFields = await getSecretObject('github-pat');
// Returns: { username: '...', password: '...', uri: '...', API_KEY: '...' }
```

## CLI Reference

The `secret` command provides muscle-memory-friendly access to your secrets.

### Installation

```bash
# Install globally
bun link

# Add shell integration to ~/.zshrc
source ~/.config/pai/lib/secrets/shell/secret.sh
```

### Daily Commands

| Command | Description | Example |
|---------|-------------|---------|
| `secret <path>` | Get secret (shorthand) | `secret github-pat` |
| `secret get <path>` | Get secret to stdout | `secret get "API Keys.OPENAI"` |
| `secret copy <path>` | Copy to clipboard | `secret copy github-pat` |
| `secret paste <path>` | Set from clipboard | `secret paste myapp.password` |
| `secret set <path> [value]` | Set secret (prompts if no value) | `secret set myapp.token` |

### Discovery Commands

| Command | Description | Example |
|---------|-------------|---------|
| `secret list [filter]` | List secrets | `secret list github` |
| `secret search <query>` | Fuzzy search | `secret search postgres` |
| `secret show <item>` | Show all fields (tree view) | `secret show "PostgreSQL"` |

### Vault Management

| Command | Description |
|---------|-------------|
| `secret vault list` | List available vaults |
| `secret vault use <name>` | Switch active vault |
| `secret vault current` | Show current vault |

### Folder Prefix

Organize secrets by project with folder prefixes:

```bash
# Set folder prefix
secret folder myproject
# Now "secret get API_KEY" looks up "myproject/API_KEY"

# Show current folder
secret folder
# Output: myproject

# Clear folder prefix
secret folder clear
```

### Cache Management

| Command | Description |
|---------|-------------|
| `secret cache clear` | Clear all cached secrets |
| `secret cache stats` | Show hit/miss statistics |
| `secret cache refresh` | Force refresh from VW |

### System Commands

| Command | Description |
|---------|-------------|
| `secret health` | Check bw CLI, session, connectivity |
| `secret set-session <vault> <token>` | Store BW_SESSION in Keychain |
| `secret version` | Show version |
| `secret help` | Show help |

### Path Syntax

```bash
# Default: password field
secret get github-pat

# Specific field
secret get github-pat.login.username

# Notes field (common for API keys)
secret get "OpenAI API Key.notes"

# Custom field
secret get github-pat.fields.WEBHOOK_SECRET
```

## Shell Integration

Add to `~/.zshrc` or `~/.bashrc`:

```bash
source ~/.config/pai/lib/secrets/shell/secret.sh
```

### Muscle Memory Aliases

| Alias | Expands To | Purpose |
|-------|------------|---------|
| `sg` | `secret get` | Get secret |
| `sc` | `secret copy` | Copy to clipboard |
| `ss` | `secret set` | Set secret |
| `sl` | `secret list` | List secrets |
| `sv` | `secret vault` | Vault commands |
| `sth` | `secret health` | Health check |

### Shell Functions

```bash
# Export secret to environment variable
se "github-pat.fields.TOKEN" GITHUB_TOKEN
# Exports GITHUB_TOKEN=<secret value>

# Interactive picker (requires fzf)
sp        # Pick and get
sp copy   # Pick and copy to clipboard
```

### Tab Completion

Tab completion is automatic for both bash and zsh after sourcing the shell file.

## Migration Wizard

Migrate secrets from `.env` files, shell configs, and scripts to Vaultwarden.

### Basic Usage

```bash
# Scan current directory
secret migrate

# Scan specific paths
secret migrate ~/.env ~/Development

# Scan with depth limit
secret migrate ~/projects --depth 2
```

### What It Scans

- `.env`, `.env.local`, `.env.production` files
- `.zshrc`, `.bashrc`, `.profile` configs
- `*.sh` shell scripts
- `*.json`, `*.yaml`, `*.yml`, `*.toml` configs

### Detection Confidence

| Level | Action | Examples |
|-------|--------|----------|
| **High** | Auto-confirmed | `API_KEY`, `SECRET`, `TOKEN`, `PASSWORD` |
| **Medium** | Prompted | `KEY`, `PASS`, `CRED`, `PRIV` |
| **Low** | Skipped in auto mode | `URL`, `HOST`, `USER`, `DATABASE` |

### Duplicate Handling

When the same variable appears multiple times with different values:

```
⚠️  Same-name secrets with different values found:
  Using last value (shell semantics). All values shown newest-first:

  OPENAI_API_KEY:
    → sk-new-key (line 45) (will use)
      sk-old-key (line 12)
```

The **last value wins** (matches shell behavior).

### Migration Output

The wizard generates:

1. **New file versions** with `$(secret get ...)` calls
2. **VW import script** for batch creation
3. **Cleanup summary** showing what can be removed

### Output Locations

```
1. Side-by-side (.env → .env.migrated)
2. Output folder (~/.config/pai/migrations/<date>/)
3. In-place (backup original, replace with new)
```

### Dry Run

```bash
# Preview without making changes
secret migrate ~/.env --dry-run
```

## API Reference

### `getSecret(path, options?)`

Retrieve a single secret value from Vaultwarden with caching.

```typescript
async function getSecret(
  path: string,
  options?: SecretOptions
): Promise<string>
```

**Parameters:**

- `path` (string) – Secret path in format:
  - `ItemName` – Return password field (default)
  - `ItemName.login.username` – Get nested field
  - `ItemName.fields.CUSTOM_FIELD` – Get custom field

- `options` (optional):
  - `vault` (string) – Vault ID (default: active vault)
  - `category` (SecretCategory) – Category for TTL (`api_key`, `password`, `token`, `certificate`, `database`, `other`)
  - `ttl` (number) – Custom TTL in seconds (overrides category default)
  - `skipCache` (boolean) – Fetch fresh value, skip cache (default: false)
  - `required` (boolean) – Throw error if not found (default: true)
  - `metadata` (object) – Additional audit logging data

**Returns:** Promise<string>

**Throws:** `SecretError` if vault is locked or secret not found

**Examples:**

```typescript
// Get default password field
const password = await getSecret('github-pat');

// Get specific nested field
const username = await getSecret('github-pat.login.username');

// Get custom field
const apiKey = await getSecret('github-pat.fields.API_KEY');

// Skip cache for fresh value
const fresh = await getSecret('github-pat', { skipCache: true });

// Use specific vault and category
const token = await getSecret('work-token', {
  vault: 'work',
  category: 'token',
  ttl: 3600
});

// Get without caching (sensitive data)
const sensitive = await getSecret('master-password', {
  skipCache: true,
  metadata: { reason: 'admin-access' }
});
```

### `getSecretObject(itemName, options?)`

Retrieve all fields from a Vaultwarden item as a single object.

```typescript
async function getSecretObject(
  itemName: string,
  options?: SecretOptions
): Promise<Record<string, string>>
```

**Returns:** Promise containing:
- `username` – Login username
- `password` – Login password
- `uri` – First URI associated with item
- `notes` – Item notes
- `[customFieldName]` – All custom fields by name

**Example:**

```typescript
const secrets = await getSecretObject('github-pat');
console.log(secrets);
// {
//   username: 'my-github-user',
//   password: 'ghp_xxxxxxxxxxxx',
//   uri: 'https://github.com',
//   notes: 'Primary PAT for CI/CD',
//   API_KEY: 'sk_test_...',
//   WEBHOOK_SECRET: 'whsec_...'
// }
```

### `listSecrets(filter?, options?)`

List available secrets from Vaultwarden with optional filtering.

```typescript
async function listSecrets(
  filter?: string,
  options?: SecretOptions
): Promise<string[]>
```

**Parameters:**

- `filter` (optional) – Filter items by name (case-insensitive partial match)
- `options` (optional) – `vault` to query specific vault

**Returns:** Sorted array of item names

**Examples:**

```typescript
// List all secrets
const allSecrets = await listSecrets();

// Filter secrets
const githubSecrets = await listSecrets('github');
// Returns: ['github-pat', 'github-ssh-key']

// List from specific vault
const workSecrets = await listSecrets(undefined, { vault: 'work' });
```

### `switchVault(vaultId)`

Switch the active vault for subsequent operations.

```typescript
async function switchVault(vaultId: string): Promise<void>
```

**Example:**

```typescript
// Switch to work vault
await switchVault('work');

// Now getSecret() uses 'work' vault by default
const workToken = await getSecret('api-token');

// Can still override per-call
const personalSecret = await getSecret('personal-key', { vault: 'default' });
```

### `getActiveVault()`

Get the currently active vault ID.

```typescript
async function getActiveVault(): Promise<string>
```

**Example:**

```typescript
const active = await getActiveVault();
console.log(`Using vault: ${active}`);
```

### `setSession(vaultId, token)`

Store a Bitwarden session token in Keychain after `bw unlock`.

```typescript
async function setSession(vaultId: string, token: string): Promise<void>
```

**Example:**

```typescript
// After running: bw unlock
// Copy the BW_SESSION value and store it:
await setSession('default', 'eyJleHAiOjE2NzcwODEyNDYsImFsZyI6IkhTMjU2In0...');
```

### `clearCache(vaultId?)`

Clear the encrypted cache to force fresh secrets on next access.

```typescript
async function clearCache(vaultId?: string): Promise<void>
```

**Example:**

```typescript
// Clear all cached secrets
await clearCache();

// Clear only work vault cache
await clearCache('work');
```

### `getCacheStats()`

Get cache performance metrics and statistics.

```typescript
function getCacheStats(): CacheStats
```

**Returns:** Object containing:
- `hits` – Total cache hits
- `misses` – Total cache misses
- `hitRate` – Hit rate (0–1)
- `entries` – Current cached entries
- `size` – Cache size in bytes
- `maxSize` – Maximum cache size
- `evictions` – Entries evicted due to size limit
- `expirations` – Entries expired due to TTL
- `vaults` – List of vault IDs in cache
- `oldestEntry` – Oldest expiration time (ms)
- `newestEntry` – Newest expiration time (ms)

**Example:**

```typescript
const stats = getCacheStats();
console.log(`Cache hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);
console.log(`Cached entries: ${stats.entries}`);
console.log(`Active vaults: ${stats.vaults.join(', ')}`);
```

## Error Handling

All functions throw `SecretError` with specific error codes:

```typescript
import { getSecret, SecretError, ErrorCode } from 'vaultwarden-secrets';

try {
  const secret = await getSecret('my-secret');
} catch (error) {
  if (error instanceof SecretError) {
    switch (error.code) {
      case ErrorCode.VAULT_LOCKED:
        console.error('Vault locked. Run: bw unlock');
        break;
      case ErrorCode.SECRET_NOT_FOUND:
        console.error('Secret not found in vault');
        break;
      case ErrorCode.KEYCHAIN_ACCESS_DENIED:
        console.error('No permission to access Keychain');
        break;
      case ErrorCode.ENCRYPTION_FAILED:
        console.error('Cache encryption failed');
        break;
      default:
        console.error('Unknown error:', error.message);
    }

    // Check if error is retryable
    if (error.retryable) {
      console.log('You can retry this operation');
    }
  }
}
```

**Error Codes:**

| Code | Meaning | Retryable |
|------|---------|-----------|
| `VAULT_LOCKED` | Vault needs `bw unlock` | Yes |
| `SECRET_NOT_FOUND` | Item or field doesn't exist | No |
| `VAULT_CORRUPTED` | Vault sync/config issue | Yes |
| `KEYCHAIN_NOT_FOUND` | Session not stored in Keychain | No |
| `KEYCHAIN_ACCESS_DENIED` | Permission denied on Keychain | No |
| `ENCRYPTION_FAILED` | AES-256-GCM encryption error | No |
| `DECRYPTION_FAILED` | Cache decryption failed (tampering?) | No |
| `INVALID_PATH` | Malformed secret path | No |
| `INVALID_CATEGORY` | Unknown secret category | No |
| `CACHE_ERROR` | Cache read/write error | Yes |
| `FILE_SYSTEM_ERROR` | Filesystem operation failed | Yes |

## Security Model

### Master Key Storage

- Stored in **macOS Keychain** (locked at system level)
- Never written to disk in plaintext
- Keychain service: `vaultwarden-secrets`
- Accessible only to authenticated user

### Cache Encryption

- Cache file: `{VAULTWARDEN_SECRETS_DIR}/cache.json`
- Default: `~/.config/vaultwarden-secrets/cache.json`
- **AES-256-GCM** encryption (256-bit key)
- **HMAC-SHA256** integrity verification
- Each entry encrypted separately with unique IV
- Automatic HMAC verification on load (detects tampering)

### Session Tokens

- BW_SESSION tokens stored in Keychain per vault
- Tokens expire after vault lock or session timeout
- Run `bw unlock` to refresh token

### Data Flow

```
┌─────────────────────────────────────────┐
│  Application Request                     │
│  getSecret('item.field')                 │
└─────────────────┬───────────────────────┘
                  │
        ┌─────────▼──────────┐
        │  Check Cache       │ ◄─── Encrypted file + HMAC
        │ (AES-256-GCM)      │     verification
        └────────┬──────────┘
                  │
         ┌────────▼─────────────────┐
         │  Cache Miss?             │
         │  Fetch from Keychain     │
         │  session token           │
         └────────┬────────────────┘
                  │
        ┌─────────▼──────────────────┐
        │  bw CLI (encrypted vault)  │
        │  BW_SESSION=${token}       │
        │  bw get item Item          │
        └────────┬───────────────────┘
                 │
        ┌────────▼──────────┐
        │  Encrypt + Cache  │ ──► {VAULTWARDEN_SECRETS_DIR}/cache.json
        │  Return Secret    │     (HMAC signed)
        └────────┬──────────┘
                 │
    ┌────────────▼────────────┐
    │  Application (plaintext │
    │  only in memory)        │
    └─────────────────────────┘
```

### TTL by Category

| Category | Default TTL | Use Case |
|----------|-------------|----------|
| `api_key` | 1 hour | External API keys, moderate change rate |
| `password` | 30 minutes | User passwords, sensitive data |
| `token` | 15 minutes | Session tokens, frequent rotation |
| `certificate` | 24 hours | SSL certs, rarely change |
| `database` | 1 hour | DB credentials, moderate change |
| `other` | 30 minutes | Uncategorized (conservative default) |

## Configuration

### Configuration Directory

The library automatically detects the best configuration directory based on your setup:

**Detection Priority (deepest first):**
1. `VAULTWARDEN_SECRETS_DIR` environment variable (explicit override)
2. `~/.config/pai-private/vaultwarden-secrets/` (PAI private - highest auto priority)
3. `~/.config/pai/vaultwarden-secrets/` (PAI public)
4. `~/.config/vaultwarden-secrets/` (standalone default)

```
~/.config/vaultwarden-secrets/
├── config.json    # Vault configurations
├── cache.json     # Encrypted cache
└── vaults/        # Vault-specific data
```

**PAI Integration (Auto-Detection):**

If you have PAI installed, the library automatically uses the PAI directory structure:

```bash
# Automatically detected if directory exists:
~/.config/pai-private/vaultwarden-secrets/  # Private credentials (highest priority)
~/.config/pai/vaultwarden-secrets/          # Public/shareable configs

# No environment variable needed - just works!
```

**Manual Override:**

You can explicitly set the location using the `VAULTWARDEN_SECRETS_DIR` environment variable:

```bash
# Force a specific location
export VAULTWARDEN_SECRETS_DIR=~/.my-custom-secrets

# Add to your shell profile (.zshrc, .bashrc)
export VAULTWARDEN_SECRETS_DIR=~/.config/pai-private/vaultwarden-secrets
```

### Vault Configuration

Vaults are defined in `{VAULTWARDEN_SECRETS_DIR}/config.json`:

```json
{
  "version": "1.0.0",
  "defaultVault": "default",
  "vaults": {
    "default": {
      "name": "default",
      "path": "{VAULTWARDEN_SECRETS_DIR}/vaults/default",
      "keychainItem": "session-default",
      "description": "Personal vault",
      "default": true
    },
    "work": {
      "name": "work",
      "path": "{VAULTWARDEN_SECRETS_DIR}/vaults/work",
      "keychainItem": "session-work",
      "description": "Work vault"
    }
  }
}
```

### Environment Variables

- `VAULTWARDEN_SECRETS_DIR` – Custom configuration directory (default: `~/.config/vaultwarden-secrets`)
- `BW_CLIENTID` – Bitwarden organization ID (if using organization account)
- `BW_CLIENTSECRET` – Bitwarden organization secret (if using organization account)
- `BW_IDENTITY` – Custom Bitwarden identity URL (for Vaultwarden self-hosted)

## Examples

### Example 1: Get API Key

```typescript
import { getSecret } from 'vaultwarden-secrets';

async function setupClaudeAPI() {
  const apiKey = await getSecret('claude-api.fields.API_KEY', {
    category: 'api_key',
    ttl: 3600  // 1 hour cache
  });

  return { apiKey };
}
```

### Example 2: Multi-Vault Usage

```typescript
import { getSecret, switchVault, getActiveVault } from 'vaultwarden-secrets';

async function switchContext(environment: 'personal' | 'work') {
  const vault = environment === 'personal' ? 'default' : 'work';
  await switchVault(vault);

  console.log(`Switched to vault: ${await getActiveVault()}`);
}

async function deployApp() {
  // Deploy to production using work vault
  await switchContext('work');
  const dbPassword = await getSecret('prod-database.login.password');

  // Backup to personal account
  await switchContext('personal');
  const backupKey = await getSecret('backup-service.fields.API_KEY');
}
```

### Example 3: Batch Secrets Retrieval

```typescript
import { listSecrets, getSecretObject } from 'vaultwarden-secrets';

async function loadEnvironment() {
  // Find all secrets related to 'api'
  const apiSecrets = await listSecrets('api');

  // Load all as environment variables
  const env: Record<string, string> = {};
  for (const secretName of apiSecrets) {
    const secret = await getSecretObject(secretName);
    env[secretName.toUpperCase()] = secret.password || secret.fields?.API_KEY || '';
  }

  return env;
}
```

### Example 4: Error Handling with Retry

```typescript
import { getSecret, SecretError, ErrorCode } from 'vaultwarden-secrets';

async function getSecretWithRetry(
  path: string,
  maxRetries = 3
): Promise<string> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await getSecret(path);
    } catch (error) {
      if (error instanceof SecretError && error.retryable && i < maxRetries - 1) {
        console.log(`Attempt ${i + 1} failed, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // Exponential backoff
        continue;
      }
      throw error;
    }
  }
  throw new Error('Max retries exceeded');
}
```

### Example 5: Cache Management

```typescript
import { getCacheStats, clearCache } from 'vaultwarden-secrets';

async function showCacheMetrics() {
  const stats = getCacheStats();

  console.log(`
    Cache Statistics:
    ─────────────────
    Hit rate:       ${(stats.hitRate * 100).toFixed(1)}%
    Hits:           ${stats.hits}
    Misses:         ${stats.misses}
    Entries:        ${stats.entries}
    Size:           ${(stats.size / 1024).toFixed(2)} KB
    Evictions:      ${stats.evictions}
    Expirations:    ${stats.expirations}
    Active vaults:  ${stats.vaults.join(', ')}
  `);

  // Clear cache if hit rate is too low
  if (stats.hitRate < 0.5) {
    console.log('Hit rate below 50%, clearing cache...');
    await clearCache();
  }
}
```

## API Reference
<!-- API START -->
**vaultwarden-secrets**

***

# vaultwarden-secrets

Secrets Management Library - Public API

Provides secure secrets management with macOS Keychain integration,
encrypted file caching, and Vaultwarden CLI integration.

## Enumerations

- [ErrorCode](enumerations/ErrorCode.md)

## Classes

- [SecretError](classes/SecretError.md)

## Interfaces

- [CacheEntry](interfaces/CacheEntry.md)
- [CacheStats](interfaces/CacheStats.md)
- [EncryptedData](interfaces/EncryptedData.md)
- [SecretOptions](interfaces/SecretOptions.md)
- [VaultConfig](interfaces/VaultConfig.md)
- [VaultConfigFile](interfaces/VaultConfigFile.md)

## Type Aliases

- [SecretCategory](type-aliases/SecretCategory.md)

## Variables

- [Constants](variables/Constants.md)
- [DEFAULT\_TTLS](variables/DEFAULT_TTLS.md)
- [secretCache](variables/secretCache.md)
- [vaultManager](variables/vaultManager.md)

## Functions

- [clearCache](functions/clearCache.md)
- [clearFolder](functions/clearFolder.md)
- [getActiveVault](functions/getActiveVault.md)
- [getCacheStats](functions/getCacheStats.md)
- [getFolder](functions/getFolder.md)
- [getSecret](functions/getSecret.md)
- [getSecretObject](functions/getSecretObject.md)
- [listSecrets](functions/listSecrets.md)
- [listVaults](functions/listVaults.md)
- [setFolder](functions/setFolder.md)
- [setSession](functions/setSession.md)
- [switchVault](functions/switchVault.md)


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / SecretOptions

# Interface: SecretOptions

Defined in: [types.ts:268](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L268)

Options for getSecret() function

## Example

```ts
await getSecret('github-pat.token', {
  vault: 'work',
  category: 'api_key',
  ttl: 3600,
  required: true
});
```

## Properties

### category?

> `optional` **category**: [`SecretCategory`](../type-aliases/SecretCategory.md)

Defined in: [types.ts:273](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L273)

Secret category for TTL (default: 'other')

***

### metadata?

> `optional` **metadata**: `Record`\<`string`, `unknown`\>

Defined in: [types.ts:285](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L285)

Additional metadata for audit logging

***

### required?

> `optional` **required**: `boolean`

Defined in: [types.ts:279](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L279)

Throw error if secret not found (default: true)

***

### skipCache?

> `optional` **skipCache**: `boolean`

Defined in: [types.ts:282](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L282)

Skip cache and always fetch fresh (default: false)

***

### ttl?

> `optional` **ttl**: `number`

Defined in: [types.ts:276](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L276)

Custom TTL in seconds (overrides category default)

***

### vault?

> `optional` **vault**: `string`

Defined in: [types.ts:270](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L270)

Vault name (default: 'default')


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / CacheEntry

# Interface: CacheEntry

Defined in: [types.ts:114](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L114)

Cache entry with TTL and access tracking

## Properties

### accessCount

> **accessCount**: `number`

Defined in: [types.ts:125](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L125)

Number of times accessed

***

### category

> **category**: [`SecretCategory`](../type-aliases/SecretCategory.md)

Defined in: [types.ts:128](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L128)

Secret category for TTL management

***

### expiresAt

> **expiresAt**: `number`

Defined in: [types.ts:119](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L119)

Timestamp when entry expires (ms since epoch)

***

### lastAccessed

> **lastAccessed**: `number`

Defined in: [types.ts:122](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L122)

Timestamp of last access (ms since epoch)

***

### value

> **value**: [`EncryptedData`](EncryptedData.md)

Defined in: [types.ts:116](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L116)

Encrypted secret value (AES-256-GCM)


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / CacheStats

# Interface: CacheStats

Defined in: [types.ts:134](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L134)

Cache statistics for monitoring

## Properties

### entries

> **entries**: `number`

Defined in: [types.ts:142](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L142)

Current number of cached entries

***

### evictions

> **evictions**: `number`

Defined in: [types.ts:151](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L151)

Number of entries evicted due to size limit

***

### expirations

> **expirations**: `number`

Defined in: [types.ts:154](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L154)

Number of entries expired due to TTL

***

### hitRate

> **hitRate**: `number`

Defined in: [types.ts:157](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L157)

Cache hit rate (0-1)

***

### hits

> **hits**: `number`

Defined in: [types.ts:136](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L136)

Total number of cache hits

***

### maxSize

> **maxSize**: `number`

Defined in: [types.ts:148](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L148)

Maximum cache size

***

### misses

> **misses**: `number`

Defined in: [types.ts:139](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L139)

Total number of cache misses

***

### newestEntry?

> `optional` **newestEntry**: `number`

Defined in: [types.ts:163](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L163)

Newest entry expiration time (ms since epoch)

***

### oldestEntry?

> `optional` **oldestEntry**: `number`

Defined in: [types.ts:160](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L160)

Oldest entry expiration time (ms since epoch)

***

### size

> **size**: `number`

Defined in: [types.ts:145](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L145)

Current number of cached entries

***

### vaults

> **vaults**: `string`[]

Defined in: [types.ts:166](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L166)

List of vault IDs in cache


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / VaultConfigFile

# Interface: VaultConfigFile

Defined in: [types.ts:198](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L198)

Full vault configuration file structure

Located at: ~/.config/vaultwarden-secrets/config.json

## Properties

### aliases?

> `optional` **aliases**: `Record`\<`string`, `string`\>

Defined in: [types.ts:209](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L209)

Secret aliases for cross-project references (alias → target)

***

### defaultFolder?

> `optional` **defaultFolder**: `string`

Defined in: [types.ts:206](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L206)

Default folder prefix for secrets (e.g., "Projects/myapp")

***

### defaultVault?

> `optional` **defaultVault**: `string`

Defined in: [types.ts:203](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L203)

Default vault name (if not specified in config entries)

***

### inherits?

> `optional` **inherits**: `Record`\<`string`, `string`\>

Defined in: [types.ts:212](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L212)

Inheritance - project inherits secrets from another (project → parent)

***

### vaults

> **vaults**: `Record`\<`string`, [`VaultConfig`](VaultConfig.md)\>

Defined in: [types.ts:200](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L200)

Map of vault name to vault config

***

### version

> **version**: `string`

Defined in: [types.ts:215](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L215)

Configuration version for migrations


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / EncryptedData

# Interface: EncryptedData

Defined in: [types.ts:96](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L96)

AES-256-GCM encrypted data structure

## Example

```ts
{
 *   "iv": "base64-encoded-iv",
 *   "authTag": "base64-encoded-tag",
 *   "encryptedData": "base64-encoded-ciphertext"
 * }
```

## Properties

### authTag

> **authTag**: `string`

Defined in: [types.ts:101](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L101)

Authentication tag for GCM mode (base64)

***

### encryptedData

> **encryptedData**: `string`

Defined in: [types.ts:104](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L104)

Encrypted payload (base64)

***

### iv

> **iv**: `string`

Defined in: [types.ts:98](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L98)

Initialization vector (base64)


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / VaultConfig

# Interface: VaultConfig

Defined in: [types.ts:176](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L176)

Vault configuration for a single vault

## Properties

### default?

> `optional` **default**: `boolean`

Defined in: [types.ts:190](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L190)

Whether this is the default vault

***

### description?

> `optional` **description**: `string`

Defined in: [types.ts:187](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L187)

Description of vault purpose

***

### keychainItem

> **keychainItem**: `string`

Defined in: [types.ts:184](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L184)

Keychain item name for vault master password

***

### name

> **name**: `string`

Defined in: [types.ts:178](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L178)

Vault name (e.g., 'default', 'work')

***

### path

> **path**: `string`

Defined in: [types.ts:181](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L181)

Absolute path to vault file


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / listVaults

# Function: listVaults()

> **listVaults**(): `Promise`\<[`VaultConfig`](../interfaces/VaultConfig.md)[]\>

Defined in: [index.ts:513](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/index.ts#L513)

List all configured vaults

## Returns

`Promise`\<[`VaultConfig`](../interfaces/VaultConfig.md)[]\>

Promise resolving to array of vault configurations

## Example

```ts
const vaults = await listVaults();
for (const vault of vaults) {
  console.log(`${vault.name}: ${vault.description}`);
}
```


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / setSession

# Function: setSession()

> **setSession**(`vaultId`, `token`): `Promise`\<`void`\>

Defined in: [index.ts:482](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/index.ts#L482)

Store a session token for a vault (after bw unlock)

## Parameters

### vaultId

`string`

Vault identifier

### token

`string`

BW_SESSION token from bw unlock

## Returns

`Promise`\<`void`\>

## Example

```ts
const result = await # vaultwarden-secrets

Secure secrets management library with Vaultwarden/Bitwarden CLI integration, encrypted caching, and macOS Keychain storage.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.0+-orange.svg)](https://bun.sh/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## Features

- **Zero Plaintext Storage** – Master encryption key stored in macOS Keychain, cache encrypted with AES-256-GCM
- **Fast Retrieval** – Sub-100ms cached secret access with configurable TTL-based expiration
- **Multi-Vault Support** – Switch between personal, work, and project vaults at runtime
- **Type-Safe API** – Full TypeScript support with comprehensive error handling
- **Integrity Verification** – HMAC-SHA256 protection against cache tampering
- **LRU Eviction** – Automatic memory management with configurable cache size limits
- **Category-Based TTL** – Different expiration times for API keys, passwords, tokens, and certificates

## Prerequisites

- **macOS** (Keychain is required for master key storage)
- **Bun** ≥ 1.0.0 ([install](https://bun.sh/))
- **Vaultwarden/Bitwarden CLI** – `bw` command installed and configured

```bash
# Install Bitwarden CLI
brew install bitwarden-cli

# Initialize Bitwarden (create account/login)
bw login
```

## Installation

### Quick Install

```bash
# Clone the repository
git clone https://github.com/yourusername/vaultwarden-secrets.git
cd vaultwarden-secrets

# Install dependencies
bun install

# Set up configuration directory
bun run install-config
```

### PAI Users

If you're using this with PAI (Personal AI) framework:

```bash
# Install to PAI private directory
bun run install-pai
```

This automatically detects and uses `~/.config/pai-private/vaultwarden-secrets/` for all configuration.

### Installation Options

```bash
# Preview what would be installed (dry-run)
bun run install-config --dry-run

# Install to custom directory
bun run install.ts --path ~/.my-secrets

# Uninstall
bun run uninstall
```

### From npm (when published)

```bash
bun add vaultwarden-secrets
```

### Development/Local

```bash
# Clone the repository
git clone https://github.com/yourusername/vaultwarden-secrets.git
cd vaultwarden-secrets

# Install dependencies and set up config
bun install
bun run install-config

# Link for local development
bun link
bun link vaultwarden-secrets
```

## Quick Start

### 1. Unlock Your Vault

Before using the library, unlock the Bitwarden CLI:

```bash
bw unlock
# Follow prompts and copy the BW_SESSION token
```

### 2. Store Session in Keychain

```typescript
import { setSession } from 'vaultwarden-secrets';

// After bw unlock, copy the BW_SESSION token
await setSession('default', 'eyJleHAiOjE2NzcwODEyNDYsImFsZyI6IkhTMjU2In0...');
```

### 3. Get Secrets

```typescript
import { getSecret, getSecretObject } from 'vaultwarden-secrets';

// Get a password field (default)
const password = await getSecret('github-pat');

// Get a specific field
const username = await getSecret('github-pat.login.username');

// Get a custom field
const apiKey = await getSecret('github-pat.fields.API_KEY');

// Get all fields as an object
const allFields = await getSecretObject('github-pat');
// Returns: { username: '...', password: '...', uri: '...', API_KEY: '...' }
```

## CLI Reference

The `secret` command provides muscle-memory-friendly access to your secrets.

### Installation

```bash
# Install globally
bun link

# Add shell integration to ~/.zshrc
source ~/.config/pai/lib/secrets/shell/secret.sh
```

### Daily Commands

| Command | Description | Example |
|---------|-------------|---------|
| `secret <path>` | Get secret (shorthand) | `secret github-pat` |
| `secret get <path>` | Get secret to stdout | `secret get "API Keys.OPENAI"` |
| `secret copy <path>` | Copy to clipboard | `secret copy github-pat` |
| `secret paste <path>` | Set from clipboard | `secret paste myapp.password` |
| `secret set <path> [value]` | Set secret (prompts if no value) | `secret set myapp.token` |

### Discovery Commands

| Command | Description | Example |
|---------|-------------|---------|
| `secret list [filter]` | List secrets | `secret list github` |
| `secret search <query>` | Fuzzy search | `secret search postgres` |
| `secret show <item>` | Show all fields (tree view) | `secret show "PostgreSQL"` |

### Vault Management

| Command | Description |
|---------|-------------|
| `secret vault list` | List available vaults |
| `secret vault use <name>` | Switch active vault |
| `secret vault current` | Show current vault |

### Folder Prefix

Organize secrets by project with folder prefixes:

```bash
# Set folder prefix
secret folder myproject
# Now "secret get API_KEY" looks up "myproject/API_KEY"

# Show current folder
secret folder
# Output: myproject

# Clear folder prefix
secret folder clear
```

### Cache Management

| Command | Description |
|---------|-------------|
| `secret cache clear` | Clear all cached secrets |
| `secret cache stats` | Show hit/miss statistics |
| `secret cache refresh` | Force refresh from VW |

### System Commands

| Command | Description |
|---------|-------------|
| `secret health` | Check bw CLI, session, connectivity |
| `secret set-session <vault> <token>` | Store BW_SESSION in Keychain |
| `secret version` | Show version |
| `secret help` | Show help |

### Path Syntax

```bash
# Default: password field
secret get github-pat

# Specific field
secret get github-pat.login.username

# Notes field (common for API keys)
secret get "OpenAI API Key.notes"

# Custom field
secret get github-pat.fields.WEBHOOK_SECRET
```

## Shell Integration

Add to `~/.zshrc` or `~/.bashrc`:

```bash
source ~/.config/pai/lib/secrets/shell/secret.sh
```

### Muscle Memory Aliases

| Alias | Expands To | Purpose |
|-------|------------|---------|
| `sg` | `secret get` | Get secret |
| `sc` | `secret copy` | Copy to clipboard |
| `ss` | `secret set` | Set secret |
| `sl` | `secret list` | List secrets |
| `sv` | `secret vault` | Vault commands |
| `sth` | `secret health` | Health check |

### Shell Functions

```bash
# Export secret to environment variable
se "github-pat.fields.TOKEN" GITHUB_TOKEN
# Exports GITHUB_TOKEN=<secret value>

# Interactive picker (requires fzf)
sp        # Pick and get
sp copy   # Pick and copy to clipboard
```

### Tab Completion

Tab completion is automatic for both bash and zsh after sourcing the shell file.

## Migration Wizard

Migrate secrets from `.env` files, shell configs, and scripts to Vaultwarden.

### Basic Usage

```bash
# Scan current directory
secret migrate

# Scan specific paths
secret migrate ~/.env ~/Development

# Scan with depth limit
secret migrate ~/projects --depth 2
```

### What It Scans

- `.env`, `.env.local`, `.env.production` files
- `.zshrc`, `.bashrc`, `.profile` configs
- `*.sh` shell scripts
- `*.json`, `*.yaml`, `*.yml`, `*.toml` configs

### Detection Confidence

| Level | Action | Examples |
|-------|--------|----------|
| **High** | Auto-confirmed | `API_KEY`, `SECRET`, `TOKEN`, `PASSWORD` |
| **Medium** | Prompted | `KEY`, `PASS`, `CRED`, `PRIV` |
| **Low** | Skipped in auto mode | `URL`, `HOST`, `USER`, `DATABASE` |

### Duplicate Handling

When the same variable appears multiple times with different values:

```
⚠️  Same-name secrets with different values found:
  Using last value (shell semantics). All values shown newest-first:

  OPENAI_API_KEY:
    → sk-new-key (line 45) (will use)
      sk-old-key (line 12)
```

The **last value wins** (matches shell behavior).

### Migration Output

The wizard generates:

1. **New file versions** with `$(secret get ...)` calls
2. **VW import script** for batch creation
3. **Cleanup summary** showing what can be removed

### Output Locations

```
1. Side-by-side (.env → .env.migrated)
2. Output folder (~/.config/pai/migrations/<date>/)
3. In-place (backup original, replace with new)
```

### Dry Run

```bash
# Preview without making changes
secret migrate ~/.env --dry-run
```

## API Reference

### `getSecret(path, options?)`

Retrieve a single secret value from Vaultwarden with caching.

```typescript
async function getSecret(
  path: string,
  options?: SecretOptions
): Promise<string>
```

**Parameters:**

- `path` (string) – Secret path in format:
  - `ItemName` – Return password field (default)
  - `ItemName.login.username` – Get nested field
  - `ItemName.fields.CUSTOM_FIELD` – Get custom field

- `options` (optional):
  - `vault` (string) – Vault ID (default: active vault)
  - `category` (SecretCategory) – Category for TTL (`api_key`, `password`, `token`, `certificate`, `database`, `other`)
  - `ttl` (number) – Custom TTL in seconds (overrides category default)
  - `skipCache` (boolean) – Fetch fresh value, skip cache (default: false)
  - `required` (boolean) – Throw error if not found (default: true)
  - `metadata` (object) – Additional audit logging data

**Returns:** Promise<string>

**Throws:** `SecretError` if vault is locked or secret not found

**Examples:**

```typescript
// Get default password field
const password = await getSecret('github-pat');

// Get specific nested field
const username = await getSecret('github-pat.login.username');

// Get custom field
const apiKey = await getSecret('github-pat.fields.API_KEY');

// Skip cache for fresh value
const fresh = await getSecret('github-pat', { skipCache: true });

// Use specific vault and category
const token = await getSecret('work-token', {
  vault: 'work',
  category: 'token',
  ttl: 3600
});

// Get without caching (sensitive data)
const sensitive = await getSecret('master-password', {
  skipCache: true,
  metadata: { reason: 'admin-access' }
});
```

### `getSecretObject(itemName, options?)`

Retrieve all fields from a Vaultwarden item as a single object.

```typescript
async function getSecretObject(
  itemName: string,
  options?: SecretOptions
): Promise<Record<string, string>>
```

**Returns:** Promise containing:
- `username` – Login username
- `password` – Login password
- `uri` – First URI associated with item
- `notes` – Item notes
- `[customFieldName]` – All custom fields by name

**Example:**

```typescript
const secrets = await getSecretObject('github-pat');
console.log(secrets);
// {
//   username: 'my-github-user',
//   password: 'ghp_xxxxxxxxxxxx',
//   uri: 'https://github.com',
//   notes: 'Primary PAT for CI/CD',
//   API_KEY: 'sk_test_...',
//   WEBHOOK_SECRET: 'whsec_...'
// }
```

### `listSecrets(filter?, options?)`

List available secrets from Vaultwarden with optional filtering.

```typescript
async function listSecrets(
  filter?: string,
  options?: SecretOptions
): Promise<string[]>
```

**Parameters:**

- `filter` (optional) – Filter items by name (case-insensitive partial match)
- `options` (optional) – `vault` to query specific vault

**Returns:** Sorted array of item names

**Examples:**

```typescript
// List all secrets
const allSecrets = await listSecrets();

// Filter secrets
const githubSecrets = await listSecrets('github');
// Returns: ['github-pat', 'github-ssh-key']

// List from specific vault
const workSecrets = await listSecrets(undefined, { vault: 'work' });
```

### `switchVault(vaultId)`

Switch the active vault for subsequent operations.

```typescript
async function switchVault(vaultId: string): Promise<void>
```

**Example:**

```typescript
// Switch to work vault
await switchVault('work');

// Now getSecret() uses 'work' vault by default
const workToken = await getSecret('api-token');

// Can still override per-call
const personalSecret = await getSecret('personal-key', { vault: 'default' });
```

### `getActiveVault()`

Get the currently active vault ID.

```typescript
async function getActiveVault(): Promise<string>
```

**Example:**

```typescript
const active = await getActiveVault();
console.log(`Using vault: ${active}`);
```

### `setSession(vaultId, token)`

Store a Bitwarden session token in Keychain after `bw unlock`.

```typescript
async function setSession(vaultId: string, token: string): Promise<void>
```

**Example:**

```typescript
// After running: bw unlock
// Copy the BW_SESSION value and store it:
await setSession('default', 'eyJleHAiOjE2NzcwODEyNDYsImFsZyI6IkhTMjU2In0...');
```

### `clearCache(vaultId?)`

Clear the encrypted cache to force fresh secrets on next access.

```typescript
async function clearCache(vaultId?: string): Promise<void>
```

**Example:**

```typescript
// Clear all cached secrets
await clearCache();

// Clear only work vault cache
await clearCache('work');
```

### `getCacheStats()`

Get cache performance metrics and statistics.

```typescript
function getCacheStats(): CacheStats
```

**Returns:** Object containing:
- `hits` – Total cache hits
- `misses` – Total cache misses
- `hitRate` – Hit rate (0–1)
- `entries` – Current cached entries
- `size` – Cache size in bytes
- `maxSize` – Maximum cache size
- `evictions` – Entries evicted due to size limit
- `expirations` – Entries expired due to TTL
- `vaults` – List of vault IDs in cache
- `oldestEntry` – Oldest expiration time (ms)
- `newestEntry` – Newest expiration time (ms)

**Example:**

```typescript
const stats = getCacheStats();
console.log(`Cache hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);
console.log(`Cached entries: ${stats.entries}`);
console.log(`Active vaults: ${stats.vaults.join(', ')}`);
```

## Error Handling

All functions throw `SecretError` with specific error codes:

```typescript
import { getSecret, SecretError, ErrorCode } from 'vaultwarden-secrets';

try {
  const secret = await getSecret('my-secret');
} catch (error) {
  if (error instanceof SecretError) {
    switch (error.code) {
      case ErrorCode.VAULT_LOCKED:
        console.error('Vault locked. Run: bw unlock');
        break;
      case ErrorCode.SECRET_NOT_FOUND:
        console.error('Secret not found in vault');
        break;
      case ErrorCode.KEYCHAIN_ACCESS_DENIED:
        console.error('No permission to access Keychain');
        break;
      case ErrorCode.ENCRYPTION_FAILED:
        console.error('Cache encryption failed');
        break;
      default:
        console.error('Unknown error:', error.message);
    }

    // Check if error is retryable
    if (error.retryable) {
      console.log('You can retry this operation');
    }
  }
}
```

**Error Codes:**

| Code | Meaning | Retryable |
|------|---------|-----------|
| `VAULT_LOCKED` | Vault needs `bw unlock` | Yes |
| `SECRET_NOT_FOUND` | Item or field doesn't exist | No |
| `VAULT_CORRUPTED` | Vault sync/config issue | Yes |
| `KEYCHAIN_NOT_FOUND` | Session not stored in Keychain | No |
| `KEYCHAIN_ACCESS_DENIED` | Permission denied on Keychain | No |
| `ENCRYPTION_FAILED` | AES-256-GCM encryption error | No |
| `DECRYPTION_FAILED` | Cache decryption failed (tampering?) | No |
| `INVALID_PATH` | Malformed secret path | No |
| `INVALID_CATEGORY` | Unknown secret category | No |
| `CACHE_ERROR` | Cache read/write error | Yes |
| `FILE_SYSTEM_ERROR` | Filesystem operation failed | Yes |

## Security Model

### Master Key Storage

- Stored in **macOS Keychain** (locked at system level)
- Never written to disk in plaintext
- Keychain service: `vaultwarden-secrets`
- Accessible only to authenticated user

### Cache Encryption

- Cache file: `{VAULTWARDEN_SECRETS_DIR}/cache.json`
- Default: `~/.config/vaultwarden-secrets/cache.json`
- **AES-256-GCM** encryption (256-bit key)
- **HMAC-SHA256** integrity verification
- Each entry encrypted separately with unique IV
- Automatic HMAC verification on load (detects tampering)

### Session Tokens

- BW_SESSION tokens stored in Keychain per vault
- Tokens expire after vault lock or session timeout
- Run `bw unlock` to refresh token

### Data Flow

```
┌─────────────────────────────────────────┐
│  Application Request                     │
│  getSecret('item.field')                 │
└─────────────────┬───────────────────────┘
                  │
        ┌─────────▼──────────┐
        │  Check Cache       │ ◄─── Encrypted file + HMAC
        │ (AES-256-GCM)      │     verification
        └────────┬──────────┘
                  │
         ┌────────▼─────────────────┐
         │  Cache Miss?             │
         │  Fetch from Keychain     │
         │  session token           │
         └────────┬────────────────┘
                  │
        ┌─────────▼──────────────────┐
        │  bw CLI (encrypted vault)  │
        │  BW_SESSION=${token}       │
        │  bw get item Item          │
        └────────┬───────────────────┘
                 │
        ┌────────▼──────────┐
        │  Encrypt + Cache  │ ──► {VAULTWARDEN_SECRETS_DIR}/cache.json
        │  Return Secret    │     (HMAC signed)
        └────────┬──────────┘
                 │
    ┌────────────▼────────────┐
    │  Application (plaintext │
    │  only in memory)        │
    └─────────────────────────┘
```

### TTL by Category

| Category | Default TTL | Use Case |
|----------|-------------|----------|
| `api_key` | 1 hour | External API keys, moderate change rate |
| `password` | 30 minutes | User passwords, sensitive data |
| `token` | 15 minutes | Session tokens, frequent rotation |
| `certificate` | 24 hours | SSL certs, rarely change |
| `database` | 1 hour | DB credentials, moderate change |
| `other` | 30 minutes | Uncategorized (conservative default) |

## Configuration

### Configuration Directory

The library automatically detects the best configuration directory based on your setup:

**Detection Priority (deepest first):**
1. `VAULTWARDEN_SECRETS_DIR` environment variable (explicit override)
2. `~/.config/pai-private/vaultwarden-secrets/` (PAI private - highest auto priority)
3. `~/.config/pai/vaultwarden-secrets/` (PAI public)
4. `~/.config/vaultwarden-secrets/` (standalone default)

```
~/.config/vaultwarden-secrets/
├── config.json    # Vault configurations
├── cache.json     # Encrypted cache
└── vaults/        # Vault-specific data
```

**PAI Integration (Auto-Detection):**

If you have PAI installed, the library automatically uses the PAI directory structure:

```bash
# Automatically detected if directory exists:
~/.config/pai-private/vaultwarden-secrets/  # Private credentials (highest priority)
~/.config/pai/vaultwarden-secrets/          # Public/shareable configs

# No environment variable needed - just works!
```

**Manual Override:**

You can explicitly set the location using the `VAULTWARDEN_SECRETS_DIR` environment variable:

```bash
# Force a specific location
export VAULTWARDEN_SECRETS_DIR=~/.my-custom-secrets

# Add to your shell profile (.zshrc, .bashrc)
export VAULTWARDEN_SECRETS_DIR=~/.config/pai-private/vaultwarden-secrets
```

### Vault Configuration

Vaults are defined in `{VAULTWARDEN_SECRETS_DIR}/config.json`:

```json
{
  "version": "1.0.0",
  "defaultVault": "default",
  "vaults": {
    "default": {
      "name": "default",
      "path": "{VAULTWARDEN_SECRETS_DIR}/vaults/default",
      "keychainItem": "session-default",
      "description": "Personal vault",
      "default": true
    },
    "work": {
      "name": "work",
      "path": "{VAULTWARDEN_SECRETS_DIR}/vaults/work",
      "keychainItem": "session-work",
      "description": "Work vault"
    }
  }
}
```

### Environment Variables

- `VAULTWARDEN_SECRETS_DIR` – Custom configuration directory (default: `~/.config/vaultwarden-secrets`)
- `BW_CLIENTID` – Bitwarden organization ID (if using organization account)
- `BW_CLIENTSECRET` – Bitwarden organization secret (if using organization account)
- `BW_IDENTITY` – Custom Bitwarden identity URL (for Vaultwarden self-hosted)

## Examples

### Example 1: Get API Key

```typescript
import { getSecret } from 'vaultwarden-secrets';

async function setupClaudeAPI() {
  const apiKey = await getSecret('claude-api.fields.API_KEY', {
    category: 'api_key',
    ttl: 3600  // 1 hour cache
  });

  return { apiKey };
}
```

### Example 2: Multi-Vault Usage

```typescript
import { getSecret, switchVault, getActiveVault } from 'vaultwarden-secrets';

async function switchContext(environment: 'personal' | 'work') {
  const vault = environment === 'personal' ? 'default' : 'work';
  await switchVault(vault);

  console.log(`Switched to vault: ${await getActiveVault()}`);
}

async function deployApp() {
  // Deploy to production using work vault
  await switchContext('work');
  const dbPassword = await getSecret('prod-database.login.password');

  // Backup to personal account
  await switchContext('personal');
  const backupKey = await getSecret('backup-service.fields.API_KEY');
}
```

### Example 3: Batch Secrets Retrieval

```typescript
import { listSecrets, getSecretObject } from 'vaultwarden-secrets';

async function loadEnvironment() {
  // Find all secrets related to 'api'
  const apiSecrets = await listSecrets('api');

  // Load all as environment variables
  const env: Record<string, string> = {};
  for (const secretName of apiSecrets) {
    const secret = await getSecretObject(secretName);
    env[secretName.toUpperCase()] = secret.password || secret.fields?.API_KEY || '';
  }

  return env;
}
```

### Example 4: Error Handling with Retry

```typescript
import { getSecret, SecretError, ErrorCode } from 'vaultwarden-secrets';

async function getSecretWithRetry(
  path: string,
  maxRetries = 3
): Promise<string> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await getSecret(path);
    } catch (error) {
      if (error instanceof SecretError && error.retryable && i < maxRetries - 1) {
        console.log(`Attempt ${i + 1} failed, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // Exponential backoff
        continue;
      }
      throw error;
    }
  }
  throw new Error('Max retries exceeded');
}
```

### Example 5: Cache Management

```typescript
import { getCacheStats, clearCache } from 'vaultwarden-secrets';

async function showCacheMetrics() {
  const stats = getCacheStats();

  console.log(`
    Cache Statistics:
    ─────────────────
    Hit rate:       ${(stats.hitRate * 100).toFixed(1)}%
    Hits:           ${stats.hits}
    Misses:         ${stats.misses}
    Entries:        ${stats.entries}
    Size:           ${(stats.size / 1024).toFixed(2)} KB
    Evictions:      ${stats.evictions}
    Expirations:    ${stats.expirations}
    Active vaults:  ${stats.vaults.join(', ')}
  `);

  // Clear cache if hit rate is too low
  if (stats.hitRate < 0.5) {
    console.log('Hit rate below 50%, clearing cache...');
    await clearCache();
  }
}
```

## API Reference
bw unlock`.text();
const match = result.match(/BW_SESSION="([^"]+)"/);
if (match) {
  await setSession('default', match[1]);
}
```


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / getCacheStats

# Function: getCacheStats()

> **getCacheStats**(): [`CacheStats`](../interfaces/CacheStats.md)

Defined in: [index.ts:436](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/index.ts#L436)

Get cache statistics

## Returns

[`CacheStats`](../interfaces/CacheStats.md)

Cache statistics including hit rate, entries, and vaults

## Example

```ts
const stats = getCacheStats();
console.log(`Cache hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);
console.log(`Cached entries: ${stats.entries}`);
console.log(`Active vaults: ${stats.vaults.join(', ')}`);
```


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / getSecret

# Function: getSecret()

> **getSecret**(`path`, `options`): `Promise`\<`string`\>

Defined in: [index.ts:146](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/index.ts#L146)

Get a secret from Vaultwarden with caching

## Parameters

### path

`string`

Secret path (e.g., "github-pat", "github-pat.password", "github-pat.fields.API_KEY")

### options

[`SecretOptions`](../interfaces/SecretOptions.md) = `{}`

Options for secret retrieval

## Returns

`Promise`\<`string`\>

Promise resolving to secret value

## Throws

If vault is locked or secret not found

## Example

```ts
// Get password field (default)
const password = await getSecret('github-pat');

// Get specific field
const username = await getSecret('github-pat.login.username');

// Get custom field
const apiKey = await getSecret('github-pat.fields.API_KEY');

// Skip cache for fresh value
const fresh = await getSecret('github-pat', { skipCache: true });

// Use specific vault
const workSecret = await getSecret('work-token', { vault: 'work' });
```


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / listSecrets

# Function: listSecrets()

> **listSecrets**(`filter?`, `options?`): `Promise`\<`string`[]\>

Defined in: [index.ts:360](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/index.ts#L360)

List available secrets (items) from Vaultwarden

## Parameters

### filter?

`string`

Optional filter string (case-insensitive)

### options?

[`SecretOptions`](../interfaces/SecretOptions.md) = `{}`

Options for listing

## Returns

`Promise`\<`string`[]\>

Promise resolving to sorted array of item names

## Throws

If vault is locked

## Example

```ts
// List all secrets
const allSecrets = await listSecrets();

// List filtered secrets
const githubSecrets = await listSecrets('github');

// List from specific vault
const workSecrets = await listSecrets(undefined, { vault: 'work' });
```


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / switchVault

# Function: switchVault()

> **switchVault**(`vaultId`): `Promise`\<`void`\>

Defined in: [index.ts:450](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/index.ts#L450)

Switch active vault

## Parameters

### vaultId

`string`

ID of vault to activate

## Returns

`Promise`\<`void`\>

## Throws

If vault not found

## Example

```ts
await switchVault('work');
// Now getSecret() uses 'work' vault by default
```


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / clearCache

# Function: clearCache()

> **clearCache**(`vaultId?`): `Promise`\<`void`\>

Defined in: [index.ts:421](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/index.ts#L421)

Clear the encrypted cache

## Parameters

### vaultId?

`string`

Optional vault ID to clear (clears all if not specified)

## Returns

`Promise`\<`void`\>

## Example

```ts
// Clear all cached secrets
await clearCache();

// Clear only work vault cache
await clearCache('work');
```


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / getFolder

# Function: getFolder()

> **getFolder**(): `Promise`\<`string`\>

Defined in: [index.ts:526](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/index.ts#L526)

Get default folder prefix

## Returns

`Promise`\<`string`\>

Promise resolving to folder prefix or empty string

## Example

```ts
const folder = await getFolder();
console.log(`Current folder: ${folder || '(none)'}`);
```


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / setFolder

# Function: setFolder()

> **setFolder**(`folder`): `Promise`\<`void`\>

Defined in: [index.ts:542](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/index.ts#L542)

Set default folder prefix

When set, all secret lookups without explicit folder (no '/') will
use this prefix. e.g., getSecret('postgres') becomes getSecret('folder/postgres')

## Parameters

### folder

`string`

Folder path (e.g., "Projects/myapp")

## Returns

`Promise`\<`void`\>

## Example

```ts
await setFolder('Projects/myapp');
await getSecret('postgres'); // looks up "Projects/myapp/postgres"
```


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / getActiveVault

# Function: getActiveVault()

> **getActiveVault**(): `Promise`\<`string`\>

Defined in: [index.ts:465](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/index.ts#L465)

Get active vault ID

## Returns

`Promise`\<`string`\>

Promise resolving to active vault ID

## Example

```ts
const activeVault = await getActiveVault();
console.log(`Using vault: ${activeVault}`);
```


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / getSecretObject

# Function: getSecretObject()

> **getSecretObject**(`itemName`, `options`): `Promise`\<`Record`\<`string`, `string`\>\>

Defined in: [index.ts:271](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/index.ts#L271)

Get all fields from a Vaultwarden item as an object

## Parameters

### itemName

`string`

Name of the Vaultwarden item

### options

[`SecretOptions`](../interfaces/SecretOptions.md) = `{}`

Options for secret retrieval

## Returns

`Promise`\<`Record`\<`string`, `string`\>\>

Promise resolving to object with all fields

## Throws

If vault is locked or item not found

## Example

```ts
const secrets = await getSecretObject('github-pat');
// Returns: { username: '...', password: '...', uri: '...', API_KEY: '...' }

const workSecrets = await getSecretObject('work-token', { vault: 'work' });
```


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / clearFolder

# Function: clearFolder()

> **clearFolder**(): `Promise`\<`void`\>

Defined in: [index.ts:555](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/index.ts#L555)

Clear default folder prefix

After clearing, all lookups use the exact path provided.

## Returns

`Promise`\<`void`\>

## Example

```ts
await clearFolder();
await getSecret('postgres'); // looks up "postgres" directly
```


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / vaultManager

# Variable: vaultManager

> `const` **vaultManager**: `VaultManager`

Defined in: [vault-config.ts:272](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/vault-config.ts#L272)


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / DEFAULT\_TTLS

# Variable: DEFAULT\_TTLS

> `const` **DEFAULT\_TTLS**: `Record`\<[`SecretCategory`](../type-aliases/SecretCategory.md), `number`\>

Defined in: [types.ts:295](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L295)

Default TTLs by secret category (in seconds)


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / secretCache

# Variable: secretCache

> `const` **secretCache**: `SecretCache`

Defined in: [cache.ts:395](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/cache.ts#L395)

Singleton cache instance

Used by default in getSecret() calls.

## Example

```ts
import { secretCache } from './cache';

const token = await secretCache.get('github-pat.token', 'default');
```


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / Constants

# Variable: Constants

> `const` **Constants**: `object`

Defined in: [types.ts:361](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L361)

System constants for secrets management

## Type Declaration

### AES\_KEY\_LENGTH

> `readonly` **AES\_KEY\_LENGTH**: `256` = `256`

AES key length in bits

### AUTH\_TAG\_LENGTH

> `readonly` **AUTH\_TAG\_LENGTH**: `16` = `16`

Auth tag length for AES-GCM in bytes

### CACHE\_MAX\_SIZE

> `readonly` **CACHE\_MAX\_SIZE**: `100` = `100`

Maximum cache entries before LRU eviction

### DEFAULT\_KEYCHAIN\_SERVICE

> `readonly` **DEFAULT\_KEYCHAIN\_SERVICE**: `"vaultwarden-secrets"` = `'vaultwarden-secrets'`

Default keychain service name

### DEFAULT\_VAULT\_NAME

> `readonly` **DEFAULT\_VAULT\_NAME**: `"default"` = `'default'`

Default vault name

### IV\_LENGTH

> `readonly` **IV\_LENGTH**: `12` = `12`

IV length for AES-GCM in bytes

### PBKDF2\_ITERATIONS

> `readonly` **PBKDF2\_ITERATIONS**: `100000` = `100000`

PBKDF2 iterations for vault master key derivation

### SALT\_LENGTH

> `readonly` **SALT\_LENGTH**: `32` = `32`

Salt length for PBKDF2 in bytes

### CACHE\_PATH

#### Get Signature

> **get** **CACHE\_PATH**(): `any`

Cache file path

##### Returns

`any`

### CONFIG\_DIR

#### Get Signature

> **get** **CONFIG\_DIR**(): `string`

Configuration directory (can be overridden via VAULTWARDEN_SECRETS_DIR env var)

##### Returns

`string`

### CONFIG\_PATH

#### Get Signature

> **get** **CONFIG\_PATH**(): `any`

Config file path

##### Returns

`any`

### VAULTS\_DIR

#### Get Signature

> **get** **VAULTS\_DIR**(): `any`

Default vaults directory

##### Returns

`any`


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / SecretCategory

# Type Alias: SecretCategory

> **SecretCategory** = `"api_key"` \| `"password"` \| `"token"` \| `"certificate"` \| `"database"` \| `"other"`

Defined in: [types.ts:74](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L74)

Categories of secrets for TTL and access patterns


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / SecretError

# Class: SecretError

Defined in: [types.ts:55](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L55)

Custom error class for secret operations

## Example

```ts
throw new SecretError(
  'Secret not found in vault',
  ErrorCode.SECRET_NOT_FOUND,
  false
);
```

## Extends

- `Error`

## Constructors

### Constructor

> **new SecretError**(`message`, `code`, `retryable`, `cause?`): `SecretError`

Defined in: [types.ts:56](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L56)

#### Parameters

##### message

`string`

##### code

[`ErrorCode`](../enumerations/ErrorCode.md)

##### retryable

`boolean` = `false`

##### cause?

`Error`

#### Returns

`SecretError`

#### Overrides

`Error.constructor`

## Properties

### cause?

> `readonly` `optional` **cause**: `Error`

Defined in: [types.ts:60](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L60)

#### Inherited from

`Error.cause`

***

### code

> `readonly` **code**: [`ErrorCode`](../enumerations/ErrorCode.md)

Defined in: [types.ts:58](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L58)

***

### message

> **message**: `string`

Defined in: node\_modules/typescript/lib/lib.es5.d.ts:1077

#### Inherited from

`Error.message`

***

### name

> **name**: `string`

Defined in: node\_modules/typescript/lib/lib.es5.d.ts:1076

#### Inherited from

`Error.name`

***

### retryable

> `readonly` **retryable**: `boolean` = `false`

Defined in: [types.ts:59](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L59)

***

### stack?

> `optional` **stack**: `string`

Defined in: node\_modules/typescript/lib/lib.es5.d.ts:1078

#### Inherited from

`Error.stack`

***

### stackTraceLimit

> `static` **stackTraceLimit**: `number`

Defined in: node\_modules/@types/node/globals.d.ts:68

The `Error.stackTraceLimit` property specifies the number of stack frames
collected by a stack trace (whether generated by `new Error().stack` or
`Error.captureStackTrace(obj)`).

The default value is `10` but may be set to any valid JavaScript number. Changes
will affect any stack trace captured _after_ the value has been changed.

If set to a non-number value, or set to a negative number, stack traces will
not capture any frames.

#### Inherited from

`Error.stackTraceLimit`

## Methods

### captureStackTrace()

#### Call Signature

> `static` **captureStackTrace**(`targetObject`, `constructorOpt?`): `void`

Defined in: node\_modules/@types/node/globals.d.ts:52

Creates a `.stack` property on `targetObject`, which when accessed returns
a string representing the location in the code at which
`Error.captureStackTrace()` was called.

```js
const myObject = {};
Error.captureStackTrace(myObject);
myObject.stack;  // Similar to `new Error().stack`
```

The first line of the trace will be prefixed with
`${myObject.name}: ${myObject.message}`.

The optional `constructorOpt` argument accepts a function. If given, all frames
above `constructorOpt`, including `constructorOpt`, will be omitted from the
generated stack trace.

The `constructorOpt` argument is useful for hiding implementation
details of error generation from the user. For instance:

```js
function a() {
  b();
}

function b() {
  c();
}

function c() {
  // Create an error without stack trace to avoid calculating the stack trace twice.
  const { stackTraceLimit } = Error;
  Error.stackTraceLimit = 0;
  const error = new Error();
  Error.stackTraceLimit = stackTraceLimit;

  // Capture the stack trace above function b
  Error.captureStackTrace(error, b); // Neither function c, nor b is included in the stack trace
  throw error;
}

a();
```

##### Parameters

###### targetObject

`object`

###### constructorOpt?

`Function`

##### Returns

`void`

##### Inherited from

`Error.captureStackTrace`

#### Call Signature

> `static` **captureStackTrace**(`targetObject`, `constructorOpt?`): `void`

Defined in: node\_modules/bun-types/globals.d.ts:1042

Create .stack property on a target object

##### Parameters

###### targetObject

`object`

###### constructorOpt?

`Function`

##### Returns

`void`

##### Inherited from

`Error.captureStackTrace`

***

### isError()

#### Call Signature

> `static` **isError**(`error`): `error is Error`

Defined in: node\_modules/typescript/lib/lib.esnext.error.d.ts:23

Indicates whether the argument provided is a built-in Error instance or not.

##### Parameters

###### error

`unknown`

##### Returns

`error is Error`

##### Inherited from

`Error.isError`

#### Call Signature

> `static` **isError**(`value`): `value is Error`

Defined in: node\_modules/bun-types/globals.d.ts:1037

Check if a value is an instance of Error

##### Parameters

###### value

`unknown`

The value to check

##### Returns

`value is Error`

True if the value is an instance of Error, false otherwise

##### Inherited from

`Error.isError`

***

### prepareStackTrace()

> `static` **prepareStackTrace**(`err`, `stackTraces`): `any`

Defined in: node\_modules/@types/node/globals.d.ts:56

#### Parameters

##### err

`Error`

##### stackTraces

`CallSite`[]

#### Returns

`any`

#### See

https://v8.dev/docs/stack-trace-api#customizing-stack-traces

#### Inherited from

`Error.prepareStackTrace`


[**vaultwarden-secrets**](../README.md)

***

[vaultwarden-secrets](../README.md) / ErrorCode

# Enumeration: ErrorCode

Defined in: [types.ts:17](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L17)

Error codes for secret operations

## Enumeration Members

### CACHE\_ERROR

> **CACHE\_ERROR**: `"CACHE_ERROR"`

Defined in: [types.ts:41](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L41)

***

### DECRYPTION\_FAILED

> **DECRYPTION\_FAILED**: `"DECRYPTION_FAILED"`

Defined in: [types.ts:31](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L31)

***

### ENCRYPTION\_FAILED

> **ENCRYPTION\_FAILED**: `"ENCRYPTION_FAILED"`

Defined in: [types.ts:30](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L30)

***

### FILE\_SYSTEM\_ERROR

> **FILE\_SYSTEM\_ERROR**: `"FILE_SYSTEM_ERROR"`

Defined in: [types.ts:42](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L42)

***

### INVALID\_CATEGORY

> **INVALID\_CATEGORY**: `"INVALID_CATEGORY"`

Defined in: [types.ts:36](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L36)

***

### INVALID\_KEY

> **INVALID\_KEY**: `"INVALID_KEY"`

Defined in: [types.ts:32](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L32)

***

### INVALID\_PATH

> **INVALID\_PATH**: `"INVALID_PATH"`

Defined in: [types.ts:35](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L35)

***

### KEYCHAIN\_ACCESS\_DENIED

> **KEYCHAIN\_ACCESS\_DENIED**: `"KEYCHAIN_ACCESS_DENIED"`

Defined in: [types.ts:20](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L20)

***

### KEYCHAIN\_COMMAND\_FAILED

> **KEYCHAIN\_COMMAND\_FAILED**: `"KEYCHAIN_COMMAND_FAILED"`

Defined in: [types.ts:21](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L21)

***

### KEYCHAIN\_NOT\_FOUND

> **KEYCHAIN\_NOT\_FOUND**: `"KEYCHAIN_NOT_FOUND"`

Defined in: [types.ts:19](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L19)

***

### SECRET\_NOT\_FOUND

> **SECRET\_NOT\_FOUND**: `"SECRET_NOT_FOUND"`

Defined in: [types.ts:37](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L37)

***

### UNKNOWN\_ERROR

> **UNKNOWN\_ERROR**: `"UNKNOWN_ERROR"`

Defined in: [types.ts:40](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L40)

***

### VAULT\_CORRUPTED

> **VAULT\_CORRUPTED**: `"VAULT_CORRUPTED"`

Defined in: [types.ts:26](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L26)

***

### VAULT\_INVALID\_FORMAT

> **VAULT\_INVALID\_FORMAT**: `"VAULT_INVALID_FORMAT"`

Defined in: [types.ts:27](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L27)

***

### VAULT\_LOCKED

> **VAULT\_LOCKED**: `"VAULT_LOCKED"`

Defined in: [types.ts:25](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L25)

***

### VAULT\_NOT\_FOUND

> **VAULT\_NOT\_FOUND**: `"VAULT_NOT_FOUND"`

Defined in: [types.ts:24](https://github.com/rodaddy/vaultwarden-secrets/blob/HEAD/types.ts#L24)
<!-- API END -->

## Testing

Run the test suite:

```bash
bun test
```

Run the example:

```bash
bun run example.ts
```

Type checking:

```bash
bun run typecheck
```

## Performance

### Latency

- **Cache hit:** < 1ms (in-memory decrypt)
- **Cache miss:** 100–500ms (Bitwarden CLI + network)
- **First retrieval:** 500ms–2s (vault sync)

### Memory

- Default cache size: 100 entries max
- Average entry: 0.5–2 KB (depends on secret size)
- Total typical: 50–200 KB in memory + encrypted file

## Troubleshooting

### "Vault is locked" Error

```bash
# Unlock the Bitwarden vault
bw unlock

# Copy the BW_SESSION token and store it:
# await setSession('default', '<BW_SESSION value>');
```

### "Secret not found" Error

```bash
# List available secrets to verify name
bw list items

# Check custom field name (case-sensitive)
bw get item "ItemName"  # View full structure
```

### "Keychain access denied" Error

```bash
# Check Keychain permission for `security` command
# Restart the Keychain agent:
security lock-keychain
security unlock-keychain -p "YOUR_PASSWORD"
```

### Cache Corruption

```typescript
import { clearCache } from 'vaultwarden-secrets';

// Clear all cached data and rebuild from vault
await clearCache();
```

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Write tests for new functionality
4. Ensure type checking passes (`bun run typecheck`)
5. Commit changes (`git commit -m 'Add amazing feature'`)
6. Push to branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

## License

MIT – See [LICENSE](LICENSE) for details.

## Author

Rico – [GitHub](https://github.com/yourusername)

## Acknowledgments

- [Bitwarden](https://bitwarden.com/) – Open-source password manager
- [Vaultwarden](https://github.com/dani-garcia/vaultwarden) – Self-hosted Bitwarden server
- [Bun](https://bun.sh/) – Fast TypeScript runtime
