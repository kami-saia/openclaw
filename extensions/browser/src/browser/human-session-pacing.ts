/**
 * Session-level behavioural pacing for browser navigation.
 *
 * `human-pacing.ts` covers *intra-action* timing: keystrokes, cursor paths,
 * click settle. That makes a single action look human but says nothing about
 * the shape of a whole session. A run of navigations issued back-to-back with
 * no read time is a behavioural tell that per-action pacing cannot hide:
 * real users load a page, read it for seconds, scroll, and only then move on.
 *
 * This module models the gap *between* page loads:
 *   - dwell time that scales with how much content the last page had,
 *   - a log-normal base gap with a long right tail (occasional long pauses),
 *   - an occasional much longer "distraction" pause,
 *   - credit for time the caller already spent, so we only pad when the
 *     session is running faster than a human would.
 */

const DWELL_MS_PER_CHAR = 3.6;
const DWELL_MIN_MS = 700;
const DWELL_MAX_MS = 22_000;
const BASE_GAP_LOG_MEAN = Math.log(1500);
const BASE_GAP_LOG_SIGMA = 0.62;
const BASE_GAP_MIN_MS = 350;
const BASE_GAP_MAX_MS = 12_000;
const DISTRACTION_PROBABILITY = 0.07;
const DISTRACTION_MIN_MS = 9_000;
const DISTRACTION_MAX_MS = 41_000;
const SCROLL_PROBABILITY = 0.72;
const SCROLL_MIN_BURSTS = 1;
const SCROLL_MAX_BURSTS = 5;
const SCROLL_DELTA_MIN = 90;
const SCROLL_DELTA_MAX = 420;
const SCROLL_PAUSE_MIN_MS = 180;
const SCROLL_PAUSE_MAX_MS = 1400;

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Box-Muller standard normal sample. */
function standardNormal(): number {
  let u = 0;
  let v = 0;
  while (u === 0) {
    u = Math.random();
  }
  while (v === 0) {
    v = Math.random();
  }
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Log-normal base gap. Human inter-page intervals are not symmetric: the bulk
 * sits near a short median with a long right tail, which is exactly what a
 * log-normal produces and what a uniform/fixed delay never does.
 */
export function humanNavigationGapMs(): number {
  const sample = Math.exp(BASE_GAP_LOG_MEAN + BASE_GAP_LOG_SIGMA * standardNormal());
  const clamped = Math.min(BASE_GAP_MAX_MS, Math.max(BASE_GAP_MIN_MS, sample));
  if (Math.random() < DISTRACTION_PROBABILITY) {
    return Math.round(clamped + randomInRange(DISTRACTION_MIN_MS, DISTRACTION_MAX_MS));
  }
  return Math.round(clamped);
}

/**
 * Reading dwell for a page, scaled by visible content size.
 * A dense article should hold attention longer than a redirect stub.
 */
export function humanDwellMs(contentLength: number): number {
  const safeLength = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
  const base = safeLength * DWELL_MS_PER_CHAR * randomInRange(0.55, 1.45);
  return Math.round(Math.min(DWELL_MAX_MS, Math.max(DWELL_MIN_MS, base)));
}

/** Total time a human would plausibly spend before the next page load. */
export function humanInterPageDelayMs(contentLength: number): number {
  return humanDwellMs(contentLength) + humanNavigationGapMs();
}

/** A single scroll burst: wheel delta plus the pause that follows it. */
export type ScrollBurst = { deltaY: number; pauseMs: number };

/**
 * Idle scrolling while "reading". Bursts vary in size and direction, with an
 * occasional scroll back up, because humans overshoot and re-read.
 */
export function humanScrollBursts(): ScrollBurst[] {
  if (Math.random() >= SCROLL_PROBABILITY) {
    return [];
  }
  const count = Math.round(randomInRange(SCROLL_MIN_BURSTS, SCROLL_MAX_BURSTS));
  const bursts: ScrollBurst[] = [];
  for (let index = 0; index < count; index += 1) {
    const magnitude = Math.round(randomInRange(SCROLL_DELTA_MIN, SCROLL_DELTA_MAX));
    const backtrack = index > 0 && Math.random() < 0.18;
    bursts.push({
      deltaY: backtrack ? -Math.round(magnitude * randomInRange(0.3, 0.7)) : magnitude,
      pauseMs: Math.round(randomInRange(SCROLL_PAUSE_MIN_MS, SCROLL_PAUSE_MAX_MS)),
    });
  }
  return bursts;
}

/** Disabled explicitly, or when an operator opts out for a deterministic run. */
export function isSessionPacingEnabled(): boolean {
  const raw = process.env.OPENCLAW_BROWSER_SESSION_PACING?.trim().toLowerCase();
  return raw !== "off" && raw !== "0" && raw !== "false";
}

/**
 * Remaining wait after crediting elapsed wall time.
 *
 * The agent's own reasoning between tool calls is real elapsed time that a
 * detector sees as think time, so it counts toward the human budget. Only the
 * shortfall is padded; a slow caller waits nothing extra.
 */
export function remainingPacingWaitMs(params: {
  targetDelayMs: number;
  elapsedMs: number;
}): number {
  const shortfall = params.targetDelayMs - params.elapsedMs;
  return shortfall > 0 ? Math.round(shortfall) : 0;
}

/** What the previous navigation left behind, used to size the next pause. */
type PacingState = { lastNavigationAtMs: number; lastContentLength: number };

const pacingStateByPage = new WeakMap<object, PacingState>();

/** Minimal surface we need from a Playwright page, kept structural for testability. */
export type PacingPage = {
  evaluate: <T>(fn: string) => Promise<T>;
  mouse: { wheel: (deltaX: number, deltaY: number) => Promise<void> };
};

/**
 * Pause and idle-scroll before leaving the current page.
 *
 * Called immediately before a navigation, so the wait lands between page
 * loads exactly where a reader's dwell time would sit. Time the caller
 * already burned since the last navigation is credited, so this only pads a
 * session that is moving faster than a human would.
 */
export async function applySessionPacingBeforeNavigation(params: {
  page: PacingPage;
  signal?: AbortSignal;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<number> {
  if (!isSessionPacingEnabled()) {
    return 0;
  }
  const state = pacingStateByPage.get(params.page as object);
  if (!state) {
    // First navigation on this page: nothing was read yet, so nothing to pace.
    return 0;
  }
  const targetDelayMs = humanInterPageDelayMs(state.lastContentLength);
  const elapsedMs = Date.now() - state.lastNavigationAtMs;
  const waitMs = remainingPacingWaitMs({ targetDelayMs, elapsedMs });
  if (waitMs <= 0) {
    return 0;
  }
  let remaining = waitMs;
  for (const burst of humanScrollBursts()) {
    if (remaining <= burst.pauseMs) {
      break;
    }
    await params.page.mouse.wheel(0, burst.deltaY).catch(() => {});
    await params.sleep(burst.pauseMs, params.signal);
    remaining -= burst.pauseMs;
  }
  if (remaining > 0) {
    await params.sleep(remaining, params.signal);
  }
  return waitMs;
}

/** Record the landed page so the next navigation can size its dwell. */
export async function recordNavigationForPacing(page: PacingPage): Promise<void> {
  if (!isSessionPacingEnabled()) {
    return;
  }
  const contentLength = await page
    .evaluate<number>("document.body ? document.body.innerText.length : 0")
    .catch(() => 0);
  pacingStateByPage.set(page as object, {
    lastNavigationAtMs: Date.now(),
    lastContentLength: typeof contentLength === "number" ? contentLength : 0,
  });
}
