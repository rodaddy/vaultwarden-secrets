/**
 * Multi-vault configuration management
 *
 * Manages vault configurations stored at ~/.config/vaultwarden-secrets/config.json
 * Provides CRUD operations for vault definitions and active vault tracking.
 *
 * @module vault-config
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { VaultConfig, VaultConfigFile, SecretError, ErrorCode, Constants } from './types';

/**
 * Vault configuration manager
 *
 * Handles loading, saving, and manipulating vault configurations.
 * Stores configuration in {VAULTWARDEN_SECRETS_DIR}/config.json
 * Default: ~/.config/vaultwarden-secrets/config.json
 */
export class VaultManager {
  private config: VaultConfigFile | null = null;
  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath || Constants.CONFIG_PATH;
  }

  /**
   * Load configuration from file
   *
   * @returns Promise resolving to vault configuration
   * @throws {SecretError} If JSON parsing fails
   */
  async loadConfig(): Promise<VaultConfigFile> {
    if (this.config) return this.config;

    if (!existsSync(this.configPath)) {
      // Return default config
      this.config = {
        vaults: {},
        version: '1.0.0',
      };
      return this.config;
    }

    try {
      const content = readFileSync(this.configPath, 'utf-8');
      this.config = JSON.parse(content);
      return this.config!;
    } catch (error) {
      throw new SecretError(
        `Failed to parse vault config: ${error instanceof Error ? error.message : String(error)}`,
        ErrorCode.VAULT_INVALID_FORMAT,
        false,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Save configuration to file
   *
   * Creates parent directories if they don't exist.
   *
   * @throws {SecretError} If no config is loaded or file write fails
   */
  async saveConfig(): Promise<void> {
    if (!this.config) {
      throw new SecretError('No config loaded', ErrorCode.VAULT_NOT_FOUND);
    }

    try {
      // Ensure parent directory exists
      const dir = dirname(this.configPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (error) {
      throw new SecretError(
        `Failed to save vault config: ${error instanceof Error ? error.message : String(error)}`,
        ErrorCode.FILE_SYSTEM_ERROR,
        true,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get active vault ID
   *
   * Returns the default vault if specified, or the first vault in the list,
   * or an empty string if no vaults are configured.
   *
   * @returns Promise resolving to active vault ID
   */
  async getActiveVault(): Promise<string> {
    const config = await this.loadConfig();

    // Check if defaultVault is set
    if (config.defaultVault) {
      return config.defaultVault;
    }

    // Return first vault ID if any exist
    const vaultIds = Object.keys(config.vaults);
    return vaultIds.length > 0 ? vaultIds[0] : '';
  }

  /**
   * Switch active vault
   *
   * @param vaultId - ID of vault to activate
   * @throws {SecretError} If vault not found
   */
  async switchVault(vaultId: string): Promise<void> {
    const config = await this.loadConfig();
    if (!config.vaults[vaultId]) {
      throw new SecretError(`Vault not found: ${vaultId}`, ErrorCode.VAULT_NOT_FOUND);
    }
    config.defaultVault = vaultId;
    await this.saveConfig();
  }

  /**
   * List all configured vaults
   *
   * @returns Promise resolving to array of vault configurations
   */
  async listVaults(): Promise<VaultConfig[]> {
    const config = await this.loadConfig();
    return Object.values(config.vaults);
  }

  /**
   * Get vault by ID
   *
   * @param vaultId - Vault ID to retrieve
   * @returns Promise resolving to vault config or null if not found
   */
  async getVault(vaultId: string): Promise<VaultConfig | null> {
    const config = await this.loadConfig();
    return config.vaults[vaultId] || null;
  }

  /**
   * Add or update a vault
   *
   * @param vaultId - Vault ID to set
   * @param vault - Vault configuration
   */
  async setVault(vaultId: string, vault: VaultConfig): Promise<void> {
    const config = await this.loadConfig();
    config.vaults[vaultId] = vault;
    await this.saveConfig();
  }

  /**
   * Remove a vault
   *
   * If the removed vault is the default/active vault, switches to the first
   * remaining vault or empty string if no vaults remain.
   *
   * @param vaultId - Vault ID to remove
   * @returns Promise resolving to true if removed, false if not found
   */
  async removeVault(vaultId: string): Promise<boolean> {
    const config = await this.loadConfig();
    if (!config.vaults[vaultId]) return false;

    delete config.vaults[vaultId];

    // Update defaultVault if we just deleted it
    if (config.defaultVault === vaultId) {
      const remainingVaults = Object.keys(config.vaults);
      config.defaultVault = remainingVaults.length > 0 ? remainingVaults[0] : undefined;
    }

    await this.saveConfig();
    return true;
  }

  /**
   * Clear cached config (force reload)
   *
   * Use this after external modifications to the config file.
   */
  clearCache(): void {
    this.config = null;
  }
}

// Singleton instance
export const vaultManager = new VaultManager();
