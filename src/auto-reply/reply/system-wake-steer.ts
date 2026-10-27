import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import type { FollowupRun } from "./queue/types.js";

/**
 * FORK: a requester-less execution (exec-completion/system wake) has no source turn,
 * so retained terminal tombstones from earlier restart recoveries make steering
 * fail closed as "unknown-source-with-terminal-history". Such an execution never
 * owns a restart-recovery terminal send, so the verified owner may still steer it.
 */
export function allowsOwnerSystemWakeSteer(
  blockReason: string | undefined,
  followupRun: FollowupRun,
  operation: ReplyOperation | undefined,
): boolean {
  return (
    blockReason === "unknown-source-with-terminal-history" &&
    operation !== undefined &&
    !operation.requesterPrincipalKey &&
    followupRun.run.senderIsOwner === true
  );
}
