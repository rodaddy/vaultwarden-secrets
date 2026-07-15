/**
 * server/rotation/states.ts
 *
 * Explicit rotation state machine. GCP/#10-shaped happy path plus terminal
 * failure outcomes. The valid-transition graph is data, not scattered `if`s,
 * so illegal transitions are rejected in one place and the diagram in
 * docs/rotation.md stays in lockstep with the code.
 */

export type RotationStage =
  // happy path
  | "requested"
  | "provider-created"
  | "staged" // new version in vault + control plane
  | "consumers-reloaded"
  | "verified"
  | "alias-moved"
  | "old-revoked"
  | "done"
  // failure handling
  | "failed"
  | "rolling-back"
  | "rolled-back"
  | "reconcile-required";

/** Terminal stages: no outbound transitions. */
export const TERMINAL_STAGES: ReadonlySet<RotationStage> =
  new Set<RotationStage>(["done", "rolled-back", "reconcile-required"]);

/** Ordered happy-path stages the driver advances through. */
export const HAPPY_PATH: readonly RotationStage[] = [
  "requested",
  "provider-created",
  "staged",
  "consumers-reloaded",
  "verified",
  "alias-moved",
  "old-revoked",
  "done",
];

/**
 * Valid-transition graph. Each key lists the stages it may move to.
 * Any stage may fail (except terminals). `failed` can either roll back or,
 * when a partial cross-store outcome makes rollback unsafe, escalate to
 * reconcile-required. `rolling-back` resolves to rolled-back or, if rollback
 * itself cannot fully undo, reconcile-required.
 */
export const TRANSITIONS: Record<RotationStage, readonly RotationStage[]> = {
  requested: ["provider-created", "failed"],
  "provider-created": ["staged", "failed"],
  staged: ["consumers-reloaded", "failed"],
  "consumers-reloaded": ["verified", "failed"],
  verified: ["alias-moved", "failed"],
  // Alias move is the cross-store commit point: a failure here can leave a
  // partial outcome, so it may go straight to reconcile-required.
  "alias-moved": ["old-revoked", "failed", "reconcile-required"],
  // Revoke failure after a committed alias is a partial cross-store outcome.
  "old-revoked": ["done", "reconcile-required"],
  done: [],
  failed: ["rolling-back", "reconcile-required"],
  "rolling-back": ["rolled-back", "reconcile-required"],
  "rolled-back": [],
  "reconcile-required": [],
};

export function isTerminal(stage: RotationStage): boolean {
  return TERMINAL_STAGES.has(stage);
}

export function canTransition(from: RotationStage, to: RotationStage): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export class InvalidTransitionError extends Error {
  constructor(from: RotationStage, to: RotationStage) {
    super(`invalid rotation transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/** The next happy-path stage after `stage`, or null at the end/terminal. */
export function nextHappyStage(stage: RotationStage): RotationStage | null {
  const i = HAPPY_PATH.indexOf(stage);
  if (i < 0 || i >= HAPPY_PATH.length - 1) return null;
  return HAPPY_PATH[i + 1] ?? null;
}
