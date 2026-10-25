import {
  DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR,
  parseNonNegativeByteSize,
  resolveCronStyleNow,
  resolveEffectiveCompactionReserveTokens,
  SILENT_REPLY_TOKEN,
  type MemoryFlushPlan,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { formatMemoryDreamingDay } from "openclaw/plugin-sdk/memory-core-host-status";
import { resolveMemoryCoreNowMs } from "./time.js";

const DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 4000;
const DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

const MEMORY_FLUSH_TARGET_HINT =
  "Store durable memories only in memory/YYYY-MM-DD.md (create memory/ if needed).";
const MEMORY_FLUSH_APPEND_ONLY_HINT =
  "If memory/YYYY-MM-DD.md already exists, APPEND new content only and do not overwrite existing entries.";
const MEMORY_FLUSH_READ_ONLY_HINT =
  "Treat workspace bootstrap/reference files such as MEMORY.md, DREAMS.md, SOUL.md, and AGENTS.md as read-only during this flush; never overwrite, replace, or edit them.";
const DEFAULT_MEMORY_FLUSH_PROMPT = [
  "Pre-compaction memory flush.",
  MEMORY_FLUSH_TARGET_HINT,
  MEMORY_FLUSH_READ_ONLY_HINT,
  MEMORY_FLUSH_APPEND_ONLY_HINT,
  "Do NOT create timestamped variant files (e.g., YYYY-MM-DD-HHMM.md); always use the standard YYYY-MM-DD.md filename.",
  `If nothing to store, reply with ${SILENT_REPLY_TOKEN}.`,
].join(" ");

const DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT = [
  "Pre-compaction memory flush turn.",
  "The session is near auto-compaction; capture durable memories to disk.",
  MEMORY_FLUSH_TARGET_HINT,
  MEMORY_FLUSH_READ_ONLY_HINT,
  MEMORY_FLUSH_APPEND_ONLY_HINT,
  `You may reply, but usually ${SILENT_REPLY_TOKEN} is correct.`,
].join(" ");

// FORK: agent compaction (agents.defaults.compaction.mode === "agent").
// The same pre-compaction turn drives compaction itself: the model calls
// `compact({ summary })` and the tool writes memory/YYYY-MM-DD.md
// programmatically, so there is no detached summarizer and no `write` call.
const AGENT_COMPACTION_PROMPT = [
  "Pre-compaction turn. This session is about to be compacted.",
  "Call the `compact` tool once with a complete structured summary of this conversation.",
  "The tool records the summary to today's memory file for you; do not call `write`.",
  "Include, in this order: goal; constraints and preferences; decisions;",
  "corrections and retractions; open threads and next steps; critical context",
  "(paths, ids, commands, numbers, exact error strings).",
  "Preserve decisions, corrections, retractions, and any user statement that",
  "changed direction verbatim, as written.",
  "Write it so a fresh instance of you could resume mid-task without asking anything.",
  `After the tool returns, reply ${SILENT_REPLY_TOKEN}.`,
].join(" ");

const AGENT_COMPACTION_SYSTEM_PROMPT = [
  "Pre-compaction turn (agent compaction).",
  "You are summarizing your own conversation; older messages are replaced by",
  "what you pass to `compact`. Anything you omit is lost permanently.",
  "Losing identity, user preferences, corrections, or in-flight work is the",
  "failure mode; length is not.",
  "Do not write memory files by hand during this turn; `compact` persists the summary.",
  `You may reply, but usually ${SILENT_REPLY_TOKEN} is correct.`,
].join(" ");

function normalizeNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int >= 0 ? int : null;
}

export function buildMemoryFlushPlan(
  params: {
    cfg?: OpenClawConfig;
    nowMs?: number;
    contextWindowTokens?: number;
  } = {},
): MemoryFlushPlan | null {
  const nowMs = resolveMemoryCoreNowMs(params.nowMs);
  const cfg = params.cfg;
  const defaults = cfg?.agents?.defaults?.compaction?.memoryFlush;
  if (defaults?.enabled === false) {
    return null;
  }

  let softThresholdTokens =
    normalizeNonNegativeInt(defaults?.softThresholdTokens) ?? DEFAULT_MEMORY_FLUSH_SOFT_TOKENS;
  const forceFlushTranscriptBytes =
    parseNonNegativeByteSize(defaults?.forceFlushTranscriptBytes) ??
    DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES;
  let reserveTokensFloor = DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR;
  const contextWindowTokens = normalizeNonNegativeInt(params.contextWindowTokens);
  if (contextWindowTokens !== null && contextWindowTokens > 0) {
    reserveTokensFloor = resolveEffectiveCompactionReserveTokens({
      contextTokenBudget: contextWindowTokens,
      reserveTokens: reserveTokensFloor,
    });
    softThresholdTokens = Math.min(
      softThresholdTokens,
      Math.floor((contextWindowTokens - reserveTokensFloor) / 2),
    );
  }

  const { timeLine, userTimezone } = resolveCronStyleNow(cfg ?? {}, nowMs);
  const dateStamp = formatMemoryDreamingDay(nowMs, userTimezone);
  const relativePath = `memory/${dateStamp}.md`;

  const agentCompaction = cfg?.agents?.defaults?.compaction?.mode === "agent";
  // FORK: agent compaction swaps in the in-session summarize prompts.
  const promptBase = agentCompaction ? AGENT_COMPACTION_PROMPT : DEFAULT_MEMORY_FLUSH_PROMPT;
  const systemPrompt = agentCompaction
    ? AGENT_COMPACTION_SYSTEM_PROMPT
    : DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT;

  return {
    softThresholdTokens,
    forceFlushTranscriptBytes,
    reserveTokensFloor,
    // FORK: agent-compaction prompts.
    prompt: `${promptBase.replaceAll("YYYY-MM-DD", dateStamp)}\n${timeLine}`,
    systemPrompt: systemPrompt.replaceAll("YYYY-MM-DD", dateStamp),
    relativePath,
  };
}
