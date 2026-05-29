/**
 * Integration test: agent-runner pressure-signal wiring (fork bug repro for 0f3455a4bb).
 *
 * The unit-test harness in `agent-runner-memory.pressure.test.ts` injects a
 * test-only token source via `setTokenSourceForTestsHook`, then asserts that
 * `maybeInjectAgentCompactionPressureSignal` fires when the injected number
 * crosses the threshold. That coverage is fine but does not catch the bug
 * fixed in 0f3455a4bb: production used to estimate tokens *only* from the
 * transcript jsonl, missing ~80-100k of system/bootstrap/projectContext/tool
 * tokens, so the signal computed pressure ~0.30 when the API said ~0.95.
 *
 * This test exercises the real wiring: it calls `runMemoryFlushIfNeeded`
 * (the agent-runner integration point) with a realistic SessionEntry where
 * `totalTokens` / `totalTokensFresh` are set the way the runtime actually
 * sets them, and DOES NOT install any test token source. The production
 * default token source falls back to transcript estimation, which has no
 * file to read in a temp env and so returns `undefined`. The fix uses
 * `resolveFreshSessionTotalTokens(entry)` first and only falls back to the
 * transcript estimate when the API number is stale or missing.
 *
 * Pre-fix expectation: signal would NOT fire at 95k/100k because production
 * read the (empty) transcript and got `undefined` -> no pressure number.
 * Post-fix expectation: signal DOES fire because we read `entry.totalTokens`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPressureTrackingForTestsHook } from "../../agents/context-pressure.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";

const enqueueSystemEventMock = vi.fn();
vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

import { setTokenSourceForTestsHook } from "./agent-compaction-pressure.runtime.js";
import { runMemoryFlushIfNeeded } from "./agent-runner-memory.js";

function agentCompactionCfg(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        compaction: { mode: "agent" },
      },
    },
  } as unknown as OpenClawConfig;
}

function entryAtPressure(
  totalTokens: number | undefined,
  fresh: boolean,
  contextTokens = 100_000,
): SessionEntry {
  // sessionId points at a path that does not exist on disk so the production
  // transcript-source returns `undefined`. The fix must fall back to
  // `entry.totalTokens` via `resolveFreshSessionTotalTokens`, not silently
  // return undefined as the buggy version did.
  return {
    sessionId: "integration-test-no-transcript-on-disk",
    totalTokens,
    totalTokensFresh: fresh,
    contextTokens,
  } as unknown as SessionEntry;
}

async function callRunMemoryFlush(params: {
  cfg: OpenClawConfig;
  sessionEntry: SessionEntry;
  agentCfgContextTokens?: number;
}) {
  // runMemoryFlushIfNeeded short-circuits into the pressure-signal path as
  // soon as it sees `compaction.mode === "agent"`; the followupRun /
  // sessionCtx / replyOperation never get touched on that branch, so
  // intentionally minimal stubs are fine here.
  return runMemoryFlushIfNeeded({
    cfg: params.cfg,
    followupRun: {} as never,
    promptForEstimate: undefined,
    sessionCtx: {} as never,
    opts: undefined,
    defaultModel: "test-model",
    agentCfgContextTokens: params.agentCfgContextTokens,
    resolvedVerboseLevel: 0 as never,
    sessionEntry: params.sessionEntry,
    sessionStore: undefined,
    sessionKey: "agent:main:integration-pressure-test",
    runtimePolicySessionKey: "agent:main:integration-pressure-test",
    storePath: undefined,
    isHeartbeat: false,
    replyOperation: {} as never,
  });
}

describe("agent-runner integration: pressure signal wiring", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockReset();
    resetPressureTrackingForTestsHook();
    // Make absolutely sure the test-only token source from sibling tests is
    // NOT in effect. The whole point of this test is to exercise the
    // production wiring end-to-end.
    setTokenSourceForTestsHook(null);
  });

  afterEach(() => {
    setTokenSourceForTestsHook(null);
  });

  it("fires the [context_pressure] signal from entry.totalTokens when totalTokensFresh=true and no transcript exists", async () => {
    // 95k of 100k window -> pressure 0.95, well above the 0.85 RECOMMEND
    // threshold. Pre-fix this would have silently returned undefined
    // because the only token source was a transcript file we never wrote.
    await callRunMemoryFlush({
      cfg: agentCompactionCfg(),
      sessionEntry: entryAtPressure(95_000, true, 100_000),
      agentCfgContextTokens: 100_000,
    });

    // import("../../infra/system-events.js") inside
    // maybeInjectAgentCompactionPressureSignal is a microtask; flush it.
    await new Promise((r) => setImmediate(r));

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [message, opts] = enqueueSystemEventMock.mock.calls[0] as [
      string,
      { sessionKey: string },
    ];
    expect(message).toContain("context_pressure");
    expect(message).toContain("compaction_recommended: true");
    expect(opts.sessionKey).toBe("agent:main:integration-pressure-test");
  });

  it("does NOT fire the signal when totalTokensFresh=false (API number is stale and no transcript on disk)", async () => {
    await callRunMemoryFlush({
      cfg: agentCompactionCfg(),
      // Same numbers as the firing case, but flagged stale -> the fix
      // refuses to use them and falls back to the (empty) transcript
      // source, which returns undefined.
      sessionEntry: entryAtPressure(95_000, false, 100_000),
      agentCfgContextTokens: 100_000,
    });

    await new Promise((r) => setImmediate(r));

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });
});
