import { beforeEach, describe, expect, it } from "vitest";
import {
  computeContextPressure,
  resetPressureTracking,
  resetPressureTrackingForTestsHook,
} from "./context-pressure.js";

describe("computeContextPressure", () => {
  beforeEach(() => {
    resetPressureTrackingForTestsHook();
  });

  it("recommends agent-owned compaction at the first pressure signal", () => {
    expect(
      computeContextPressure({ totalTokens: 95_999, contextWindowTokens: 128_000 }),
    ).toBeNull();
    expect(computeContextPressure({ totalTokens: 96_000, contextWindowTokens: 128_000 })).toEqual({
      pressure: 0.75,
      compactionRecommended: true,
    });
  });

  it("keeps recommending until the agent compacts", () => {
    expect(
      computeContextPressure({ totalTokens: 96_000, contextWindowTokens: 128_000 }),
    ).toMatchObject({ compactionRecommended: true });
    expect(computeContextPressure({ totalTokens: 104_960, contextWindowTokens: 128_000 })).toEqual({
      pressure: 0.82,
      compactionRecommended: true,
    });
  });

  it("suppresses exactly one stale pressure signal after compaction", () => {
    resetPressureTracking();
    expect(
      computeContextPressure({ totalTokens: 104_960, contextWindowTokens: 128_000 }),
    ).toBeNull();
    expect(
      computeContextPressure({ totalTokens: 104_960, contextWindowTokens: 128_000 }),
    ).toMatchObject({ compactionRecommended: true });
  });
});
