/**
 * FORK: agent-driven compaction tool.
 *
 * Restores the pre-`f19e8cf1dda` design (deleted by the upstream merge) on top
 * of upstream's pre-compaction memory-flush turn:
 *
 *   flush turn (same session, same transcript, extra system section)
 *     -> model calls `compact({ summary })`
 *     -> this tool appends the compaction entry AND writes the summary to
 *        memory/YYYY-MM-DD.md programmatically (the model never calls `write`)
 *
 * Why this exists instead of the detached summarizer:
 *  - the detached summarization request shape (1 message, 0 tools, ~390 char
 *    system prompt, prose-serialized conversation) is what the Copilot
 *    enterprise endpoint 403s on;
 *  - the detached summarizer runs without SOUL/USER/AGENTS context, so a
 *    stranger model decides what matters and silently erases identity.
 *
 * Gated on `agents.defaults.compaction.mode === "agent"`.
 */
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { incrementCompactionCount } from "../../auto-reply/reply/session-updates.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveUserTimezone } from "../date-time.js";
import { restoreAgentOverflowStash } from "../embedded-agent-runner/run/agent-overflow-fallback.js";
import { prepareCompaction, type SessionManager } from "../sessions/index.js";
import type { AnyAgentTool } from "./common.js";

const log = createSubsystemLogger("agent-compaction");

const CompactToolSchema = Type.Object({
  summary: Type.String({
    description:
      "Structured summary of the conversation so far. Replaces older history verbatim-losslessly: " +
      "goal, constraints, decisions, retractions/corrections, open threads, critical context " +
      "(paths, ids, commands, numbers). Preserve decisions, corrections, retractions, and any " +
      "user statement that changed direction as written.",
  }),
  /**
   * Fallback (context-overflow) compaction preserves nothing: the recent tail
   * was already programmatically cut out of the request and is re-appended by
   * the runner after this call returns.
   */
  keepRecent: Type.Optional(
    Type.Boolean({
      description:
        "Keep the recent tail of the conversation after the summary (default true). " +
        "Set false only when instructed by a context-overflow fallback prompt.",
    }),
  ),
});

function formatDateStamp(nowMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  if (y && m && d) {
    return `${y}-${m}-${d}`;
  }
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function createCompactTool(options: {
  sessionKey?: string;
  sessionId?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  /** Live SessionManager for the in-flight embedded attempt. */
  getSessionManager?: () => SessionManager | undefined;
  /** Session store handle so the compaction counter / token cache stay coherent. */
  getSessionStoreContext?: () =>
    | {
        agentId?: string;
        sessionStore?: Record<string, unknown>;
        storePath?: string;
      }
    | undefined;
  /**
   * Refresh live agent.state.messages after compaction, injecting a synthetic
   * tool_result for this call: the SDK appends the assistant tool_use BEFORE
   * execute() and the real tool_result AFTER, so a mid-execute state swap would
   * otherwise leave an orphaned tool_use that transcript-repair replaces with a
   * synthetic error, killing the turn.
   */
  updateAgentMessagesAfterCompaction?: (toolCallId: string, resultText: string) => void;
  /**
   * Run session-file writes inside the embedded attempt's write lock; writing
   * outside it trips the fingerprint fence
   * (EmbeddedAttemptSessionTakeoverError) before the toolResult is persisted.
   */
  withSessionWriteLock?: <T>(run: () => Promise<T> | T) => Promise<T>;
  /** Test seam. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prepareCompactionOverride?: (pathEntries: any[], settings: any) => any;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (cfg?.agents?.defaults?.compaction?.mode !== "agent") {
    return null;
  }

  return {
    name: "compact",
    description:
      "Compact conversation history by replacing older messages with your own structured summary, " +
      "and record that summary in today's memory file. Call this when a context pressure or " +
      "context-overflow prompt tells you to compact.",
    label: "Compact conversation history",
    parameters: CompactToolSchema,
    async execute(toolCallId, params) {
      const prep = options.prepareCompactionOverride ?? prepareCompaction;
      const typed = params as { summary?: string; keepRecent?: boolean };
      const summary = typed.summary?.trim();
      if (!summary) {
        return {
          content: [{ type: "text", text: "Error: summary is required and cannot be empty." }],
          details: undefined,
        };
      }
      const sessionKey = options.sessionKey;
      if (!sessionKey) {
        return {
          content: [{ type: "text", text: "Error: no session key available." }],
          details: undefined,
        };
      }
      const sessionManager = options.getSessionManager?.();
      if (!sessionManager) {
        return {
          content: [{ type: "text", text: "Error: live session manager unavailable." }],
          details: undefined,
        };
      }

      try {
        const pathEntries = sessionManager.getBranch();
        const keepRecent = typed.keepRecent !== false;
        const settings = {
          enabled: true,
          reserveTokens: cfg?.agents?.defaults?.compaction?.reserveTokens ?? 0,
          // keepRecent=false is the overflow-fallback path: the recent tail was
          // already cut from the request and is re-appended by the runner.
          keepRecentTokens: keepRecent
            ? (cfg?.agents?.defaults?.compaction?.keepRecentTokens ?? 4096)
            : 0,
        };

        const preparation = prep(pathEntries, settings);
        if (!preparation) {
          return {
            content: [
              {
                type: "text",
                text: "Nothing to compact (session too small or already compacted).",
              },
            ],
            details: undefined,
          };
        }
        const { firstKeptEntryId, tokensBefore } = preparation;

        const wrap =
          options.withSessionWriteLock ?? (async <T>(run: () => Promise<T> | T) => await run());

        await wrap(async () => {
          sessionManager.appendCompaction(
            summary,
            firstKeptEntryId,
            tokensBefore,
            undefined,
            true /* fromHook */,
          );
        });

        log.info(
          `Agent compaction: sessionKey=${sessionKey} tokensBefore=${tokensBefore} keepRecent=${keepRecent} summaryLength=${summary.length}`,
        );

        // Overflow fallback: the runner cut the recent tail at a turn boundary
        // before this request was resent. Restore it now so ordering is
        // summary -> re-appended tail -> "fallback completed" notice.
        let restoredTailCount = 0;
        if (!keepRecent) {
          await wrap(async () => {
            restoredTailCount = restoreAgentOverflowStash({
              sessionManager,
              sessionKey,
              ...(options.sessionId ? { sessionId: options.sessionId } : {}),
            });
          });
        }

        const storeCtx = options.getSessionStoreContext?.();
        if (storeCtx?.sessionStore && storeCtx.storePath) {
          try {
            await incrementCompactionCount({
              ...(storeCtx.agentId ? { agentId: storeCtx.agentId } : {}),
              sessionStore: storeCtx.sessionStore as never,
              sessionKey,
              storePath: storeCtx.storePath,
              cfg,
            });
          } catch (countErr) {
            log.warn(`compact: compaction count update failed: ${String(countErr)}`);
          }
        }

        // Programmatic memory write — the model never calls `write` for this.
        const nowMs = Date.now();
        const timezone = resolveUserTimezone(cfg?.agents?.defaults?.userTimezone);
        const dateStamp = formatDateStamp(nowMs, timezone);
        const workspaceDir = options.workspaceDir;
        let memoryTarget: string | undefined;
        if (workspaceDir) {
          const memoryDir = path.join(workspaceDir, "memory");
          const dailyFile = path.join(memoryDir, `${dateStamp}.md`);
          try {
            if (!fs.existsSync(memoryDir)) {
              fs.mkdirSync(memoryDir, { recursive: true });
            }
            fs.appendFileSync(dailyFile, `\n${summary}\n`, "utf-8");
            memoryTarget = `memory/${dateStamp}.md`;
          } catch (fsErr) {
            log.warn(`Failed to append compaction summary to ${dailyFile}: ${String(fsErr)}`);
          }
        }

        const resultText =
          `Compaction complete. tokensBefore=${tokensBefore}, summaryLength=${summary.length}, keepRecent=${keepRecent}. ` +
          (restoredTailCount > 0
            ? `Restored ${restoredTailCount} message(s) cut by the context-overflow fallback. `
            : "") +
          (memoryTarget
            ? `Summary saved to session and ${memoryTarget}. `
            : "Summary saved to session. ") +
          "Continue from the summary.";

        try {
          await wrap(async () => {
            options.updateAgentMessagesAfterCompaction?.(toolCallId, resultText);
          });
        } catch (refreshErr) {
          log.warn(`Failed to refresh agent messages post-compaction: ${String(refreshErr)}`);
        }

        return { content: [{ type: "text", text: resultText }], details: undefined };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Agent compaction failed: sessionKey=${sessionKey} error=${msg}`);
        return {
          content: [{ type: "text", text: `Compaction failed: ${msg}` }],
          details: undefined,
        };
      }
    },
  };
}
