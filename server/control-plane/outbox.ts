import { randomUUID } from "node:crypto";
import type { ControlPlaneTx } from "./db";
import { assertRedacted } from "./audit";
import type { LifecycleEvent, OutboxEvent } from "./types";

const DEFAULT_MAX_ATTEMPTS = 3;
const LEASE_MS = 30_000;

type EventRow = {
  id: string;
  type: string;
  resource: string;
  correlation_id: string;
  data_json: string;
  dedupe_key: string;
  state: OutboxEvent["state"];
  attempts: number;
  next_attempt_at: number;
  processing_until: number | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
};

export type EventHandler = (event: OutboxEvent) => void | Promise<void>;

function toEvent(row: EventRow): OutboxEvent {
  return {
    id: row.id,
    type: row.type,
    resource: row.resource,
    correlationId: row.correlation_id,
    data: JSON.parse(row.data_json) as OutboxEvent["data"],
    dedupeKey: row.dedupe_key,
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    processingUntil: row.processing_until,
    lastError: row.last_error,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

export function enqueueEvent(
  event: LifecycleEvent,
  tx: ControlPlaneTx,
): OutboxEvent {
  assertRedacted(event);
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const id = randomUUID();
  const correlationId = event.correlationId ?? id;
  const dedupeKey =
    event.dedupeKey ?? `${event.type}:${event.resource}:${correlationId}`;
  const data = event.data ?? {};
  tx.query(
    `INSERT INTO outbox_events
    (id, type, resource, correlation_id, data_json, dedupe_key, state, attempts, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
  ).run(
    id,
    event.type,
    event.resource,
    correlationId,
    JSON.stringify(data),
    dedupeKey,
    now,
    createdAt,
  );
  return {
    id,
    type: event.type,
    resource: event.resource,
    correlationId,
    data,
    dedupeKey,
    state: "pending",
    attempts: 0,
    nextAttemptAt: now,
    processingUntil: null,
    lastError: null,
    createdAt,
    deliveredAt: null,
  };
}

export async function deliverPending(
  tx: ControlPlaneTx,
  handler: EventHandler,
  options: { now?: number; maxAttempts?: number } = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const rows = tx
    .query(
      `SELECT * FROM outbox_events
    WHERE (state = 'pending' AND next_attempt_at <= ?)
       OR (state = 'delivering' AND processing_until <= ?)
    ORDER BY created_at`,
    )
    .all(now, now) as EventRow[];
  let delivered = 0;
  for (const row of rows) {
    const leaseUntil = now + LEASE_MS;
    const claimed = tx
      .query(
        `UPDATE outbox_events SET state = 'delivering', processing_until = ?
      WHERE id = ? AND ((state = 'pending' AND next_attempt_at <= ?)
        OR (state = 'delivering' AND processing_until <= ?))`,
      )
      .run(leaseUntil, row.id, now, now);
    if (claimed.changes !== 1) continue;
    const priorDelivery = tx
      .query(
        `SELECT id FROM outbox_events
        WHERE dedupe_key = ? AND state = 'delivered' AND id <> ? LIMIT 1`,
      )
      .get(row.dedupe_key, row.id) as { id: string } | null;
    if (priorDelivery) {
      tx.query(
        `UPDATE outbox_events SET state = 'delivered', delivered_at = ?, processing_until = NULL,
        last_error = NULL WHERE id = ?`,
      ).run(new Date(now).toISOString(), row.id);
      continue;
    }
    const event = toEvent({
      ...row,
      state: "delivering",
      processing_until: leaseUntil,
    });
    try {
      await handler(event);
      tx.query(
        `UPDATE outbox_events SET state = 'delivered', delivered_at = ?, processing_until = NULL,
        last_error = NULL WHERE id = ?`,
      ).run(new Date(now).toISOString(), row.id);
      delivered += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      const message =
        error instanceof Error ? error.message : "delivery failed";
      const state = attempts >= maxAttempts ? "dead-letter" : "pending";
      const retryAt = now + 1_000 * 2 ** Math.max(0, attempts - 1);
      tx.query(
        `UPDATE outbox_events SET state = ?, attempts = ?, next_attempt_at = ?, processing_until = NULL,
        last_error = ? WHERE id = ?`,
      ).run(state, attempts, retryAt, message.slice(0, 256), row.id);
    }
  }
  return delivered;
}

export function listDeadLetters(tx: ControlPlaneTx): OutboxEvent[] {
  return (
    tx
      .query(
        `SELECT * FROM outbox_events WHERE state = 'dead-letter' ORDER BY created_at`,
      )
      .all() as EventRow[]
  ).map(toEvent);
}
