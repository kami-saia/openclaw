/** Pressure thresholds for context pressure signaling. */
const PRESSURE_SILENT = 0.75;
const PRESSURE_RECOMMEND = 0.85;

/** Track last emitted pressure to avoid redundant signals below RECOMMEND threshold. */
let lastEmittedPressure: number | null = null;

export interface ContextPressureSignal {
  pressure: number;
  compactionRecommended: boolean;
}

/**
 * Compute context pressure from actual API-reported token counts.
 * Returns null if pressure is below the signaling threshold or data is unavailable.
 */
export function computeContextPressure(params: {
  totalTokens?: number;
  contextWindowTokens: number;
}): ContextPressureSignal | null {
  const { totalTokens, contextWindowTokens } = params;

  if (!totalTokens || totalTokens <= 0 || !contextWindowTokens || contextWindowTokens <= 0) {
    return null;
  }

  const pressure = totalTokens / contextWindowTokens;

  if (pressure < PRESSURE_SILENT) {
    return null;
  }

  const compactionRecommended = pressure >= PRESSURE_RECOMMEND;
  const roundedPressure = Math.round(pressure * 100) / 100;

  // Below RECOMMEND: notify once, then stay silent until crossing RECOMMEND.
  if (!compactionRecommended) {
    if (lastEmittedPressure !== null) {
      return null;
    }
    lastEmittedPressure = roundedPressure;
    return { pressure: roundedPressure, compactionRecommended };
  }

  // At or above RECOMMEND: always emit (every turn).
  lastEmittedPressure = roundedPressure;
  return { pressure: roundedPressure, compactionRecommended };
}

/** Reset pressure tracking (call after compaction). */
export function resetPressureTracking(): void {
  lastEmittedPressure = null;
}

/**
 * Format a context pressure signal as a system message string.
 */
export function formatContextPressureMessage(signal: ContextPressureSignal): string {
  const tag = signal.compactionRecommended
    ? `[context_pressure: ${signal.pressure}, compaction_recommended: true]`
    : `[context_pressure: ${signal.pressure}]`;

  if (!signal.compactionRecommended) {
    return tag;
  }

  return (
    tag +
    "\n\nContext is filling up. Call `compact` with a summary at your next natural break point." +
    "\n\n**Compaction guidelines:**" +
    "\n- Structure: Goal → Decisions → Progress (done/in-progress) → Open TODOs → Critical Context → Next Steps" +
    "\n- Keep ONLY what's needed to continue the current work thread" +
    "\n- Drop completed work details — just note they're done" +
    "\n- Drop exact identifiers (commit hashes, PIDs, message IDs, timestamps) unless actively needed" +
    "\n- Carry forward file paths and session keys only if the next steps reference them" +
    "\n- Be concise — a good summary is 1500-3000 chars, not 10000" +
    "\n- Don't duplicate what's already in workspace files (MEMORY.md, AGENTS.md, TOOLS.md)" +
    "\n- Preserve any pending user asks or unanswered questions verbatim"
  );
}
