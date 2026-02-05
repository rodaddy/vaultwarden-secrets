/**
 * Migration manifest - tracks what was created/aliased per source file
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Constants } from '../types';

export interface MigrationRecord {
  /** VW items created */
  created: string[];
  /** Aliases added (alias → target) */
  aliased: Record<string, string>;
  /** Timestamp of migration */
  timestamp: string;
  /** Generated .migrated file path */
  migratedFile?: string;
}

export interface MigrationManifest {
  version: string;
  /** Source file path → migration record */
  migrations: Record<string, MigrationRecord>;
}

const MANIFEST_PATH = `${dirname(Constants.CONFIG_PATH)}/migrations.json`;

/**
 * Load migration manifest
 */
export function loadManifest(): MigrationManifest {
  if (!existsSync(MANIFEST_PATH)) {
    return { version: '1.0.0', migrations: {} };
  }

  try {
    const content = readFileSync(MANIFEST_PATH, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { version: '1.0.0', migrations: {} };
  }
}

/**
 * Save migration manifest
 */
export function saveManifest(manifest: MigrationManifest): void {
  const dir = dirname(MANIFEST_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

/**
 * Record a migration
 */
export function recordMigration(
  sourcePath: string,
  record: Omit<MigrationRecord, 'timestamp'>
): void {
  const manifest = loadManifest();

  // Merge with existing record if present
  const existing = manifest.migrations[sourcePath];
  if (existing) {
    manifest.migrations[sourcePath] = {
      created: [...new Set([...existing.created, ...record.created])],
      aliased: { ...existing.aliased, ...record.aliased },
      timestamp: new Date().toISOString(),
      migratedFile: record.migratedFile || existing.migratedFile,
    };
  } else {
    manifest.migrations[sourcePath] = {
      ...record,
      timestamp: new Date().toISOString(),
    };
  }

  saveManifest(manifest);
}

/**
 * Get migration record for a source
 */
export function getMigration(sourcePath: string): MigrationRecord | undefined {
  const manifest = loadManifest();
  return manifest.migrations[sourcePath];
}

/**
 * Clear migration record for a source
 */
export function clearMigration(sourcePath: string): MigrationRecord | undefined {
  const manifest = loadManifest();
  const record = manifest.migrations[sourcePath];

  if (record) {
    delete manifest.migrations[sourcePath];
    saveManifest(manifest);
  }

  return record;
}

/**
 * Clear all migration records
 */
export function clearAllMigrations(): MigrationManifest {
  const manifest = loadManifest();
  const cleared = { ...manifest };

  manifest.migrations = {};
  saveManifest(manifest);

  return cleared;
}

/**
 * List all migrated sources
 */
export function listMigrations(): Array<{ source: string; record: MigrationRecord }> {
  const manifest = loadManifest();
  return Object.entries(manifest.migrations).map(([source, record]) => ({
    source,
    record,
  }));
}
