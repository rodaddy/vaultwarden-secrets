import { randomUUID } from "node:crypto";
import { assertRedacted, looksLikeSecretValue } from "./audit";
import type { ControlPlaneTx } from "./db";
import type { ControlPlaneStore } from "./store";
import type { SecretMeta, VersionMeta, VersionState } from "./types";

export interface CreateSecretInput {
  name: string;
  labels?: Record<string, string>;
  idempotencyKey?: string;
}

export interface AddVersionInput {
  secret: string;
  payloadRef: string;
  checksum: string;
  idempotencyKey?: string;
}

export interface MoveAliasInput {
  secret: string;
  alias: string;
  toVersion: number;
}

export interface ImportLegacyInput {
  name: string;
  payloadRef: string;
  checksum: string;
  importedFrom: string;
  idempotencyKey?: string;
}

type SecretRow = {
  id: string;
  name: string;
  labels_json: string;
  imported_from: string | null;
  created_at: string;
};
type VersionRow = {
  secret_name: string;
  version: number;
  state: VersionState;
  payload_ref: string | null;
  checksum: string;
  created_at: string;
};

const VALID_TRANSITIONS: Readonly<
  Record<VersionState, readonly VersionState[]>
> = {
  ENABLED: ["DISABLED", "DESTROYED"],
  DISABLED: ["ENABLED", "DESTROYED"],
  DESTROYED: [],
};

export { VALID_TRANSITIONS };

function resource(secret: string): string {
  return `secrets/${secret}`;
}
function requireText(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} is required`);
}

function validatePayloadRef(value: string): void {
  requireText(value, "payloadRef");
  if (/\s/.test(value) || looksLikeSecretValue(value))
    throw new Error("payloadRef must be a non-secret reference");
  if (
    !/^vaultwarden:[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) &&
    !/^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)+$/.test(value)
  ) {
    throw new Error(
      "payloadRef must be vaultwarden:<id> or <item>.<fieldpath>",
    );
  }
}

function validateLabels(labels: Record<string, string>): void {
  assertRedacted(labels);
  for (const [key, value] of Object.entries(labels)) {
    requireText(key, "label key");
    if (typeof value !== "string")
      throw new Error("Label values must be strings");
  }
}

function toSecret(row: SecretRow): SecretMeta {
  return {
    id: row.id,
    name: row.name,
    labels: JSON.parse(row.labels_json) as Record<string, string>,
    ...(row.imported_from ? { importedFrom: row.imported_from } : {}),
    createdAt: row.created_at,
  };
}

function toVersion(row: VersionRow): VersionMeta {
  return {
    secret: row.secret_name,
    version: row.version,
    state: row.state,
    payloadRef: row.payload_ref,
    checksum: row.checksum,
    createdAt: row.created_at,
  };
}

function idempotent<T>(
  tx: ControlPlaneTx,
  key: string | undefined,
  scope: string,
  work: () => T,
): T {
  if (!key) return work();
  const existing = tx
    .query(
      "SELECT scope, result_json FROM idempotency_keys WHERE idempotency_key = ?",
    )
    .get(key) as { scope: string; result_json: string } | null;
  if (existing) {
    if (existing.scope !== scope)
      throw new Error(`Idempotency key already used for ${existing.scope}`);
    return JSON.parse(existing.result_json) as T;
  }
  const result = work();
  tx.query(
    "INSERT INTO idempotency_keys (idempotency_key, scope, result_json, created_at) VALUES (?, ?, ?, ?)",
  ).run(key, scope, JSON.stringify(result), new Date().toISOString());
  return result;
}

function requireSecret(tx: ControlPlaneTx, name: string): SecretRow {
  const row = tx
    .query("SELECT * FROM logical_secrets WHERE name = ?")
    .get(name) as SecretRow | null;
  if (!row) throw new Error(`Secret not found: ${name}`);
  return row;
}

function requireVersion(
  tx: ControlPlaneTx,
  secret: string,
  version: number,
): VersionRow {
  const row = tx
    .query(
      "SELECT * FROM secret_versions WHERE secret_name = ? AND version = ?",
    )
    .get(secret, version) as VersionRow | null;
  if (!row) throw new Error(`Version not found: ${secret}/${version}`);
  return row;
}

function updateLatest(
  tx: ControlPlaneTx,
  secret: string,
  version: number,
  now: string,
): void {
  tx.query(
    `INSERT INTO secret_aliases (secret_name, alias, version, updated_at) VALUES (?, 'latest', ?, ?)
    ON CONFLICT(secret_name, alias) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
  ).run(secret, version, now);
}

function auditMutation(
  store: ControlPlaneStore,
  tx: ControlPlaneTx,
  action: string,
  secret: string,
  outcome: string,
  correlationId: string,
): void {
  store.audit(
    {
      actor: store.actor,
      action,
      resource: resource(secret),
      outcome,
      correlationId,
    },
    tx,
  );
  store.emit(
    {
      type: action,
      resource: resource(secret),
      correlationId,
      data: { outcome },
    },
    tx,
  );
}

export function createSecret(
  store: ControlPlaneStore,
  input: CreateSecretInput,
): SecretMeta {
  requireText(input.name, "name");
  const labels = input.labels ?? {};
  validateLabels(labels);
  return store.transaction((tx) =>
    idempotent(tx, input.idempotencyKey, "secret.create", () => {
      const existing = tx
        .query("SELECT * FROM logical_secrets WHERE name = ?")
        .get(input.name) as SecretRow | null;
      if (existing) return toSecret(existing);
      const now = new Date().toISOString();
      const meta: SecretMeta = {
        id: randomUUID(),
        name: input.name,
        labels,
        createdAt: now,
      };
      tx.query(
        "INSERT INTO logical_secrets (id, name, labels_json, created_at) VALUES (?, ?, ?, ?)",
      ).run(meta.id, meta.name, JSON.stringify(labels), now);
      auditMutation(store, tx, "secret.create", input.name, "created", meta.id);
      return meta;
    }),
  );
}

export function addVersion(
  store: ControlPlaneStore,
  input: AddVersionInput,
): VersionMeta {
  requireText(input.secret, "secret");
  validatePayloadRef(input.payloadRef);
  requireText(input.checksum, "checksum");
  return store.transaction((tx) =>
    idempotent(tx, input.idempotencyKey, "version.add", () => {
      requireSecret(tx, input.secret);
      const version = (
        tx
          .query(
            "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM secret_versions WHERE secret_name = ?",
          )
          .get(input.secret) as { next_version: number }
      ).next_version;
      const now = new Date().toISOString();
      const meta: VersionMeta = {
        secret: input.secret,
        version,
        state: "ENABLED",
        payloadRef: input.payloadRef,
        checksum: input.checksum,
        createdAt: now,
      };
      tx.query(
        `INSERT INTO secret_versions (secret_name, version, state, payload_ref, checksum, created_at)
      VALUES (?, ?, 'ENABLED', ?, ?, ?)`,
      ).run(input.secret, version, input.payloadRef, input.checksum, now);
      updateLatest(tx, input.secret, version, now);
      auditMutation(
        store,
        tx,
        "version.add",
        input.secret,
        "created",
        `${input.secret}:${version}`,
      );
      return meta;
    }),
  );
}

export function getSecret(
  store: ControlPlaneStore,
  name: string,
): SecretMeta | null {
  const row = store.database.db
    .query("SELECT * FROM logical_secrets WHERE name = ?")
    .get(name) as SecretRow | null;
  return row ? toSecret(row) : null;
}

export function listSecrets(store: ControlPlaneStore): SecretMeta[] {
  return (
    store.database.db
      .query("SELECT * FROM logical_secrets ORDER BY name")
      .all() as SecretRow[]
  ).map(toSecret);
}

export function getVersion(
  store: ControlPlaneStore,
  secret: string,
  versionOrAlias: number | string,
): VersionMeta | null {
  let version: number;
  if (typeof versionOrAlias === "number") version = versionOrAlias;
  else {
    const alias = store.database.db
      .query(
        "SELECT version FROM secret_aliases WHERE secret_name = ? AND alias = ?",
      )
      .get(secret, versionOrAlias) as { version: number } | null;
    if (!alias) return null;
    version = alias.version;
  }
  const row = store.database.db
    .query(
      "SELECT * FROM secret_versions WHERE secret_name = ? AND version = ?",
    )
    .get(secret, version) as VersionRow | null;
  return row && row.state !== "DESTROYED" ? toVersion(row) : null;
}

function transition(
  store: ControlPlaneStore,
  secret: string,
  version: number,
  to: VersionState,
): VersionMeta {
  return store.transaction((tx) => {
    const current = requireVersion(tx, secret, version);
    if (current.state === to) return toVersion(current);
    if (!VALID_TRANSITIONS[current.state].includes(to)) {
      throw new Error(`Invalid version transition: ${current.state} -> ${to}`);
    }
    const now = new Date().toISOString();
    const payloadRef = to === "DESTROYED" ? null : current.payload_ref;
    if (to === "DESTROYED") {
      const alias = tx
        .query(
          `SELECT alias FROM secret_aliases
          WHERE secret_name = ? AND version = ? AND alias <> 'latest' LIMIT 1`,
        )
        .get(secret, version) as { alias: string } | null;
      if (alias)
        throw new Error(
          `Cannot destroy version targeted by alias: ${alias.alias}`,
        );
    }
    tx.query(
      "UPDATE secret_versions SET state = ?, payload_ref = ? WHERE secret_name = ? AND version = ?",
    ).run(to, payloadRef, secret, version);
    if (to === "DESTROYED") {
      tx.query(
        "DELETE FROM secret_aliases WHERE secret_name = ? AND version = ?",
      ).run(secret, version);
      const replacement = tx
        .query(
          `SELECT version FROM secret_versions
        WHERE secret_name = ? AND state = 'ENABLED' ORDER BY version DESC LIMIT 1`,
        )
        .get(secret) as { version: number } | null;
      if (replacement) updateLatest(tx, secret, replacement.version, now);
    }
    auditMutation(
      store,
      tx,
      `version.${to.toLowerCase()}`,
      secret,
      to.toLowerCase(),
      `${secret}:${version}`,
    );
    return { ...toVersion(current), state: to, payloadRef };
  });
}

export function disableVersion(
  store: ControlPlaneStore,
  secret: string,
  version: number,
): VersionMeta {
  return transition(store, secret, version, "DISABLED");
}

export function enableVersion(
  store: ControlPlaneStore,
  secret: string,
  version: number,
): VersionMeta {
  return transition(store, secret, version, "ENABLED");
}

export function destroyVersion(
  store: ControlPlaneStore,
  secret: string,
  version: number,
): VersionMeta {
  return transition(store, secret, version, "DESTROYED");
}

export function moveAlias(
  store: ControlPlaneStore,
  input: MoveAliasInput,
): VersionMeta {
  requireText(input.alias, "alias");
  if (input.alias === "latest")
    throw new Error("latest is managed automatically when versions are added");
  return store.transaction((tx) => {
    requireSecret(tx, input.secret);
    const target = requireVersion(tx, input.secret, input.toVersion);
    if (target.state === "DESTROYED")
      throw new Error("Aliases may not point to DESTROYED versions");
    const now = new Date().toISOString();
    tx.query(
      `INSERT INTO secret_aliases (secret_name, alias, version, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(secret_name, alias) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
    ).run(input.secret, input.alias, input.toVersion, now);
    auditMutation(
      store,
      tx,
      "alias.move",
      input.secret,
      "moved",
      `${input.secret}:${input.alias}:${input.toVersion}`,
    );
    return toVersion(target);
  });
}

export function importLegacy(
  store: ControlPlaneStore,
  input: ImportLegacyInput,
): SecretMeta {
  requireText(input.name, "name");
  validatePayloadRef(input.payloadRef);
  requireText(input.checksum, "checksum");
  requireText(input.importedFrom, "importedFrom");
  const key =
    input.idempotencyKey ?? `legacy-import:${input.name}:${input.payloadRef}`;
  return store.transaction((tx) => {
    const existing = tx
      .query("SELECT * FROM logical_secrets WHERE name = ?")
      .get(input.name) as SecretRow | null;
    if (existing && existing.imported_from !== input.importedFrom)
      throw new Error(
        `Secret already exists with different provenance: ${input.name}`,
      );
    return idempotent(tx, key, "secret.import", () => {
      const existing = tx
        .query("SELECT * FROM logical_secrets WHERE name = ?")
        .get(input.name) as SecretRow | null;
      if (existing) {
        if (existing.imported_from !== input.importedFrom)
          throw new Error(
            `Secret already exists with different provenance: ${input.name}`,
          );
        return toSecret(existing);
      }
      const now = new Date().toISOString();
      const meta: SecretMeta = {
        id: randomUUID(),
        name: input.name,
        labels: {},
        importedFrom: input.importedFrom,
        createdAt: now,
      };
      tx.query(
        `INSERT INTO logical_secrets (id, name, labels_json, imported_from, created_at)
      VALUES (?, ?, '{}', ?, ?)`,
      ).run(meta.id, meta.name, input.importedFrom, now);
      tx.query(
        `INSERT INTO secret_versions (secret_name, version, state, payload_ref, checksum, created_at)
      VALUES (?, 1, 'ENABLED', ?, ?, ?)`,
      ).run(input.name, input.payloadRef, input.checksum, now);
      updateLatest(tx, input.name, 1, now);
      auditMutation(
        store,
        tx,
        "secret.import",
        input.name,
        "imported",
        meta.id,
      );
      return meta;
    });
  });
}
