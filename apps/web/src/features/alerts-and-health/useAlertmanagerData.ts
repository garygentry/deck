import { POLL_DEFAULTS } from "@deck/server";
import type { FreshnessStamp, ProviderEnvelope } from "@deck/server";
import { useEffect, useState } from "react";
import { isProviderPollable } from "../../shell/providers-index.js";

/**
 * One active alert, normalized from Alertmanager v2. Web-side mirror of the canonical server-side
 * declaration in `apps/server/src/providers/alertmanager/index.ts` — kept structurally identical.
 * Mirrored (not barrel-imported) per the web-side-mirror decision; same pattern as
 * `apps/web/src/features/portal/card-status.ts`.
 */
export interface ActiveAlert {
  /** Stable Alertmanager fingerprint — the dedup/list key. */
  fingerprint: string;
  /** Display name (`labels.alertname`, or a summary annotation when absent). */
  name: string;
  /** The alert's own `severity` label value; `""` when absent → grouped under "Other". */
  severity: string;
  /** ISO-8601 start time. */
  startsAt: string;
  /** True when suppressed by an active silence — kept, not hidden, so the UI can dim it. */
  suppressed: boolean;
  /** Deep link to the source (`generatorURL`) or `null` → display-only. */
  sourceUrl: string | null;
}

/** One active silence, presented read-only (web-side mirror). */
export interface ActiveSilence {
  /** Alertmanager silence id. */
  id: string;
  /** ISO-8601 end time. */
  endsAt: string;
  /** Human-readable matcher summary for read-only display (no edit affordance). */
  matchers: string;
}

/** The alertmanager provider's payload (web-side mirror). */
export interface AlertmanagerResult {
  /** All active alerts (firing and suppressed), so the UI can distinguish them. */
  alerts: ActiveAlert[];
  /** All active silences, read-only. */
  silences: ActiveSilence[];
  /** Count of firing, non-suppressed alerts — drives the header alert segment. */
  firingCount: number;
}

/** Flattened alertmanager envelope view — see `PrometheusData` for the field contract. */
export interface AlertmanagerData {
  data: AlertmanagerResult | null;
  freshness: FreshnessStamp | null;
  error: { message: string } | null;
  loading: boolean;
}

const INITIAL: AlertmanagerData = { data: null, freshness: null, error: null, loading: true };

/**
 * Poll `/api/providers/alertmanager` on `intervalMs`. Identical shape and body to
 * `usePrometheusData`. Callers pass no argument in production; the parameter exists only so tests
 * can drive fake timers.
 */
export function useAlertmanagerData(
  intervalMs: number = POLL_DEFAULTS.pollIntervalMs,
): AlertmanagerData {
  const [state, setState] = useState<AlertmanagerData>(INITIAL);

  useEffect(() => {
    let live = true;

    async function poll(): Promise<void> {
      // Poll only when alertmanager is registered; otherwise the null envelope
      // yields the same not-configured render without a console 404.
      const envelope = (await isProviderPollable("alertmanager"))
        ? await getJson<ProviderEnvelope<AlertmanagerResult>>("/api/providers/alertmanager")
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
