/**
 * FORK: agent-compaction context-overflow fallback.
 *
 * When a prompt is about to be sent over budget, upstream throws
 * PREEMPTIVE_OVERFLOW_ERROR_TEXT and hands the transcript to a detached
 * summarizer. Under `agents.defaults.compaction.mode === "agent"` we instead:
 *
 *   1. cut the recent tail off the transcript at a safe boundary (a turn start,
 *      or immediately after a toolResult so no toolCall is orphaned),
 *   2. stash the cut entries in memory keyed by session,
 *   3. retry the prompt with a synthetic user message explaining the overflow
 *      and instructing an immediate `compact({ keepRecent: false })`,
 *   4. after the compact tool runs, re-append the stashed messages plus a
 *      "compaction fallback completed" user message.
 *
 * Ordering after recovery: summary -> re-appended tail -> completion notice.
 */
import type { AgentMessage } from "../../runtime/index.js";
import { findTurnStartIndex } from "../../sessions/compaction/index.js";
import type { SessionEntry, SessionManager } from "../../sessions/index.js";
import { log } from "../logger.js";

/** Target number of trailing messages to cut before snapping to a turn boundary. */
const DEFAULT_OVERFLOW_CUT_MESSAGES = 10;

export const AGENT_OVERFLOW_COMPACTION_PROMPT = [
  "Context window overflow: the previous prompt did not fit the model's context.",
  "The most recent messages were programmatically removed from this request and are held aside;",
  "they will be restored automatically after you compact.",
  "Call the `compact` tool NOW, once, with `keepRecent: false` and a complete structured summary",
  "of everything above: goal; constraints and preferences; decisions; corrections and retractions;",
  "open threads and next steps; critical context (paths, ids, commands, numbers, exact error strings).",
  "Preserve decisions, corrections, retractions, and any user statement that changed direction verbatim.",
  "Do not answer the user's request in this turn and do not call any other tool first.",
].join(" ");

const AGENT_OVERFLOW_RESUME_NOTICE = [
  "Compaction fallback completed.",
  "The messages that were cut to fit the context window have been restored above this line,",
  "after your summary. Resume the interrupted work from here.",
].join(" ");

type StashedOverflowTail = {
  messages: AgentMessage[];
  cutEntryCount: number;
  createdAtMs: number;
};

const overflowStashes = new Map<string, StashedOverflowTail>();

/**
 * Live SessionManager registry keyed by runId. The overflow recovery path runs
 * outside the attempt closure that owns the manager, so the attempt publishes
 * it here on creation and clears it when the run unwinds.
 */
const liveSessionManagers = new Map<string, SessionManager>();

export function registerAgentOverflowSessionManager(
  runId: string | undefined,
  sessionManager: SessionManager,
): void {
  if (runId) {
    liveSessionManagers.set(runId, sessionManager);
  }
}

export function unregisterAgentOverflowSessionManager(runId: string | undefined): void {
  if (runId) {
    liveSessionManagers.delete(runId);
  }
}

export function getAgentOverflowSessionManager(
  runId: string | undefined,
): SessionManager | undefined {
  return runId ? liveSessionManagers.get(runId) : undefined;
}

function stashKey(sessionKey: string | undefined, sessionId: string | undefined): string {
  return sessionKey?.trim() || sessionId?.trim() || "";
}

function messageFromEntry(entry: SessionEntry): AgentMessage | undefined {
  return entry.type === "message" ? entry.message : undefined;
}

function entryRole(entry: SessionEntry | undefined): string | undefined {
  const message = entry ? messageFromEntry(entry) : undefined;
  return message ? (message as { role?: string }).role : undefined;
}

/**
 * A cut index is safe when the transcript that survives ends on a complete
 * unit: either the cut starts a new turn, or the entry immediately before the
 * cut is a toolResult (mid-chain is fine as long as every toolCall keeps its
 * result). Anything else could orphan a toolCall.
 */
function isSafeCutIndex(entries: SessionEntry[], index: number): boolean {
  if (index <= 0 || index >= entries.length) {
    return false;
  }
  const entry = entries[index];
  if (entry && isTurnStartRole(entryRole(entry))) {
    return true;
  }
  return entryRole(entries[index - 1]) === "toolResult";
}

function isTurnStartRole(role: string | undefined): boolean {
  return (
    role === "user" ||
    role === "bashExecution" ||
    role === "custom" ||
    role === "branchSummary" ||
    role === "compactionSummary"
  );
}

/**
 * Choose a cut index near `entries.length - targetCut`. Prefers the safe index
 * closest to the target (cutting as few messages as possible), accepting either
 * a turn start or a position right after a toolResult. Returns -1 when no safe
 * boundary exists, in which case the caller must fall back to upstream
 * behavior rather than cut mid-chain.
 */
function resolveTurnBoundaryCutIndex(entries: SessionEntry[], targetCut: number): number {
  if (entries.length <= 1) {
    return -1;
  }
  const desired = Math.max(1, entries.length - Math.max(1, targetCut));
  // Prefer cutting at least the requested amount: scan backwards first.
  for (let index = desired; index >= 1; index--) {
    if (isSafeCutIndex(entries, index)) {
      return index;
    }
  }
  // Nothing safe at or before the target (e.g. one long assistant/tool run).
  // Cut less rather than not at all: take the nearest safe index after it.
  for (let index = desired + 1; index < entries.length; index++) {
    if (isSafeCutIndex(entries, index)) {
      return index;
    }
  }
  // Last resort: upstream's turn-start scan, in case role shapes differ.
  const turnStart = findTurnStartIndex(entries as never[], desired, 1);
  if (turnStart > 0 && turnStart < entries.length) {
    return turnStart;
  }
  return -1;
}

/**
 * Cut the trailing turn(s) out of the live transcript and stash them.
 * Returns the prompt to resend with, or null when no safe cut exists.
 */
export function prepareAgentOverflowFallback(input: {
  sessionManager: SessionManager;
  sessionKey?: string;
  sessionId?: string;
  cutMessages?: number;
}): { prompt: string; cutEntryCount: number } | null {
  const key = stashKey(input.sessionKey, input.sessionId);
  if (!key) {
    return null;
  }
  if (overflowStashes.has(key)) {
    // A previous fallback for this session never completed; do not stack cuts.
    return null;
  }
  const entries = input.sessionManager.getBranch() as SessionEntry[];
  const cutIndex = resolveTurnBoundaryCutIndex(
    entries,
    input.cutMessages ?? DEFAULT_OVERFLOW_CUT_MESSAGES,
  );
  if (cutIndex < 0) {
    return null;
  }
  const cutEntries = entries.slice(cutIndex);
  const messages = cutEntries
    .map(messageFromEntry)
    .filter((message): message is AgentMessage => message !== undefined);
  const parentEntry = entries[cutIndex - 1];
  if (!parentEntry) {
    return null;
  }
  try {
    input.sessionManager.branch(parentEntry.id);
  } catch (err) {
    log.warn(`[agent-overflow-fallback] branch to ${parentEntry.id} failed: ${String(err)}`);
    return null;
  }
  overflowStashes.set(key, {
    messages,
    cutEntryCount: cutEntries.length,
    createdAtMs: Date.now(),
  });
  log.warn(
    `[agent-overflow-fallback] cut sessionKey=${key} cutEntries=${cutEntries.length} ` +
      `stashedMessages=${messages.length} cutIndex=${cutIndex} totalEntries=${entries.length}`,
  );
  return { prompt: AGENT_OVERFLOW_COMPACTION_PROMPT, cutEntryCount: cutEntries.length };
}

/** True when a fallback cut is waiting to be restored for this session. */
export function hasAgentOverflowStash(sessionKey?: string, sessionId?: string): boolean {
  const key = stashKey(sessionKey, sessionId);
  return key ? overflowStashes.has(key) : false;
}

/**
 * Re-append stashed messages after a successful compaction, followed by the
 * completion notice. Returns the number of restored messages.
 */
export function restoreAgentOverflowStash(input: {
  sessionManager: SessionManager;
  sessionKey?: string;
  sessionId?: string;
}): number {
  const key = stashKey(input.sessionKey, input.sessionId);
  if (!key) {
    return 0;
  }
  const stash = overflowStashes.get(key);
  if (!stash) {
    return 0;
  }
  overflowStashes.delete(key);
  let restored = 0;
  for (const message of stash.messages) {
    try {
      input.sessionManager.appendMessage(message);
      restored += 1;
    } catch (err) {
      log.warn(`[agent-overflow-fallback] restore append failed: ${String(err)}`);
    }
  }
  try {
    input.sessionManager.appendMessage({
      role: "user",
      content: AGENT_OVERFLOW_RESUME_NOTICE,
    } as AgentMessage);
  } catch (err) {
    log.warn(`[agent-overflow-fallback] resume notice append failed: ${String(err)}`);
  }
  log.warn(
    `[agent-overflow-fallback] restored sessionKey=${key} messages=${restored}/${stash.messages.length} ` +
      `heldMs=${Date.now() - stash.createdAtMs}`,
  );
  return restored;
}

/** Drop a stash without restoring it (session rotation, abandoned run). */
export function clearAgentOverflowStash(sessionKey?: string, sessionId?: string): void {
  const key = stashKey(sessionKey, sessionId);
  if (key) {
    overflowStashes.delete(key);
  }
}
