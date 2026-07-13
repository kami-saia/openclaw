import { describe, expect, it } from "vitest";
import { buildAgentCompactionPressurePrompt } from "./context-pressure.js";

describe("buildAgentCompactionPressurePrompt", () => {
  it("uses the assembled LLM-boundary estimate rather than stale session totals", () => {
    const block = buildAgentCompactionPressurePrompt({
      prompt: "the current user request",
      estimatedPromptTokens: 108_603,
      contextWindowTokens: 128_000,
    });

    expect(block).toContain("System: [context_pressure: 0.85, compaction_recommended: true]");
    expect(block).toContain("Call the `compact` tool as your VERY NEXT tool call");
  });

  it("stays silent below 75% of the assembled context window", () => {
    expect(
      buildAgentCompactionPressurePrompt({
        prompt: "the current user request",
        estimatedPromptTokens: 95_999,
        contextWindowTokens: 128_000,
      }),
    ).toBeUndefined();
  });

  it("does not duplicate an existing pressure instruction", () => {
    expect(
      buildAgentCompactionPressurePrompt({
        prompt:
          "System: [context_pressure: 0.8, compaction_recommended: true]\n\nthe current user request",
        estimatedPromptTokens: 108_603,
        contextWindowTokens: 128_000,
      }),
    ).toBeUndefined();
  });
});
