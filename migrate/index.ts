/**
 * Migration orchestrator - Main entry point for secret migration
 */

import * as readline from 'readline';
import {
  ScanConfig,
  DiscoveredSecret,
  MigrationPlan,
  OutputLocation,
  DEFAULT_FILE_PATTERNS,
  DEFAULT_EXCLUDE_PATTERNS,
} from './types';
import { scan, getDefaultConfig } from './scanner';
import { detectSecrets, confirmSecrets, maskValue } from './detector';
import { createPlan, summarizePlan } from './planner';
import {
  generateFiles,
  writeGeneratedFiles,
  generateImportScript,
  generateRemovalSummary,
} from './generator';
import { executePlan, verifySecrets } from './executor';

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

/**
 * Ask a question and get answer
 */
function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

/**
 * Migration options
 */
export interface MigrateOptions {
  /** Paths to scan */
  paths?: string[];

  /** Max depth for directory scan */
  maxDepth?: number;

  /** Interactive mode */
  interactive?: boolean;

  /** Output location for generated files */
  outputLocation?: OutputLocation;

  /** Custom output folder (for output-folder mode) */
  outputFolder?: string;

  /** Dry run - don't actually create in VW */
  dryRun?: boolean;

  /** Skip VW creation (plan and generate only) */
  skipVwCreation?: boolean;

  /** Auto-confirm all prompts */
  autoConfirm?: boolean;

  /** List only - scan and show, don't migrate */
  listOnly?: boolean;
}

/**
 * Run the full migration workflow
 */
export async function migrate(options: MigrateOptions = {}): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log(bold('\n🔐 Secret Migration Wizard\n'));

    // === STEP 1: Determine paths to scan ===
    let paths = options.paths || [];

    if (paths.length === 0) {
      console.log('What would you like to scan?');
      console.log(dim('  Enter paths separated by spaces, or press Enter for current directory'));
      const input = await ask(rl, '\nPaths: ');
      paths = input.trim() ? input.trim().split(/\s+/) : ['.'];
    }

    console.log(`\n${dim('Scanning:')} ${paths.join(', ')}\n`);

    // === STEP 2: Scan for files ===
    const config: Partial<ScanConfig> = {
      paths,
      maxDepth: options.maxDepth ?? 3,
      filePatterns: [...DEFAULT_FILE_PATTERNS],
      excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS],
      interactive: options.interactive ?? true,
    };

    const { files, projects } = await scan(config);

    console.log(`Found ${cyan(String(files.length))} files in ${cyan(String(projects.size))} project(s)\n`);

    if (files.length === 0) {
      console.log(yellow('No matching files found.'));
      rl.close();
      return;
    }

    // Show projects
    console.log(bold('Projects detected:'));
    for (const [, project] of projects) {
      console.log(`  ${green('•')} ${project.name} ${dim(`(${project.source})`)}`);
    }
    console.log('');

    // === STEP 3: Detect secrets ===
    console.log(dim('Scanning files for secrets...'));

    const allSecrets: DiscoveredSecret[] = [];
    for (const file of files) {
      try {
        const secrets = await detectSecrets(file);
        allSecrets.push(...secrets);
      } catch (error) {
        console.error(dim(`  Warning: Could not parse ${file}`));
      }
    }

    console.log(`\nFound ${cyan(String(allSecrets.length))} potential secret(s)\n`);

    if (allSecrets.length === 0) {
      console.log(yellow('No secrets detected.'));
      rl.close();
      return;
    }

    // === LIST ONLY MODE: Show secrets and exit ===
    if (options.listOnly) {
      console.log(bold('Secrets found:\n'));
      // Group by file
      const byFile = new Map<string, DiscoveredSecret[]>();
      for (const secret of allSecrets) {
        const existing = byFile.get(secret.sourcePath) || [];
        existing.push(secret);
        byFile.set(secret.sourcePath, existing);
      }

      for (const [file, secrets] of byFile) {
        console.log(cyan(file));
        for (const s of secrets) {
          const conf = s.confidence === 'high' ? green('●') : s.confidence === 'medium' ? yellow('●') : dim('○');
          console.log(`  ${conf} ${s.name} = ${maskValue(s.value)} ${dim(`(line ${s.lineNumber})`)}`);
        }
        console.log('');
      }

      console.log(dim(`Total: ${allSecrets.length} secrets in ${byFile.size} files`));
      rl.close();
      return;
    }

    // === STEP 4: Confirm secrets (interactive) ===
    const confirmed = await confirmSecrets(allSecrets, options.interactive ?? true);
    const toMigrate = confirmed.filter((s) => s.confirmed && !s.skipped);

    console.log(`\n${green(String(toMigrate.length))} secret(s) confirmed for migration\n`);

    if (toMigrate.length === 0) {
      console.log(yellow('Nothing to migrate.'));
      rl.close();
      return;
    }

    // === STEP 5: Create migration plan ===
    const plan = createPlan(confirmed, projects);
    console.log(summarizePlan(plan));

    // === STEP 6: Ask about output location ===
    let outputLocation: OutputLocation = options.outputLocation || 'side-by-side';

    if (!options.outputLocation && !options.autoConfirm) {
      console.log('\nWhere should new file versions go?');
      console.log('  1. Side-by-side (.env → .env.migrated)');
      console.log('  2. Output folder (~/.config/pai/migrations/<date>/)');
      console.log('  3. In-place (backup original, replace with new)');

      const choice = await ask(rl, '\nChoice [1]: ');
      switch (choice.trim()) {
        case '2':
          outputLocation = 'output-folder';
          break;
        case '3':
          outputLocation = 'in-place';
          break;
        default:
          outputLocation = 'side-by-side';
      }
    }

    // === STEP 7: Generate new file versions ===
    console.log(dim('\nGenerating new file versions...'));
    const generatedFiles = await generateFiles(
      confirmed,
      plan,
      outputLocation,
      options.outputFolder
    );
    plan.filesToGenerate = generatedFiles;

    console.log(`Generated ${green(String(generatedFiles.length))} file(s)`);

    // Show preview
    if (generatedFiles.length > 0) {
      console.log('\nFiles to generate:');
      for (const file of generatedFiles) {
        console.log(`  ${dim(file.originalPath)} → ${cyan(file.newPath)}`);
        console.log(`    ${file.replacements.length} replacement(s)`);
      }
    }

    // === STEP 8: Generate import script ===
    const importScript = generateImportScript(plan);
    const scriptPath = options.outputFolder
      ? `${options.outputFolder}/import.sh`
      : './vw-import.sh';

    // === STEP 9: Confirm and execute ===
    if (!options.dryRun && !options.autoConfirm) {
      console.log('\n' + bold('Ready to migrate!'));
      console.log(`  • Create ${plan.secretsToCreate.length} secret(s) in Vaultwarden`);
      console.log(`  • Generate ${generatedFiles.length} new file version(s)`);
      console.log(`  • Save import script to ${scriptPath}`);

      const proceed = await ask(rl, '\nProceed? [y/N]: ');
      if (proceed.toLowerCase() !== 'y') {
        console.log(yellow('\nAborted.'));
        rl.close();
        return;
      }
    }

    // Write generated files
    if (!options.dryRun) {
      await writeGeneratedFiles(generatedFiles);
      console.log(green('✓') + ' Wrote new file versions');

      // Write import script
      await Bun.write(scriptPath, importScript);
      console.log(green('✓') + ` Wrote import script to ${scriptPath}`);
    }

    // Execute VW creation
    if (!options.skipVwCreation) {
      const results = await executePlan(plan, {
        dryRun: options.dryRun,
        skipConfirmation: options.autoConfirm,
      });

      // Verify if not dry run
      if (!options.dryRun && results.created > 0) {
        await verifySecrets(plan);
      }
    }

    // Show cleanup summary
    console.log(generateRemovalSummary(confirmed, generatedFiles));

    console.log(bold('\n✅ Migration complete!\n'));

    if (options.dryRun) {
      console.log(yellow('(This was a dry run - no changes were made)'));
    }

  } finally {
    rl.close();
  }
}

// Re-export for direct use
export { scan, detectSecrets, createPlan, generateFiles, executePlan };
export * from './types';
