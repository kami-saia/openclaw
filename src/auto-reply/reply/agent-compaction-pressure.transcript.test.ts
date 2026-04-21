import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { estimateSessionTokensFromTranscriptFile } from "./agent-compaction-pressure.js";

function writeJsonl(filePath: string, entries: object[]): void {
  fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function makeMessage(id: string, text: string): object {
  return {
    id,
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
  };
}

function makeCompaction(id: string, summaryChars: number, firstKeptId: string): object {
  return {
    id,
    type: "compaction",
    summary: "X".repeat(summaryChars),
    firstKeptEntryId: firstKeptId,
    timestamp: Date.now(),
  };
}

describe("estimateSessionTokensFromTranscriptFile — stale-summary regression", () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-pressure-test-"));
    transcriptPath = path.join(tmpDir, "session.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not accumulate prior compaction summaries in the token estimate", () => {
    // Build a transcript with 60 historical compactions, each carrying a large summary.
    // Buggy behavior: counts ALL summaries -> ~60 * 8000 chars / 4 = ~120k tokens.
    // Fixed behavior: counts only the MOST RECENT summary -> ~2k tokens + 1 small kept msg.
    const SMALL_KEPT = "ok";
    const SUMMARY_CHARS = 8000; // ~2k tokens each

    const entries: object[] = [];
    for (let i = 0; i < 60; i++) {
      entries.push(makeCompaction(`c-${i}`, SUMMARY_CHARS, `m-${i}`));
      entries.push(makeMessage(`m-${i}`, "old"));
    }
    // Final compaction; only entries AFTER this point are "kept".
    entries.push(makeCompaction("c-final", SUMMARY_CHARS, "kept-1"));
    entries.push(makeMessage("kept-1", SMALL_KEPT));

    writeJsonl(transcriptPath, entries);

    const tokens = estimateSessionTokensFromTranscriptFile(transcriptPath);
    expect(tokens).toBeDefined();

    // With the bug, this would be ~120k+. With the fix, it should be in the
    // low thousands (one ~2k-token summary + a tiny kept message).
    expect(tokens!).toBeLessThan(5_000);
    expect(tokens!).toBeGreaterThan(1_000); // sanity: latest summary IS counted
  });

  it("handles a transcript with no compactions", () => {
    const entries = [makeMessage("m-1", "hello world"), makeMessage("m-2", "another message")];
    writeJsonl(transcriptPath, entries);
    const tokens = estimateSessionTokensFromTranscriptFile(transcriptPath);
    expect(tokens).toBeDefined();
    expect(tokens!).toBeGreaterThan(0);
    expect(tokens!).toBeLessThan(100);
  });

  it("returns undefined for an empty transcript", () => {
    fs.writeFileSync(transcriptPath, "");
    expect(estimateSessionTokensFromTranscriptFile(transcriptPath)).toBeUndefined();
  });
});
