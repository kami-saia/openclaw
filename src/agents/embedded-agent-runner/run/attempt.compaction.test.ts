/**
 * Integration test: Pi auto-compaction is actually disabled in agent mode at
 * the real production call sites (fork bug repro for b55d22b917).
 *
 * The unit-test in `pi-settings.test.ts` proves
 * `shouldDisablePiAutoCompaction({ cfg })` and `applyPiAutoCompactionGuard`
 * return / call the right thing in isolation. It does NOT prove that the two
 * production callers (the Pi embedded run loop in
 * `pi-embedded-runner/run/attempt.ts` and the CLI compaction lifecycle in
 * `agents/command/cli-compaction.ts`) actually pass `cfg` through.
 *
 * Pre-fix history: `applyPiAutoCompactionGuard` was being called from both
 * sites WITHOUT `cfg`, so the agent-mode short-circuit could never be
 * evaluated even when the workspace had `agents.defaults.compaction.mode:
 * "agent"`. Pi's safeguard kept firing system-style summarization behind the
 * agent's back. The fix in b55d22b917 threads `cfg` through both sites.
 *
 * This test runs the CLI compaction lifecycle end-to-end against test deps
 * that capture exactly what `applyPiAutoCompactionGuard` was called with,
 * and pipes those captured args through the real `applyPiAutoCompactionGuard`
 * implementation. It is the closest we can get to "Pi SDK actually skipped
 * compaction" without spinning a real Pi session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../../config/sessions.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  resetCliCompactionTestDeps,
  runCliTurnCompactionLifecycle,
  setCliCompactionTestDeps,
} from "../../command/cli-compaction.js";
import { applyPiAutoCompactionGuard } from "../../pi-settings.js";

type GuardCall = {
  cfg?: OpenClawConfig;
  compactionMode?: import("../../../config/types.agent-defaults.js").AgentCompactionMode;
  contextEngineInfo?: { ownsCompaction?: boolean };
  setCompactionEnabledCalls: boolean[];
};

function buildSettingsManagerStub() {
  const setCompactionEnabledCalls: boolean[] = [];
  const settingsManager = {
    getCompactionReserveTokens: () => 20_000,
    getCompactionKeepRecentTokens: () => 8_000,
    applyOverrides: () => undefined,
    setCompactionEnabled: (enabled: boolean) => {
      setCompactionEnabledCalls.push(enabled);
    },
  };
  return { settingsManager, setCompactionEnabledCalls };
}

function installCliCompactionTestDeps(captured: GuardCall) {
  // Use the real applyPiAutoCompactionGuard implementation; we want the
  // production decision to flow through, only stubbing surrounding I/O.
  setCliCompactionTestDeps({
    openSessionManager: () =>
      ({
        getBranch: () => [],
      }) as never,
    resolveContextEngine: async () =>
      ({
        info: {} as never,
      }) as never,
    createPreparedEmbeddedPiSettingsManager: async () => {
      const stub = buildSettingsManagerStub();
      // Re-bind the captured calls so the assertion below sees them.
      captured.setCompactionEnabledCalls = stub.setCompactionEnabledCalls;
      return stub.settingsManager as never;
    },
    applyPiAutoCompactionGuard: (params) => {
      captured.compactionMode = params.compactionMode;
      captured.contextEngineInfo = params.contextEngineInfo as
        | { ownsCompaction?: boolean }
        | undefined;
      // Delegate to the REAL implementation so the test reflects the
      // real production decision, not a stubbed boolean.
      return applyPiAutoCompactionGuard(params as never);
    },
    // Force the lifecycle to short-circuit *after* the guard has been
    // applied: claim no preemptive compaction is needed and have the rest
    // of the pipeline noop.
    shouldPreemptivelyCompactBeforePrompt: () =>
      ({
        shouldCompact: false,
        estimatedPromptTokens: 0,
        // Force the lifecycle to short-circuit *after* the guard runs and
        // *before* it tries to actually compact (which would need a real
        // context engine + transcript).
        promptBudgetBeforeReserve: Number.MAX_SAFE_INTEGER,
      }) as never,
    resolveLiveToolResultMaxChars: () => 100_000,
    runContextEngineMaintenance: (async () => undefined) as never,
    recordCliCompactionInStore: (async () => undefined) as never,
  });
}

function baseSessionEntry(): SessionEntry {
  return {
    sessionFile: "/tmp/integration-test-no-real-session.jsonl",
    contextTokens: 100_000,
    totalTokens: 95_000,
    totalTokensFresh: true,
  } as unknown as SessionEntry;
}

async function runLifecycle(cfg: OpenClawConfig): Promise<GuardCall> {
  const captured: GuardCall = { setCompactionEnabledCalls: [], cfg };
  installCliCompactionTestDeps(captured);
  await runCliTurnCompactionLifecycle({
    cfg,
    sessionId: "integration-pi-guard",
    sessionKey: "agent:main:integration-pi-guard",
    sessionEntry: baseSessionEntry(),
    sessionStore: undefined,
    storePath: undefined,
    sessionAgentId: "main",
    workspaceDir: "/tmp",
    agentDir: "/tmp",
    provider: "test",
    model: "test-model",
  });
  return captured;
}

describe("integration: Pi auto-compaction guard wiring at real call sites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetCliCompactionTestDeps();
  });

  it("disables Pi SDK auto-compaction when agents.defaults.compaction.mode === 'agent'", async () => {
    const captured = await runLifecycle({
      agents: {
        defaults: {
          compaction: { mode: "agent" },
        },
      },
    } as unknown as OpenClawConfig);

    // Real cfg must have made it to the guard (this is exactly what
    // b55d22b917 fixed: the guard used to be called without cfg).
    expect(captured.cfg?.agents?.defaults?.compaction?.mode).toBe("agent");
    // And the real guard impl must therefore have flipped Pi's SDK off.
    expect(captured.setCompactionEnabledCalls).toEqual([false]);
  });

  it("does NOT disable Pi SDK auto-compaction when compaction mode is unset (default upstream behavior)", async () => {
    const captured = await runLifecycle({
      agents: {
        defaults: {},
      },
    } as unknown as OpenClawConfig);

    expect(captured.cfg?.agents?.defaults?.compaction?.mode).toBeUndefined();
    // No context engine claims ownsCompaction, no agent mode -> guard noop.
    expect(captured.setCompactionEnabledCalls).toEqual([]);
  });

  it("still disables when an upstream context engine claims ownsCompaction (regression guard for the original branch)", async () => {
    // Override the resolveContextEngine stub for this case only.
    const captured: GuardCall = { setCompactionEnabledCalls: [] };
    installCliCompactionTestDeps(captured);
    setCliCompactionTestDeps({
      resolveContextEngine: async () =>
        ({
          info: { ownsCompaction: true },
        }) as never,
    });
    await runCliTurnCompactionLifecycle({
      cfg: { agents: { defaults: {} } } as unknown as OpenClawConfig,
      sessionId: "integration-pi-guard-cv",
      sessionKey: "agent:main:integration-pi-guard-cv",
      sessionEntry: baseSessionEntry(),
      sessionStore: undefined,
      storePath: undefined,
      sessionAgentId: "main",
      workspaceDir: "/tmp",
      agentDir: "/tmp",
      provider: "test",
      model: "test-model",
    });

    expect(captured.contextEngineInfo?.ownsCompaction).toBe(true);
    expect(captured.setCompactionEnabledCalls).toEqual([false]);
  });
});
