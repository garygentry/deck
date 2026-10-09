import { POLL_DEFAULTS } from "@deck/contract";
import type { FreshnessStamp } from "@deck/contract";
import { useProvider } from "../../data/index.js";

/**
 * One active alert, normalized from Alertmanager v2. Web-side mirror of the canonical server-side
 * declaration in `apps/server/src/providers/alertmanager/index.ts` — kept structurally identical.
 * Mirrored (not barrel-imported) per the web-side-mirror decision; same pattern as
 * `modules/portal/web/card-status.ts`.
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

/**
 * Poll `/api/providers/alertmanager` on `intervalMs`. Identical shape and body to
 * `usePrometheusData`. Callers pass no argument in production; the parameter exists only so tests
 * can drive fake timers.
 */
export function useAlertmanagerData(
  intervalMs: number = POLL_DEFAULTS.pollIntervalMs,
): AlertmanagerData {
  // Shared with every other reader of this provider (the page and the header pill poll once).
  // An unlisted provider resolves to the same not-configured render without a console 404.
  const { envelope, loading } = useProvider<AlertmanagerResult>("alertmanager", { intervalMs });
  if (loading) return { data: null, freshness: null, error: null, loading: true };
  return envelope === null
    ? { data: null, freshness: null, error: null, loading: false }
    : { data: envelope.data, freshness: envelope.freshness, error: envelope.error, loading: false };
}
