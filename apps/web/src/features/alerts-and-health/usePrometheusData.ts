import { POLL_DEFAULTS } from "@deck/server";
import type { FreshnessStamp, ProviderEnvelope } from "@deck/server";
import { useEffect, useState } from "react";
import { isProviderPollable } from "../../shell/providers-index.js";

/**
 * Threshold-derived status for one rendered summary. Web-side mirror of the canonical server-side
 * declaration in `apps/server/src/providers/prometheus/index.ts` — kept structurally identical.
 * Mirrored (not imported from `@deck/server`) because this feature adds no engine-core barrel
 * export; the same pattern as `apps/web/src/features/portal/card-status.ts` with
 * `DockerResult`/`GatusResult`.
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

const INITIAL: PrometheusData = { data: null, freshness: null, error: null, loading: true };

/**
 * Poll `/api/providers/prometheus` on `intervalMs`. The cadence is a shell default
 * (`POLL_DEFAULTS.pollIntervalMs`, re-exported from `@deck/server`), never a per-provider field this
 * feature invents. Callers pass no argument in production; the parameter exists only so tests can
 * drive fake timers.
 */
export function usePrometheusData(
  intervalMs: number = POLL_DEFAULTS.pollIntervalMs,
): PrometheusData {
  const [state, setState] = useState<PrometheusData>(INITIAL);

  useEffect(() => {
    let live = true;

    async function poll(): Promise<void> {
      // Poll only when prometheus is registered; otherwise the null envelope
      // yields the same not-configured render without a console 404.
      const envelope = (await isProviderPollable("prometheus"))
        ? await getJson<ProviderEnvelope<PrometheusResult>>("/api/providers/prometheus")
        : null;
      if (!live) return;
      setState(
        envelope === null
          ? { data: null, freshness: null, error: null, loading: false }
          : {
              data: envelope.data,
              freshness: envelope.freshness,
              error: envelope.error,
              loading: false,
            },
      );
    }

    void poll();
    const timer = setInterval(() => void poll(), intervalMs);

    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [intervalMs]);

  return state;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch (error) {
    // Degrade to a not-configured state, but leave a breadcrumb for field debugging.
    console.warn(`[deck] request failed: ${url}`, error);
    return null;
  }
}
