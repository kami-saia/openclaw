// Verifies compaction settings config parsing and defaults.
import { describe, expect, it } from "vitest";
import { applyCompactionDefaults } from "./defaults.js";
import type { OpenClawConfig } from "./types.js";

function materializeCompactionConfig(
  compaction: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["compaction"],
) {
  const cfg = applyCompactionDefaults({
    agents: {
      defaults: {
        compaction,
      },
    },
  });
  return cfg.agents?.defaults?.compaction;
}

describe("config compaction settings", () => {
  it("preserves memory flush config values", () => {
    const compaction = materializeCompactionConfig({
      mode: "safeguard",
      identifierPolicy: "strict",
      qualityGuard: {
        enabled: true,
        maxRetries: 2,
      },
      midTurnPrecheck: {
        enabled: true,
      },
      memoryFlush: {
        enabled: false,
        model: "ollama/qwen3:8b",
        softThresholdTokens: 1234,
      },
      maxActiveTranscriptBytes: "20mb",
    });

    expect(compaction?.mode).toBe("safeguard");
    expect(compaction?.keepRecentTokens).toBeUndefined();
    expect(compaction?.identifierPolicy).toBe("strict");
    expect(compaction?.qualityGuard?.enabled).toBe(true);
    expect(compaction?.qualityGuard?.maxRetries).toBe(2);
    expect(compaction?.midTurnPrecheck?.enabled).toBe(true);
    expect(compaction?.memoryFlush?.enabled).toBe(false);
    expect(compaction?.memoryFlush?.model).toBe("ollama/qwen3:8b");
    expect(compaction?.memoryFlush?.softThresholdTokens).toBe(1234);
    expect(compaction?.maxActiveTranscriptBytes).toBe("20mb");
  });

  it("defaults compaction mode to safeguard", () => {
    const compaction = materializeCompactionConfig({});

    expect(compaction?.mode).toBe("safeguard");
  });

  it("preserves recent turn safeguard values during materialization", () => {
    const compaction = materializeCompactionConfig({
      mode: "safeguard",
      recentTurnsPreserve: 4,
    });

    expect(compaction?.recentTurnsPreserve).toBe(4);
  });

  it("preserves oversized quality guard retry values for runtime clamping", () => {
    const compaction = materializeCompactionConfig({
      qualityGuard: {
        maxRetries: 99,
      },
    });

    expect(compaction?.qualityGuard?.maxRetries).toBe(99);
  });

  it.each(["off", "low", "adaptive", "max", "ultra"] as const)(
    "preserves compaction thinkingLevel=%s during materialization",
    (thinkingLevel) => {
      expect(materializeCompactionConfig({ thinkingLevel })?.thinkingLevel).toBe(thinkingLevel);
    },
  );

  it.each(["default", "safeguard", "agent"] as const)(
    "preserves compaction mode=%s during materialization",
    (mode) => {
      expect(materializeCompactionConfig({ mode })?.mode).toBe(mode);
    },
  );

  it("keeps the agent-mode model and timeout overrides that gate in-session compaction", () => {
    const compaction = materializeCompactionConfig({
      mode: "agent",
      model: "***/gpt-5.5",
      timeoutSeconds: 360,
      keepRecentTokens: 4096,
    });

    expect(compaction?.mode).toBe("agent");
    expect(compaction?.model).toBe("***/gpt-5.5");
    expect(compaction?.timeoutSeconds).toBe(360);
    expect(compaction?.keepRecentTokens).toBe(4096);
  });
});
