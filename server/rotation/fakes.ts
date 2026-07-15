/**
 * server/rotation/fakes.ts
 *
 * In-memory reference implementations of the injected deps. Used by the
 * offline test suite and by scripts/rotate.ts in --dry-run mode until the real
 * control plane / authz / audit / outbox / vault streams are wired at
 * integration. None of these are production components.
 *
 * The InMemoryVaultWriter is the ONLY place secret material lives; it stores
 * material keyed by ref and returns a sha-256 checksum + ref. The material is
 * never returned to callers.
 */

import { createHash } from "node:crypto";
import type {
  Audit,
  AuditEntry,
  Authorize,
  AuthorizeInput,
  AuthorizeResult,
  ControlPlaneStore,
  MaterialGenerator,
  MoveAliasInput,
  Outbox,
  OutboxEvent,
  ReconcileOp,
  VaultWriteResult,
  VaultWriter,
  VersionRecord,
  AddVersionInput,
  VersionResult,
  ConsumerHook,
  ConsumerReloader,
} from "./deps";

// ---------------------------------------------------------------------------
// Vault writer (holds material; hands out refs + checksums only)
// ---------------------------------------------------------------------------

export class InMemoryVaultWriter implements VaultWriter {
  /** ref -> stored material. Test-only accessor to prove non-leakage. */
  readonly stored = new Map<string, string>();
  private seq = 0;

  async writeItem(
    ref: string,
    generator: MaterialGenerator,
  ): Promise<VaultWriteResult> {
    const material = await generator();
    const payloadRef = `${ref}@v${++this.seq}`;
    this.stored.set(payloadRef, material);
    const checksum =
      "sha256:" + createHash("sha256").update(material).digest("hex");
    return { payloadRef, checksum };
  }
}

// ---------------------------------------------------------------------------
// Control plane store (immutable versions + alias with CAS)
// ---------------------------------------------------------------------------

export class CasViolationError extends Error {
  constructor(
    secret: string,
    alias: string,
    expected: number | null | undefined,
    actual: number | null,
  ) {
    super(
      `CAS violation moving ${secret}:${alias} (expected ${expected}, actual ${actual})`,
    );
    this.name = "CasViolationError";
  }
}

interface VersionInternal extends VersionRecord {}

export class InMemoryControlPlaneStore implements ControlPlaneStore {
  private versions = new Map<string, VersionInternal[]>();
  private aliases = new Map<string, number>(); // `${secret}:${alias}` -> version
  private idem = new Map<string, number>(); // idempotencyKey -> version
  readonly reconcile: ReconcileOp[] = [];

  async addVersion(input: AddVersionInput): Promise<VersionResult> {
    const prior = this.idem.get(input.idempotencyKey);
    if (prior != null) return { version: prior }; // idempotent
    const list = this.versions.get(input.secret) ?? [];
    const version = list.length + 1;
    list.push({
      version,
      payloadRef: input.payloadRef,
      checksum: input.checksum,
      state: "staged",
    });
    this.versions.set(input.secret, list);
    this.idem.set(input.idempotencyKey, version);
    return { version };
  }

  async moveAlias(input: MoveAliasInput): Promise<void> {
    const key = `${input.secret}:${input.alias}`;
    const actual = this.aliases.get(key) ?? null;
    const expected = input.expectedFromVersion;
    if (expected !== undefined && (expected ?? null) !== actual) {
      throw new CasViolationError(input.secret, input.alias, expected, actual);
    }
    this.aliases.set(key, input.toVersion);
  }

  async getVersion(
    secret: string,
    versionOrAlias: number | string,
  ): Promise<VersionRecord | null> {
    const list = this.versions.get(secret) ?? [];
    if (typeof versionOrAlias === "number") {
      return list.find((v) => v.version === versionOrAlias) ?? null;
    }
    const v = this.aliases.get(`${secret}:${versionOrAlias}`);
    if (v == null) return null;
    return list.find((x) => x.version === v) ?? null;
  }

  async markReconcileRequired(op: ReconcileOp): Promise<void> {
    this.reconcile.push(op);
  }

  aliasVersion(secret: string, alias: string): number | null {
    return this.aliases.get(`${secret}:${alias}`) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Authorize / Audit / Outbox / ConsumerReloader
// ---------------------------------------------------------------------------

export function allowAllAuthorize(): Authorize {
  return async (_i: AuthorizeInput): Promise<AuthorizeResult> => ({
    allow: true,
  });
}

export function denyAuthorize(deniedActions: string[]): Authorize {
  return async (i: AuthorizeInput): Promise<AuthorizeResult> =>
    deniedActions.includes(i.action)
      ? { allow: false, reason: "denied by policy" }
      : { allow: true };
}

export class InMemoryAudit implements Audit {
  readonly entries: AuditEntry[] = [];
  async appendAudit(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

export class InMemoryOutbox implements Outbox {
  readonly events: OutboxEvent[] = [];
  async enqueueEvent(event: OutboxEvent): Promise<void> {
    this.events.push(event);
  }
}

/** No-op reloader for offline tests: records calls, never shells out. */
export class RecordingConsumerReloader implements ConsumerReloader {
  readonly reloads: Array<{ consumer: string; hook: ConsumerHook }> = [];
  async reload(consumer: string, hook: ConsumerHook): Promise<void> {
    this.reloads.push({ consumer, hook });
  }
}
