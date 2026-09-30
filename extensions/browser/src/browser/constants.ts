export const DEFAULT_OPENCLAW_BROWSER_ENABLED = true;
export const DEFAULT_BROWSER_EVALUATE_ENABLED = true;
export const DEFAULT_OPENCLAW_BROWSER_COLOR = "#FF4500";
export const DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME = "openclaw";
export const DEFAULT_BROWSER_DEFAULT_PROFILE_NAME = "openclaw";
export const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 60_000;
export const DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS = 120_000;
export const DEFAULT_BROWSER_LOCAL_LAUNCH_TIMEOUT_MS = 15_000;
export const DEFAULT_BROWSER_LOCAL_CDP_READY_TIMEOUT_MS = 8_000;
export const DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS = 20_000;
export const DEFAULT_BROWSER_SNAPSHOT_TIMEOUT_MS = 20_000;
// FORK: fork-only `browser action=extract` budgets.
/** Default overall budget for page extraction and its one-shot model answer. */
export const DEFAULT_BROWSER_EXTRACT_TIMEOUT_MS = 60_000;
/** Minimum accepted extraction budget after clamping. */
export const MIN_BROWSER_EXTRACT_TIMEOUT_MS = 5_000;
/** Maximum accepted extraction budget after clamping. */
export const MAX_BROWSER_EXTRACT_TIMEOUT_MS = 120_000;
/** Default idle age before session tab cleanup can close tabs. */
export const DEFAULT_BROWSER_TAB_CLEANUP_IDLE_MINUTES = 120;
export const DEFAULT_BROWSER_TAB_CLEANUP_MAX_TABS_PER_SESSION = 8;
export const DEFAULT_BROWSER_TAB_CLEANUP_SWEEP_MINUTES = 5;
/**
 * Age after which a tracked tab whose browser stays unreachable is retired
 * instead of retried forever. Rows only reach this branch when cleanup already
 * failed to prove ownership, and a browser that returns after this long almost
 * always carries a fresh instance fingerprint, which retires the row anyway.
 */
export const BROWSER_TAB_UNREACHABLE_RETIRE_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_AI_SNAPSHOT_MAX_CHARS = 40_000;
export const DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS = 8_000;
export const DEFAULT_AI_SNAPSHOT_EFFICIENT_DEPTH = 6;
// FORK: fork-only `browser action=extract` size limits.
/**
 * Keep page extraction below a practical single-completion context budget while
 * leaving room for the instruction, question, reasoning, and concise answer.
 */
export const BROWSER_EXTRACT_MAX_CHARS = 80_000;
/** Reject unusually large serialized DOMs before transport and Markdown conversion. */
export const BROWSER_EXTRACT_MAX_HTML_CHARS = 2_000_000;
/** Visible line appended when page markdown is shortened to the extraction budget. */
export const BROWSER_EXTRACT_TRUNCATION_MARKER = "[PAGE CONTENT TRUNCATED]";
