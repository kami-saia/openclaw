import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import type { SessionEntry, SessionManager } from "../../sessions/index.js";
import type { ToolResultPromptProjectionState } from "../session-prompt-state.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const truncateOversizedToolResultsInActiveTargetMock = vi.hoisted(() =>
  vi.fn(async () => ({ truncated: true, truncatedCount: 1 })),
);

vi.mock("../tool-result-truncation.js", () => ({
  resolveLiveToolResultMaxChars: () => 32_000,
  sessionLikelyHasOversizedToolResults: () => true,
  truncateOversizedToolResultsInActiveTarget: truncateOversizedToolResultsInActiveTargetMock,
}));

describe("recoverEmbeddedRunOverflow", () => {
  it("passes the frozen prompt projection into append-only fallback truncation", async () => {
    const { recoverEmbeddedRunOverflow } = await import("./overflow-context-recovery.js");
    const promptError = new Error("Context window exceeded for this request");
    const projectionState: ToolResultPromptProjectionState = {
      replacements: new Map(),
      frozen: new Set(["tool:call_1:1"]),
      ambiguousBaseKeys: new Set(),
      sourceTextByKey: new Map(),
    };
    const attempt = {
      terminal: { kind: "failed", source: "prompt", error: promptError },
      messagesSnapshot: [
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: "x".repeat(64_000) }],
          isError: false,
          timestamp: 1,
        },
      ],
    } as EmbeddedRunAttemptResult;

    const result = await recoverEmbeddedRunOverflow({
      runParams: {
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        config: {},
        workspaceDir: "/tmp/workspace",
        prompt: "continue",
        timeoutMs: 1_000,
      },
      state: {
        autoCompactionCount: 0,
        lastCompactionTokensAfter: undefined,
        lastContextBudgetStatus: undefined,
        overflowCompactionAttempts: 3,
        timeoutCompactionAttempts: 0,
        toolResultTruncationAttempted: false,
      },
      contextEngine: {
        info: { id: "legacy", name: "Legacy" },
        ingest: async () => ({ ingested: true }),
        assemble: async ({
          messages,
        }: {
          messages: EmbeddedRunAttemptResult["messagesSnapshot"];
        }) => ({
          messages,
          estimatedTokens: 0,
        }),
        compact: async () => ({ ok: true, compacted: false }),
      },
      contextTokenBudget: 200_000,
      genericCompactionRecoveryAllowed: true,
      aborted: false,
      signalOwnedInterruption: false,
      promptError,
      attempt,
      toolResultPromptProjectionState: projectionState,
      attemptCompactionCount: 0,
      runtimeAuthPlan: {},
      resolvedSessionKey: "agent:main:session-1",
      sessionAgentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      provider: "openai",
      modelId: "gpt-test",
      harnessRuntime: "embedded",
      thinkLevel: "off",
      authProfileIdSource: "auto",
      resolveContextEnginePluginId: () => undefined,
      buildRuntimeSettings: () => ({}),
      onCompactionHookMessages: async () => {},
      runOwnsCompactionBeforeHook: async () => {},
      runOwnsCompactionAfterHook: async () => {},
      adoptCompactionTranscript: async () => undefined,
      getActiveSession: () => ({ id: "session-1", file: "agent:main:session-1" }),
      prepareCurrentTranscriptRetry: () => {},
      prepareCompactedTranscriptRetry: async () => {},
      armPostCompactionGuard: () => {},
    } as unknown as Parameters<typeof recoverEmbeddedRunOverflow>[0]);

    expect(result).toEqual({ action: "retry" });
    expect(truncateOversizedToolResultsInActiveTargetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectionState,
        scope: expect.objectContaining({
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
        }),
      }),
    );
  });

  // FORK: end-to-end guard for the agent-compaction overflow fallback. The
  // feature only engages when compaction.mode === "agent", a live SessionManager
  // is registered for the runId, and no stash is already pending.
  describe("agent-compaction overflow fallback", () => {
    const SESSION_KEY = "agent:main:session-agent";
    const RUN_ID = "run-agent-overflow";

    function entry(id: string, role: string): SessionEntry {
      return {
        id,
        type: "message",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role, content: `${role}-${id}` } as unknown as AgentMessage,
      } as SessionEntry;
    }

    function createManager(entries: SessionEntry[]) {
      let branch = [...entries];
      return {
        getBranch: () => branch,
        branch: (entryId: string) => {
          const index = branch.findIndex((candidate) => candidate.id === entryId);
          if (index < 0) {
            throw new Error(`unknown entry ${entryId}`);
          }
          branch = branch.slice(0, index + 1);
        },
        appendMessage: () => {},
      } as unknown as SessionManager;
    }

    /** 12 alternating turns: plenty of safe turn-start cut points. */
    function longTranscript(): SessionEntry[] {
      const entries: SessionEntry[] = [];
      for (let index = 0; index < 12; index++) {
        entries.push(entry(`u${index}`, "user"));
        entries.push(entry(`a${index}`, "assistant"));
      }
      return entries;
    }

    async function runRecovery(overrides: {
      mode?: string;
      registerManager?: boolean;
      prepareAgentOverflowRetry?: (prompt: string) => void;
      entries?: SessionEntry[];
    }) {
      const mod = await import("./overflow-context-recovery.js");
      const fallbackMod = await import("./agent-overflow-fallback.js");
      fallbackMod.clearAgentOverflowStash(SESSION_KEY, "session-agent");
      fallbackMod.unregisterAgentOverflowSessionManager(RUN_ID);

      const manager = createManager(overrides.entries ?? longTranscript());
      if (overrides.registerManager !== false) {
        fallbackMod.registerAgentOverflowSessionManager(RUN_ID, manager);
      }

      const promptError = new Error("Context window exceeded for this request");
      const result = await mod.recoverEmbeddedRunOverflow({
        runParams: {
          runId: RUN_ID,
          sessionId: "session-agent",
          sessionKey: SESSION_KEY,
          config: overrides.mode
            ? { agents: { defaults: { compaction: { mode: overrides.mode } } } }
            : {},
          workspaceDir: "/tmp/workspace",
          prompt: "continue",
          timeoutMs: 1_000,
        },
        state: {
          autoCompactionCount: 0,
          lastCompactionTokensAfter: undefined,
          lastContextBudgetStatus: undefined,
          overflowCompactionAttempts: 0,
          timeoutCompactionAttempts: 0,
          toolResultTruncationAttempted: false,
        },
        contextEngine: {
          info: { id: "legacy", name: "Legacy" },
          ingest: async () => ({ ingested: true }),
          assemble: async ({ messages }: { messages: unknown }) => ({
            messages,
            estimatedTokens: 0,
          }),
          compact: async () => ({ ok: true, compacted: false }),
        },
        contextTokenBudget: 200_000,
        genericCompactionRecoveryAllowed: true,
        aborted: false,
        signalOwnedInterruption: false,
        promptError,
        attempt: {
          terminal: { kind: "failed", source: "prompt", error: promptError },
          messagesSnapshot: [],
        } as unknown as EmbeddedRunAttemptResult,
        toolResultPromptProjectionState: {
          replacements: new Map(),
          frozen: new Set(),
          ambiguousBaseKeys: new Set(),
          sourceTextByKey: new Map(),
        },
        attemptCompactionCount: 0,
        runtimeAuthPlan: {},
        resolvedSessionKey: SESSION_KEY,
        sessionAgentId: "main",
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp/workspace",
        provider: "***",
        modelId: "claude-opus-5",
        harnessRuntime: "embedded",
        thinkLevel: "off",
        authProfileIdSource: "auto",
        resolveContextEnginePluginId: () => undefined,
        buildRuntimeSettings: () => ({}),
        onCompactionHookMessages: async () => {},
        runOwnsCompactionBeforeHook: async () => {},
        runOwnsCompactionAfterHook: async () => {},
        adoptCompactionTranscript: async () => undefined,
        getActiveSession: () => ({ id: "session-agent", file: SESSION_KEY }),
        prepareCurrentTranscriptRetry: () => {},
        prepareCompactedTranscriptRetry: async () => {},
        armPostCompactionGuard: () => {},
        ...(overrides.prepareAgentOverflowRetry
          ? { prepareAgentOverflowRetry: overrides.prepareAgentOverflowRetry }
          : {}),
      } as unknown as Parameters<typeof mod.recoverEmbeddedRunOverflow>[0]);

      return { result, manager, fallbackMod };
    }

    it("cuts the tail and retries with the agent compaction prompt under mode=agent", async () => {
      const prepareAgentOverflowRetry = vi.fn();
      const { result, manager, fallbackMod } = await runRecovery({
        mode: "agent",
        prepareAgentOverflowRetry,
      });

      expect(result).toEqual({ action: "retry" });
      expect(prepareAgentOverflowRetry).toHaveBeenCalledTimes(1);
      expect(prepareAgentOverflowRetry.mock.calls[0]?.[0]).toBe(
        fallbackMod.AGENT_OVERFLOW_COMPACTION_PROMPT,
      );
      // The live transcript actually shrank, and a stash is pending restore.
      expect(manager.getBranch().length).toBeLessThan(24);
      expect(fallbackMod.hasAgentOverflowStash(SESSION_KEY, "session-agent")).toBe(true);

      fallbackMod.clearAgentOverflowStash(SESSION_KEY, "session-agent");
      fallbackMod.unregisterAgentOverflowSessionManager(RUN_ID);
    });

    it("does not engage when compaction.mode is not agent", async () => {
      const prepareAgentOverflowRetry = vi.fn();
      const { manager, fallbackMod } = await runRecovery({
        mode: "safeguard",
        prepareAgentOverflowRetry,
      });

      expect(prepareAgentOverflowRetry).not.toHaveBeenCalled();
      expect(manager.getBranch().length).toBe(24);
      expect(fallbackMod.hasAgentOverflowStash(SESSION_KEY, "session-agent")).toBe(false);
    });

    it("does not engage without a registered live session manager", async () => {
      const prepareAgentOverflowRetry = vi.fn();
      const { fallbackMod } = await runRecovery({
        mode: "agent",
        registerManager: false,
        prepareAgentOverflowRetry,
      });

      expect(prepareAgentOverflowRetry).not.toHaveBeenCalled();
      expect(fallbackMod.hasAgentOverflowStash(SESSION_KEY, "session-agent")).toBe(false);
    });

    it("does not engage when the runner exposes no agent-overflow retry hook", async () => {
      const { manager, fallbackMod } = await runRecovery({ mode: "agent" });

      expect(manager.getBranch().length).toBe(24);
      expect(fallbackMod.hasAgentOverflowStash(SESSION_KEY, "session-agent")).toBe(false);
    });

    it("falls through to default recovery when no safe cut boundary exists", async () => {
      const prepareAgentOverflowRetry = vi.fn();
      const { manager, fallbackMod } = await runRecovery({
        mode: "agent",
        prepareAgentOverflowRetry,
        // A single assistant run: every cut would orphan a toolCall.
        entries: [entry("u0", "user"), entry("a0", "assistant"), entry("a1", "assistant")],
      });

      expect(prepareAgentOverflowRetry).not.toHaveBeenCalled();
      expect(manager.getBranch().length).toBe(3);
      expect(fallbackMod.hasAgentOverflowStash(SESSION_KEY, "session-agent")).toBe(false);
    });
  });
});
