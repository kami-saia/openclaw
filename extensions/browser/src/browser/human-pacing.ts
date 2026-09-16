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

/** A single point on a synthetic cursor path. */
export type CursorPoint = { x: number; y: number };

const MOUSE_MIN_STEPS = 12;
const MOUSE_MAX_STEPS = 34;
const MOUSE_STEP_DELAY_MIN_MS = 6;
const MOUSE_STEP_DELAY_MAX_MS = 18;
const MOUSE_OVERSHOOT_PROBABILITY = 0.35;

/**
 * Cubic Bezier through two randomised control points, so the cursor arcs
 * instead of teleporting or travelling in a perfectly straight line.
 * Real pointer traces are curved, variable-speed and frequently overshoot the
 * target before settling back onto it.
 */
export function humanCursorPath(from: CursorPoint, to: CursorPoint): CursorPoint[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1) {
    return [to];
  }
  // Perpendicular offset scaled to travel distance gives a natural-looking arc.
  const bow = Math.min(120, distance * randomInRange(0.08, 0.22));
  const sign = Math.random() < 0.5 ? -1 : 1;
  const nx = (-dy / distance) * bow * sign;
  const ny = (dx / distance) * bow * sign;
  const c1 = { x: from.x + dx * 0.3 + nx, y: from.y + dy * 0.3 + ny };
  const c2 = { x: from.x + dx * 0.7 + nx * 0.6, y: from.y + dy * 0.7 + ny * 0.6 };

  const steps = Math.max(
    MOUSE_MIN_STEPS,
    Math.min(MOUSE_MAX_STEPS, Math.round(distance / randomInRange(18, 42))),
  );
  const points: CursorPoint[] = [];
  for (let step = 1; step <= steps; step += 1) {
    const linear = step / steps;
    // Ease-in-out: humans accelerate away from rest and decelerate onto a target.
    const t = linear < 0.5 ? 2 * linear * linear : 1 - ((-2 * linear + 2) * (-2 * linear + 2)) / 2;
    const inv = 1 - t;
    const x =
      inv * inv * inv * from.x +
      3 * inv * inv * t * c1.x +
      3 * inv * t * t * c2.x +
      t * t * t * to.x;
    const y =
      inv * inv * inv * from.y +
      3 * inv * inv * t * c1.y +
      3 * inv * t * t * c2.y +
      t * t * t * to.y;
    points.push({ x: Math.round(x), y: Math.round(y) });
  }
  if (Math.random() < MOUSE_OVERSHOOT_PROBABILITY && distance > 60) {
    // Shoot slightly past the target, then correct back onto it.
    points.push({
      x: Math.round(to.x + (dx / distance) * randomInRange(3, 11)),
      y: Math.round(to.y + (dy / distance) * randomInRange(3, 11)),
    });
  }
  points.push({ x: Math.round(to.x), y: Math.round(to.y) });
  return points;
}

/** Per-step delay while traversing a cursor path. */
export function humanCursorStepDelayMs(): number {
  return Math.round(randomInRange(MOUSE_STEP_DELAY_MIN_MS, MOUSE_STEP_DELAY_MAX_MS));
}
