import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  BACKUP_PATTERN,
  decryptFile,
  loadBackupKey,
  verifyExtractedManifest,
} from "./backup";

export interface BackupHealth {
  healthy: boolean;
  backup?: string;
  ageHours?: number;
  reason?: string;
}

export async function checkBackupHealth(
  options: {
    destination?: string;
    keyFile?: string;
    maxAgeHours?: number;
    now?: Date;
  } = {},
): Promise<BackupHealth> {
  let work: string | undefined;
  try {
    const destination = options.destination ?? process.env.VW_BACKUP_DEST;
    if (!destination) throw new Error("VW_BACKUP_DEST is required");
    const maxAgeHours =
      options.maxAgeHours ??
      parseThreshold(process.env.VW_BACKUP_MAX_AGE_HOURS);
    const now = options.now ?? new Date();
    work = await mkdtemp(join(tmpdir(), "vw-backup-health-"));
    // mtime only selects the newest candidate; freshness is judged from the
    // authenticated manifest.createdAt so a touched/copied stale backup cannot
    // report healthy.
    const newest = await newestBackup(destination, work);
    if (!newest) return { healthy: false, reason: "no backup found" };
    const key = await loadBackupKey(options.keyFile);
    const tarPath = join(work, "backup.tar");
    const extracted = join(work, "extracted");
    await mkdir(extracted, { mode: 0o700 });
    await decryptFile(newest.localPath, tarPath, key);
    await run([
      "tar",
      "-xf",
      tarPath,
      "-C",
      extracted,
      "--no-same-owner",
      "--no-same-permissions",
    ]);
    const manifest = await verifyExtractedManifest(extracted);
    const createdAt = Date.parse(manifest.createdAt);
    if (!Number.isFinite(createdAt))
      return {
        healthy: false,
        backup: newest.displayPath,
        reason: "backup manifest has an invalid createdAt",
      };
    const ageHours = (now.getTime() - createdAt) / 3_600_000;
    if (ageHours > maxAgeHours)
      return {
        healthy: false,
        backup: newest.displayPath,
        ageHours,
        reason: `backup is older than ${maxAgeHours} hours`,
      };
    return { healthy: true, backup: newest.displayPath, ageHours };
  } catch (error) {
    return {
      healthy: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
  }
}

async function newestBackup(
  destination: string,
  work: string,
): Promise<{
  localPath: string;
  displayPath: string;
  modifiedAt: Date;
} | null> {
  if (isRemote(destination)) return newestRemoteBackup(destination, work);
  const directory = resolve(expandHome(destination));
  let newest: {
    localPath: string;
    displayPath: string;
    modifiedAt: Date;
  } | null = null;
  for (const name of await readdir(directory)) {
    if (!BACKUP_PATTERN.test(name)) continue;
    const path = join(directory, name);
    const modifiedAt = (await stat(path)).mtime;
    if (!newest || modifiedAt > newest.modifiedAt)
      newest = { localPath: path, displayPath: path, modifiedAt };
  }
  return newest;
}

async function newestRemoteBackup(
  destination: string,
  work: string,
): Promise<{
  localPath: string;
  displayPath: string;
  modifiedAt: Date;
} | null> {
  const { host, directory } = parseRemote(destination);
  const output = await run([
    "ssh",
    host,
    "find",
    directory,
    "-maxdepth",
    "1",
    "-type",
    "f",
    "-name",
    "vw-state-????????T??????Z.tar.enc",
    "-printf",
    "%T@ %f\\n",
  ]);
  const candidates = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(" ");
      return {
        seconds: Number(line.slice(0, separator)),
        name: line.slice(separator + 1),
      };
    })
    .filter(
      (entry) =>
        Number.isFinite(entry.seconds) && BACKUP_PATTERN.test(entry.name),
    );
  candidates.sort((a, b) => b.seconds - a.seconds);
  const latest = candidates[0];
  if (!latest) return null;
  const localPath = join(work, latest.name);
  const remotePath = `${host}:${directory.replace(/\/$/, "")}/${latest.name}`;
  await run(["rsync", "--protect-args", remotePath, localPath]);
  return {
    localPath,
    displayPath: remotePath,
    modifiedAt: new Date(latest.seconds * 1000),
  };
}

function parseRemote(destination: string): { host: string; directory: string } {
  const match = destination.match(
    /^([A-Za-z0-9._@-]+):(\/[A-Za-z0-9._/-]+)\/?$/,
  );
  if (!match)
    throw new Error(
      "remote backup destination must use user@host:/absolute/path without spaces",
    );
  return { host: match[1], directory: match[2] };
}

function isRemote(destination: string): boolean {
  return /^[^/]+:.+/.test(destination);
}

function expandHome(path: string): string {
  const home = process.env.HOME;
  if (path.startsWith("~/") && !home)
    throw new Error("HOME is required to expand backup destination");
  return path === "~"
    ? (home ?? path)
    : path.startsWith("~/")
      ? join(home!, path.slice(2))
      : path;
}

function parseThreshold(value: string | undefined): number {
  if (value === undefined) return 24;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error("VW_BACKUP_MAX_AGE_HOURS must be a non-negative number");
  return parsed;
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

async function main(): Promise<void> {
  const health = await checkBackupHealth();
  if (health.healthy) {
    console.log(
      `backup healthy: file=${health.backup} age_hours=${health.ageHours?.toFixed(2)}`,
    );
  } else {
    console.error(
      `backup unhealthy: ${health.reason}${health.backup ? ` file=${basename(health.backup)}` : ""}`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
