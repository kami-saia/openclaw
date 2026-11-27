import {
  annotateInterSessionPromptText,
  type InputProvenance,
} from "../../sessions/input-provenance.js";
import { visibleParentInputProvenance } from "../subagents/spawn/subagent-capabilities.js";

/** Builds sessions_send provenance; a verified spawning parent is marked as the child's parent. */
export function buildSessionsSendInput(
  message: string,
  requesterSessionKey: string | undefined,
  targetSessionKey: string,
  params: {
    targetEntry: Parameters<typeof visibleParentInputProvenance>[2];
    sourceChannel: string | undefined;
    requesterIsSubagent: boolean;
  },
) {
  const inputProvenance = {
    kind: "inter_session" as const,
    sourceSessionKey: requesterSessionKey,
    sourceChannel: params.sourceChannel,
    sourceTool: "sessions_send",
    ...(params.requesterIsSubagent ? { sourceRole: "subagent" as const } : {}),
    ...visibleParentInputProvenance(requesterSessionKey, targetSessionKey, params.targetEntry),
  } satisfies InputProvenance;
  return {
    inputProvenance,
    dispatchMessage: annotateInterSessionPromptText(message, inputProvenance),
  };
}
