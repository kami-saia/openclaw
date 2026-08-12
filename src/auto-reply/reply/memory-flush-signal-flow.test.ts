// Flow-level contract for the pre-compaction signal.
//
// Expected behaviour, independent of implementation: while a session keeps
// growing past the compaction threshold, the runtime must keep asking the agent
// to compact. A signal that was emitted but did not result in a compaction must
// not silently disarm the gate — otherwise context climbs unbounded until the
// provider rejects the request.
import { describe, expect, it } from "vitest";
import { shouldRunMemoryFlush } from "./memory-flush.js";

const GATE = {
  contextWindowTokens: 128_000,
  reserveTokensFloor: 16_000,
  softThresholdTokens: 8_000,
};

type Entry = {
  totalTokens: number;
  totalTokensFresh: true;
  compactionCount: number;
  memoryFlush?: { kind: "succeeded"; compactionCount: number };
};

/**
 * Simulates turns of a growing session. `compactionLands` models whether the
 * agent's compaction actually succeeded after being signalled.
 */
function runSession(opts: {
  turns: number;
  growthPerTurn: number;
  startTokens: number;
  compactionLands: boolean;
}) {
  const entry: Entry = {
    totalTokens: opts.startTokens,
    totalTokensFresh: true,
    compactionCount: 3,
  };
  const signals: number[] = [];

  for (let turn = 0; turn < opts.turns; turn++) {
    if (shouldRunMemoryFlush({ entry, ...GATE })) {
      signals.push(entry.totalTokens);
      // The runtime records the flush against the current compaction cycle.
      entry.memoryFlush = { kind: "succeeded", compactionCount: entry.compactionCount };
      if (opts.compactionLands) {
        entry.compactionCount += 1;
        entry.totalTokens = opts.startTokens;
        continue;
      }
    }
    entry.totalTokens += opts.growthPerTurn;
  }

  return { signals, finalTokens: entry.totalTokens };
}

describe("pre-compaction signal flow", () => {
  it("signals once per cycle while compactions land, keeping context bounded", () => {
    const { signals, finalTokens } = runSession({
      turns: 40,
      growthPerTurn: 4_000,
      startTokens: 90_000,
      compactionLands: true,
    });

    expect(signals.length).toBeGreaterThan(1);
    expect(finalTokens).toBeLessThan(GATE.contextWindowTokens);
  });

  it("keeps signalling while context grows and no compaction has landed", () => {
    const { signals, finalTokens } = runSession({
      turns: 40,
      growthPerTurn: 4_000,
      startTokens: 90_000,
      compactionLands: false,
    });

    // The first signal was ignored; the session is still growing, so the agent
    // must be asked again rather than silently sailing into the window.
    // (Context itself cannot be bounded here — only the agent compacting does
    // that — but the runtime must keep asking the whole way up.)
    expect(signals.length).toBeGreaterThan(1);
    expect(finalTokens).toBeGreaterThan(GATE.contextWindowTokens);
    expect(signals.at(-1)).toBeGreaterThan(GATE.contextWindowTokens);
  });

  it("never lets a session pass the context window without a fresh signal", () => {
    const entry: Entry = {
      totalTokens: 106_554,
      totalTokensFresh: true,
      compactionCount: 14,
      memoryFlush: { kind: "succeeded", compactionCount: 14 },
    };

    // Context has grown substantially since that flush was recorded.
    entry.totalTokens = 127_000;
    expect(shouldRunMemoryFlush({ entry, ...GATE })).toBe(true);
  });
});
