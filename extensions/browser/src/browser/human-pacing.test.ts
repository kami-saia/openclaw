// FORK: coverage for human input pacing (upstream has none; the browser shard
// runs with OPENCLAW_BROWSER_HUMAN_INPUT=off so upstream's guard tests stay pinned).
import { afterEach, describe, expect, it } from "vitest";
import {
  humanCursorPath,
  humanKeyDelaysMs,
  isHumanInputPacingEnabled,
  typeWithHumanPacing,
} from "./human-pacing.js";

describe("human input pacing", () => {
  const original = process.env.OPENCLAW_BROWSER_HUMAN_INPUT;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.OPENCLAW_BROWSER_HUMAN_INPUT;
    } else {
      process.env.OPENCLAW_BROWSER_HUMAN_INPUT = original;
    }
  });

  it("is on unless explicitly switched off", () => {
    delete process.env.OPENCLAW_BROWSER_HUMAN_INPUT;
    expect(isHumanInputPacingEnabled()).toBe(true);
    for (const off of ["off", "0", "false", " OFF "]) {
      process.env.OPENCLAW_BROWSER_HUMAN_INPUT = off;
      expect(isHumanInputPacingEnabled()).toBe(false);
    }
  });

  it("produces one jittered, non-uniform delay per character", () => {
    const delays = humanKeyDelaysMs("the quick brown fox jumps");
    expect(delays).toHaveLength(25);
    expect(delays.every((delay) => delay >= 18)).toBe(true);
    expect(new Set(delays).size).toBeGreaterThan(1);
  });

  it("types every character in order through the supplied key press", async () => {
    const pressed: string[] = [];
    await typeWithHumanPacing({
      text: "héllo",
      delays: [1, 1, 1, 1, 1],
      pressKey: async (char) => {
        pressed.push(char);
      },
    });
    expect(pressed.join("")).toBe("héllo");
  });

  it("ends the cursor path on the target", () => {
    const path = humanCursorPath({ x: 0, y: 0 }, { x: 400, y: 300 });
    expect(path.length).toBeGreaterThan(1);
    expect(path.at(-1)).toEqual({ x: 400, y: 300 });
  });
});
