import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ControlPlaneTx = Database;

export interface ControlPlaneDbOptions {
  stateDir?: string;
  databasePath?: string;
}

function defaultStateDir(): string {
  return (
    process.env.VW_STATE_DIR ?? join(homedir(), ".vaultwarden-secrets", "state")
  );
}

/** SQLite owner for the non-secret metadata boundary. */
export class ControlPlaneDatabase {
  readonly db: Database;
  readonly path: string;

  constructor(options: ControlPlaneDbOptions = {}) {
    this.path =
      options.databasePath ??
      join(options.stateDir ?? defaultStateDir(), "control-plane.db");
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path, { create: true, strict: true });
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    this.runMigrations();
  }

  transaction<T>(work: (tx: ControlPlaneTx) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work(this.db);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private runMigrations(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    )`);
    const migrationDir = join(import.meta.dir, "migrations");
    if (!existsSync(migrationDir)) return;
    const migrations = readdirSync(migrationDir)
      .map((name) => ({ name, match: /^(\d{3})_.+\.sql$/.exec(name) }))
      .filter(
        (entry): entry is { name: string; match: RegExpExecArray } =>
          entry.match !== null,
      )
      .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));

    this.transaction((tx) => {
      const applied = tx
        .query("SELECT version FROM schema_migrations")
        .all() as Array<{ version: number }>;
      const known = new Set(applied.map((row) => row.version));
      for (const migration of migrations) {
        const version = Number(migration.match[1]);
        if (known.has(version)) continue;
        tx.exec(readFileSync(join(migrationDir, migration.name), "utf8"));
        tx.query(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        ).run(version, migration.name, new Date().toISOString());
      }
    });
  }
}
