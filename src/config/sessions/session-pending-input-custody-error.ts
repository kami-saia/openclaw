/** Custody refusal must not release already accepted input for another dispatch. */
export class SessionPendingInputCustodyError extends Error {}

/**
 * The durable pending-input row refuses this request permanently (identity
 * conflict or ended ownership). Replaying the same source cannot succeed, so
 * queue owners must settle it instead of retrying it.
 */
export class SessionPendingInputConflictError extends Error {}

const conflictMessages = {
  completion: "Input completion idempotency key conflicts with the accepted input",
  idempotency: "Pending input idempotency key conflicts with the accepted input",
  ownership: "Pending input ownership ended; submit a new turn to continue",
} as const;

export function pendingInputConflict(
  kind: keyof typeof conflictMessages,
): SessionPendingInputConflictError {
  return new SessionPendingInputConflictError(conflictMessages[kind]);
}

export function isSessionPendingInputConflictError(error: unknown): boolean {
  return error instanceof SessionPendingInputConflictError;
}
