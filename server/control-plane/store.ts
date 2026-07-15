import { randomUUID } from "node:crypto";
import {
  appendAudit,
  looksLikeSecretValue,
  verifyLedger,
  type LedgerVerification,
} from "./audit";
import {
  ControlPlaneDatabase,
  type ControlPlaneDbOptions,
  type ControlPlaneTx,
} from "./db";
import {
  deliverPending,
  enqueueEvent,
  listDeadLetters,
  type EventHandler,
} from "./outbox";
import type {
  AuditEntry,
  LifecycleEvent,
  OperationMeta,
  OutboxEvent,
  SecretMeta,
  VersionMeta,
} from "./types";
import {
  addVersion,
  createSecret,
  destroyVersion,
  disableVersion,
  enableVersion,
  getSecret,
  getVersion,
  importLegacy,
  listSecrets,
  moveAlias,
  type AddVersionInput,
  type CreateSecretInput,
  type ImportLegacyInput,
  type MoveAliasInput,
} from "./lifecycle";

type OperationRow = {
  id: string;
  kind: string;
  resource: string;
  state: OperationMeta["state"];
  correlation_id: string;
  evidence_json: string | null;
  created_at: string;
  updated_at: string;
};

export interface StoreOptions extends ControlPlaneDbOptions {
  actor?: string;
}

export interface BeginOperationInput {
  kind: string;
  resource: string;
  correlationId?: string;
}

function toOperation(row: OperationRow): OperationMeta {
  return {
    id: row.id,
    kind: row.kind,
    resource: row.resource,
    state: row.state,
    correlationId: row.correlation_id,
    evidence: row.evidence_json
      ? (JSON.parse(row.evidence_json) as Record<string, string>)
      : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function redactedEvidence(
  evidence: Record<string, string> = {},
): Record<string, string> {
  for (const [key, value] of Object.entries(evidence)) {
    if (
      /(?:password|token|secret|credential|payload|private[_-]?key)/i.test(key)
    ) {
      throw new Error(`Sensitive reconciliation evidence rejected: ${key}`);
    }
    if (typeof value !== "string")
      throw new Error("Reconciliation evidence must be strings");
    if (looksLikeSecretValue(value))
      throw new Error("Sensitive reconciliation evidence rejected");
  }
  return evidence;
}

/**
 * Non-secret control-plane store. Every mutation writes its audit row in the
 * same SQLite transaction; callers never provide payload bytes to this API.
 */
export class ControlPlaneStore {
  readonly database: ControlPlaneDatabase;
  readonly actor: string;

  constructor(options: StoreOptions = {}) {
    this.database = new ControlPlaneDatabase(options);
    this.actor = options.actor ?? "system";
  }

  close(): void {
    this.database.close();
  }

  transaction<T>(work: (tx: ControlPlaneTx) => T): T {
    return this.database.transaction(work);
  }

  audit(entry: AuditEntry, tx: ControlPlaneTx): number {
    return appendAudit(entry, tx);
  }

  emit(event: LifecycleEvent, tx: ControlPlaneTx): OutboxEvent {
    return enqueueEvent(event, tx);
  }

  createSecret(input: CreateSecretInput): SecretMeta {
    return createSecret(this, input);
  }
  addVersion(input: AddVersionInput): VersionMeta {
    return addVersion(this, input);
  }
  getSecret(name: string): SecretMeta | null {
    return getSecret(this, name);
  }
  listSecrets(): SecretMeta[] {
    return listSecrets(this);
  }
  getVersion(
    secret: string,
    versionOrAlias: number | string,
  ): VersionMeta | null {
    return getVersion(this, secret, versionOrAlias);
  }
  disableVersion(secret: string, version: number): VersionMeta {
    return disableVersion(this, secret, version);
  }
  enableVersion(secret: string, version: number): VersionMeta {
    return enableVersion(this, secret, version);
  }
  destroyVersion(secret: string, version: number): VersionMeta {
    return destroyVersion(this, secret, version);
  }
  moveAlias(input: MoveAliasInput): VersionMeta {
    return moveAlias(this, input);
  }
  importLegacy(input: ImportLegacyInput): SecretMeta {
    return importLegacy(this, input);
  }

  beginOperation(input: BeginOperationInput): OperationMeta {
    return this.transaction((tx) => {
      const now = new Date().toISOString();
      const id = randomUUID();
      const correlationId = input.correlationId ?? id;
      tx.query(
        `INSERT INTO operations (id, kind, resource, state, correlation_id, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      ).run(id, input.kind, input.resource, correlationId, now, now);
      this.audit(
        {
          actor: this.actor,
          action: "operation.begin",
          resource: input.resource,
          outcome: "pending",
          correlationId,
        },
        tx,
      );
      this.emit(
        {
          type: "operation.pending",
          resource: input.resource,
          correlationId,
          data: { kind: input.kind },
        },
        tx,
      );
      return {
        id,
        kind: input.kind,
        resource: input.resource,
        state: "pending",
        correlationId,
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  commitOperation(
    id: string,
    evidence: Record<string, string> = {},
  ): OperationMeta {
    return this.setOperationState(id, "committed", evidence);
  }

  markReconcileRequired(
    id: string,
    evidence: Record<string, string> = {},
  ): OperationMeta {
    return this.setOperationState(id, "reconcile-required", evidence);
  }

  /** Execute the external half after recording pending state; failures remain repairable. */
  async performCrossStoreOperation(
    input: BeginOperationInput,
    vaultWrite: () => Promise<void> | void,
  ): Promise<OperationMeta> {
    const operation = this.beginOperation(input);
    try {
      await vaultWrite();
      return this.commitOperation(operation.id, { externalWrite: "confirmed" });
    } catch (error) {
      const code = error instanceof Error ? error.name : "external-failure";
      this.markReconcileRequired(operation.id, {
        externalWrite: "unknown",
        failure: code,
      });
      throw error;
    }
  }

  /** Repair open records once; repeating a completed repair is a no-op. */
  async reconcile(
    repair: (
      operation: OperationMeta,
    ) => Promise<Record<string, string> | void> | Record<string, string> | void,
  ): Promise<OperationMeta[]> {
    const rows = this.database.db
      .query(
        `SELECT o.* FROM operations o
      JOIN reconciliation_records r ON r.operation_id = o.id WHERE r.state = 'open' ORDER BY r.created_at`,
      )
      .all() as OperationRow[];
    const resolved: OperationMeta[] = [];
    for (const row of rows) {
      const operation = toOperation(row);
      const evidence = redactedEvidence(
        (await repair(operation)) ?? { repair: "confirmed" },
      );
      resolved.push(
        this.transaction((tx) => {
          const now = new Date().toISOString();
          tx.query(
            `UPDATE operations SET state = 'committed', evidence_json = ?, updated_at = ? WHERE id = ?`,
          ).run(JSON.stringify(evidence), now, operation.id);
          tx.query(
            `UPDATE reconciliation_records SET state = 'resolved', evidence_json = ?, updated_at = ? WHERE operation_id = ?`,
          ).run(JSON.stringify(evidence), now, operation.id);
          this.audit(
            {
              actor: this.actor,
              action: "operation.reconcile",
              resource: operation.resource,
              outcome: "committed",
              correlationId: operation.correlationId,
            },
            tx,
          );
          this.emit(
            {
              type: "operation.reconciled",
              resource: operation.resource,
              correlationId: operation.correlationId,
              data: evidence,
            },
            tx,
          );
          return { ...operation, state: "committed", evidence, updatedAt: now };
        }),
      );
    }
    return resolved;
  }

  appendAudit(entry: AuditEntry, tx?: ControlPlaneTx): number {
    return tx
      ? this.audit(entry, tx)
      : this.transaction((inner) => this.audit(entry, inner));
  }

  verifyLedger(): LedgerVerification {
    return verifyLedger(this.database.db);
  }
  enqueueEvent(event: LifecycleEvent, tx: ControlPlaneTx): OutboxEvent {
    return this.emit(event, tx);
  }
  deliverPending(handler: EventHandler): Promise<number> {
    return deliverPending(this.database.db, handler);
  }
  listDeadLetters(): OutboxEvent[] {
    return listDeadLetters(this.database.db);
  }

  private setOperationState(
    id: string,
    state: "committed" | "reconcile-required",
    evidenceInput: Record<string, string>,
  ): OperationMeta {
    const evidence = redactedEvidence(evidenceInput);
    return this.transaction((tx) => {
      const row = tx
        .query("SELECT * FROM operations WHERE id = ?")
        .get(id) as OperationRow | null;
      if (!row) throw new Error(`Operation not found: ${id}`);
      if (row.state === "committed" && state === "committed")
        return toOperation(row);
      const now = new Date().toISOString();
      tx.query(
        "UPDATE operations SET state = ?, evidence_json = ?, updated_at = ? WHERE id = ?",
      ).run(state, JSON.stringify(evidence), now, id);
      if (state === "reconcile-required") {
        tx.query(
          `INSERT INTO reconciliation_records (id, operation_id, state, evidence_json, created_at, updated_at)
          VALUES (?, ?, 'open', ?, ?, ?) ON CONFLICT(operation_id) DO UPDATE SET state = 'open', evidence_json = excluded.evidence_json, updated_at = excluded.updated_at`,
        ).run(randomUUID(), id, JSON.stringify(evidence), now, now);
      }
      this.audit(
        {
          actor: this.actor,
          action: `operation.${state}`,
          resource: row.resource,
          outcome: state,
          correlationId: row.correlation_id,
        },
        tx,
      );
      this.emit(
        {
          type: `operation.${state}`,
          resource: row.resource,
          correlationId: row.correlation_id,
          data: evidence,
        },
        tx,
      );
      return { ...toOperation(row), state, evidence, updatedAt: now };
    });
  }
}
