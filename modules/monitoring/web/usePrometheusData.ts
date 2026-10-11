import { POLL_DEFAULTS } from "@deck/contract";
import type { FreshnessStamp } from "@deck/contract";
import { useProvider } from "@/data/index.js";

/**
 * Threshold-derived status for one rendered summary. Web-side mirror of the canonical server-side
 * declaration in `modules/prometheus/server/index.ts` — kept structurally identical.
 * Mirrored (not barrel-imported) per the web-side-mirror decision; same pattern as
 * `modules/portal/web/card-status.ts`.
 */
export type SummaryStatus = "ok" | "warning" | "critical" | "neutral" | "error";

/** One rendered summary: a labeled scalar with unit and threshold-derived status (web-side mirror). */
export interface SummaryValue {
  /** Echoes the declaring summary's id. */
  id: string;
  /** Echoes the declaring summary's label. */
  label: string;
  /** Echoes the declaring summary's unit, when declared. */
  unit?: string;
  /** Numeric scalar when the query returned a single value; `null` on no-data/shape error. */
  value: number | null;
  /** Threshold-derived status; `error` when `value` is `null`. */
  status: SummaryStatus;
}

/** The prometheus provider's payload — one entry per declared summary (web-side mirror). */
export interface PrometheusResult {
  /** One entry per declared summary, in declaration order. */
  summaries: SummaryValue[];
}

/**
 * Flattened view of the prometheus provider envelope for the SPA. `data`/`freshness`/`error` mirror
 * the envelope fields; when the endpoint returns 404/absent (provider never registered) all three are
 * `null` and `loading` is `false` — the "not configured" signal.
 */
export interface PrometheusData {
  /** Last successful payload, or `null` on not-configured / never-yet-fetched. */
  data: PrometheusResult | null;
  /** Freshness stamp from the envelope, or `null` when no envelope exists (not configured). */
  freshness: FreshnessStamp | null;
  /** Server-reported error, or `null`. Never carries a client-side transport string. */
  error: { message: string } | null;
  /** True until the first poll resolves; drives the initial pending render. */
  loading: boolean;
}

/**
 * Poll `/api/providers/prometheus` on `intervalMs`. The cadence is a shell default
 * (`POLL_DEFAULTS.pollIntervalMs`, from `@deck/contract`), never a per-provider field this
 * feature invents. Callers pass no argument in production; the parameter exists only so tests can
 * drive fake timers.
 */
export function usePrometheusData(
  intervalMs: number = POLL_DEFAULTS.pollIntervalMs,
): PrometheusData {
  // Shared with every other reader of this provider (the page and the header pill poll once).
  // An unlisted provider resolves to the same not-configured render without a console 404.
  const { envelope, loading } = useProvider<PrometheusResult>("prometheus", { intervalMs });
  if (loading) return { data: null, freshness: null, error: null, loading: true };
  return envelope === null
    ? { data: null, freshness: null, error: null, loading: false }
    : { data: envelope.data, freshness: envelope.freshness, error: envelope.error, loading: false };
}
