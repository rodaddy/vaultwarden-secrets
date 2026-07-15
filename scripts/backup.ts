import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

export const BACKUP_PATTERN = /^vw-state-\d{8}T\d{6}Z\.tar\.enc$/;
export const MANIFEST_NAME = "backup-manifest.json";
export const ENV_NAMES_NAME = "config-env-names.json";
const MAGIC = Buffer.from("VWBKUP01");
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface BackupManifest {
  version: 1;
  createdAt: string;
  sourceHost: string;
  files: Array<{ path: string; sha256: string; size: number }>;
}

export function stateDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(
    expandHome(env.VW_STATE_DIR ?? "~/.vaultwarden-secrets/state"),
  );
}

export function backupName(date = new Date()): string {
  return `vw-state-${date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")}.tar.enc`;
}

export async function loadBackupKey(
  pathValue = process.env.VW_BACKUP_KEY_FILE,
): Promise<Buffer> {
  if (!pathValue) throw new Error("VW_BACKUP_KEY_FILE is required");
  const keyPath = resolve(expandHome(pathValue));
  const keyStat = await stat(keyPath);
  if (!keyStat.isFile())
    throw new Error("VW_BACKUP_KEY_FILE must be a regular file");
  if ((keyStat.mode & 0o004) !== 0)
    throw new Error("backup key file must not be world-readable");

  const raw = await readFile(keyPath);
  if (raw.length === 32) return raw;
  const text = raw.toString("utf8").trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, "hex");
  const decoded = Buffer.from(text, "base64");
  if (
    decoded.length === 32 &&
    decoded.toString("base64").replace(/=+$/, "") === text.replace(/=+$/, "")
  )
    return decoded;
  throw new Error(
    "backup key must be exactly 32 raw bytes, 64 hex characters, or base64-encoded 32 bytes",
  );
}

export async function encryptFile(
  input: string,
  output: string,
  key: Buffer,
): Promise<void> {
  const plaintext = await readFile(input);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  await writeFile(output, Buffer.concat([MAGIC, iv, tag, ciphertext]), {
    mode: 0o600,
  });
}

export async function decryptFile(
  input: string,
  output: string,
  key: Buffer,
): Promise<void> {
  const envelope = await readFile(input);
  const minimum = MAGIC.length + IV_BYTES + TAG_BYTES + 1;
  if (
    envelope.length < minimum ||
    !envelope.subarray(0, MAGIC.length).equals(MAGIC)
  ) {
    throw new Error("invalid backup envelope");
  }
  const ivStart = MAGIC.length;
  const tagStart = ivStart + IV_BYTES;
  const ciphertextStart = tagStart + TAG_BYTES;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    envelope.subarray(ivStart, tagStart),
  );
  decipher.setAuthTag(envelope.subarray(tagStart, ciphertextStart));
  const plaintext = Buffer.concat([
    decipher.update(envelope.subarray(ciphertextStart)),
    decipher.final(),
  ]);
  await writeFile(output, plaintext, { mode: 0o600 });
}

export async function verifyExtractedManifest(
  root: string,
): Promise<BackupManifest> {
  const manifest = JSON.parse(
    await readFile(join(root, MANIFEST_NAME), "utf8"),
  ) as BackupManifest;
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    !manifest.createdAt ||
    !manifest.sourceHost
  ) {
    throw new Error("invalid backup manifest");
  }
  const actualPaths = (await listRegularFiles(root))
    .map((path) => relative(root, path))
    .filter((path) => path !== MANIFEST_NAME)
    .sort();
  const expectedPaths = manifest.files.map((entry) => entry.path).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths))
    throw new Error("manifest file list mismatch");
  for (const entry of manifest.files) {
    const filePath = safeManifestPath(root, entry.path);
    const fileStat = await stat(filePath);
    const digest = await sha256File(filePath);
    if (fileStat.size !== entry.size || digest !== entry.sha256)
      throw new Error(`checksum mismatch: ${entry.path}`);
  }
  return manifest;
}

export async function createBackup(
  options: {
    stateDir?: string;
    destination?: string;
    keyFile?: string;
    retainDays?: number;
    now?: Date;
  } = {},
): Promise<string> {
  const source = resolve(options.stateDir ?? stateDirFromEnv());
  const destination = options.destination ?? process.env.VW_BACKUP_DEST;
  if (!destination) throw new Error("VW_BACKUP_DEST is required");
  if (!(await stat(source)).isDirectory())
    throw new Error(`state directory does not exist: ${source}`);
  const key = await loadBackupKey(options.keyFile);
  const now = options.now ?? new Date();
  const retainDays =
    options.retainDays ??
    parsePositiveNumber(
      process.env.VW_BACKUP_RETAIN_DAYS,
      30,
      "VW_BACKUP_RETAIN_DAYS",
    );
  const work = await mkdtemp(join(tmpdir(), "vw-backup-"));
  try {
    const staged = join(work, "payload");
    await mkdir(staged, { recursive: true, mode: 0o700 });
    await stageState(source, staged);
    const envNames = Object.keys(process.env).filter(isConfigEnvName).sort();
    await writeFile(
      join(staged, ENV_NAMES_NAME),
      `${JSON.stringify({ names: envNames }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const files = await manifestEntries(staged);
    const manifest: BackupManifest = {
      version: 1,
      createdAt: now.toISOString(),
      sourceHost: hostname(),
      files,
    };
    await writeFile(
      join(staged, MANIFEST_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );

    const tarPath = join(work, "payload.tar");
    await run(["tar", "-cf", tarPath, "-C", staged, "."]);
    const encryptedPath = join(work, backupName(now));
    await encryptFile(tarPath, encryptedPath, key);
    const delivered = await deliverBackup(encryptedPath, destination);
    await pruneBackups(destination, retainDays, now);
    return delivered;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function pruneBackups(
  destination: string,
  retainDays: number,
  now = new Date(),
): Promise<string[]> {
  if (isRemote(destination))
    return pruneRemoteBackups(destination, retainDays, now);
  const directory = resolve(expandHome(destination));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cutoff = now.getTime() - retainDays * 86_400_000;
  const pruned: string[] = [];
  for (const name of await readdir(directory)) {
    if (!BACKUP_PATTERN.test(name)) continue;
    const path = join(directory, name);
    if ((await stat(path)).mtimeMs < cutoff) {
      await Bun.file(path).delete();
      pruned.push(path);
    }
  }
  return pruned;
}

async function stageState(source: string, staged: string): Promise<void> {
  for (const sourcePath of await listRegularFiles(source, true)) {
    const rel = relative(source, sourcePath);
    if (/-(wal|shm)$/.test(rel)) continue;
    const target = join(staged, rel);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    if (await isSqlite(sourcePath)) {
      await run([
        "sqlite3",
        sourcePath,
        `.backup '${target.replaceAll("'", "''")}'`,
      ]);
    } else {
      await copyFile(sourcePath, target);
    }
    await chmod(target, 0o600);
  }
}

async function deliverBackup(
  localPath: string,
  destination: string,
): Promise<string> {
  if (isRemote(destination)) {
    await run([
      "rsync",
      "--protect-args",
      "--chmod=F600",
      localPath,
      destination.endsWith("/") ? destination : `${destination}/`,
    ]);
    return `${destination.replace(/\/$/, "")}/${basename(localPath)}`;
  }
  const directory = resolve(expandHome(destination));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const finalPath = join(directory, basename(localPath));
  const partialPath = `${finalPath}.partial`;
  await copyFile(localPath, partialPath);
  await chmod(partialPath, 0o600);
  await rename(partialPath, finalPath);
  return finalPath;
}

async function pruneRemoteBackups(
  destination: string,
  retainDays: number,
  now: Date,
): Promise<string[]> {
  const match = destination.match(
    /^([A-Za-z0-9._@-]+):(\/[A-Za-z0-9._/-]+)\/?$/,
  );
  if (!match)
    throw new Error(
      "remote backup destination must use user@host:/absolute/path without spaces",
    );
  const [, host, directory] = match;
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
    "%T@ %p\\n",
  ]);
  const cutoff = now.getTime() - retainDays * 86_400_000;
  const stale = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const separator = line.indexOf(" ");
      const timestamp = Number(line.slice(0, separator)) * 1000;
      const path = line.slice(separator + 1);
      return Number.isFinite(timestamp) &&
        timestamp < cutoff &&
        path.startsWith(`${directory.replace(/\/$/, "")}/`)
        ? [path]
        : [];
    });
  for (const path of stale) await run(["ssh", host, "unlink", path]);
  return stale;
}

async function manifestEntries(root: string): Promise<BackupManifest["files"]> {
  const entries: BackupManifest["files"] = [];
  for (const path of await listRegularFiles(root)) {
    const fileStat = await stat(path);
    entries.push({
      path: relative(root, path),
      sha256: await sha256File(path),
      size: fileStat.size,
    });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function listRegularFiles(
  root: string,
  rejectSymlinks = false,
): Promise<string[]> {
  const result: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (rejectSymlinks)
          throw new Error(
            `state directory contains unsupported symlink: ${path}`,
          );
        continue;
      }
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) result.push(path);
    }
  }
  await walk(root);
  return result.sort();
}

async function isSqlite(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, 16, 0);
    return bytesRead === 16 && header.toString("utf8") === "SQLite format 3\0";
  } finally {
    await handle.close();
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function safeManifestPath(root: string, path: string): string {
  const resolved = resolve(root, path);
  if (resolved === resolve(root) || !resolved.startsWith(`${resolve(root)}/`))
    throw new Error(`unsafe manifest path: ${path}`);
  return resolved;
}

function isConfigEnvName(name: string): boolean {
  return /^(VW_|BW_|API_TOKEN_|JWT_|MTLS_|SECURITY_PROFILE$)/.test(name);
}

function isRemote(destination: string): boolean {
  return /^[^/]+:.+/.test(destination);
}

function expandHome(path: string): string {
  return path === "~"
    ? homedir()
    : path.startsWith("~/")
      ? join(homedir(), path.slice(2))
      : path;
}

function parsePositiveNumber(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`${name} must be a non-negative number`);
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
  try {
    const path = await createBackup();
    console.log(`backup healthy: ${path}`);
  } catch (error) {
    console.error(
      `backup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
