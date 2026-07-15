/**
 * server/rotation/guard.ts
 *
 * No-secret-leak guard. The rotation engine must never let generated secret
 * material appear in job state, checkpoints, audit entries, outbox events,
 * receipts, or errors. Payloads live only inside the VaultWriter boundary.
 *
 * The engine registers the sentinel(s) it must never emit (the generated
 * material) and every value about to be persisted or logged is scanned. A hit
 * throws immediately -- fail closed -- rather than silently redacting, so a
 * leak is a hard, testable failure instead of a quiet near-miss.
 */

export class SecretLeakError extends Error {
  constructor(where: string) {
    // Deliberately does NOT include the offending value.
    super(`secret material leak detected while building ${where}`);
    this.name = "SecretLeakError";
  }
}

/**
 * A tripwire holding registered sentinels (raw secret values that must never
 * be emitted). Values are held only in memory for the life of a job and never
 * serialized themselves.
 */
export class LeakGuard {
  private sentinels: string[] = [];

  /** Register a raw secret value that must never appear in emitted state. */
  arm(sentinel: string | null | undefined): void {
    if (typeof sentinel === "string" && sentinel.length >= 8) {
      this.sentinels.push(sentinel);
    }
  }

  /** True if `text` contains any armed sentinel. */
  private trips(text: string): boolean {
    for (const s of this.sentinels) {
      if (text.includes(s)) return true;
    }
    return false;
  }

  /**
   * Assert that a value about to be persisted/emitted contains no sentinel.
   * Scans the JSON serialization so nested fields are covered. Returns the
   * value unchanged on success; throws {@link SecretLeakError} otherwise.
   */
  assertClean<T>(value: T, where: string): T {
    let text: string;
    try {
      text = JSON.stringify(value);
    } catch {
      // Non-serializable: fall back to String() so we still scan something.
      text = String(value);
    }
    if (text !== undefined && this.trips(text)) {
      throw new SecretLeakError(where);
    }
    return value;
  }

  /** Sanitize an arbitrary error so a thrown payload cannot leak upstream. */
  sanitizeError(err: unknown, where: string): Error {
    const msg = err instanceof Error ? err.message : String(err);
    if (this.trips(msg)) {
      return new SecretLeakError(where);
    }
    return err instanceof Error ? err : new Error(msg);
  }
}
