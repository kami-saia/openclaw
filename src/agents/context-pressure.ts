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
    " Context is filling up. Use the `compact` tool with a summary when you have a natural break point. " +
    "Include: goals, progress, key decisions, and context needed to continue."
  );
}
