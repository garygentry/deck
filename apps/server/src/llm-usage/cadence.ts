import type { UsagePollMode } from "./types.js";

/**
 * Upstream poll cadence. The Claude OAuth endpoint 429s stickily (a 60s poller logged
 * 111 consecutive 429s over 18h) and Claude Code itself refreshes at most every 5 min,
 * so nothing here goes below {@link OAUTH_FLOOR_MS}. Sub-minute freshness comes from the
 * statusLine push, not from polling. Polling stops entirely with no recent viewer.
 */

export const OAUTH_FLOOR_MS = 120_000;
/** A session is "live" if a push or a value change happened this recently. */
export const ACTIVITY_WINDOW_MS = 120_000;
export const ERROR_BACKOFF_MAX_MS = 300_000;
/** Manual refresh debounce. */
export const FORCE_FLOOR_MS = 5_000;
/** A server-directed `Retry-After` longer than this is capped: it would stall the panel for good. */
export const RETRY_AFTER_MAX_MS = 3_600_000;

export interface CadenceState {
  now: number;
  activeMs: number;
  idleMs: number;
  idlePauseMs: number;
  /** Last statusLine push. */
  lastPushAt: number | null;
  /** Last time any polled value actually moved (or a Codex turn was detected). */
  lastChangeAt: number | null;
  /** Last API read by any viewer. */
  lastViewerAt: number | null;
  consecutiveErrors: number;
  /** Server-directed backoff; only a positive `Retry-After` is trusted. */
  retryAfterMs: number;
}

const within = (at: number | null, now: number, windowMs: number) => at !== null && now - at < windowMs;

export function isActive(state: CadenceState): boolean {
  return within(state.lastPushAt, state.now, ACTIVITY_WINDOW_MS)
    || within(state.lastChangeAt, state.now, ACTIVITY_WINDOW_MS);
}

export function pollMode(state: CadenceState): UsagePollMode {
  if (!within(state.lastViewerAt, state.now, state.idlePauseMs)) return "paused";
  if (state.consecutiveErrors > 0) return "backoff";
  return isActive(state) ? "active" : "idle";
}

/**
 * Delay until the next upstream poll, or null when paused. Error backoff doubles from
 * the floor to {@link ERROR_BACKOFF_MAX_MS}; a positive `Retry-After` wins when longer,
 * up to {@link RETRY_AFTER_MAX_MS}.
 */
export function nextDelay(state: CadenceState): number | null {
  const mode = pollMode(state);
  if (mode === "paused") return null;
  if (mode === "backoff") {
    const ours = Math.min(OAUTH_FLOOR_MS * 2 ** (state.consecutiveErrors - 1), ERROR_BACKOFF_MAX_MS);
    return Math.max(ours, Math.min(state.retryAfterMs, RETRY_AFTER_MAX_MS));
  }
  return Math.max(mode === "active" ? state.activeMs : state.idleMs, OAUTH_FLOOR_MS);
}
