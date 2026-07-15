import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupName,
  createBackup,
  decryptFile,
  encryptFile,
  pruneBackups,
} from "../../scripts/backup";
import { checkBackupHealth } from "../../scripts/backup-health";
import { restoreDrill } from "../../scripts/restore-drill";

let root: string;
let stateDir: string;
let destination: string;
let receiptsDir: string;
let keyFile: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vw-backup-test-"));
  stateDir = join(root, "state");
  destination = join(root, "backups");
  receiptsDir = join(root, "receipts");
  keyFile = join(root, "backup.key");
  await mkdir(stateDir, { recursive: true });
  await mkdir(destination, { recursive: true });
  await writeFile(keyFile, Buffer.alloc(32, 0x5a));
  await chmod(keyFile, 0o600);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("encrypted backup recovery", () => {
  test("round trips state and records SQLite evidence", async () => {
    const db = join(stateDir, "control.db");
    await sqlite(
      db,
      "CREATE TABLE evidence(value TEXT NOT NULL); INSERT INTO evidence VALUES('sentinel-20');",
    );
    await writeFile(
      join(stateDir, "snapshot.enc"),
      "opaque-encrypted-snapshot",
    );
    const createdAt = new Date("2026-07-14T12:00:00Z");
    const backup = await createBackup({
      stateDir,
      destination,
      keyFile,
      now: createdAt,
    });
    const result = await restoreDrill({
      backupFile: backup,
      targetDir: join(root, "round-trip"),
      receiptsDir,
      keyFile,
      liveStateDir: stateDir,
      now: new Date("2026-07-14T12:03:00Z"),
    });

    const restoredDb = join(result.targetDir, "restored", "control.db");
    expect(
      (await sqlite(restoredDb, "SELECT value FROM evidence;")).trim(),
    ).toBe("sentinel-20");
    expect(result.receipt.sqlite).toEqual([
      { path: "control.db", integrity: "ok", rowCounts: { evidence: 1 } },
    ]);
    expect(result.receipt.backupAgeSeconds).toBe(180);
    expect(result.receipt.restoreElapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(await readFile(result.receiptPath, "utf8")).result).toBe(
      "healthy",
    );
  });

  test("detects a tampered encrypted backup", async () => {
    const backup = await createBackup({
      stateDir,
      destination,
      keyFile,
      now: new Date("2026-07-14T13:00:00Z"),
    });
    const bytes = Buffer.from(await readFile(backup));
    bytes[bytes.length - 1] ^= 0xff;
    const tampered = join(root, "tampered.tar.enc");
    await writeFile(tampered, bytes);
    await expect(
      restoreDrill({
        backupFile: tampered,
        targetDir: join(root, "tamper-drill"),
        receiptsDir,
        keyFile,
        liveStateDir: stateDir,
      }),
    ).rejects.toThrow();
  });

  test("retention prunes only our exact backup naming pattern", async () => {
    const oldBackup = join(
      destination,
      backupName(new Date("2026-05-01T00:00:00Z")),
    );
    const unrelated = join(destination, "manual-backup.tar.enc");
    const almostMatching = join(destination, "vw-state-delete-me.tar.enc");
    await Promise.all([
      writeFile(oldBackup, "old"),
      writeFile(unrelated, "keep"),
      writeFile(almostMatching, "keep"),
    ]);
    const oldDate = new Date("2026-05-01T00:00:00Z");
    await Promise.all([
      utimes(oldBackup, oldDate, oldDate),
      utimes(unrelated, oldDate, oldDate),
      utimes(almostMatching, oldDate, oldDate),
    ]);

    const pruned = await pruneBackups(
      destination,
      30,
      new Date("2026-07-14T00:00:00Z"),
    );
    expect(pruned).toEqual([oldBackup]);
    expect(await Bun.file(unrelated).exists()).toBe(true);
    expect(await Bun.file(almostMatching).exists()).toBe(true);
  });

  test("health fails closed for stale and corrupt backups", async () => {
    const missing = await checkBackupHealth({
      destination: join(root, "missing-backups"),
      keyFile,
    });
    expect(missing.healthy).toBe(false);
    const healthDir = join(root, "health");
    await mkdir(healthDir);
    const createdAt = new Date("2026-07-14T14:00:00Z");
    const backup = await createBackup({
      stateDir,
      destination: healthDir,
      keyFile,
      now: createdAt,
    });
    const fresh = await checkBackupHealth({
      destination: healthDir,
      keyFile,
      maxAgeHours: 24,
      now: new Date(createdAt.getTime() + 23 * 3_600_000),
    });
    expect(fresh.healthy).toBe(true);
    const stale = await checkBackupHealth({
      destination: healthDir,
      keyFile,
      maxAgeHours: 24,
      now: new Date(createdAt.getTime() + 25 * 3_600_000),
    });
    expect(stale.healthy).toBe(false);
    expect(stale.reason).toContain("older than 24 hours");

    const bytes = Buffer.from(await readFile(backup));
    bytes[bytes.length - 2] ^= 0xff;
    await writeFile(backup, bytes);
    const corrupt = await checkBackupHealth({
      destination: healthDir,
      keyFile,
      maxAgeHours: 24,
      now: createdAt,
    });
    expect(corrupt.healthy).toBe(false);
  });

  test("health judges freshness from the manifest, not a touched mtime", async () => {
    const freshnessDir = join(root, "freshness");
    await mkdir(freshnessDir);
    const staleCreatedAt = new Date("2026-06-01T00:00:00Z");
    const backup = await createBackup({
      stateDir,
      destination: freshnessDir,
      keyFile,
      now: staleCreatedAt,
    });
    // Attacker touches the stale backup to look brand-new by mtime.
    const nowish = new Date("2026-07-14T12:00:00Z");
    await utimes(backup, nowish, nowish);
    const health = await checkBackupHealth({
      destination: freshnessDir,
      keyFile,
      maxAgeHours: 24,
      now: nowish,
    });
    expect(health.healthy).toBe(false);
    expect(health.reason).toContain("older than 24 hours");
  });

  test("refuses a live restore target before touching it", async () => {
    const backup = join(
      destination,
      backupName(new Date("2026-07-14T15:00:00Z")),
    );
    await expect(
      restoreDrill({
        backupFile: backup,
        targetDir: stateDir,
        receiptsDir,
        keyFile,
        liveStateDir: stateDir,
      }),
    ).rejects.toThrow("live state directory");
    expect(
      (
        await sqlite(
          join(stateDir, "control.db"),
          "SELECT value FROM evidence;",
        )
      ).trim(),
    ).toBe("sentinel-20");
  });

  test("refuses a restore target symlinked into the live state dir", async () => {
    const link = join(root, "sneaky-link");
    await symlink(stateDir, link);
    await expect(
      restoreDrill({
        backupFile: join(
          destination,
          backupName(new Date("2026-07-14T16:00:00Z")),
        ),
        targetDir: link,
        receiptsDir,
        keyFile,
        liveStateDir: stateDir,
      }),
    ).rejects.toThrow("live state directory");
  });

  test("restore drill fails on a manifest/payload checksum mismatch", async () => {
    const mismatchState = join(root, "mismatch-state");
    await mkdir(mismatchState, { recursive: true });
    await writeFile(join(mismatchState, "snapshot.enc"), "original-bytes");
    const backup = await createBackup({
      stateDir: mismatchState,
      destination,
      keyFile,
      now: new Date("2026-07-14T17:00:00Z"),
    });
    // Rewrite the encrypted payload's inner file bytes: decrypt, corrupt one
    // payload file while keeping its manifest checksum, re-encrypt.
    const work = await mkdtemp(join(tmpdir(), "vw-mismatch-"));
    const tar = join(work, "p.tar");
    const extracted = join(work, "x");
    await mkdir(extracted, { recursive: true });
    await decryptFile(backup, tar, await keyBytes());
    await runCmd(["tar", "-xf", tar, "-C", extracted]);
    await writeFile(
      join(extracted, "snapshot.enc"),
      "tampered-different-length",
    );
    const tar2 = join(work, "p2.tar");
    await runCmd(["tar", "-cf", tar2, "-C", extracted, "."]);
    const tampered = join(root, "mismatch.tar.enc");
    await encryptFile(tar2, tampered, await keyBytes());
    await rm(work, { recursive: true, force: true });

    await expect(
      restoreDrill({
        backupFile: tampered,
        targetDir: join(root, "mismatch-drill"),
        receiptsDir,
        keyFile,
        liveStateDir: stateDir,
      }),
    ).rejects.toThrow("checksum mismatch");
  });

  test("refuses a world-readable backup key", async () => {
    const insecure = join(root, "insecure.key");
    await writeFile(insecure, Buffer.alloc(32, 0x41));
    await chmod(insecure, 0o604);
    await expect(
      createBackup({ stateDir, destination, keyFile: insecure }),
    ).rejects.toThrow("must not be world-readable");
  });
});

async function keyBytes(): Promise<Buffer> {
  return Buffer.from(await readFile(keyFile));
}

async function runCmd(command: string[]): Promise<void> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command[0]} failed: ${stderr}`);
}

async function sqlite(path: string, sql: string): Promise<string> {
  const process = Bun.spawn(["sqlite3", path, sql], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`sqlite3 failed: ${stderr}`);
  return stdout;
}
