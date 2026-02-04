/**
 * Detector - Parse files and identify secrets
 */

import * as readline from 'readline';
import { DiscoveredSecret, SECRET_PATTERNS } from './types';

// Colors for interactive prompts
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

/**
 * Check if a variable name looks like a secret
 */
export function looksLikeSecret(name: string): {
  isSecret: boolean;
  confidence: 'high' | 'medium' | 'low';
} {
  const upperName = name.toUpperCase();

  // High confidence patterns
  for (const pattern of SECRET_PATTERNS) {
    if (upperName.includes(pattern)) {
      return { isSecret: true, confidence: 'high' };
    }
  }

  // Medium confidence - looks like it could be sensitive
  if (
    upperName.includes('KEY') ||
    upperName.includes('PASS') ||
    upperName.includes('PWD') ||
    upperName.includes('CRED') ||
    upperName.includes('PRIV')
  ) {
    return { isSecret: true, confidence: 'medium' };
  }

  // Low confidence - generic assignments that might be secrets
  if (
    upperName.includes('URL') ||
    upperName.includes('HOST') ||
    upperName.includes('USER') ||
    upperName.includes('DB_') ||
    upperName.includes('DATABASE')
  ) {
    return { isSecret: true, confidence: 'low' };
  }

  return { isSecret: false, confidence: 'low' };
}

/**
 * Parse .env style files
 */
function parseEnvFile(content: string, filePath: string): DiscoveredSecret[] {
  const secrets: DiscoveredSecret[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip comments and empty lines
    if (!line || line.startsWith('#')) continue;

    // Match: NAME=value or export NAME=value
    const match = line.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/i);
    if (match) {
      const [, name, rawValue] = match;

      // Clean up value (remove quotes)
      let value = rawValue.trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      // Skip empty values
      if (!value) continue;

      const { isSecret, confidence } = looksLikeSecret(name);

      secrets.push({
        name,
        value,
        sourcePath: filePath,
        lineNumber: i + 1,
        detection: isSecret ? 'pattern' : 'export',
        confidence,
      });
    }
  }

  return secrets;
}

/**
 * Parse shell config files (.zshrc, .bashrc)
 */
function parseShellConfig(content: string, filePath: string): DiscoveredSecret[] {
  const secrets: DiscoveredSecret[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip comments
    if (line.startsWith('#')) continue;

    // Match export statements
    const match = line.match(/^export\s+([A-Z_][A-Z0-9_]*)=(.*)$/i);
    if (match) {
      const [, name, rawValue] = match;

      // Clean up value
      let value = rawValue.trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      // Skip if value contains command substitution (not a static secret)
      if (value.includes('$(') || value.includes('`')) continue;

      // Skip empty values
      if (!value) continue;

      const { isSecret, confidence } = looksLikeSecret(name);

      // Only include if it looks like a secret (shell configs have lots of non-secrets)
      if (isSecret) {
        secrets.push({
          name,
          value,
          sourcePath: filePath,
          lineNumber: i + 1,
          detection: 'pattern',
          confidence,
        });
      }
    }
  }

  return secrets;
}

/**
 * Parse JSON config files
 */
function parseJsonConfig(content: string, filePath: string): DiscoveredSecret[] {
  const secrets: DiscoveredSecret[] = [];

  try {
    const data = JSON.parse(content);

    function traverse(obj: any, path: string[] = [], lineHint: number = 1) {
      if (typeof obj === 'object' && obj !== null) {
        for (const [key, value] of Object.entries(obj)) {
          const currentPath = [...path, key];
          if (typeof value === 'string') {
            const { isSecret, confidence } = looksLikeSecret(key);
            if (isSecret && value.length > 0) {
              secrets.push({
                name: currentPath.join('.'),
                value,
                sourcePath: filePath,
                lineNumber: lineHint, // Approximate
                detection: 'pattern',
                confidence,
              });
            }
          } else if (typeof value === 'object') {
            traverse(value, currentPath, lineHint);
          }
        }
      }
    }

    traverse(data);
  } catch {
    // Invalid JSON - skip
  }

  return secrets;
}

/**
 * Parse YAML config files
 */
function parseYamlConfig(content: string, filePath: string): DiscoveredSecret[] {
  const secrets: DiscoveredSecret[] = [];
  const lines = content.split('\n');

  // Simple YAML parsing (key: value pairs)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip comments and empty lines
    if (line.trim().startsWith('#') || !line.trim()) continue;

    // Match simple key: value pairs
    const match = line.match(/^(\s*)([a-zA-Z_][a-zA-Z0-9_]*):\s*(.+)$/);
    if (match) {
      const [, , key, rawValue] = match;

      // Clean up value
      let value = rawValue.trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      // Skip multi-line, objects, arrays
      if (value === '|' || value === '>' || value.startsWith('-') || value.startsWith('{')) {
        continue;
      }

      const { isSecret, confidence } = looksLikeSecret(key);
      if (isSecret && value.length > 0) {
        secrets.push({
          name: key,
          value,
          sourcePath: filePath,
          lineNumber: i + 1,
          detection: 'pattern',
          confidence,
        });
      }
    }
  }

  return secrets;
}

/**
 * Parse shell scripts for hardcoded secrets
 */
function parseShellScript(content: string, filePath: string): DiscoveredSecret[] {
  const secrets: DiscoveredSecret[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip comments
    if (line.trim().startsWith('#')) continue;

    // Match variable assignments
    const match = line.match(/([A-Z_][A-Z0-9_]*)=["']?([^"'\s]+)["']?/i);
    if (match) {
      const [, name, value] = match;

      // Skip if value contains variable expansion
      if (value.includes('$') || value.includes('`')) continue;

      const { isSecret, confidence } = looksLikeSecret(name);
      if (isSecret && value.length > 0) {
        secrets.push({
          name,
          value,
          sourcePath: filePath,
          lineNumber: i + 1,
          detection: 'pattern',
          confidence,
        });
      }
    }
  }

  return secrets;
}

/**
 * Detect secrets in a file
 */
export async function detectSecrets(filePath: string): Promise<DiscoveredSecret[]> {
  const content = await Bun.file(filePath).text();
  const filename = filePath.split('/').pop() || '';

  // Route to appropriate parser
  if (filename.startsWith('.env')) {
    return parseEnvFile(content, filePath);
  }

  if (filename === '.zshrc' || filename === '.bashrc' ||
      filename === '.profile' || filename === '.zprofile') {
    return parseShellConfig(content, filePath);
  }

  if (filename.endsWith('.json')) {
    return parseJsonConfig(content, filePath);
  }

  if (filename.endsWith('.yaml') || filename.endsWith('.yml') ||
      filename.endsWith('.toml')) {
    return parseYamlConfig(content, filePath);
  }

  if (filename.endsWith('.sh')) {
    return parseShellScript(content, filePath);
  }

  // Fallback: try env-style parsing
  return parseEnvFile(content, filePath);
}

/**
 * Mask a secret value for display
 */
export function maskValue(value: string): string {
  if (value.length <= 8) return '••••••••';
  return value.slice(0, 4) + '••••' + value.slice(-4);
}

/**
 * Deduplicate same-name secrets within a file, keeping last value (shell semantics)
 * Returns deduplicated list and any conflicts for display
 */
export function deduplicateSameNameSecrets(
  secrets: DiscoveredSecret[]
): { deduplicated: DiscoveredSecret[]; conflicts: Map<string, DiscoveredSecret[]> } {
  // Group by (sourcePath, name) to find same-name duplicates within a file
  const byKey = new Map<string, DiscoveredSecret[]>();

  for (const secret of secrets) {
    const key = `${secret.sourcePath}:${secret.name}`;
    const existing = byKey.get(key) || [];
    existing.push(secret);
    byKey.set(key, existing);
  }

  const deduplicated: DiscoveredSecret[] = [];
  const conflicts = new Map<string, DiscoveredSecret[]>();

  for (const [key, group] of byKey) {
    if (group.length === 1) {
      // No duplicates, keep as-is
      deduplicated.push(group[0]);
    } else {
      // Multiple entries with same name - check if values differ
      const uniqueValues = new Set(group.map(s => s.value));

      if (uniqueValues.size === 1) {
        // Same value, just keep last occurrence
        deduplicated.push(group[group.length - 1]);
      } else {
        // Different values - this is a conflict
        // Sort by line number (ascending), then take last (highest line = last in file)
        const sorted = [...group].sort((a, b) => a.lineNumber - b.lineNumber);
        const last = sorted[sorted.length - 1];
        deduplicated.push(last);

        // Store all values in reverse order (last/newest first) for display
        conflicts.set(key, sorted.reverse());
      }
    }
  }

  return { deduplicated, conflicts };
}

/**
 * Display conflicts to user
 */
function showConflicts(conflicts: Map<string, DiscoveredSecret[]>): void {
  if (conflicts.size === 0) return;

  console.log(yellow('\n⚠️  Same-name secrets with different values found:'));
  console.log(dim('  Using last value (shell semantics). All values shown newest-first:\n'));

  for (const [key, secrets] of conflicts) {
    const name = secrets[0].name;
    console.log(bold(`  ${name}:`));

    secrets.forEach((s, idx) => {
      const marker = idx === 0 ? green('→') : dim(' ');
      const note = idx === 0 ? dim(' (will use)') : '';
      console.log(`    ${marker} ${cyan(maskValue(s.value))} ${dim(`line ${s.lineNumber}`)}${note}`);
    });
    console.log('');
  }
}

/**
 * Interactive prompt to confirm ambiguous secrets
 */
export async function confirmSecrets(
  secrets: DiscoveredSecret[],
  interactive: boolean
): Promise<DiscoveredSecret[]> {
  // First, deduplicate same-name secrets (keep last value per shell semantics)
  const { deduplicated, conflicts } = deduplicateSameNameSecrets(secrets);

  // Show any conflicts found
  if (conflicts.size > 0) {
    showConflicts(conflicts);
  }

  if (!interactive) {
    // Auto-confirm high confidence, skip low
    return deduplicated.map((s) => ({
      ...s,
      confirmed: s.confidence === 'high' || s.confidence === 'medium',
      skipped: s.confidence === 'low',
    }));
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, resolve));

  const confirmed: DiscoveredSecret[] = [];

  for (const secret of deduplicated) {
    // Auto-confirm high confidence
    if (secret.confidence === 'high') {
      confirmed.push({ ...secret, confirmed: true });
      continue;
    }

    // Ask for medium/low confidence
    console.log(`\n${bold(secret.name)} = ${cyan(maskValue(secret.value))}`);
    console.log(dim(`  ${secret.sourcePath}:${secret.lineNumber}`));
    console.log(dim(`  Confidence: ${secret.confidence}`));

    const answer = await ask('  Is this a secret? [Y/n/s(skip all similar)]: ');
    const normalized = answer.toLowerCase().trim();

    if (normalized === 'n') {
      confirmed.push({ ...secret, skipped: true });
    } else if (normalized === 's') {
      // Skip all with same name pattern
      confirmed.push({ ...secret, skipped: true });
      // Mark future ones with same name as skipped
      for (let i = secrets.indexOf(secret) + 1; i < secrets.length; i++) {
        if (secrets[i].name === secret.name) {
          secrets[i].skipped = true;
        }
      }
    } else {
      confirmed.push({ ...secret, confirmed: true });
    }
  }

  rl.close();
  return confirmed;
}
