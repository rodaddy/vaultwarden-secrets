/**
 * server/rotation/deps.ts
 *
 * PINNED dependency interfaces for the rotation engine.
 *
 * These are the shapes the integration pass will satisfy. They are defined
 * LOCALLY on purpose: the concrete implementations (control plane store,
 * authorization, audit ledger, outbox, vault writer) are being built in
 * parallel streams. The engine depends only on these interfaces and receives
 * concrete instances via constructor injection. Nothing in this file imports
 * from `server/control-plane` or `server/authz`.
 *
 * Security boundary rule: `ctx` values that cross the engine <-> connector
 * boundary carry IDENTIFIERS ONLY, never secret material. Connectors handle
 * generated material internally and persist it through an injected
 * {@link VaultWriter}. The engine never sees, stores, or logs a payload value.
 */

// ---------------------------------------------------------------------------
// Control plane store (immutable versions + aliases + lifecycle)
// ---------------------------------------------------------------------------

export interface AddVersionInput {
  /** Logical credential/secret name (identifier, never a value). */
  secret: string;
  /** Opaque pointer to the material stored in the vault (identifier). */
  payloadRef: string;
  /** Content checksum/hash of the material (NOT the material). */
  checksum: string;
  /** Idempotency key so a re-run does not create a duplicate version. */
  idempotencyKey: string;
}

export interface VersionResult {
  version: number;
}

export interface MoveAliasInput {
  secret: string;
  alias: string;
  toVersion: number;
  /**
   * CAS guard: the version the caller believes the alias currently points at.
   * The store MUST reject the move if the live alias has drifted. `null` means
   * "expected unset / first assignment".
   */
  expectedFromVersion?: number | null;
}

export interface VersionRecord {
  version: number;
  payloadRef: string;
  checksum: string;
  state?: string;
}

export interface ReconcileOp {
  op: string;
  secret: string;
  detail: string;
}

export interface ControlPlaneStore {
  addVersion(input: AddVersionInput): Promise<VersionResult>;
  moveAlias(input: MoveAliasInput): Promise<void>;
  getVersion(
    secret: string,
    versionOrAlias: number | string,
  ): Promise<VersionRecord | null>;
  markReconcileRequired(op: ReconcileOp): Promise<void>;
}

// ---------------------------------------------------------------------------
// Authorization (fail-closed)
// ---------------------------------------------------------------------------

export type RotationAction = "rotate" | "move-alias" | "revoke" | "rollback";

export interface AuthorizeInput {
  subject: string;
  action: RotationAction;
  resource: string;
}

export interface AuthorizeResult {
  allow: boolean;
  reason?: string;
}

export interface Authorize {
  (input: AuthorizeInput): Promise<AuthorizeResult>;
}

// ---------------------------------------------------------------------------
// Audit ledger + event outbox (redacted only)
// ---------------------------------------------------------------------------

export interface AuditEntry {
  jobId: string;
  secret: string;
  stage: string;
  outcome: "ok" | "error" | "skip";
  /** Identifiers/hashes only. Guarded against leaking secret material. */
  detail?: Record<string, string | number | boolean | null>;
  at: string;
}

export interface Audit {
  appendAudit(entry: AuditEntry): Promise<void>;
}

export interface OutboxEvent {
  jobId: string;
  secret: string;
  type: string;
  /** Identifiers/hashes only. Guarded against leaking secret material. */
  data?: Record<string, string | number | boolean | null>;
  at: string;
}

export interface Outbox {
  enqueueEvent(event: OutboxEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// Vault writer (the ONLY component that touches material)
// ---------------------------------------------------------------------------

/**
 * A generator that produces the raw secret material. It runs INSIDE the vault
 * writer boundary; its return value never crosses back into engine state.
 */
export type MaterialGenerator = () => Promise<string> | string;

export interface VaultWriteResult {
  payloadRef: string;
  checksum: string;
}

export interface VaultWriter {
  /**
   * Persist material produced by `generator` under `ref`. Returns only an
   * identifier (payloadRef) and a checksum -- never the material itself.
   */
  writeItem(
    ref: string,
    generator: MaterialGenerator,
  ): Promise<VaultWriteResult>;
}

// ---------------------------------------------------------------------------
// Connector (provider-facing)
// ---------------------------------------------------------------------------

/**
 * Context passed to connector methods. IDENTIFIERS ONLY. The connector uses
 * the injected {@link VaultWriter} to store generated material; nothing here
 * carries a secret value.
 */
export interface ConnectorContext {
  jobId: string;
  secret: string;
  strategy: RotationStrategy;
  /** Vault ref for the newly staged version (set once staged). */
  newPayloadRef?: string;
  /** Vault ref / provider handle for the credential being superseded. */
  oldPayloadRef?: string;
  /** Provider-side handle for the newly created credential, if any. */
  newProviderRef?: string;
  /** Provider-side handle for the old credential to revoke. */
  oldProviderRef?: string;
  vault: VaultWriter;
}

export interface ConnectorCreateResult {
  payloadRef: string;
  checksum: string;
  /** Optional provider-side identifier for the created credential. */
  providerRef?: string;
}

export interface Connector {
  /** Create the replacement at the provider + stage material via vault writer. */
  create(ctx: ConnectorContext): Promise<ConnectorCreateResult>;
  /** Prove the replacement works (provider/consumer probe). */
  verify(ctx: ConnectorContext): Promise<boolean>;
  /** Revoke the superseded provider credential (after verify passes). */
  revoke(ctx: ConnectorContext): Promise<void>;
  /** Bounded rollback of a failed rotation (leaves old credential intact). */
  rollback(ctx: ConnectorContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Rotation policy types
// ---------------------------------------------------------------------------

export type RotationStrategy = "dual" | "single";

/**
 * Consumer reload hook config. ALLOWLIST ONLY. A consumer name maps to a
 * declared systemd unit or a fixed command template. Caller-supplied commands
 * are never accepted.
 */
export type ConsumerHook =
  | { kind: "systemd"; unit: string }
  | { kind: "command"; command: readonly string[] };

export type ConsumerAllowlist = Record<string, ConsumerHook>;

/** Executes an allowlisted consumer reload. Injected so tests stay offline. */
export interface ConsumerReloader {
  reload(consumer: string, hook: ConsumerHook): Promise<void>;
}

export interface Clock {
  now(): number;
}

export interface EngineDeps {
  store: ControlPlaneStore;
  authorize: Authorize;
  audit: Audit;
  outbox: Outbox;
  connector: Connector;
  vault: VaultWriter;
  consumerAllowlist: ConsumerAllowlist;
  consumerReloader: ConsumerReloader;
  clock?: Clock;
  /** Lease TTL in ms. Default 5 minutes. */
  leaseTtlMs?: number;
  /** Max attempts per stage before failing. Default 3. */
  maxAttempts?: number;
}
