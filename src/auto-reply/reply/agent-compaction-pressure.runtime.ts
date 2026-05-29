/**
 * Agent-controlled compaction: check context pressure and inject a system event
 * signal instead of running a memory flush turn.
 *
 * Extracted to its own runtime module to keep its (heavy) transitive
 * dependencies out of the auto-reply chunk graph. Statically importing the
 * gateway transcript-resolution helpers or context-pressure into the reply hot
 * path perturbs tsdown chunk-init ordering and breaks unrelated runtime chunks
 * (memory-host-sdk barrel: init_input_provenance / init_paths / etc.). See the
 * 2026-05-28 upstream merge note in memory for the full diagnosis.
 *
 * Strategy: import only leaf/light modules statically; defer everything that
 * reaches the heavy session/gateway graph (transcript files, context-pressure,
 * system-events) to dynamic import() inside the async function.
 */
import type { OpenClawConfig } from "../../config/config.js";
import { resolveFreshSessionTotalTokens, type SessionEntry } from "../../config/sessions/types.js";
import { logVerbose } from "../../globals.js";

/**
 * Test-only injection point for the token-source function. Production code uses
 * the transcript-based estimator (loaded dynamically). Tests call
 * `setTokenSourceForTestsHook()` to supply tokens directly without needing a
 * real transcript file on disk.
 */
type TokenSource = (entry: SessionEntry) => number | undefined;
let tokenSourceOverride: TokenSource | null = null;
export function setTokenSourceForTestsHook(fn: TokenSource | null): void {
  tokenSourceOverride = fn;
}

/**
 * Estimate current context tokens from the session transcript using a chars/4
 * heuristic over kept messages (respects compaction markers).
 *
 * The transcript-file path resolver lives in the heavy gateway graph, so it is
 * loaded via dynamic import() to stay out of this module's static chunk.
 */
async function estimateSessionTokensFromTranscriptDefault(
  entry: SessionEntry,
): Promise<number | undefined> {
  const sessionId = (entry as Record<string, unknown>).sessionId as string | undefined;
  if (!sessionId) {
    return undefined;
  }
  try {
    const fs = await import("node:fs");
    const { resolveSessionTranscriptCandidates } =
      await import("../../gateway/session-transcript-files.fs.js");
    const candidates = resolveSessionTranscriptCandidates(
      sessionId,
      undefined,
      (entry as Record<string, unknown>).sessionFile as string | undefined,
    );
    const filePath = candidates.find((p: string) => fs.existsSync(p));
    if (!filePath) {
      return undefined;
    }

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

    // Collect only kept messages (after compaction marker)
    let foundKept = !firstKeptId; // if no compaction, keep all
    const messages: unknown[] = [];
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as Record<string, unknown> | null;
        if (!foundKept && parsed?.id === firstKeptId) {
          foundKept = true;
        }
        // Include compaction summary as a message
        if (parsed?.type === "compaction" && parsed.summary) {
          messages.push({
            role: "assistant",
            content: [{ type: "text", text: parsed.summary }],
            timestamp: Date.now(),
          });
        }
        if (foundKept && parsed?.message) {
          messages.push(parsed.message);
        }
      } catch {
        // ignore malformed lines
      }
    }

    if (messages.length === 0) {
      return undefined;
    }
    // Inline chars/4 heuristic to avoid a heavy estimateTokens import that would
    // perturb the tsdown chunk graph. Close enough for pressure thresholds.
    const estimateMessageTokens = (msg: unknown): number => {
      const m = msg as Record<string, unknown> | null;
      if (!m) return 0;
      const content = m.content;
      let chars = 0;
      if (typeof content === "string") {
        chars = content.length;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown> | null;
          if (b && typeof b.text === "string") chars += b.text.length;
        }
      }
      return Math.ceil(chars / 4);
    };
    let total = 0;
    for (const msg of messages) {
      total += estimateMessageTokens(msg);
    }
    return total > 0 ? total : undefined;
  } catch {
    return undefined;
  }
}

export async function maybeInjectAgentCompactionPressureSignal(params: {
  cfg: OpenClawConfig;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
}): Promise<SessionEntry | undefined> {
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

  // Prefer API-reported fresh totalTokens (includes system prompt, bootstrap
  // files, project context, tool definitions — none of which appear in the
  // transcript jsonl). The transcript estimate severely under-counts because
  // it only sees conversation messages, missing ~80-100k of system overhead.
  // Fall back to transcript estimation only when the API number is stale or
  // unavailable (totalTokensFresh=false or missing).
  const apiTokens = resolveFreshSessionTotalTokens(entry);
  let totalTokens = apiTokens;
  let tokenSource: "api-fresh" | "transcript" = "api-fresh";
  if (totalTokens === undefined) {
    totalTokens = tokenSourceOverride
      ? tokenSourceOverride(entry)
      : await estimateSessionTokensFromTranscriptDefault(entry);
    tokenSource = "transcript";
  }

  logVerbose(
    `preflightCompaction check: sessionKey=${params.sessionKey} ` +
      `tokenCount=${totalTokens} contextWindow=${contextWindowTokens} ` +
      `threshold=${contextWindowTokens * 0.85} ` +
      `estimated=true method=${tokenSource}`,
  );

  // Dynamic import keeps context-pressure out of this module's static chunk
  // graph; a static edge here perturbs tsdown chunk-init ordering and breaks
  // unrelated runtime chunks (memory-host-sdk barrel). See 2026-05-28 merge note.
  const { computeContextPressure, formatContextPressureMessage } =
    await import("../../agents/context-pressure.js");
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
