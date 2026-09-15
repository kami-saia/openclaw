/**
 * Human-like input pacing for browser interactions.
 *
 * Machine-speed input is a behavioural tell: `fill()` sets a value in one shot
 * with no keystrokes, and `type(delay: 75)` produces a perfectly uniform
 * inter-key interval that no human produces. These helpers generate
 * human-shaped timings instead (log-normal-ish jitter, occasional longer
 * pauses at word boundaries, slight settle time before a click).
 */

const BASE_KEY_DELAY_MS = 92;
const KEY_JITTER_RATIO = 0.45;
const WORD_PAUSE_PROBABILITY = 0.18;
const WORD_PAUSE_MIN_MS = 120;
const WORD_PAUSE_MAX_MS = 340;
const CLICK_SETTLE_MIN_MS = 45;
const CLICK_SETTLE_MAX_MS = 190;

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Gaussian-ish sample via sum of uniforms, clamped to a sane positive range.
 * Keeps the bulk of keystrokes near the base delay with a long right tail,
 * which is what real typing histograms look like.
 */
function jitteredKeyDelayMs(baseMs: number): number {
  const spread = baseMs * KEY_JITTER_RATIO;
  const noise = (Math.random() + Math.random() + Math.random() - 1.5) * spread;
  return Math.max(18, Math.round(baseMs + noise));
}

/** Per-character delays for a string, including occasional word-boundary pauses. */
export function humanKeyDelaysMs(text: string, baseMs = BASE_KEY_DELAY_MS): number[] {
  const delays: number[] = [];
  for (const char of text) {
    let delay = jitteredKeyDelayMs(baseMs);
    if ((char === " " || char === "." || char === "@") && Math.random() < WORD_PAUSE_PROBABILITY) {
      delay += Math.round(randomInRange(WORD_PAUSE_MIN_MS, WORD_PAUSE_MAX_MS));
    }
    delays.push(delay);
  }
  return delays;
}

/** Short settle delay between hovering an element and pressing it. */
export function humanClickSettleMs(): number {
  return Math.round(randomInRange(CLICK_SETTLE_MIN_MS, CLICK_SETTLE_MAX_MS));
}

/** Delay before submitting a form after the last keystroke. */
export function humanSubmitPauseMs(): number {
  return Math.round(randomInRange(180, 620));
}

/**
 * Drive a per-character key dispatch loop with the supplied human delays.
 * The caller owns the actual key press so this stays transport-agnostic.
 */
export async function typeWithHumanPacing(params: {
  text: string;
  delays: number[];
  pressKey: (char: string, delayMs: number) => Promise<void>;
  throwIfAborted?: () => void;
}): Promise<void> {
  const chars = [...params.text];
  for (let index = 0; index < chars.length; index += 1) {
    params.throwIfAborted?.();
    const char = chars[index] ?? "";
    const delayMs = params.delays[index] ?? 0;
    await params.pressKey(char, delayMs);
  }
}
