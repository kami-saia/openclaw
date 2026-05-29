import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetPressureTrackingForTestsHook,
  formatContextPressureMessage,
  resetPressureTracking,
} from "../../agents/context-pressure.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";

const enqueueSystemEventMock = vi.fn();

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

import {
  maybeInjectAgentCompactionPressureSignal,
  setTokenSourceForTestsHook,
} from "./agent-compaction-pressure.runtime.js";

function createCfg(mode: "agent" | "default" = "agent"): OpenClawConfig {
  return {
    agents: {
      defaults: {
        compaction: { mode },
      },
    },
  };
}

function createEntry(totalTokens: number): SessionEntry {
  return {
    totalTokens,
    totalTokensFresh: true,
  } as SessionEntry;
}

// Inject a test-only token source so tests don't need an on-disk transcript.
// The default production source reads from the session transcript file via
// sessionId, which doesn't exist in unit tests.
setTokenSourceForTestsHook(
  (entry) => ((entry as Record<string, unknown>).totalTokens as number | undefined) ?? undefined,
);

describe("agent compaction pressure signaling", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockReset();
    resetPressureTrackingForTestsHook();
  });

  it("enqueues a pressure signal at 76% when compaction.mode is agent", async () => {
    const entry = createEntry(76_000);
    maybeInjectAgentCompactionPressureSignal({
      cfg: createCfg("agent"),
      sessionEntry: entry,
      sessionKey: "agent:main:main",
      defaultModel: "test/model",
      agentCfgContextTokens: 100_000,
    });

    // Wait for dynamic import to resolve
    await new Promise((r) => setTimeout(r, 50));

    const expected = formatContextPressureMessage({
      pressure: 0.76,
      compactionRecommended: false,
    });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(expected, {
      sessionKey: "agent:main:main",
    });
  });

  it("enqueues a compaction-recommended pressure signal at 86% when compaction.mode is agent", async () => {
    const entry = createEntry(86_000);
    maybeInjectAgentCompactionPressureSignal({
      cfg: createCfg("agent"),
      sessionEntry: entry,
      sessionKey: "agent:main:main",
      defaultModel: "test/model",
      agentCfgContextTokens: 100_000,
    });

    await new Promise((r) => setTimeout(r, 50));

    const expected = formatContextPressureMessage({
      pressure: 0.86,
      compactionRecommended: true,
    });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(expected, {
      sessionKey: "agent:main:main",
    });
  });

  it("does not inject a pressure signal below 75%", () => {
    const entry = createEntry(50_000);
    maybeInjectAgentCompactionPressureSignal({
      cfg: createCfg("agent"),
      sessionEntry: entry,
      sessionKey: "agent:main:main",
      defaultModel: "test/model",
      agentCfgContextTokens: 100_000,
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("76% fires once only below RECOMMEND threshold", async () => {
    const entry = createEntry(76_000);
    const params = {
      cfg: createCfg("agent"),
      sessionEntry: entry,
      sessionKey: "agent:main:main",
      defaultModel: "test/model",
      agentCfgContextTokens: 100_000,
    };

    maybeInjectAgentCompactionPressureSignal(params);
    await new Promise((r) => setTimeout(r, 50));
    maybeInjectAgentCompactionPressureSignal(params);
    await new Promise((r) => setTimeout(r, 50));

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
  });

  it("86% fires every turn at/above RECOMMEND threshold", async () => {
    const entry = createEntry(86_000);
    const params = {
      cfg: createCfg("agent"),
      sessionEntry: entry,
      sessionKey: "agent:main:main",
      defaultModel: "test/model",
      agentCfgContextTokens: 100_000,
    };

    maybeInjectAgentCompactionPressureSignal(params);
    await new Promise((r) => setTimeout(r, 50));
    maybeInjectAgentCompactionPressureSignal(params);
    await new Promise((r) => setTimeout(r, 50));

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(2);
  });

  it("escalation from 76% to 86% fires both times", async () => {
    const params76 = {
      cfg: createCfg("agent"),
      sessionEntry: createEntry(76_000),
      sessionKey: "agent:main:main",
      defaultModel: "test/model",
      agentCfgContextTokens: 100_000,
    };
    const params86 = {
      ...params76,
      sessionEntry: createEntry(86_000),
    };

    maybeInjectAgentCompactionPressureSignal(params76);
    await new Promise((r) => setTimeout(r, 50));
    maybeInjectAgentCompactionPressureSignal(params86);
    await new Promise((r) => setTimeout(r, 50));

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(2);
  });

  it("prefers API-fresh totalTokens over transcript estimate (regression: pressure never fired in production)", async () => {
    // Regression: pre-fix, the production code path used transcript-based
    // estimation only, which omits system prompt + bootstrap files + project
    // context + tool defs (~80-100k of tokens). Result: pressure signal
    // computed ~0.30 when API-reported context was ~0.99, and the
    // compaction_recommended signal never fired. This test installs a
    // transcript source that returns a low number and asserts that we still
    // pick up the high API-fresh number from entry.totalTokens.
    setTokenSourceForTestsHook(() => 5_000); // pretend transcript is tiny
    try {
      const entry = createEntry(95_000); // API-fresh says we're at 95%
      maybeInjectAgentCompactionPressureSignal({
        cfg: createCfg("agent"),
        sessionEntry: entry,
        sessionKey: "agent:main:main",
        defaultModel: "test/model",
        agentCfgContextTokens: 100_000,
      });
      await new Promise((r) => setTimeout(r, 50));

      const expected = formatContextPressureMessage({
        pressure: 0.95,
        compactionRecommended: true,
      });
      expect(enqueueSystemEventMock).toHaveBeenCalledWith(expected, {
        sessionKey: "agent:main:main",
      });
    } finally {
      // Restore the default test override for subsequent tests.
      setTokenSourceForTestsHook(
        (entry) =>
          ((entry as Record<string, unknown>).totalTokens as number | undefined) ?? undefined,
      );
    }
  });

  it("falls back to transcript estimate when totalTokensFresh is false", async () => {
    setTokenSourceForTestsHook(() => 90_000); // transcript is reliable here
    try {
      const entry = {
        totalTokens: 5_000, // stale cumulative noise; would mislead if used
        totalTokensFresh: false,
      } as SessionEntry;
      maybeInjectAgentCompactionPressureSignal({
        cfg: createCfg("agent"),
        sessionEntry: entry,
        sessionKey: "agent:main:main",
        defaultModel: "test/model",
        agentCfgContextTokens: 100_000,
      });
      await new Promise((r) => setTimeout(r, 50));

      const expected = formatContextPressureMessage({
        pressure: 0.9,
        compactionRecommended: true,
      });
      expect(enqueueSystemEventMock).toHaveBeenCalledWith(expected, {
        sessionKey: "agent:main:main",
      });
    } finally {
      setTokenSourceForTestsHook(
        (entry) =>
          ((entry as Record<string, unknown>).totalTokens as number | undefined) ?? undefined,
      );
    }
  });

  it("suppresses one signal after resetPressureTracking() (post-compaction guard)", async () => {
    // Regression: pre-fix, the turn immediately after compaction would re-emit
    // a `compaction_recommended: true` signal because the next compute call
    // still saw pre-compaction token counts. resetPressureTracking() now arms
    // a one-shot suppression that swallows that stale signal.
    const params = {
      cfg: createCfg("agent"),
      sessionEntry: createEntry(95_000),
      sessionKey: "agent:main:main",
      defaultModel: "test/model",
      agentCfgContextTokens: 100_000,
    };

    // Compaction just ran.
    resetPressureTracking();

    // Stale token count comes through on the very next turn -> suppressed.
    maybeInjectAgentCompactionPressureSignal(params);
    await new Promise((r) => setTimeout(r, 50));
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(0);

    // Subsequent turn (presumably with a refreshed token count) emits normally.
    maybeInjectAgentCompactionPressureSignal(params);
    await new Promise((r) => setTimeout(r, 50));
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
  });
});
