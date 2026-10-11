/**
 * The longest delay a JavaScript timer honours: `setTimeout` and `setInterval` treat anything
 * larger (or not a number) as 1 ms, so a poll interval of 3e9 would poll continuously.
 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The range of each provider timing field, in whole milliseconds. Every field is capped at
 * {@link MAX_TIMER_MS}. A poll interval is at least 1000 ms: a provider that polls faster than
 * once a second spends deck's shared poll loop (and the upstream) on data nobody can read that
 * fast, and every built-in source is content with seconds. A timeout, a freshness window and an
 * unreachable threshold need only be positive.
 */
export const TIMING_LIMITS = {
  pollIntervalMs: { min: 1_000, max: MAX_TIMER_MS },
  ttlMs: { min: 1, max: MAX_TIMER_MS },
  unreachableAfterMs: { min: 1, max: MAX_TIMER_MS },
  timeoutMs: { min: 1, max: MAX_TIMER_MS },
} as const;

/** A numeric provider timing field. */
export type TimingField = keyof typeof TIMING_LIMITS;

export const TIMING_FIELDS = Object.keys(TIMING_LIMITS) as readonly TimingField[];

/** Why `value` is not a usable `field` (an integer number of milliseconds in its range), or null. */
export function timingProblem(field: TimingField, value: unknown): string | null {
  const { min, max } = TIMING_LIMITS[field];
  if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) return null;
  return `${field} must be a whole number of milliseconds from ${min} to ${max}`;
}

/**
 * `value` as a usable `field`: a finite number is rounded and clamped into the field's range;
 * anything else (NaN, Infinity, not a number) is undefined.
 */
export function clampTiming(field: TimingField, value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const { min, max } = TIMING_LIMITS[field];
  return Math.min(max, Math.max(min, Math.round(value)));
}
