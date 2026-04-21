import { estimateTokens } from "@mariozechner/pi-coding-agent";
/**
 * Agent-controlled compaction: check context pressure and inject a system event
 * signal instead of running a memory flush turn.
 *
 * Extracted to its own module to avoid circular import chains from
 * agent-runner-memory.ts's heavy transitive dependency graph.
 */
import {
  computeContextPressure,
  formatContextPressureMessage,
} from "../../agents/context-pressure.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";

/**
 * Test-only injection point for the token-source function. Production code
 * always uses `estimateSessionTokensFromTranscriptDefault`. Tests call
 * `_setTokenSourceForTests()` to supply tokens directly without needing a
 * real transcript file on disk.
 */
type TokenSource = (entry: SessionEntry) => number | undefined;
let tokenSourceOverride: TokenSource | null = null;
export function _setTokenSourceForTests(fn: TokenSource | null): void {
  tokenSourceOverride = fn;
}

/**
 * Estimate current context tokens from the session transcript.
 * Uses chars/4 heuristic (same as upstream compaction).
 * Reads only kept messages (respects compaction markers).
 */
function estimateSessionTokensFromTranscriptDefault(entry: SessionEntry): number | undefined {
  const sessionId = (entry as Record<string, unknown>).sessionId as string | undefined;
  if (!sessionId) {
    return undefined;
  }
  try {
    const fs = require("node:fs");
    const { resolveSessionTranscriptCandidates } = require("../../gateway/session-utils.fs.js");
    const candidates = resolveSessionTranscriptCandidates(
      sessionId,
      undefined,
      (entry as Record<string, unknown>).sessionFile as string | undefined,
    );
    const filePath = candidates.find((p: string) => fs.existsSync(p));
    if (!filePath) {
      return undefined;
    }
    return estimateSessionTokensFromTranscriptFile(filePath);
  } catch {
    return undefined;
  }
}

/**
 * Pure estimator: given a session transcript file path, return the
 * estimated token count of the LLM-facing context after the most recent
 * compaction. Exported for testing.
 */
export function estimateSessionTokensFromTranscriptFile(filePath: string): number | undefined {
  try {
    const fs = require("node:fs");
    const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);

    // Find last compaction's firstKeptEntryId
    let firstKeptId: string | null = null;
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as Record<string, unknown> | null;
        if (parsed?.type === "compaction" && parsed.firstKeptEntryId) {
          firstKeptId = parsed.firstKeptEntryId as string;
        }
      } catch {
        // ignore malformed lines
      }
    }

    // Collect only kept messages (after compaction marker).
    // Each compaction supersedes prior summaries (the new summary folds in
    // earlier ones), so we only count the MOST RECENT compaction summary,
    // not every historical one. Without this, sessions with many compactions
    // accumulate stale summaries in the token estimate and inflate pressure
    // far above the actual LLM-facing context size, causing repeated
    // compaction signals on every turn.
    let foundKept = !firstKeptId; // if no compaction, keep all
    const messages: unknown[] = [];
    let latestCompactionSummary: string | null = null;
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as Record<string, unknown> | null;
        if (!foundKept && parsed?.id === firstKeptId) {
          foundKept = true;
        }
        // Track the most recent compaction summary; older ones are subsumed.
        if (parsed?.type === "compaction" && parsed.summary) {
          latestCompactionSummary = parsed.summary as string;
        }
        if (foundKept && parsed?.message) {
          messages.push(parsed.message);
        }
      } catch {
        // ignore malformed lines
      }
    }

    // Prepend the single most-recent compaction summary (if any) as one message.
    if (latestCompactionSummary) {
      messages.unshift({
        role: "assistant",
        content: [{ type: "text", text: latestCompactionSummary }],
        timestamp: Date.now(),
      });
    }

    if (messages.length === 0) {
      return undefined;
    }
    let total = 0;
    for (const msg of messages) {
      total += estimateTokens(msg as Parameters<typeof estimateTokens>[0]);
    }
    return total > 0 ? total : undefined;
  } catch {
    return undefined;
  }
}

export function maybeInjectAgentCompactionPressureSignal(params: {
  cfg: OpenClawConfig;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
}): SessionEntry | undefined {
  const entry = params.sessionEntry;
  if (!entry) {
    return entry;
  }

  // Prefer explicit agent config contextTokens over catalog-reported value
  // (GH Copilot reports 1M for Claude Opus but real limit is 200k)
  const contextWindowTokens =
    params.agentCfgContextTokens ??
    ((entry as Record<string, unknown>).contextTokens as number | undefined) ??
    128_000;

  const totalTokens = tokenSourceOverride
    ? tokenSourceOverride(entry)
    : estimateSessionTokensFromTranscriptDefault(entry);

  logVerbose(
    `preflightCompaction check: sessionKey=${params.sessionKey} ` +
      `tokenCount=${totalTokens} contextWindow=${contextWindowTokens} ` +
      `threshold=${contextWindowTokens * 0.85} ` +
      `estimated=true method=transcript`,
  );

  const signal = computeContextPressure({
    totalTokens: totalTokens ?? undefined,
    contextWindowTokens,
  });

  if (signal && params.sessionKey) {
    const message = formatContextPressureMessage(signal);
    void import("../../infra/system-events.js").then(({ enqueueSystemEvent }) => {
      enqueueSystemEvent(message, { sessionKey: params.sessionKey! });
    });
    logVerbose(
      `agent-compaction pressure signal: sessionKey=${params.sessionKey} ` +
        `pressure=${signal.pressure} recommended=${signal.compactionRecommended}`,
    );
  }

  return entry;
}
