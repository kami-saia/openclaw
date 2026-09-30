import { expect, it } from "vitest";
import { applyCompactionDefaults } from "./defaults.js";

it.each(["default", undefined] as const)(
  "preserves authored compaction settings with mode=%s",
  (mode) => {
    const compaction = {
      mode,
      thinkingLevel: "inherit",
      qualityGuard: { maxRetries: 99 },
    } as const;
    expect(
      applyCompactionDefaults({ agents: { defaults: { compaction } } }).agents?.defaults
        ?.compaction,
    ).toEqual({ ...compaction, mode: mode ?? "safeguard" });
  },
);

// FORK: agent-driven in-session compaction keeps its mode and overrides.
it("keeps the agent-mode model and timeout overrides that gate in-session compaction", () => {
  const compaction = applyCompactionDefaults({
    agents: {
      defaults: {
        compaction: {
          mode: "agent",
          model: "github-copilot/gpt-5.5",
          timeoutSeconds: 360,
          keepRecentTokens: 4096,
        },
      },
    },
  }).agents?.defaults?.compaction;

  expect(compaction?.mode).toBe("agent");
  expect(compaction?.model).toBe("github-copilot/gpt-5.5");
  expect(compaction?.timeoutSeconds).toBe(360);
  expect(compaction?.keepRecentTokens).toBe(4096);
});
