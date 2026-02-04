/**
 * Scanner - Recursively find files that may contain secrets
 */

import { readdir, stat } from 'node:fs/promises';
import { join, basename, relative } from 'node:path';
import { existsSync } from 'node:fs';
import {
  ScanConfig,
  ProjectInfo,
  DEFAULT_FILE_PATTERNS,
  DEFAULT_EXCLUDE_PATTERNS,
} from './types';

/**
 * Check if a filename matches any of the patterns
 */
function matchesPattern(filename: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    // Exact match
    if (filename === pattern) return true;

    // Wildcard match (*.sh, .env.*)
    if (pattern.includes('*')) {
      const regex = new RegExp(
        '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$'
      );
      if (regex.test(filename)) return true;
    }

    // Prefix match (.env.local matches .env.*)
    if (pattern.endsWith('*') && filename.startsWith(pattern.slice(0, -1))) {
      return true;
    }
  }
  return false;
}

/**
 * Check if path should be excluded
 */
function shouldExclude(path: string, excludePatterns: readonly string[]): boolean {
  const parts = path.split('/');
  for (const part of parts) {
    if (matchesPattern(part, excludePatterns)) return true;
  }
  return false;
}

/**
 * Detect project info from a directory
 */
export async function detectProject(dirPath: string): Promise<ProjectInfo> {
  let name = basename(dirPath);
  let source: ProjectInfo['source'] = 'directory';

  // Try package.json first
  const packageJsonPath = join(dirPath, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = await Bun.file(packageJsonPath).json();
      if (pkg.name) {
        name = pkg.name;
        source = 'package.json';
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Try .git for repo name
  if (source === 'directory') {
    const gitConfigPath = join(dirPath, '.git', 'config');
    if (existsSync(gitConfigPath)) {
      try {
        const gitConfig = await Bun.file(gitConfigPath).text();
        const match = gitConfig.match(/url\s*=\s*.*\/([^\/\s]+?)(?:\.git)?$/m);
        if (match) {
          name = match[1];
          source = 'git';
        }
      } catch {
        // Ignore
      }
    }
  }

  return {
    name,
    path: dirPath,
    source,
    secrets: [],
  };
}

/**
 * Recursively scan a directory for files matching patterns
 */
export async function scanDirectory(
  dirPath: string,
  config: ScanConfig,
  currentDepth: number = 0
): Promise<string[]> {
  const results: string[] = [];

  if (currentDepth > config.maxDepth) return results;

  const relPath = relative(config.paths[0], dirPath) || '.';
  if (shouldExclude(relPath, config.excludePatterns)) return results;

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        // Recurse into subdirectories
        const subResults = await scanDirectory(fullPath, config, currentDepth + 1);
        results.push(...subResults);
      } else if (entry.isFile()) {
        // Check if file matches patterns
        if (matchesPattern(entry.name, config.filePatterns)) {
          if (!shouldExclude(entry.name, config.excludePatterns)) {
            results.push(fullPath);
          }
        }
      }
    }
  } catch (error) {
    // Permission denied or other errors - skip
    console.error(`Warning: Could not scan ${dirPath}: ${error}`);
  }

  return results;
}

/**
 * Scan multiple paths (files or directories)
 */
export async function scan(config: Partial<ScanConfig> = {}): Promise<{
  files: string[];
  projects: Map<string, ProjectInfo>;
}> {
  const fullConfig: ScanConfig = {
    paths: config.paths || ['.'],
    maxDepth: config.maxDepth ?? 3,
    filePatterns: config.filePatterns || [...DEFAULT_FILE_PATTERNS],
    excludePatterns: config.excludePatterns || [...DEFAULT_EXCLUDE_PATTERNS],
    interactive: config.interactive ?? true,
  };

  const files: string[] = [];
  const projects = new Map<string, ProjectInfo>();

  for (const path of fullConfig.paths) {
    try {
      const stats = await stat(path);

      if (stats.isFile()) {
        files.push(path);
        // Find project root for this file
        let projectRoot = join(path, '..');
        while (
          projectRoot !== '/' &&
          !existsSync(join(projectRoot, 'package.json')) &&
          !existsSync(join(projectRoot, '.git'))
        ) {
          projectRoot = join(projectRoot, '..');
        }
        if (!projects.has(projectRoot)) {
          projects.set(projectRoot, await detectProject(projectRoot));
        }
      } else if (stats.isDirectory()) {
        // Scan directory
        const foundFiles = await scanDirectory(path, fullConfig);
        files.push(...foundFiles);

        // Detect project info
        if (!projects.has(path)) {
          projects.set(path, await detectProject(path));
        }

        // Also detect subprojects (directories with package.json or .git)
        for (const file of foundFiles) {
          let dir = join(file, '..');
          while (dir !== path && dir !== '/') {
            if (
              (existsSync(join(dir, 'package.json')) ||
                existsSync(join(dir, '.git'))) &&
              !projects.has(dir)
            ) {
              projects.set(dir, await detectProject(dir));
              break;
            }
            dir = join(dir, '..');
          }
        }
      }
    } catch (error) {
      console.error(`Warning: Could not access ${path}: ${error}`);
    }
  }

  return { files, projects };
}

/**
 * Get default scan config
 */
export function getDefaultConfig(): ScanConfig {
  return {
    paths: ['.'],
    maxDepth: 3,
    filePatterns: [...DEFAULT_FILE_PATTERNS],
    excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS],
    interactive: true,
  };
}
