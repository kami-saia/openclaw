import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  clearAgentOverflowStash,
  prepareAgentOverflowFallback,
} from "../embedded-agent-runner/run/agent-overflow-fallback.js";
import type { AgentMessage } from "../runtime/index.js";
import type { SessionEntry, SessionManager } from "../sessions/index.js";
import { createCompactTool } from "./compact-tool.js";

const KEY = "agent:test:compact";

function entry(id: string, role: string, text = id): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role, content: text } as unknown as AgentMessage,
  } as SessionEntry;
}

type AppendedCompaction = {
  summary: string;
  firstKeptEntryId: string | undefined;
  tokensBefore: number;
  fromHook: boolean;
};

function createManager(entries: SessionEntry[]) {
  let branch = [...entries];
  const compactions: AppendedCompaction[] = [];
  const appended: AgentMessage[] = [];
  const manager = {
    getBranch: () => branch,
    branch: (entryId: string) => {
      const index = branch.findIndex((candidate) => candidate.id === entryId);
      if (index < 0) {
        throw new Error(`unknown entry ${entryId}`);
      }
      branch = branch.slice(0, index + 1);
    },
    appendMessage: (message: AgentMessage) => {
      appended.push(message);
      branch = [...branch, entry(`appended-${appended.length}`, "user")];
    },
    appendCompaction: (
      summary: string,
      firstKeptEntryId: string | undefined,
      tokensBefore: number,
      _meta: unknown,
      fromHook: boolean,
    ) => {
      compactions.push({ summary, firstKeptEntryId, tokensBefore, fromHook });
    },
  } as unknown as SessionManager;
  return { manager, compactions, appended, branchLength: () => branch.length };
}

function agentConfig(extra?: Record<string, unknown>): OpenClawConfig {
  return {
    agents: { defaults: { compaction: { mode: "agent", ...extra } } },
  } as unknown as OpenClawConfig;
}

function makeTool(
  overrides: Partial<Parameters<typeof createCompactTool>[0]> = {},
  prepareResult: unknown = { firstKeptEntryId: "e3", tokensBefore: 12345 },
) {
  const managed = createManager([
    entry("e1", "user"),
    entry("e2", "assistant"),
    entry("e3", "user"),
  ]);
  const prepareCalls: unknown[] = [];
  const tool = createCompactTool({
    sessionKey: KEY,
    config: agentConfig(),
    getSessionManager: () => managed.manager,
    prepareCompactionOverride: (pathEntries: unknown[], settings: unknown) => {
      prepareCalls.push({ pathEntries, settings });
      return prepareResult;
    },
    ...overrides,
  });
  return { tool, managed, prepareCalls };
}

async function run(tool: NonNullable<ReturnType<typeof createCompactTool>>, params: unknown) {
  const result = await tool.execute("call-1", params as never, {} as never);
  const text = (result.content as Array<{ type: string; text: string }>)
    .map((part) => part.text)
    .join("\n");
  return { result, text };
}

describe("compact-tool", () => {
  let workspaceDir: string;

  beforeEach(() => {
    clearAgentOverflowStash(KEY);
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "compact-tool-test-"));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("gating", () => {
    it("returns null unless compaction.mode is agent", () => {
      expect(
        createCompactTool({
          sessionKey: KEY,
          config: { agents: { defaults: { compaction: { mode: "default" } } } } as OpenClawConfig,
        }),
      ).toBeNull();
      expect(createCompactTool({ sessionKey: KEY })).toBeNull();
    });

    it("returns a tool named compact when mode is agent", () => {
      const tool = createCompactTool({ sessionKey: KEY, config: agentConfig() });
      expect(tool?.name).toBe("compact");
    });
  });

  describe("input validation", () => {
    it("rejects an empty summary without touching the session", async () => {
      const { tool, managed } = makeTool();
      const { text } = await run(tool!, { summary: "   " });
      expect(text).toContain("summary is required");
      expect(managed.compactions).toHaveLength(0);
    });

    it("errors when no session key is available", async () => {
      const { tool } = makeTool({ sessionKey: undefined });
      const { text } = await run(tool!, { summary: "s" });
      expect(text).toContain("no session key");
    });

    it("errors when the live session manager is unavailable", async () => {
      const { tool } = makeTool({ getSessionManager: () => undefined });
      const { text } = await run(tool!, { summary: "s" });
      expect(text).toContain("session manager unavailable");
    });

    it("reports nothing to compact when prepareCompaction declines", async () => {
      const { tool, managed } = makeTool({}, null);
      const { text } = await run(tool!, { summary: "s" });
      expect(text).toContain("Nothing to compact");
      expect(managed.compactions).toHaveLength(0);
    });
  });

  describe("compaction", () => {
    it("appends the compaction entry from the model summary", async () => {
      const { tool, managed } = makeTool();
      const { text } = await run(tool!, { summary: "## Goal\nfix compaction" });
      expect(managed.compactions).toHaveLength(1);
      expect(managed.compactions[0]).toMatchObject({
        summary: "## Goal\nfix compaction",
        firstKeptEntryId: "e3",
        tokensBefore: 12345,
        fromHook: true,
      });
      expect(text).toContain("Compaction complete");
      expect(text).toContain("tokensBefore=12345");
    });

    it("keeps the recent tail by default (keepRecentTokens > 0)", async () => {
      const { tool, prepareCalls } = makeTool();
      await run(tool!, { summary: "s" });
      const settings = (prepareCalls[0] as { settings: { keepRecentTokens: number } }).settings;
      expect(settings.keepRecentTokens).toBe(4096);
    });

    it("honours a configured keepRecentTokens", async () => {
      const managed = createManager([entry("e1", "user"), entry("e2", "user")]);
      const prepareCalls: unknown[] = [];
      const tool = createCompactTool({
        sessionKey: KEY,
        config: agentConfig({ keepRecentTokens: 1024, reserveTokens: 77 }),
        getSessionManager: () => managed.manager,
        prepareCompactionOverride: (_e: unknown, settings: unknown) => {
          prepareCalls.push(settings);
          return { firstKeptEntryId: "e2", tokensBefore: 1 };
        },
      });
      await run(tool!, { summary: "s" });
      expect(prepareCalls[0]).toMatchObject({ keepRecentTokens: 1024, reserveTokens: 77 });
    });

    it("keeps nothing when keepRecent is false (overflow fallback path)", async () => {
      const { tool, prepareCalls } = makeTool();
      const { text } = await run(tool!, { summary: "s", keepRecent: false });
      const settings = (prepareCalls[0] as { settings: { keepRecentTokens: number } }).settings;
      expect(settings.keepRecentTokens).toBe(0);
      expect(text).toContain("keepRecent=false");
    });

    it("runs session writes inside the provided write lock", async () => {
      const order: string[] = [];
      const { tool } = makeTool({
        withSessionWriteLock: async (fn) => {
          order.push("lock-in");
          const value = await fn();
          order.push("lock-out");
          return value;
        },
      });
      await run(tool!, { summary: "s" });
      expect(order[0]).toBe("lock-in");
      expect(order).toContain("lock-out");
    });

    it("refreshes agent messages with a synthetic tool_result", async () => {
      const refresh = vi.fn();
      const { tool } = makeTool({ updateAgentMessagesAfterCompaction: refresh });
      const { text } = await run(tool!, { summary: "s" });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh.mock.calls[0]?.[0]).toBe("call-1");
      expect(refresh.mock.calls[0]?.[1]).toBe(text);
    });

    it("surfaces an error instead of throwing when compaction fails", async () => {
      const managed = createManager([entry("e1", "user"), entry("e2", "user")]);
      (managed.manager as unknown as { appendCompaction: () => void }).appendCompaction = () => {
        throw new Error("boom");
      };
      const tool = createCompactTool({
        sessionKey: KEY,
        config: agentConfig(),
        getSessionManager: () => managed.manager,
        prepareCompactionOverride: () => ({ firstKeptEntryId: "e2", tokensBefore: 5 }),
      });
      const { text } = await run(tool!, { summary: "s" });
      expect(text).toContain("Compaction failed: boom");
    });
  });

  describe("memory write", () => {
    it("appends the summary to memory/<date>.md programmatically", async () => {
      const { tool } = makeTool({ workspaceDir });
      const { text } = await run(tool!, { summary: "SUMMARY-BODY" });
      const memoryDir = path.join(workspaceDir, "memory");
      const files = fs.readdirSync(memoryDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/);
      expect(fs.readFileSync(path.join(memoryDir, files[0]!), "utf-8")).toContain("SUMMARY-BODY");
      expect(text).toContain(`memory/${files[0]!.replace(/\.md$/, "")}.md`);
    });

    it("appends rather than overwrites an existing daily file", async () => {
      fs.mkdirSync(path.join(workspaceDir, "memory"), { recursive: true });
      const { tool } = makeTool({ workspaceDir });
      await run(tool!, { summary: "FIRST" });
      const file = path.join(
        workspaceDir,
        "memory",
        fs.readdirSync(path.join(workspaceDir, "memory"))[0]!,
      );
      fs.appendFileSync(file, "\nPRE-EXISTING\n");
      const second = makeTool({ workspaceDir });
      await run(second.tool!, { summary: "SECOND" });
      const body = fs.readFileSync(file, "utf-8");
      expect(body).toContain("FIRST");
      expect(body).toContain("PRE-EXISTING");
      expect(body).toContain("SECOND");
    });

    it("still compacts when no workspaceDir is configured", async () => {
      const { tool, managed } = makeTool({ workspaceDir: undefined });
      const { text } = await run(tool!, { summary: "s" });
      expect(managed.compactions).toHaveLength(1);
      expect(text).toContain("Summary saved to session.");
    });

    it("does not fail compaction when the memory write throws", async () => {
      const spy = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
        throw new Error("disk full");
      });
      const { tool, managed } = makeTool({ workspaceDir });
      const { text } = await run(tool!, { summary: "s" });
      expect(spy).toHaveBeenCalled();
      expect(managed.compactions).toHaveLength(1);
      expect(text).toContain("Compaction complete");
    });
  });

  describe("overflow stash restore", () => {
    function stashedSetup() {
      const managed = createManager([
        entry("e1", "user"),
        entry("e2", "assistant"),
        entry("e3", "toolResult"),
        entry("e4", "user", "cut-1"),
        entry("e5", "assistant", "cut-2"),
      ]);
      const prompt = prepareAgentOverflowFallback({
        sessionManager: managed.manager,
        sessionKey: KEY,
        sessionId: "sess-1",
        cutMessages: 2,
      });
      expect(prompt).not.toBeNull();
      return managed;
    }

    it("restores the stashed tail when keepRecent is false", async () => {
      const managed = stashedSetup();
      const tool = createCompactTool({
        sessionKey: KEY,
        sessionId: "sess-1",
        config: agentConfig(),
        getSessionManager: () => managed.manager,
        prepareCompactionOverride: () => ({ firstKeptEntryId: "e1", tokensBefore: 9 }),
      });
      const { text } = await run(tool!, { summary: "s", keepRecent: false });
      // cut tail + the "fallback completed" notice
      expect(managed.appended.length).toBeGreaterThanOrEqual(3);
      expect(text).toContain("Restored");
      expect(text).toContain("context-overflow fallback");
    });

    it("leaves the stash alone when keepRecent is true", async () => {
      const managed = stashedSetup();
      const tool = createCompactTool({
        sessionKey: KEY,
        sessionId: "sess-1",
        config: agentConfig(),
        getSessionManager: () => managed.manager,
        prepareCompactionOverride: () => ({ firstKeptEntryId: "e1", tokensBefore: 9 }),
      });
      const { text } = await run(tool!, { summary: "s" });
      expect(managed.appended).toHaveLength(0);
      expect(text).not.toContain("Restored");
    });

    it("compacts normally when keepRecent is false but nothing was stashed", async () => {
      const { tool, managed } = makeTool({ sessionId: "sess-none" });
      const { text } = await run(tool!, { summary: "s", keepRecent: false });
      expect(managed.compactions).toHaveLength(1);
      expect(text).not.toContain("Restored");
    });

    it("restores after the compaction entry, not before it", async () => {
      const managed = stashedSetup();
      const order: string[] = [];
      (managed.manager as unknown as { appendCompaction: () => void }).appendCompaction = () => {
        order.push("compaction");
      };
      const originalAppend = managed.manager.appendMessage.bind(managed.manager);
      (managed.manager as unknown as { appendMessage: (m: AgentMessage) => void }).appendMessage = (
        message: AgentMessage,
      ) => {
        order.push("message");
        originalAppend(message);
      };
      const tool = createCompactTool({
        sessionKey: KEY,
        sessionId: "sess-1",
        config: agentConfig(),
        getSessionManager: () => managed.manager,
        prepareCompactionOverride: () => ({ firstKeptEntryId: "e1", tokensBefore: 9 }),
      });
      await run(tool!, { summary: "s", keepRecent: false });
      expect(order[0]).toBe("compaction");
      expect(order.slice(1).every((step) => step === "message")).toBe(true);
    });
  });

  describe("compaction counter", () => {
    it("skips the counter when no session store context is provided", async () => {
      const { tool, managed } = makeTool({ getSessionStoreContext: () => undefined });
      await run(tool!, { summary: "s" });
      expect(managed.compactions).toHaveLength(1);
    });
  });
});
