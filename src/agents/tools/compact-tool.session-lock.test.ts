import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks so vi.mock can reference them.
const mocks = vi.hoisted(() => ({
  resolveAgentIdFromSessionKey: vi.fn(() => "main"),
  resolveStorePath: vi.fn(() => "/tmp/store.json"),
  loadSessionStore: vi.fn(() => ({})),
  resolveSessionFilePathOptions: vi.fn(() => ({})),
  resolveSessionFilePath: vi.fn(() => ""),
  incrementCompactionCount: vi.fn(async () => undefined),
  SessionManagerOpen: vi.fn(),
  prepareCompactionImpl: vi.fn(() => ({
    firstKeptEntryId: "entry-42",
    tokensBefore: 12345,
  })),
}));

vi.mock("../../routing/session-key.js", () => ({
  resolveAgentIdFromSessionKey: mocks.resolveAgentIdFromSessionKey,
}));

vi.mock("../../config/sessions.js", () => ({
  resolveStorePath: mocks.resolveStorePath,
  loadSessionStore: mocks.loadSessionStore,
  resolveSessionFilePathOptions: mocks.resolveSessionFilePathOptions,
  resolveSessionFilePath: mocks.resolveSessionFilePath,
}));

vi.mock("../../auto-reply/reply/session-updates.js", () => ({
  incrementCompactionCount: mocks.incrementCompactionCount,
}));

vi.mock("../sessions/index.js", () => ({
  SessionManager: { open: mocks.SessionManagerOpen },
}));

// Mock the SDK internal compaction module that compact-tool dynamically imports.
// (Test injects prepareCompactionOverride directly; this mock just prevents
// the dynamic import inside loadPrepareCompaction from blowing up tests that
// don't supply the override.)

import { createCompactTool } from "./compact-tool.js";

describe("compact-tool session write lock (FORK regression)", () => {
  let tmpDir: string;
  let sessionFile: string;
  let appendCompactionMock: ReturnType<typeof vi.fn>;
  let getBranchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "compact-tool-test-"));
    sessionFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");

    mocks.resolveSessionFilePath.mockReturnValue(sessionFile);

    appendCompactionMock = vi.fn();
    getBranchMock = vi.fn(() => []);
    const sessionManager = {
      getBranch: getBranchMock,
      appendCompaction: appendCompactionMock,
    };
    mocks.SessionManagerOpen.mockReturnValue(sessionManager);
    mocks.prepareCompactionImpl.mockReturnValue({
      firstKeptEntryId: "entry-42",
      tokensBefore: 12345,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("wraps appendCompaction AND updateAgentMessagesAfterCompaction inside withSessionWriteLock", async () => {
    const callOrder: string[] = [];

    const withSessionWriteLock = vi.fn(async <T>(run: () => Promise<T> | T) => {
      callOrder.push("lock:enter");
      try {
        const result = await run();
        callOrder.push("lock:exit");
        return result;
      } catch (err) {
        callOrder.push("lock:throw");
        throw err;
      }
    });

    appendCompactionMock.mockImplementation(() => {
      callOrder.push("appendCompaction");
    });

    const updateAgentMessagesAfterCompaction = vi.fn(() => {
      callOrder.push("updateAgentMessages");
    });

    const tool = createCompactTool({
      sessionKey: "agent:main:test",
      config: { agents: { defaults: { compaction: { mode: "agent" } } } } as never,
      workspaceDir: tmpDir,
      withSessionWriteLock,
      updateAgentMessagesAfterCompaction,
      prepareCompactionOverride: mocks.prepareCompactionImpl,
    });

    expect(tool).not.toBeNull();

    const result = await tool!.execute("toolu_test_123", {
      summary: "Test summary content with enough body to be meaningful.",
    });

    // Tool returned the real success payload (not an error).
    const textBlock = result.content.find((c) => c.type === "text");
    expect(textBlock?.text).toMatch(/Compaction complete/);

    // The wrap was invoked exactly twice — once for appendCompaction, once for
    // updateAgentMessagesAfterCompaction. Both writes happened INSIDE the lock.
    expect(withSessionWriteLock).toHaveBeenCalledTimes(2);
    expect(appendCompactionMock).toHaveBeenCalledTimes(1);
    expect(updateAgentMessagesAfterCompaction).toHaveBeenCalledTimes(1);

    // updateAgentMessages received the active tool_call_id + result text so the
    // rebuilt messages can include a synthetic tool_result (orphan-toolCall fix).
    const [calledToolCallId, calledText] = updateAgentMessagesAfterCompaction.mock.calls[0];
    expect(calledToolCallId).toBe("toolu_test_123");
    expect(calledText).toMatch(/Compaction complete/);

    // Order: every write call happened between a lock:enter and a lock:exit
    // (i.e. inside the wrap, not before/after).
    expect(callOrder).toEqual([
      "lock:enter",
      "appendCompaction",
      "lock:exit",
      "lock:enter",
      "updateAgentMessages",
      "lock:exit",
    ]);
  });

  it("falls back to no-op wrap when withSessionWriteLock is not provided", async () => {
    appendCompactionMock.mockImplementation(() => undefined);

    const tool = createCompactTool({
      sessionKey: "agent:main:test",
      config: { agents: { defaults: { compaction: { mode: "agent" } } } } as never,
      workspaceDir: tmpDir,
      prepareCompactionOverride: mocks.prepareCompactionImpl,
      // No withSessionWriteLock — must still work (backwards compat).
    });

    const result = await tool!.execute("toolu_test_456", {
      summary: "Another summary.",
    });

    const textBlock = result.content.find((c) => c.type === "text");
    expect(textBlock?.text).toMatch(/Compaction complete/);
    expect(appendCompactionMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when compaction mode is not 'agent' (no tool registered)", () => {
    const tool = createCompactTool({
      sessionKey: "agent:main:test",
      config: { agents: { defaults: { compaction: { mode: "sdk" } } } } as never,
      workspaceDir: tmpDir,
    });
    expect(tool).toBeNull();
  });

  it("accepts colon-containing routed sessionKeys (telegram-direct) by resolving via entry.sessionId", async () => {
    // Telegram DM session key form: agent:main:telegram:default:direct:<userId>
    // The raw key contains colons → fails validateSessionId. compact-tool must
    // resolve via store entry.sessionId (sanitized) instead of passing the
    // routed key into the file-path validator.
    const telegramKey = "agent:main:telegram:default:direct:8757708493";
    const sanitizedId = "telegram-direct-8757708493";
    const entrySessionFile = path.join(tmpDir, `${sanitizedId}.jsonl`);
    fs.writeFileSync(entrySessionFile, "{}\n", "utf-8");

    mocks.loadSessionStore.mockReturnValue({
      [telegramKey]: {
        sessionId: sanitizedId,
        sessionFile: entrySessionFile,
      },
    });
    mocks.resolveSessionFilePath.mockImplementation((sessionId: string) => {
      // Mirror real behavior: throw if sessionId contains colons (validator).
      if (/[^a-z0-9._-]/i.test(sessionId)) {
        throw new Error(`Invalid session ID: ${sessionId}`);
      }
      return entrySessionFile;
    });

    appendCompactionMock.mockImplementation(() => undefined);

    const tool = createCompactTool({
      sessionKey: telegramKey,
      config: { agents: { defaults: { compaction: { mode: "agent" } } } } as never,
      workspaceDir: tmpDir,
      prepareCompactionOverride: mocks.prepareCompactionImpl,
    });

    const result = await tool!.execute("toolu_tg_1", { summary: "tg compaction" });
    const textBlock = result.content.find((c) => c.type === "text");
    expect(textBlock?.text).toMatch(/Compaction complete/);
    // resolveSessionFilePath received the sanitized id, NOT the routed key.
    expect(mocks.resolveSessionFilePath).toHaveBeenCalledWith(
      sanitizedId,
      expect.anything(),
      expect.anything(),
    );
    expect(mocks.resolveSessionFilePath).not.toHaveBeenCalledWith(
      telegramKey,
      expect.anything(),
      expect.anything(),
    );
  });
});
