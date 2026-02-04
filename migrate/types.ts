/**
 * Migration types for secret discovery and import
 */

/**
 * A discovered secret from scanning
 */
export interface DiscoveredSecret {
  /** Original variable name (e.g., POSTGRES_PASSWORD) */
  name: string;

  /** The secret value */
  value: string;

  /** Source file path */
  sourcePath: string;

  /** Line number in source file */
  lineNumber: number;

  /** How it was detected */
  detection: 'pattern' | 'export' | 'manual';

  /** Confidence level */
  confidence: 'high' | 'medium' | 'low';

  /** Suggested VW folder */
  suggestedFolder?: string;

  /** Suggested VW item name */
  suggestedItem?: string;

  /** Is this a duplicate of another secret? */
  duplicateOf?: string;

  /** User confirmed this is a secret */
  confirmed?: boolean;

  /** User marked to skip */
  skipped?: boolean;
}

/**
 * Project info detected from directory
 */
export interface ProjectInfo {
  /** Project name (from package.json, .git, or dir name) */
  name: string;

  /** Root directory */
  path: string;

  /** How the name was detected */
  source: 'package.json' | 'git' | 'directory';

  /** Secrets found in this project */
  secrets: DiscoveredSecret[];
}

/**
 * Scan configuration
 */
export interface ScanConfig {
  /** Paths to scan (files or directories) */
  paths: string[];

  /** Max depth for directory recursion */
  maxDepth: number;

  /** File patterns to include */
  filePatterns: string[];

  /** Patterns to exclude */
  excludePatterns: string[];

  /** Interactive mode (ask for ambiguous) */
  interactive: boolean;
}

/**
 * Migration plan - what will be created in VW
 */
export interface MigrationPlan {
  /** Projects discovered */
  projects: ProjectInfo[];

  /** Secrets to create */
  secretsToCreate: PlannedSecret[];

  /** Aliases to configure */
  aliases: SecretAlias[];

  /** Files to generate */
  filesToGenerate: GeneratedFile[];

  /** Summary stats */
  stats: {
    totalSecretsFound: number;
    duplicatesSkipped: number;
    userSkipped: number;
    toCreate: number;
  };
}

/**
 * A secret planned for VW creation
 */
export interface PlannedSecret {
  /** VW folder path */
  folder: string;

  /** VW item name */
  itemName: string;

  /** Field name (if adding to existing item) */
  fieldName?: string;

  /** The value to store */
  value: string;

  /** Original source(s) */
  sources: Array<{
    path: string;
    varName: string;
    lineNumber: number;
  }>;

  /** Is this in the shared folder? */
  isShared: boolean;
}

/**
 * Alias configuration for cross-project references
 */
export interface SecretAlias {
  /** The alias path (e.g., projectB/DB_PASSWORD) */
  alias: string;

  /** The target path (e.g., projectA/DB_PASSWORD) */
  target: string;

  /** Why this alias exists */
  reason: string;
}

/**
 * A file to be generated with secret CLI calls
 */
export interface GeneratedFile {
  /** Original file path */
  originalPath: string;

  /** New file path */
  newPath: string;

  /** New file content */
  content: string;

  /** Secrets replaced in this file */
  replacements: Array<{
    original: string;
    replacement: string;
    lineNumber: number;
  }>;
}

/**
 * Output location preference
 */
export type OutputLocation = 'side-by-side' | 'output-folder' | 'in-place';

/**
 * Pattern categories for detection
 */
export const SECRET_PATTERNS = [
  'PASSWORD',
  'SECRET',
  'TOKEN',
  'API_KEY',
  'APIKEY',
  'API-KEY',
  'CREDENTIAL',
  'PRIVATE_KEY',
  'PRIVATE-KEY',
  'AUTH',
  'ACCESS_KEY',
  'ACCESS-KEY',
  'CLIENT_SECRET',
  'CLIENT-SECRET',
] as const;

/**
 * File patterns to scan
 */
export const DEFAULT_FILE_PATTERNS = [
  '.env',
  '.env.*',
  '.env.local',
  '.env.development',
  '.env.production',
  '.zshrc',
  '.bashrc',
  '.profile',
  '.zprofile',
  '*.sh',
  'config.json',
  'config.yaml',
  'config.yml',
  'config.toml',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
] as const;

/**
 * Patterns to exclude from scanning
 */
export const DEFAULT_EXCLUDE_PATTERNS = [
  'node_modules',
  '.git',
  'vendor',
  'dist',
  'build',
  '.cache',
  '*.backup',
  '*.bak',
  '*.migrated',
] as const;
