import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  decryptFile,
  loadBackupKey,
  stateDirFromEnv,
  verifyExtractedManifest,
  type BackupManifest,
} from "./backup";

export interface DrillReceipt {
  version: 1;
  backupFile: string;
  backupCreatedAt: string;
  drillAt: string;
  drillHost: string;
  restoreElapsedMs: number;
  backupAgeSeconds: number;
  manifestFilesVerified: number;
  sqlite: Array<{
    path: string;
    integrity: "ok";
    rowCounts: Record<string, number>;
  }>;
  result: "healthy";
}

export async function restoreDrill(options: {
  backupFile: string;
  targetDir?: string;
  receiptsDir?: string;
  keyFile?: string;
  liveStateDir?: string;
  now?: Date;
}): Promise<{ receipt: DrillReceipt; receiptPath: string; targetDir: string }> {
  const started = performance.now();
  const now = options.now ?? new Date();
  const liveState = resolve(options.liveStateDir ?? stateDirFromEnv());
  const target = resolve(
    options.targetDir ?? (await mkdtemp(join(tmpdir(), "vw-restore-drill-"))),
  );
  await mkdir(target, { recursive: true, mode: 0o700 });
  // Resolve symlinks before comparing so a symlinked or relative target cannot
  // smuggle the drill into the live state directory.
  await assertOutsideLiveState(target, liveState, "restore target");
  if ((await readdir(target)).length !== 0)
    throw new Error("restore target must be empty");

  const key = await loadBackupKey(options.keyFile);
  const tarPath = join(target, "backup.tar");
  const restored = join(target, "restored");
  await mkdir(restored, { mode: 0o700 });
  try {
    await decryptFile(resolve(options.backupFile), tarPath, key);
    await run([
      "tar",
      "-xf",
      tarPath,
      "-C",
      restored,
      "--no-same-owner",
      "--no-same-permissions",
    ]);
  } finally {
    await rm(tarPath, { force: true });
  }
  const manifest = await verifyExtractedManifest(restored);
  const sqlite = await verifySqliteFiles(restored, manifest);
  const elapsed = Math.round(performance.now() - started);
  const ageSeconds = Math.max(
    0,
    Math.floor((now.getTime() - Date.parse(manifest.createdAt)) / 1000),
  );
  const receipt: DrillReceipt = {
    version: 1,
    backupFile: basename(options.backupFile),
    backupCreatedAt: manifest.createdAt,
    drillAt: now.toISOString(),
    drillHost: hostname(),
    restoreElapsedMs: elapsed,
    backupAgeSeconds: ageSeconds,
    manifestFilesVerified: manifest.files.length,
    sqlite,
    result: "healthy",
  };
  const receiptsDir = resolve(
    options.receiptsDir ??
      process.env.VW_BACKUP_RECEIPTS_DIR ??
      join(dirname(target), "receipts"),
  );
  await mkdir(receiptsDir, { recursive: true, mode: 0o700 });
  // Receipts must never land inside the live state directory either.
  await assertOutsideLiveState(receiptsDir, liveState, "receipts directory");
  const receiptPath = join(
    receiptsDir,
    `restore-drill-${now
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z")}.json`,
  );
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
  });
  return { receipt, receiptPath, targetDir: target };
}

// Resolve symlinks on the deepest existing ancestor of `path` (the leaf may not
// exist yet) and refuse if the result is the live state dir or nested inside it.
async function assertOutsideLiveState(
  path: string,
  liveState: string,
  label: string,
): Promise<void> {
  const liveReal = await realpathOfNearest(liveState);
  const targetReal = await realpathOfNearest(path);
  if (targetReal === liveReal || targetReal.startsWith(`${liveReal}${sep}`))
    throw new Error(`refusing to use ${label} inside the live state directory`);
}

async function realpathOfNearest(path: string): Promise<string> {
  let current = resolve(path);
  // Walk up to the nearest existing ancestor, then realpath that.
  for (;;) {
    try {
      const real = await realpath(current);
      return current === resolve(path)
        ? real
        : join(real, relative(current, resolve(path)));
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      current = parent;
    }
  }
}

async function verifySqliteFiles(
  root: string,
  manifest: BackupManifest,
): Promise<DrillReceipt["sqlite"]> {
  const results: DrillReceipt["sqlite"] = [];
  for (const entry of manifest.files) {
    const path = join(root, entry.path);
    if (!(await isSqlite(path))) continue;
    const integrity = (
      await run(["sqlite3", "-batch", path, "PRAGMA integrity_check;"])
    ).trim();
    if (integrity !== "ok")
      throw new Error(`SQLite integrity check failed: ${entry.path}`);
    const tableOutput = await run([
      "sqlite3",
      "-batch",
      "-noheader",
      path,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
    ]);
    const tables = tableOutput.trim() ? tableOutput.trim().split("\n") : [];
    const rowCounts: Record<string, number> = {};
    for (const table of tables) {
      const quoted = `"${table.replaceAll('"', '""')}"`;
      const count = Number(
        (
          await run([
            "sqlite3",
            "-batch",
            "-noheader",
            path,
            `SELECT COUNT(*) FROM ${quoted};`,
          ])
        ).trim(),
      );
      if (!Number.isSafeInteger(count) || count < 0)
        throw new Error(`invalid row count for ${entry.path}:${table}`);
      rowCounts[table] = count;
    }
    results.push({ path: relative(root, path), integrity: "ok", rowCounts });
  }
  return results;
}

async function isSqlite(path: string): Promise<boolean> {
  const file = Bun.file(path);
  if (!(await file.exists()) || file.size < 16) return false;
  return (
    Buffer.from(await file.slice(0, 16).arrayBuffer()).toString("utf8") ===
    "SQLite format 3\0"
  );
}

async function run(command: string[]): Promise<string> {
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`${command[0]} failed (${exitCode}): ${stderr.trim()}`);
  return stdout;
}

function parseArgs(args: string[]): {
  backupFile: string;
  targetDir?: string;
  receiptsDir?: string;
} {
  const [backupFile, ...rest] = args;
  if (!backupFile)
    throw new Error(
      "usage: bun scripts/restore-drill.ts <backup-file> [--target DIR] [--receipts-dir DIR]",
    );
  const parsed: {
    backupFile: string;
    targetDir?: string;
    receiptsDir?: string;
  } = { backupFile };
  for (let index = 0; index < rest.length; index += 2) {
    const value = rest[index + 1];
    if (!value) throw new Error(`missing value for ${rest[index]}`);
    if (rest[index] === "--target") parsed.targetDir = value;
    else if (rest[index] === "--receipts-dir") parsed.receiptsDir = value;
    else throw new Error(`unknown argument: ${rest[index]}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  try {
    const result = await restoreDrill(parseArgs(process.argv.slice(2)));
    console.log(
      `restore healthy: rto_ms=${result.receipt.restoreElapsedMs} rpo_seconds=${result.receipt.backupAgeSeconds} receipt=${result.receiptPath}`,
    );
  } catch (error) {
    console.error(
      `restore unhealthy: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
