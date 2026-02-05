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
