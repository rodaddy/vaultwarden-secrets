/**
 * server/rotation/wiring.ts
 *
 * Integration wiring for the rotation engine. Maps the REAL merged modules
 * (control-plane store, authz engine, vault client) onto the PINNED injected
 * interfaces the engine depends on (server/rotation/deps.ts). This is the only
 * place the rotation engine meets production components; the engine and its
 * deps.ts contract are untouched.
 *
 * Three adapter hazards are solved here (see the task spec):
 *  (a) CAS on moveAlias -- the real store has no CAS on its plain moveAlias, so
 *      we route through the purpose-built atomic `store.moveAliasCas` which does
 *      read-alias + compare + write inside ONE control-plane transaction.
 *  (b) Audit/Outbox tx ownership + shape mapping -- the engine calls
 *      appendAudit/enqueueEvent as standalone async calls; the real store needs
 *      a ControlPlaneTx. Each adapter opens its own `store.transaction(...)` and
 *      maps the rotation shape onto the control-plane shape.
 *  (c) markReconcileRequired shape -- rotation passes {op,secret,detail} with no
 *      operation id; the real store is operation-id based. We open an operation
 *      then mark it reconcile-required with redaction-safe evidence.
 *
 * Security boundary rule (unchanged): identifiers/hashes only cross the engine
 * boundary. The VaultWriter is the only adapter that touches material; it
 * computes a checksum WITHOUT logging or returning the material.
 */

import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { ControlPlaneStore as RealControlPlaneStore } from "../control-plane/store";
import { AliasCasError } from "../control-plane/lifecycle";
import type { AuthorizationEngine, Action } from "../authz/authz";
import { bwCreateItem, bwGetItem, buildCreateTemplate } from "../vault-client";
import { RotationEngine } from "./engine";
import { RotationStore } from "./store-sqlite";
import {
  CloudflareConnector,
  cloudflareConfigFromEnv,
} from "./connectors/cloudflare";
import type {
  AddVersionInput,
  Audit,
  AuditEntry,
  Authorize,
  AuthorizeInput,
  AuthorizeResult,
  Connector,
  ConsumerAllowlist,
  ConsumerHook,
  ConsumerReloader,
  ControlPlaneStore as RotationControlPlaneStore,
  EngineDeps,
  MaterialGenerator,
  MoveAliasInput,
  Outbox,
  OutboxEvent,
  ReconcileOp,
  VaultWriteResult,
  VaultWriter,
  VersionRecord,
  VersionResult,
} from "./deps";

// ---------------------------------------------------------------------------
// (a)+(b)+(c) Control plane store adapter
// ---------------------------------------------------------------------------

function resourceOf(secret: string): string {
  return `secrets/${secret}`;
}

/**
 * Adapts the real synchronous, tx-owning {@link RealControlPlaneStore} to the
 * async rotation {@link RotationControlPlaneStore} interface.
 */
export class ControlPlaneStoreAdapter implements RotationControlPlaneStore {
  constructor(private readonly real: RealControlPlaneStore) {}

  async addVersion(input: AddVersionInput): Promise<VersionResult> {
    // Real addVersion is sync and returns full VersionMeta; project to {version}.
    const meta = this.real.addVersion({
      secret: input.secret,
      payloadRef: input.payloadRef,
      checksum: input.checksum,
      idempotencyKey: input.idempotencyKey,
    });
    return { version: meta.version };
  }

  async moveAlias(input: MoveAliasInput): Promise<void> {
    // (a) CAS: the engine's expectedFromVersion is enforced atomically by the
    // real store's purpose-built moveAliasCas (read+check+write in one tx).
    // Translate the store-side CAS violation into the engine's failure signal.
    try {
      this.real.moveAliasCas({
        secret: input.secret,
        alias: input.alias,
        toVersion: input.toVersion,
        expectedFromVersion: input.expectedFromVersion ?? null,
      });
    } catch (err) {
      if (err instanceof AliasCasError) {
        // Surface as a plain Error the engine treats as a retryable/stale
        // publish; message carries identifiers only (no material).
        throw new Error(err.message);
      }
      throw err;
    }
  }

  async getVersion(
    secret: string,
    versionOrAlias: number | string,
  ): Promise<VersionRecord | null> {
    const meta = this.real.getVersion(secret, versionOrAlias);
    if (!meta) return null;
    return {
      version: meta.version,
      payloadRef: meta.payloadRef ?? "",
      checksum: meta.checksum,
      state: meta.state,
    };
  }

  async markReconcileRequired(op: ReconcileOp): Promise<void> {
    // (c) The real store is operation-id based. Open an operation, then mark it
    // reconcile-required with redaction-safe evidence. Keys op/detail are safe
    // against the store's sensitive-key rejector; detail is pre-sanitized by
    // the engine (identifiers/hashes only).
    const operation = this.real.beginOperation({
      kind: "rotation.reconcile",
      resource: resourceOf(op.secret),
    });
    this.real.markReconcileRequired(operation.id, {
      op: op.op,
      detail: op.detail,
    });
  }
}

// ---------------------------------------------------------------------------
// (b) Audit adapter -- opens its own tx per call, maps shape
// ---------------------------------------------------------------------------

export class AuditAdapter implements Audit {
  constructor(private readonly real: RealControlPlaneStore) {}

  async appendAudit(entry: AuditEntry): Promise<void> {
    // rotation {jobId,secret,stage,outcome,detail,at} -> real audit
    // {actor,action:'rotation.<stage>',resource:'secrets/<secret>',outcome,correlationId:jobId}
    this.real.transaction((tx) => {
      this.real.appendAudit(
        {
          actor: this.real.actor,
          action: `rotation.${entry.stage}`,
          resource: resourceOf(entry.secret),
          outcome: entry.outcome,
          correlationId: entry.jobId,
        },
        tx,
      );
    });
  }
}

// ---------------------------------------------------------------------------
// (b) Outbox adapter -- opens its own tx per call, maps shape
// ---------------------------------------------------------------------------

/** Coerce rotation detail into the redaction-safe LifecycleEvent data shape. */
function toEventData(
  data: OutboxEvent["data"],
): Record<string, string | number | boolean | null> {
  return data ?? {};
}

export class OutboxAdapter implements Outbox {
  constructor(private readonly real: RealControlPlaneStore) {}

  async enqueueEvent(event: OutboxEvent): Promise<void> {
    // rotation {jobId,secret,type,data,at} -> real enqueueEvent
    // ({type,resource:'secrets/<secret>',correlationId:jobId,data}). The real
    // store rejects secret-looking values -- that redaction is a feature, kept.
    this.real.transaction((tx) => {
      this.real.enqueueEvent(
        {
          type: event.type,
          resource: resourceOf(event.secret),
          correlationId: event.jobId,
          data: toEventData(event.data),
        },
        tx,
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Authorize adapter -- real AuthorizationEngine
// ---------------------------------------------------------------------------

/**
 * Map rotation actions onto the authz Action union. Each rotation capability is
 * its OWN first-class action so a rotate role can be granted least-privilege
 * (F2): revoking a provider credential (`rotate.revoke`) and bounded rollback
 * (`rotate.rollback`) are distinct from `secret.destroy` on a version. A
 * subject can drive rotation revoke/rollback WITHOUT holding secret.destroy,
 * and holding secret.destroy alone grants no rotation capability.
 */
const ROTATION_TO_AUTHZ_ACTION: Record<AuthorizeInput["action"], Action> = {
  rotate: "rotate",
  "move-alias": "alias.move",
  revoke: "rotate.revoke",
  rollback: "rotate.rollback",
};

/**
 * Build the {@link Authorize} function the engine expects from the real
 * {@link AuthorizationEngine}. Fail-closed: any non-allow decision denies.
 * Decision.reason is audit-only and never surfaced to the caller.
 */
export function makeAuthorize(engine: AuthorizationEngine): Authorize {
  return async (input: AuthorizeInput): Promise<AuthorizeResult> => {
    const action = ROTATION_TO_AUTHZ_ACTION[input.action];
    const decision = engine.authorize({
      subject: input.subject,
      action,
      resource: input.resource,
    });
    return decision.allow
      ? { allow: true }
      : { allow: false, reason: "denied by policy" };
  };
}

// ---------------------------------------------------------------------------
// VaultWriter adapter -- the ONLY component that touches material
// ---------------------------------------------------------------------------

export interface BwSession {
  session: string;
  /** Folder id newly created rotation items are stored under. */
  folderId: string;
}

/** Creates a vaultwarden item from a template; defaults to the real bw CLI. */
export type ItemCreator = (
  session: string,
  template: Record<string, unknown>,
) => Promise<{ id: string }>;

/**
 * Persists generated material as a vaultwarden secure-note item and returns
 * `{payloadRef:'vaultwarden:<id>', checksum:'sha256:<hex>'}`. The material is
 * computed, hashed, and written to the vault WITHOUT ever being logged or
 * returned to the engine. `creator` is injected so tests stay offline.
 */
export class VaultWriterAdapter implements VaultWriter {
  private readonly creator: ItemCreator;
  constructor(
    private readonly sessionProvider: () => Promise<BwSession>,
    creator: ItemCreator = bwCreateItem,
  ) {
    this.creator = creator;
  }

  async writeItem(
    ref: string,
    generator: MaterialGenerator,
  ): Promise<VaultWriteResult> {
    const material = await generator();
    // Compute the checksum without logging or persisting the raw material
    // anywhere except the vault item body.
    const checksum =
      "sha256:" + createHash("sha256").update(material).digest("hex");
    const { session, folderId } = await this.sessionProvider();
    const template = buildCreateTemplate({
      name: ref,
      type: 2, // secure note; material lives in a hidden custom field
      folderId,
      fields: [{ name: "material", value: material, type: 1 }],
    });
    const created = await this.creator(session, template);
    return { payloadRef: `vaultwarden:${created.id}`, checksum };
  }
}

/**
 * Read-for-probe adapter over the vault client. Reads the hidden material field
 * back for a verify() probe; used transiently and never returned to the engine.
 */
export class VaultReaderAdapter {
  constructor(private readonly sessionProvider: () => Promise<BwSession>) {}

  async readItem(payloadRef: string): Promise<string | null> {
    const id = payloadRef.startsWith("vaultwarden:")
      ? payloadRef.slice("vaultwarden:".length)
      : payloadRef;
    const { session } = await this.sessionProvider();
    const item = await bwGetItem(session, id);
    const field = (item?.fields ?? []).find(
      (f: { name?: string; value?: string }) => f.name === "material",
    );
    return field?.value ?? null;
  }
}

// ---------------------------------------------------------------------------
// ConsumerReloader -- allowlist-only systemd/command executor
// ---------------------------------------------------------------------------

/**
 * Runs an allowlisted consumer reload. The hook itself (systemd unit or fixed
 * command template) comes from the engine's allowlist -- caller-supplied
 * commands are never accepted. `runner` is injected so tests stay offline.
 */
export class SystemdConsumerReloader implements ConsumerReloader {
  constructor(
    private readonly runner: (argv: readonly string[]) => Promise<void>,
  ) {}

  async reload(consumer: string, hook: ConsumerHook): Promise<void> {
    if (hook.kind === "systemd") {
      await this.runner(["systemctl", "reload-or-restart", hook.unit]);
      return;
    }
    // kind === "command": the argv is a fixed template from the allowlist.
    await this.runner(hook.command);
  }
}

// ---------------------------------------------------------------------------
// Engine factory -- assembles the wired deps onto a RotationEngine
// ---------------------------------------------------------------------------

export interface RotationWiring {
  /** Real control-plane store (owns versions/aliases/audit/outbox). */
  store: RealControlPlaneStore;
  /** Real authorization engine (default-deny). */
  authz: AuthorizationEngine;
  /** Provider-facing connector instance (selected by the caller). */
  connector: Connector;
  /** Vault writer over the vault client (the only material-touching adapter). */
  vault: VaultWriter;
  /** Allowlist mapping consumer name -> declared reload hook. */
  consumerAllowlist: ConsumerAllowlist;
  /** Allowlisted consumer reload executor. */
  consumerReloader: ConsumerReloader;
  /** Optional engine tuning. */
  leaseTtlMs?: number;
  maxAttempts?: number;
}

/**
 * Assemble the injected {@link EngineDeps} from real modules and construct a
 * {@link RotationEngine} bound to the given rotation-job database. The engine
 * and its deps.ts contract are untouched; this factory only maps real
 * components onto the pinned interfaces via the adapters above.
 */
export function buildRotationEngine(
  db: Database,
  wiring: RotationWiring,
): RotationEngine {
  const deps: EngineDeps = {
    store: new ControlPlaneStoreAdapter(wiring.store),
    authorize: makeAuthorize(wiring.authz),
    audit: new AuditAdapter(wiring.store),
    outbox: new OutboxAdapter(wiring.store),
    connector: wiring.connector,
    vault: wiring.vault,
    consumerAllowlist: wiring.consumerAllowlist,
    consumerReloader: wiring.consumerReloader,
    ...(wiring.leaseTtlMs != null ? { leaseTtlMs: wiring.leaseTtlMs } : {}),
    ...(wiring.maxAttempts != null ? { maxAttempts: wiring.maxAttempts } : {}),
  };
  return new RotationEngine(db, deps);
}

/**
 * Resolve a connector instance by name from the configured registry. Returns
 * null when the named connector is unknown or not configured (e.g. missing
 * provider env). The caller fails closed on null -- never invents a connector.
 * `vaultReader` lets the connector probe the NEW credential during verify().
 */
export function resolveConnector(
  name: string,
  vaultReader?: { readItem(payloadRef: string): Promise<string | null> },
): Connector | null {
  if (name === "cloudflare") {
    const cfg = cloudflareConfigFromEnv();
    if (!cfg) return null;
    return new CloudflareConnector({ ...cfg, vaultReader });
  }
  return null;
}

export interface SupersededRefs {
  /** Provider handle of the credential this rotation supersedes (revoke target). */
  oldProviderRef: string | null;
  /** Vault ref of the credential this rotation supersedes. */
  oldPayloadRef: string | null;
  /** True when there is no prior completed rotation -> nothing to revoke. */
  firstIssuance: boolean;
}

/**
 * SECURITY (F1): derive the superseded credential's revoke target from TRUSTED
 * server state, never from the request. The prior PUBLISHED rotation job for
 * THIS secret recorded the provider handle + vault ref it made live; that is
 * exactly what the next rotation supersedes. A caller can therefore never point
 * the revoke (a provider-side DELETE) at an unrelated credential id.
 *
 * "Published" spans `done`, `old-revoked`, and `reconcile-required` (any job
 * past alias-moved), newest-first -- NOT merely the newest `done` job. A prior
 * rotation that published but then failed its revoke sits in
 * `reconcile-required`, and ITS handle is the actually-live stale credential;
 * selecting an older `done` job would revoke an already-dead handle and leave
 * the real one un-revoked (F1 stale-job fix).
 *
 * If no prior published job exists, this is a first issuance through the engine
 * and there is nothing to revoke -- the caller MUST NOT be able to supply a
 * handle to fill that gap.
 */
export function resolveSupersededRefs(
  rotationDb: Database,
  secret: string,
): SupersededRefs {
  const store = new RotationStore(rotationDb);
  const last = store.getLastPublishedJob(secret);
  if (!last || !last.newProviderRef) {
    // No trusted prior credential for this secret -> first issuance.
    return { oldProviderRef: null, oldPayloadRef: null, firstIssuance: true };
  }
  return {
    oldProviderRef: last.newProviderRef,
    oldPayloadRef: last.newPayloadRef ?? null,
    firstIssuance: false,
  };
}
