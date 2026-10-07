/**
 * Metrics-capability runtime resolution from deck-deployment environment variables.
 *
 * DECK_METRICS_ENABLED is a deck setting, NOT estate config. Off by default: an
 * existing deployment exposes no /metrics route until an operator opts in.
 */
import { parseBool } from "../actions/runtime.js";

export interface MetricsRuntime {
  /** When false, GET /metrics is not registered (deck's 404). */
  enabled: boolean;
}

/** Environment variable names for the metrics capability. */
export const METRICS_ENV = {
  /** Master capability switch. */
  ENABLED: "DECK_METRICS_ENABLED",
} as const;

/** Default for DECK_METRICS_ENABLED: false. */
export const DEFAULT_METRICS_ENABLED = false;

/** Resolve the metrics-capability settings once from the environment. Never throws. */
export function resolveMetricsRuntime(env: NodeJS.ProcessEnv = process.env): MetricsRuntime {
  return { enabled: parseBool(env[METRICS_ENV.ENABLED], DEFAULT_METRICS_ENABLED) };
}
