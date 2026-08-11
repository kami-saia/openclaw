import { beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import type { SessionEntry, SessionManager } from "../../sessions/index.js";
import {
  AGENT_OVERFLOW_COMPACTION_PROMPT,
  clearAgentOverflowStash,
  getAgentOverflowSessionManager,
  hasAgentOverflowStash,
  prepareAgentOverflowFallback,
  registerAgentOverflowSessionManager,
  restoreAgentOverflowStash,
  unregisterAgentOverflowSessionManager,
} from "./agent-overflow-fallback.js";

type Role = "user" | "assistant" | "toolResult";

function entry(id: string, role: Role, text = id): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role, content: text } as unknown as AgentMessage,
  } as SessionEntry;
}

/** Minimal SessionManager stub: branch() truncates, appendMessage() pushes. */
function createManager(entries: SessionEntry[]) {
  let branch = [...entries];
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
  } as unknown as SessionManager;
  return {
    manager,
    appended,
    branchLength: () => branch.length,
  };
}

const KEY = "agent:test:session";

describe("agent-overflow-fallback", () => {
  beforeEach(() => {
    clearAgentOverflowStash(KEY);
    unregisterAgentOverflowSessionManager("run-1");
  });

  describe("session manager registry", () => {
    it("registers, reads back, and unregisters by runId", () => {
      const { manager } = createManager([entry("a", "user")]);
      expect(getAgentOverflowSessionManager("run-1")).toBeUndefined();
      registerAgentOverflowSessionManager("run-1", manager);
      expect(getAgentOverflowSessionManager("run-1")).toBe(manager);
      unregisterAgentOverflowSessionManager("run-1");
      expect(getAgentOverflowSessionManager("run-1")).toBeUndefined();
    });

    it("ignores undefined runIds instead of leaking a shared slot", () => {
      const { manager } = createManager([entry("a", "user")]);
      registerAgentOverflowSessionManager(undefined, manager);
      expect(getAgentOverflowSessionManager(undefined)).toBeUndefined();
    });
  });

  describe("cut placement", () => {
    it("cuts at a turn start when the target index is a user message", () => {
      // 12 entries: cut target = index 2, which is a user turn start.
      const entries = [
        entry("u0", "user"),
        entry("a0", "assistant"),
        entry("u1", "user"),
        ...Array.from({ length: 9 }, (_, i) => entry(`a${i + 1}`, "assistant")),
      ];
      const { manager, branchLength } = createManager(entries);
      const result = prepareAgentOverflowFallback({ sessionManager: manager, sessionKey: KEY });
      expect(result).not.toBeNull();
      expect(result?.prompt).toBe(AGENT_OVERFLOW_COMPACTION_PROMPT);
      expect(result?.cutEntryCount).toBe(10);
      // Surviving transcript ends at the entry before the cut.
      expect(branchLength()).toBe(2);
      expect(hasAgentOverflowStash(KEY)).toBe(true);
    });

    it("accepts a mid-tool-chain cut when the preceding entry is a toolResult", () => {
      // Target index 2 is an assistant toolCall continuation, but index 1 is a
      // toolResult, so cutting at 2 leaves no orphaned toolCall.
      const entries = [
        entry("u0", "user"),
        entry("tr0", "toolResult"),
        ...Array.from({ length: 10 }, (_, i) => entry(`a${i}`, "assistant")),
      ];
      const { manager, branchLength } = createManager(entries);
      const result = prepareAgentOverflowFallback({ sessionManager: manager, sessionKey: KEY });
      expect(result).not.toBeNull();
      expect(result?.cutEntryCount).toBe(10);
      expect(branchLength()).toBe(2);
    });

    it("never cuts immediately after an assistant entry (would orphan a toolCall)", () => {
      // Entries after index 0 are all assistant: the only safe index is a turn
      // start. Target lands mid-assistant-run and must walk back to index 0+.
      const entries = [
        entry("u0", "user"),
        ...Array.from({ length: 5 }, (_, i) => entry(`a${i}`, "assistant")),
        entry("u1", "user"),
        ...Array.from({ length: 5 }, (_, i) => entry(`b${i}`, "assistant")),
      ];
      const { manager } = createManager(entries);
      const result = prepareAgentOverflowFallback({ sessionManager: manager, sessionKey: KEY });
      expect(result).not.toBeNull();
      const cutIndex = entries.length - (result?.cutEntryCount ?? 0);
      const before = entries[cutIndex - 1]?.type === "message" ? entries[cutIndex - 1] : undefined;
      const beforeRole = (before as { message?: { role?: string } } | undefined)?.message?.role;
      const cutRole = (entries[cutIndex] as { message?: { role?: string } }).message?.role;
      const safe = cutRole === "user" || beforeRole === "toolResult";
      expect(safe).toBe(true);
    });

    it("prefers the safe index closest to the target (cuts as little as possible)", () => {
      // Two safe indices exist: 2 (user) and 6 (user). Target = 12-10 = 2.
      const entries = [
        entry("u0", "user"),
        entry("a0", "assistant"),
        entry("u1", "user"),
        entry("a1", "assistant"),
        entry("a2", "assistant"),
        entry("a3", "assistant"),
        entry("u2", "user"),
        ...Array.from({ length: 5 }, (_, i) => entry(`c${i}`, "assistant")),
      ];
      const { manager } = createManager(entries);
      const result = prepareAgentOverflowFallback({ sessionManager: manager, sessionKey: KEY });
      // index 2 chosen, not 6 -> cutEntryCount = 12 - 2 = 10
      expect(result?.cutEntryCount).toBe(10);
    });

    it("returns null when no safe boundary exists so callers fall through to upstream", () => {
      const entries = [entry("u0", "user"), entry("a0", "assistant")];
      const { manager, branchLength } = createManager(entries);
      const result = prepareAgentOverflowFallback({ sessionManager: manager, sessionKey: KEY });
      expect(result).toBeNull();
      expect(branchLength()).toBe(2);
      expect(hasAgentOverflowStash(KEY)).toBe(false);
    });

    it("returns null for a single-entry transcript", () => {
      const { manager } = createManager([entry("u0", "user")]);
      expect(prepareAgentOverflowFallback({ sessionManager: manager, sessionKey: KEY })).toBeNull();
    });

    it("returns null without a session key or id", () => {
      const { manager } = createManager([entry("u0", "user"), entry("u1", "user")]);
      expect(prepareAgentOverflowFallback({ sessionManager: manager })).toBeNull();
    });

    it("does not stack a second cut while a stash is pending", () => {
      const entries = [
        entry("u0", "user"),
        entry("a0", "assistant"),
        entry("u1", "user"),
        ...Array.from({ length: 9 }, (_, i) => entry(`a${i + 1}`, "assistant")),
      ];
      const { manager } = createManager(entries);
      expect(
        prepareAgentOverflowFallback({ sessionManager: manager, sessionKey: KEY }),
      ).not.toBeNull();
      expect(prepareAgentOverflowFallback({ sessionManager: manager, sessionKey: KEY })).toBeNull();
    });

    it("honours an explicit cutMessages target", () => {
      const entries = [...Array.from({ length: 10 }, (_, i) => entry(`u${i}`, "user"))];
      const { manager } = createManager(entries);
      const result = prepareAgentOverflowFallback({
        sessionManager: manager,
        sessionKey: KEY,
        cutMessages: 3,
      });
      expect(result?.cutEntryCount).toBe(3);
    });
  });

  describe("restore", () => {
    it("re-appends the cut tail then the completion notice, in that order", () => {
      const entries = [
        entry("u0", "user"),
        entry("a0", "assistant"),
        entry("u1", "user"),
        ...Array.from({ length: 9 }, (_, i) => entry(`tail${i}`, "assistant")),
      ];
      const { manager, appended } = createManager(entries);
      prepareAgentOverflowFallback({ sessionManager: manager, sessionKey: KEY });

      const restored = restoreAgentOverflowStash({ sessionManager: manager, sessionKey: KEY });
      expect(restored).toBe(10);
      // 10 restored + 1 completion notice
      expect(appended).toHaveLength(11);
      const last = appended[appended.length - 1] as { role: string; content: string };
      expect(last.role).toBe("user");
      expect(last.content).toContain("Compaction fallback completed");
      // First restored message is the first cut entry, order preserved.
      expect((appended[0] as { content: string }).content).toBe("u1");
      expect(hasAgentOverflowStash(KEY)).toBe(false);
    });

    it("is a no-op when nothing was stashed", () => {
      const { manager, appended } = createManager([entry("u0", "user")]);
      expect(restoreAgentOverflowStash({ sessionManager: manager, sessionKey: KEY })).toBe(0);
      expect(appended).toHaveLength(0);
    });

    it("is idempotent: a second restore does not duplicate messages", () => {
      const entries = [
        entry("u0", "user"),
        entry("a0", "assistant"),
        entry("u1", "user"),
        ...Array.from({ length: 9 }, (_, i) => entry(`tail${i}`, "assistant")),
      ];
      const { manager, appended } = createManager(entries);
      prepareAgentOverflowFallback({ sessionManager: manager, sessionKey: KEY });
      restoreAgentOverflowStash({ sessionManager: manager, sessionKey: KEY });
      const countAfterFirst = appended.length;
      expect(restoreAgentOverflowStash({ sessionManager: manager, sessionKey: KEY })).toBe(0);
      expect(appended).toHaveLength(countAfterFirst);
    });

    it("clearAgentOverflowStash drops the tail without restoring it", () => {
      const entries = [
        entry("u0", "user"),
        entry("a0", "assistant"),
        entry("u1", "user"),
        ...Array.from({ length: 9 }, (_, i) => entry(`tail${i}`, "assistant")),
      ];
      const { manager, appended } = createManager(entries);
      prepareAgentOverflowFallback({ sessionManager: manager, sessionKey: KEY });
      clearAgentOverflowStash(KEY);
      expect(hasAgentOverflowStash(KEY)).toBe(false);
      expect(restoreAgentOverflowStash({ sessionManager: manager, sessionKey: KEY })).toBe(0);
      expect(appended).toHaveLength(0);
    });

    it("keys stashes by session so two sessions do not collide", () => {
      const build = () => [
        entry("u0", "user"),
        entry("a0", "assistant"),
        entry("u1", "user"),
        ...Array.from({ length: 9 }, (_, i) => entry(`tail${i}`, "assistant")),
      ];
      const a = createManager(build());
      const b = createManager(build());
      prepareAgentOverflowFallback({ sessionManager: a.manager, sessionKey: "session-a" });
      prepareAgentOverflowFallback({ sessionManager: b.manager, sessionKey: "session-b" });
      expect(hasAgentOverflowStash("session-a")).toBe(true);
      expect(hasAgentOverflowStash("session-b")).toBe(true);
      restoreAgentOverflowStash({ sessionManager: a.manager, sessionKey: "session-a" });
      expect(hasAgentOverflowStash("session-a")).toBe(false);
      expect(hasAgentOverflowStash("session-b")).toBe(true);
      clearAgentOverflowStash("session-b");
    });

    it("falls back to sessionId when no session key is supplied", () => {
      const entries = [
        entry("u0", "user"),
        entry("a0", "assistant"),
        entry("u1", "user"),
        ...Array.from({ length: 9 }, (_, i) => entry(`tail${i}`, "assistant")),
      ];
      const { manager } = createManager(entries);
      prepareAgentOverflowFallback({ sessionManager: manager, sessionId: "sid-1" });
      expect(hasAgentOverflowStash(undefined, "sid-1")).toBe(true);
      expect(restoreAgentOverflowStash({ sessionManager: manager, sessionId: "sid-1" })).toBe(10);
    });
  });

  describe("prompt", () => {
    it("instructs an immediate single compact with keepRecent false", () => {
      expect(AGENT_OVERFLOW_COMPACTION_PROMPT).toContain("keepRecent: false");
      expect(AGENT_OVERFLOW_COMPACTION_PROMPT).toContain("compact");
      expect(AGENT_OVERFLOW_COMPACTION_PROMPT).toContain("do not call any other tool");
    });
  });
});
