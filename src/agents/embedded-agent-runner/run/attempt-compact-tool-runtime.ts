// FORK: live session handles for the agent-driven `compact` tool, extracted
// from attempt.ts to keep it under the max-lines budget.
import type { OpenClawCodingToolsOptions } from "../../agent-tools.options.js";
import { estimateContextTokens } from "../../runtime/index.js";
import type { EmbeddedAttemptSessionResources } from "./attempt-session-settle.js";
import type { EmbeddedContextAccountingEvent } from "./internal-params.js";

/**
 * Late-bound handles: the tool set is constructed before the session,
 * session manager and lock exist, so the tool closes over this ref.
 */
export type CompactLiveHandles = {
  withLock?: <T>(run: () => Promise<T> | T) => Promise<T>;
  sessionRuntimeState?: { prePromptMessageCount: number };
};

export function buildCompactToolRuntime(params: {
  live: CompactLiveHandles;
  getResources: () => EmbeddedAttemptSessionResources;
  onContextAccountingEvent?: (event: EmbeddedContextAccountingEvent) => void;
}): NonNullable<OpenClawCodingToolsOptions["compactToolRuntime"]> {
  const { live, getResources } = params;
  return {
    getSessionManager: () => getResources().sessionManager,
    withSessionWriteLock: (run) => (live.withLock ? live.withLock(run) : Promise.resolve(run())),
    updateAgentMessagesAfterCompaction: (toolCallId, resultText) => {
      const resources = getResources();
      // SAFETY: only buildSessionContext is called; the cast narrows to that one method.
      const manager = resources.sessionManager as
        | { buildSessionContext: () => { messages: unknown[] } }
        | undefined;
      const state = resources.session?.agent?.state;
      if (!manager || !state) {
        return;
      }
      try {
        const ctx = manager.buildSessionContext();
        // SAFETY: session context messages are plain records; only keys are read/written.
        const messages = [...(ctx.messages as Array<Record<string, unknown>>)];
        const last = messages.at(-1);
        const lastContent =
          last && Array.isArray(last.content)
            ? (last.content as Array<Record<string, unknown>>) // SAFETY: Array.isArray checked.
            : [];
        // The SDK appends the assistant toolCall before execute() and the
        // real toolResult after it returns; swapping state mid-execute
        // would orphan the toolCall and transcript-repair would replace
        // it with a synthetic error, killing the turn.
        const hasOrphan =
          Boolean(last) &&
          last?.role === "assistant" &&
          lastContent.some((b) => b?.type === "toolCall" && b?.id === toolCallId);
        if (hasOrphan) {
          messages.push({
            role: "toolResult",
            toolCallId,
            toolName: "compact",
            content: [{ type: "text", text: resultText }],
            isError: false,
            timestamp: Date.now(),
          });
        }
        // SAFETY: messages came from state.messages via buildSessionContext, same shape back.
        state.messages = messages as never;
        if (live.sessionRuntimeState) {
          live.sessionRuntimeState.prePromptMessageCount = messages.length;
        }
        params.onContextAccountingEvent?.({
          kind: "compaction",
          tokensAfter: estimateContextTokens(messages as never).tokens,
        });
      } catch {
        /* best-effort: compaction already landed on disk */
      }
    },
  };
}
