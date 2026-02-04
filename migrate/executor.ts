/**
 * Executor - Run VW import commands
 */

import { $ } from 'bun';
import * as readline from 'readline';
import { MigrationPlan, PlannedSecret, SecretAlias } from './types';
import { vaultManager } from '../vault-config';
import { getVaultSession } from '../keychain';

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

/**
 * Create a single secret in VW
 */
async function createSecret(
  secret: PlannedSecret,
  session: string
): Promise<{ success: boolean; error?: string }> {
  const itemName = `${secret.folder}/${secret.itemName}`;

  try {
    // Create the item JSON
    const item = {
      type: 1, // Login type
      name: itemName,
      login: {
        password: secret.value,
      },
      notes: `Migrated from: ${secret.sources.map((s) => s.path).join(', ')}`,
    };

    const encoded = Buffer.from(JSON.stringify(item)).toString('base64');

    // Create in VW
    await $`BW_SESSION=${session} bw create item ${encoded}`.quiet();

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Check for duplicate
    if (message.includes('already exists')) {
      return { success: false, error: 'Item already exists' };
    }

    return { success: false, error: message };
  }
}

/**
 * Save aliases to local config
 */
async function saveAliases(aliases: SecretAlias[]): Promise<void> {
  if (aliases.length === 0) return;

  // Load existing config and add aliases
  const config = await vaultManager.loadConfig();

  if (!config.aliases) {
    (config as any).aliases = {};
  }

  for (const alias of aliases) {
    (config as any).aliases[alias.alias] = alias.target;
  }

  await vaultManager.saveConfig();
}

/**
 * Execute migration plan - create secrets in VW
 */
export async function executePlan(
  plan: MigrationPlan,
  options: { dryRun?: boolean; skipConfirmation?: boolean } = {}
): Promise<{
  created: number;
  failed: number;
  skipped: number;
  errors: Array<{ item: string; error: string }>;
}> {
  const results = {
    created: 0,
    failed: 0,
    skipped: 0,
    errors: [] as Array<{ item: string; error: string }>,
  };

  // Get session
  const vaultId = await vaultManager.getActiveVault();
  const session = await getVaultSession(vaultId);

  if (!session) {
    console.error(red('Error:') + ` No session for vault: ${vaultId}`);
    console.error(dim('Run: bw unlock'));
    return results;
  }

  // Confirm if needed
  if (!options.skipConfirmation && !options.dryRun) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await new Promise<string>((resolve) => {
      rl.question(
        `\nCreate ${plan.secretsToCreate.length} secrets in VW? [y/N]: `,
        resolve
      );
    });
    rl.close();

    if (answer.toLowerCase() !== 'y') {
      console.log(yellow('Aborted.'));
      results.skipped = plan.secretsToCreate.length;
      return results;
    }
  }

  // Sync VW first
  console.log(dim('Syncing with Vaultwarden...'));
  try {
    await $`BW_SESSION=${session} bw sync`.quiet();
  } catch {
    console.error(yellow('Warning:') + ' Sync failed, continuing anyway');
  }

  // Create each secret
  console.log('\nCreating secrets...\n');

  for (const secret of plan.secretsToCreate) {
    const itemName = `${secret.folder}/${secret.itemName}`;
    process.stdout.write(`  ${itemName}... `);

    if (options.dryRun) {
      console.log(dim('[dry run]'));
      results.created++;
      continue;
    }

    const result = await createSecret(secret, session);

    if (result.success) {
      console.log(green('✓'));
      results.created++;
    } else if (result.error === 'Item already exists') {
      console.log(yellow('exists'));
      results.skipped++;
    } else {
      console.log(red('✗'));
      results.failed++;
      results.errors.push({ item: itemName, error: result.error || 'Unknown error' });
    }
  }

  // Save aliases
  if (plan.aliases.length > 0 && !options.dryRun) {
    console.log(dim('\nSaving aliases to config...'));
    await saveAliases(plan.aliases);
    console.log(green('✓') + ` Saved ${plan.aliases.length} alias(es)`);
  }

  // Summary
  console.log('\n' + '─'.repeat(40));
  console.log(`Created: ${green(String(results.created))}`);
  if (results.skipped > 0) {
    console.log(`Skipped (already exist): ${yellow(String(results.skipped))}`);
  }
  if (results.failed > 0) {
    console.log(`Failed: ${red(String(results.failed))}`);
    for (const err of results.errors) {
      console.log(`  ${red('•')} ${err.item}: ${err.error}`);
    }
  }

  return results;
}

/**
 * Verify secrets were created correctly
 */
export async function verifySecrets(
  plan: MigrationPlan
): Promise<{ verified: number; missing: number }> {
  const vaultId = await vaultManager.getActiveVault();
  const session = await getVaultSession(vaultId);

  if (!session) {
    return { verified: 0, missing: plan.secretsToCreate.length };
  }

  let verified = 0;
  let missing = 0;

  console.log('\nVerifying created secrets...\n');

  for (const secret of plan.secretsToCreate) {
    const itemName = `${secret.folder}/${secret.itemName}`;
    process.stdout.write(`  ${itemName}... `);

    try {
      await $`BW_SESSION=${session} bw get item ${itemName}`.quiet();
      console.log(green('✓'));
      verified++;
    } catch {
      console.log(red('missing'));
      missing++;
    }
  }

  return { verified, missing };
}
