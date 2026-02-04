/**
 * Generator - Create new file versions with secret CLI calls
 */

import { dirname, basename, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import {
  DiscoveredSecret,
  MigrationPlan,
  GeneratedFile,
  OutputLocation,
} from './types';
import { getSecretPath } from './planner';

/**
 * Generate replacement for a secret in a file
 */
function generateReplacement(
  secret: DiscoveredSecret,
  plan: MigrationPlan,
  fileType: 'env' | 'shell' | 'script' | 'config'
): string {
  const path = getSecretPath(secret, plan);

  switch (fileType) {
    case 'env':
      // For .env files, use command substitution
      return `$(secret get "${path}")`;

    case 'shell':
      // For shell configs, export with command substitution
      return `$(secret get "${path}")`;

    case 'script':
      // For scripts, inline command substitution
      return `$(secret get "${path}")`;

    default:
      return `$(secret get "${path}")`;
  }
}

/**
 * Determine file type from path
 */
function getFileType(filePath: string): 'env' | 'shell' | 'script' | 'config' {
  const filename = basename(filePath);

  if (filename.startsWith('.env')) return 'env';
  if (
    filename === '.zshrc' ||
    filename === '.bashrc' ||
    filename === '.profile' ||
    filename === '.zprofile'
  ) {
    return 'shell';
  }
  if (filename.endsWith('.sh')) return 'script';
  return 'config';
}

/**
 * Generate new version of a single file
 */
export async function generateFile(
  filePath: string,
  secrets: DiscoveredSecret[],
  plan: MigrationPlan,
  outputLocation: OutputLocation,
  outputFolder?: string
): Promise<GeneratedFile> {
  const content = await Bun.file(filePath).text();
  const lines = content.split('\n');
  const fileType = getFileType(filePath);
  const replacements: GeneratedFile['replacements'] = [];

  // Sort secrets by line number descending (to replace from bottom up)
  const sortedSecrets = [...secrets].sort(
    (a, b) => b.lineNumber - a.lineNumber
  );

  // Process each secret
  for (const secret of sortedSecrets) {
    if (secret.skipped || !secret.confirmed) continue;

    const lineIndex = secret.lineNumber - 1;
    if (lineIndex < 0 || lineIndex >= lines.length) continue;

    const line = lines[lineIndex];
    const replacement = generateReplacement(secret, plan, fileType);

    // Replace the value in the line
    let newLine: string;
    if (fileType === 'env') {
      // Replace: VAR=value → VAR=$(secret get path)
      newLine = line.replace(
        new RegExp(`(${secret.name}=).*$`),
        `$1${replacement}`
      );
    } else if (fileType === 'shell') {
      // Replace: export VAR=value → export VAR=$(secret get path)
      newLine = line.replace(
        new RegExp(`(export\\s+${secret.name}=).*$`),
        `$1${replacement}`
      );
    } else {
      // Generic replacement
      newLine = line.replace(secret.value, replacement);
    }

    if (newLine !== line) {
      lines[lineIndex] = newLine;
      replacements.push({
        original: line,
        replacement: newLine,
        lineNumber: secret.lineNumber,
      });
    }
  }

  // Determine output path
  let newPath: string;
  const filename = basename(filePath);

  switch (outputLocation) {
    case 'side-by-side':
      newPath = filePath + '.migrated';
      break;

    case 'output-folder':
      if (!outputFolder) {
        const date = new Date().toISOString().split('T')[0];
        outputFolder = join(
          process.env.HOME || '~',
          '.config/pai/migrations',
          date
        );
      }
      if (!existsSync(outputFolder)) {
        mkdirSync(outputFolder, { recursive: true });
      }
      // Preserve relative path structure
      const relPath = filePath.replace(process.env.HOME || '~', '');
      newPath = join(outputFolder, relPath);
      const dir = dirname(newPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      break;

    case 'in-place':
      // Backup original first
      newPath = filePath;
      const backupPath = filePath + '.backup';
      await Bun.write(backupPath, content);
      break;

    default:
      newPath = filePath + '.migrated';
  }

  return {
    originalPath: filePath,
    newPath,
    content: lines.join('\n'),
    replacements,
  };
}

/**
 * Generate all new file versions
 */
export async function generateFiles(
  secrets: DiscoveredSecret[],
  plan: MigrationPlan,
  outputLocation: OutputLocation,
  outputFolder?: string
): Promise<GeneratedFile[]> {
  // Group secrets by source file
  const byFile = new Map<string, DiscoveredSecret[]>();
  for (const secret of secrets) {
    if (secret.skipped || !secret.confirmed) continue;
    const existing = byFile.get(secret.sourcePath) || [];
    existing.push(secret);
    byFile.set(secret.sourcePath, existing);
  }

  // Generate new version for each file
  const files: GeneratedFile[] = [];
  for (const [filePath, fileSecrets] of byFile) {
    const generated = await generateFile(
      filePath,
      fileSecrets,
      plan,
      outputLocation,
      outputFolder
    );
    if (generated.replacements.length > 0) {
      files.push(generated);
    }
  }

  return files;
}

/**
 * Write generated files to disk
 */
export async function writeGeneratedFiles(files: GeneratedFile[]): Promise<void> {
  for (const file of files) {
    await Bun.write(file.newPath, file.content);
  }
}

/**
 * Generate VW import script (bw create commands)
 */
export function generateImportScript(plan: MigrationPlan): string {
  const lines: string[] = [
    '#!/usr/bin/env sh',
    '# VW Import Script - Generated by secret migrate',
    '# Review this script before running!',
    '',
    '# Ensure we have a session',
    'if [ -z "$BW_SESSION" ]; then',
    '  echo "Error: BW_SESSION not set. Run: bw unlock"',
    '  exit 1',
    'fi',
    '',
  ];

  // Create folders first (VW doesn't have explicit folders, but we document it)
  const folders = new Set(plan.secretsToCreate.map((s) => s.folder));
  if (folders.size > 0) {
    lines.push('# Folders to organize secrets:');
    for (const folder of folders) {
      lines.push(`# - ${folder}/`);
    }
    lines.push('');
  }

  // Create items
  lines.push('# Create secret items');
  for (const secret of plan.secretsToCreate) {
    const itemName = `${secret.folder}/${secret.itemName}`;

    // Create JSON for the item
    const item = {
      type: 1, // Login type
      name: itemName,
      login: {
        password: secret.value,
      },
      notes: `Migrated from: ${secret.sources.map((s) => s.path).join(', ')}`,
    };

    const encoded = Buffer.from(JSON.stringify(item)).toString('base64');
    lines.push(`echo '${encoded}' | base64 -d | bw create item`);
  }

  lines.push('');
  lines.push('echo "Import complete!"');

  return lines.join('\n');
}

/**
 * Generate summary of what can be removed
 */
export function generateRemovalSummary(
  secrets: DiscoveredSecret[],
  files: GeneratedFile[]
): string {
  const lines: string[] = [
    '\n🗑️  Files to clean up after migration:\n',
  ];

  // Group by file
  const byFile = new Map<string, DiscoveredSecret[]>();
  for (const secret of secrets.filter((s) => s.confirmed && !s.skipped)) {
    const existing = byFile.get(secret.sourcePath) || [];
    existing.push(secret);
    byFile.set(secret.sourcePath, existing);
  }

  for (const [filePath, fileSecrets] of byFile) {
    const generated = files.find((f) => f.originalPath === filePath);
    if (!generated) continue;

    lines.push(`📄 ${filePath}`);
    lines.push(`   Migrated ${fileSecrets.length} secret(s)`);
    if (generated.newPath !== filePath) {
      lines.push(`   New version: ${generated.newPath}`);
    }
    lines.push('   After verifying migration works:');
    lines.push(`   - If .env file: can delete or gitignore`);
    lines.push(`   - If shell config: replace with new version`);
    lines.push('');
  }

  return lines.join('\n');
}
