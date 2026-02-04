#!/usr/bin/env bun

/**
 * Example usage of the secrets management library
 */

import {
  getSecret,
  getSecretObject,
  listSecrets,
  getCacheStats,
  getActiveVault,
  SecretError,
  ErrorCode
} from './index';

async function example() {
  try {
    // Get the active vault
    const vault = await getActiveVault();
    console.log(`📦 Active vault: ${vault || 'none configured'}`);

    // Example: Get a secret (requires vault to be unlocked)
    // const password = await getSecret('github-pat');
    // console.log('Got password:', password.substring(0, 4) + '...');

    // Example: Get a custom field
    // const apiKey = await getSecret('github-pat.fields.API_KEY');
    // console.log('Got API key:', apiKey.substring(0, 4) + '...');

    // Example: Get all fields from an item
    // const allFields = await getSecretObject('github-pat');
    // console.log('All fields:', Object.keys(allFields));

    // Example: List available secrets
    // const secrets = await listSecrets();
    // console.log('Available secrets:', secrets);

    // Example: Filter secrets
    // const githubSecrets = await listSecrets('github');
    // console.log('GitHub secrets:', githubSecrets);

    // Check cache statistics
    const stats = getCacheStats();
    console.log('\n📊 Cache statistics:');
    console.log(`  - Entries: ${stats.entries}`);
    console.log(`  - Hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);
    console.log(`  - Hits: ${stats.hits}`);
    console.log(`  - Misses: ${stats.misses}`);

  } catch (error) {
    if (error instanceof SecretError) {
      switch (error.code) {
        case ErrorCode.VAULT_LOCKED:
          console.error('❌ Vault is locked. Run: bw unlock');
          break;
        case ErrorCode.SECRET_NOT_FOUND:
          console.error('❌ Secret not found:', error.message);
          break;
        default:
          console.error('❌ Error:', error.message);
      }
    } else {
      console.error('❌ Unexpected error:', error);
    }
  }
}

// Run the example
console.log('🔐 Secrets Management Library Example\n');
example();