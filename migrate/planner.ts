/**
 * Planner - Organize discovered secrets into VW structure
 */

import { relative, dirname } from 'node:path';
import {
  DiscoveredSecret,
  ProjectInfo,
  MigrationPlan,
  PlannedSecret,
  SecretAlias,
} from './types';

/**
 * Find duplicates across projects
 */
function findDuplicates(
  secrets: DiscoveredSecret[]
): Map<string, DiscoveredSecret[]> {
  const byValue = new Map<string, DiscoveredSecret[]>();

  for (const secret of secrets) {
    const existing = byValue.get(secret.value) || [];
    existing.push(secret);
    byValue.set(secret.value, existing);
  }

  // Only keep actual duplicates (2+ occurrences)
  const duplicates = new Map<string, DiscoveredSecret[]>();
  for (const [value, secrets] of byValue) {
    if (secrets.length > 1) {
      duplicates.set(value, secrets);
    }
  }

  return duplicates;
}

/**
 * Determine the best folder for a secret
 */
function determineFolder(
  secret: DiscoveredSecret,
  projects: Map<string, ProjectInfo>
): string {
  // Find which project this secret belongs to
  for (const [projectPath, project] of projects) {
    if (secret.sourcePath.startsWith(projectPath)) {
      return project.name;
    }
  }

  // Fallback to directory name
  const dir = dirname(secret.sourcePath);
  return dir.split('/').pop() || 'default';
}

/**
 * Determine if a secret should be in shared folder
 */
function shouldBeShared(
  secret: DiscoveredSecret,
  duplicates: Map<string, DiscoveredSecret[]>
): boolean {
  const dups = duplicates.get(secret.value);
  if (!dups || dups.length < 2) return false;

  // If same secret appears in 2+ projects, it should be shared
  const projects = new Set(dups.map((d) => dirname(d.sourcePath)));
  return projects.size >= 2;
}

/**
 * Create migration plan from discovered secrets
 */
export function createPlan(
  secrets: DiscoveredSecret[],
  projects: Map<string, ProjectInfo>
): MigrationPlan {
  // Filter to confirmed secrets only
  const confirmed = secrets.filter((s) => s.confirmed && !s.skipped);
  const skipped = secrets.filter((s) => s.skipped);

  // Find duplicates
  const duplicates = findDuplicates(confirmed);

  // Track which secrets we've already planned
  const planned = new Map<string, PlannedSecret>();
  const aliases: SecretAlias[] = [];

  // Process each secret
  for (const secret of confirmed) {
    const isShared = shouldBeShared(secret, duplicates);
    const folder = isShared ? 'shared' : determineFolder(secret, projects);
    const itemName = secret.name;
    const key = `${folder}/${itemName}`;

    // Check if already planned
    const existing = planned.get(key);
    if (existing) {
      // Add this source to existing
      existing.sources.push({
        path: secret.sourcePath,
        varName: secret.name,
        lineNumber: secret.lineNumber,
      });

      // If this was in a different project, create an alias
      if (!isShared) {
        const secretFolder = determineFolder(secret, projects);
        if (secretFolder !== folder) {
          aliases.push({
            alias: `${secretFolder}/${itemName}`,
            target: key,
            reason: `Shared secret accessed from ${secretFolder}`,
          });
        }
      }
    } else {
      // Create new planned secret
      planned.set(key, {
        folder,
        itemName,
        value: secret.value,
        sources: [
          {
            path: secret.sourcePath,
            varName: secret.name,
            lineNumber: secret.lineNumber,
          },
        ],
        isShared,
      });

      // If shared, create aliases for each project that uses it
      if (isShared) {
        const dups = duplicates.get(secret.value) || [];
        for (const dup of dups) {
          const dupFolder = determineFolder(dup, projects);
          if (dupFolder !== 'shared') {
            const aliasKey = `${dupFolder}/${dup.name}`;
            if (!aliases.some((a) => a.alias === aliasKey)) {
              aliases.push({
                alias: aliasKey,
                target: key,
                reason: `Shared secret from ${dupFolder}`,
              });
            }
          }
        }
      }
    }
  }

  // Count duplicates skipped
  let duplicatesSkipped = 0;
  for (const [, dups] of duplicates) {
    duplicatesSkipped += dups.length - 1; // Keep one, skip rest
  }

  return {
    projects: Array.from(projects.values()),
    secretsToCreate: Array.from(planned.values()),
    aliases,
    filesToGenerate: [], // Filled in by generator
    stats: {
      totalSecretsFound: secrets.length,
      duplicatesSkipped,
      userSkipped: skipped.length,
      toCreate: planned.size,
    },
  };
}

/**
 * Get a summary of the plan for display
 */
export function summarizePlan(plan: MigrationPlan): string {
  const lines: string[] = [];

  lines.push('\n📋 Migration Plan\n');

  // Stats
  lines.push('Stats:');
  lines.push(`  Total secrets found: ${plan.stats.totalSecretsFound}`);
  lines.push(`  Duplicates skipped: ${plan.stats.duplicatesSkipped}`);
  lines.push(`  User skipped: ${plan.stats.userSkipped}`);
  lines.push(`  To create in VW: ${plan.stats.toCreate}`);

  // Projects
  lines.push('\nProjects:');
  for (const project of plan.projects) {
    lines.push(`  • ${project.name} (${project.source})`);
  }

  // Secrets by folder
  lines.push('\nSecrets to create:');
  const byFolder = new Map<string, PlannedSecret[]>();
  for (const secret of plan.secretsToCreate) {
    const existing = byFolder.get(secret.folder) || [];
    existing.push(secret);
    byFolder.set(secret.folder, existing);
  }

  for (const [folder, secrets] of byFolder) {
    lines.push(`\n  📁 ${folder}/`);
    for (const secret of secrets) {
      const sources = secret.sources.length > 1
        ? ` (${secret.sources.length} sources)`
        : '';
      lines.push(`    • ${secret.itemName}${sources}`);
    }
  }

  // Aliases
  if (plan.aliases.length > 0) {
    lines.push('\nAliases (cross-project references):');
    for (const alias of plan.aliases) {
      lines.push(`  ${alias.alias} → ${alias.target}`);
    }
  }

  return lines.join('\n');
}

/**
 * Get the secret path for a discovered secret based on the plan
 */
export function getSecretPath(
  secret: DiscoveredSecret,
  plan: MigrationPlan
): string {
  // Check aliases first
  for (const alias of plan.aliases) {
    if (alias.alias.endsWith(`/${secret.name}`)) {
      return alias.target;
    }
  }

  // Find in planned secrets
  for (const planned of plan.secretsToCreate) {
    if (planned.sources.some((s) => s.varName === secret.name)) {
      return `${planned.folder}/${planned.itemName}`;
    }
  }

  // Fallback
  return `default/${secret.name}`;
}
