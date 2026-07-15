import { createHash } from "node:crypto";
import type { ControlPlaneTx } from "./db";
import type { AuditEntry } from "./types";

const SENSITIVE_KEY =
  /(?:password|token|secret|credential|payload|private[_-]?key)/i;
const GENESIS_HASH = "0".repeat(64);
const OBVIOUS_SECRET_VALUE =
  /(?:^|[_-])(?:sk|pk|rk|ghp|github_pat|xox[baprs])[_-][A-Za-z0-9_-]{16,}$/;
const PRIVATE_KEY_VALUE = /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/;

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
  reason?:
    | "sequence-gap"
    | "previous-hash-mismatch"
    | "hash-mismatch"
    | "ledger-head-mismatch";
}

/** Recognize plaintext credentials without treating ordinary metadata as secret. */
export function looksLikeSecretValue(value: string): boolean {
  if (PRIVATE_KEY_VALUE.test(value) || OBVIOUS_SECRET_VALUE.test(value))
    return true;
  const parts = value.split(".");
  return (
    parts.length === 3 &&
    parts.every((part) => /^[A-Za-z0-9_-]{16,}$/.test(part))
  );
}

/** Reject data that could turn the audit trail into another secret store. */
export function assertRedacted(value: unknown, key = ""): void {
  if (value === undefined || value === null) return;
  if (SENSITIVE_KEY.test(key)) {
    throw new Error(`Sensitive audit/outbox field rejected: ${key}`);
  }
  if (typeof value === "string" && looksLikeSecretValue(value)) {
    throw new Error("Sensitive audit/outbox value rejected");
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
  const head = tx
    .query("SELECT last_sequence, last_hash FROM ledger_head WHERE id = 1")
    .get() as { last_sequence: number; last_hash: string } | null;
  if (!head) throw new Error("Audit ledger head is missing");
  const sequence = head.last_sequence + 1;
  const existing = tx
    .query("SELECT 1 AS present FROM audit_ledger WHERE sequence = ?")
    .get(sequence) as { present: number } | null;
  if (existing)
    throw new Error(`Audit ledger sequence already exists: ${sequence}`);
  const prevHash = head.last_hash;
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
  const updated = tx
    .query(
      `UPDATE ledger_head SET last_sequence = ?, last_hash = ?
      WHERE id = 1 AND last_sequence = ? AND last_hash = ?`,
    )
    .run(sequence, hash, head.last_sequence, head.last_hash);
  if (updated.changes !== 1)
    throw new Error("Audit ledger head changed concurrently");
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
  const head = tx
    .query("SELECT last_sequence, last_hash FROM ledger_head WHERE id = 1")
    .get() as { last_sequence: number; last_hash: string } | null;
  if (!head) return { ok: false, reason: "ledger-head-mismatch" };
  const lastSequence = rows.at(-1)?.sequence ?? 0;
  if (head.last_sequence !== lastSequence || head.last_hash !== previousHash) {
    return {
      ok: false,
      sequence: Math.max(head.last_sequence, lastSequence),
      reason: "ledger-head-mismatch",
    };
  }
  return { ok: true };
}
