#!/usr/bin/env bun
/**
 * CLI for vaultwarden-secrets
 *
 * Commands:
 *   set-session <vault> <session>  - Store Bitwarden session token
 *   get <path>                     - Get a secret value
 *   list-vaults                    - List configured vaults
 *   cache-stats                    - Show cache statistics
 *   clear-cache [vault]            - Clear cache (optionally for specific vault)
 */

import { getSecret, setSession, listVaults } from './index';
import { secretCache } from './cache';
import { snapshotManager } from './snapshot';
import { getVaultSession } from './keychain';

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const [command, ...commandArgs] = process.argv.slice(2);

async function main() {
  try {
    switch (command) {
      case 'set-session': {
        const [vault, session] = commandArgs;
        if (!vault || !session) {
          console.error(red('Usage: bun run cli.ts set-session <vault> <session>'));
          process.exit(1);
        }
        await setSession(vault, session);
        console.log(green(`✓ Session stored for vault '${vault}'`));
        break;
      }

      case 'get': {
        const [path] = commandArgs;
        if (!path) {
          console.error(red('Usage: bun run cli.ts get <path>'));
          console.error(dim('Example: bun run cli.ts get github-pat.token'));
          process.exit(1);
        }
        const value = await getSecret(path);
        if (value) {
          console.log(value);
        } else {
          console.error(red(`Secret not found: ${path}`));
          process.exit(1);
        }
        break;
      }

      case 'list-vaults': {
        const vaults = await listVaults();
        if (vaults.length === 0) {
          console.log(yellow('No vaults configured'));
          console.log(dim('Use "bun run cli.ts set-session <vault> <session>" to add a vault'));
        } else {
          console.log(bold('Configured vaults:'));
          for (const vault of vaults) {
            const marker = vault.default ? green(' (default)') : '';
            console.log(`  - ${vault.name}${marker}`);
            if (vault.description) {
              console.log(`    ${dim(vault.description)}`);
            }
          }
        }
        break;
      }

      case 'cache-stats': {
        const stats = secretCache.getStats();
        console.log(bold('Cache Statistics:'));
        console.log(`  Entries:     ${stats.entries}/${stats.maxSize}`);
        console.log(`  Hit Rate:    ${(stats.hitRate * 100).toFixed(1)}%`);
        console.log(`  Hits:        ${stats.hits}`);
        console.log(`  Misses:      ${stats.misses}`);
        console.log(`  Evictions:   ${stats.evictions}`);
        console.log(`  Expirations: ${stats.expirations}`);
        if (stats.vaults.length > 0) {
          console.log(`  Vaults:      ${stats.vaults.join(', ')}`);
        }
        break;
      }

      case 'clear-cache': {
        const [vault] = commandArgs;
        await secretCache.clear(vault);
        if (vault) {
          console.log(green(`✓ Cache cleared for vault '${vault}'`));
        } else {
          console.log(green('✓ Cache cleared for all vaults'));
        }
        break;
      }

      case 'snapshot': {
        const isInfo = commandArgs.includes('--info');

        if (isInfo) {
          // Show existing snapshot metadata without creating
          const metadata = await snapshotManager.getMetadata();
          if (!metadata) {
            console.log(yellow('No snapshot found'));
            console.log(dim('Run "bun run cli.ts snapshot" to create one'));
          } else {
            console.log(bold('Snapshot Metadata:'));
            console.log(`  Vault:       ${metadata.vaultId}`);
            console.log(`  Items:       ${metadata.itemCount}`);
            console.log(`  Size:        ${(metadata.fileSizeBytes / 1024).toFixed(1)} KB`);
            console.log(`  Created:     ${new Date(metadata.createdAt).toLocaleString()}`);
            const stalenessColor = metadata.isStale ? yellow : green;
            console.log(`  Status:      ${stalenessColor(metadata.isStale ? 'stale' : 'fresh')}`);
          }
        } else {
          // Create new snapshot
          const session = await getVaultSession('default');
          if (!session) {
            console.error(red('No session found for default vault'));
            console.error(dim('Run "bun run cli.ts set-session default <session>" first'));
            process.exit(1);
          }

          console.log(dim('Creating snapshot...'));
          const metadata = await snapshotManager.createSnapshot('default', session);

          console.log(green('✓ Snapshot created'));
          console.log(`  Vault:       ${metadata.vaultId}`);
          console.log(`  Items:       ${metadata.itemCount}`);
          console.log(`  Size:        ${(metadata.fileSizeBytes / 1024).toFixed(1)} KB`);
          console.log(`  Created:     ${new Date(metadata.createdAt).toLocaleString()}`);
        }
        break;
      }

      case 'help':
      case '--help':
      case undefined: {
        console.log(`
${bold('vaultwarden-secrets CLI')}

${bold('Commands:')}
  set-session <vault> <session>  Store Bitwarden session token
  get <path>                     Get a secret value
  list-vaults                    List configured vaults
  cache-stats                    Show cache statistics
  clear-cache [vault]            Clear cache
  snapshot                       Create new snapshot
  snapshot --info                Show existing snapshot metadata

${bold('Examples:')}
  # Store session for default vault
  bun run cli.ts set-session default YOUR_SESSION_TOKEN

  # Get a secret
  bun run cli.ts get github-pat.token
  bun run cli.ts get work:api-key.secret

  # View cache stats
  bun run cli.ts cache-stats

  # Clear cache
  bun run cli.ts clear-cache
  bun run cli.ts clear-cache work

  # Snapshot operations
  bun run cli.ts snapshot
  bun run cli.ts snapshot --info
`);
        break;
      }

      default: {
        console.error(red(`Unknown command: ${command}`));
        console.error(dim('Run "bun run cli.ts help" for usage'));
        process.exit(1);
      }
    }
  } catch (error) {
    console.error(red('Error:'), error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();