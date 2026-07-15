import { createHash } from "node:crypto";
import type { ControlPlaneTx } from "./db";
import type { AuditEntry } from "./types";

const SENSITIVE_KEY =
  /(?:password|token|secret|credential|payload|private[_-]?key)/i;
const GENESIS_HASH = "0".repeat(64);

type LedgerRow = {
  sequence: number;
  actor: string;
  action: string;
  resource: string;
  outcome: string;
  correlation_id: string;
  ts: string;
  prev_hash: string;
  hash: string;
};

export interface LedgerVerification {
  ok: boolean;
  sequence?: number;
  reason?: "sequence-gap" | "previous-hash-mismatch" | "hash-mismatch";
}

/** Reject data that could turn the audit trail into another secret store. */
export function assertRedacted(value: unknown, key = ""): void {
  if (value === undefined || value === null) return;
  if (SENSITIVE_KEY.test(key)) {
    throw new Error(`Sensitive audit/outbox field rejected: ${key}`);
  }
  if (Array.isArray(value)) {
    for (const item of value) assertRedacted(item, key);
    return;
  }
  if (typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value))
      assertRedacted(childValue, childKey);
  }
}

function hashRow(
  prevHash: string,
  row: Omit<LedgerRow, "prev_hash" | "hash">,
): string {
  return createHash("sha256")
    .update(prevHash)
    .update(JSON.stringify(row))
    .digest("hex");
}

export function appendAudit(entry: AuditEntry, tx: ControlPlaneTx): number {
  assertRedacted(entry);
  const ts = entry.ts ?? new Date().toISOString();
  const previous = tx
    .query(
      "SELECT sequence, hash FROM audit_ledger ORDER BY sequence DESC LIMIT 1",
    )
    .get() as Pick<LedgerRow, "sequence" | "hash"> | null;
  const sequence = (previous?.sequence ?? 0) + 1;
  const prevHash = previous?.hash ?? GENESIS_HASH;
  const row = {
    sequence,
    actor: entry.actor,
    action: entry.action,
    resource: entry.resource,
    outcome: entry.outcome,
    correlation_id: entry.correlationId,
    ts,
  };
  const hash = hashRow(prevHash, row);
  tx.query(
    `INSERT INTO audit_ledger
    (sequence, actor, action, resource, outcome, correlation_id, ts, prev_hash, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sequence,
    row.actor,
    row.action,
    row.resource,
    row.outcome,
    row.correlation_id,
    ts,
    prevHash,
    hash,
  );
  return sequence;
}

export function verifyLedger(tx: ControlPlaneTx): LedgerVerification {
  const rows = tx
    .query("SELECT * FROM audit_ledger ORDER BY sequence")
    .all() as LedgerRow[];
  let expectedSequence = 1;
  let previousHash = GENESIS_HASH;
  for (const row of rows) {
    if (row.sequence !== expectedSequence)
      return { ok: false, sequence: row.sequence, reason: "sequence-gap" };
    if (row.prev_hash !== previousHash)
      return {
        ok: false,
        sequence: row.sequence,
        reason: "previous-hash-mismatch",
      };
    const expectedHash = hashRow(row.prev_hash, {
      sequence: row.sequence,
      actor: row.actor,
      action: row.action,
      resource: row.resource,
      outcome: row.outcome,
      correlation_id: row.correlation_id,
      ts: row.ts,
    });
    if (row.hash !== expectedHash)
      return { ok: false, sequence: row.sequence, reason: "hash-mismatch" };
    expectedSequence += 1;
    previousHash = row.hash;
  }
  return { ok: true };
}
