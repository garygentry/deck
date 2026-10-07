/** Default provider timing in ms: the registry's fallback, and the web's poll cadence. */
export const POLL_DEFAULTS = {
  pollIntervalMs: 30_000,
  ttlMs: 30_000,
  unreachableAfterMs: 90_000,
  timeoutMs: 5_000,
} as const;
