export type VersionState = "ENABLED" | "DISABLED" | "DESTROYED";
export type OperationState = "pending" | "committed" | "reconcile-required";

export interface SecretMeta {
  id: string;
  name: string;
  labels: Record<string, string>;
  importedFrom?: string;
  createdAt: string;
}

export interface VersionMeta {
  secret: string;
  version: number;
  state: VersionState;
  payloadRef: string | null;
  checksum: string;
  createdAt: string;
}

export interface AliasMeta {
  secret: string;
  alias: string;
  version: number;
  updatedAt: string;
}

export interface OperationMeta {
  id: string;
  kind: string;
  resource: string;
  state: OperationState;
  correlationId: string;
  evidence?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  actor: string;
  action: string;
  resource: string;
  outcome: string;
  correlationId: string;
  ts?: string;
}

export interface LifecycleEvent {
  type: string;
  resource: string;
  correlationId?: string;
  data?: Record<string, string | number | boolean | null>;
  dedupeKey?: string;
}

export interface OutboxEvent extends Required<Omit<LifecycleEvent, "data">> {
  id: string;
  data: Record<string, string | number | boolean | null>;
  state: "pending" | "delivering" | "delivered" | "dead-letter";
  attempts: number;
  nextAttemptAt: number;
  processingUntil: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}
