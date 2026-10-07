/**
 * Opt-in Prometheus exposition endpoint for deck's own internals.
 *
 * `registerMetricsRoutes(app, deps)` adds `GET /metrics` — outside `/api/*` so it never
 * reaches the API notFound JSON branch — only when `deps.metricsEnabled` is true. The body
 * is hand-rendered Prometheus text format 0.0.4 from cached, no-I/O registry reads.
 */
import type { Hono } from "hono";

import type { ProviderPollMetrics } from "../providers/registry.js";
import type { AppDeps } from "../server/app.js";

/** Content type for the Prometheus text exposition format. */
export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4";

/** The runtime snapshot provider's fixed registry id. */
const SNAPSHOT_PROVIDER_ID = "snapshot";

export function registerMetricsRoutes(app: Hono, deps: AppDeps): void {
  if (deps.metricsEnabled !== true) return;
  app.get("/metrics", (context) => {
    const body = renderMetrics({
      providerCount: deps.providers.count(),
      polls: deps.providers.listMetrics?.() ?? [],
      snapshotAgeMs: deps.providers.read(SNAPSHOT_PROVIDER_ID)?.freshness.ageMs ?? null,
    });
    return context.text(body, 200, { "Content-Type": METRICS_CONTENT_TYPE });
  });
}

export interface MetricsInput {
  providerCount: number;
  polls: readonly ProviderPollMetrics[];
  /** Age of the cached snapshot read in ms; null when no snapshot provider or no read yet. */
  snapshotAgeMs: number | null;
}

/** Render the exposition text. Metrics without samples still emit their HELP/TYPE lines. */
export function renderMetrics(input: MetricsInput): string {
  const lines: string[] = [];
  const family = (name: string, type: "counter" | "gauge", help: string, samples: string[]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples);
  };
  const labels = (poll: ProviderPollMetrics) =>
    `{id="${escapeLabel(poll.id)}",kind="${escapeLabel(poll.kind)}"}`;

  family("deck_provider_count", "gauge", "Number of providers registered in deck.", [
    `deck_provider_count ${input.providerCount}`,
  ]);
  family(
    "deck_provider_poll_success_total",
    "counter",
    "Completed provider polls that fetched successfully.",
    input.polls.map((poll) => `deck_provider_poll_success_total${labels(poll)} ${poll.successTotal}`),
  );
  family(
    "deck_provider_poll_failure_total",
    "counter",
    "Completed provider polls that failed or timed out.",
    input.polls.map((poll) => `deck_provider_poll_failure_total${labels(poll)} ${poll.failureTotal}`),
  );
  family(
    "deck_provider_last_poll_latency_seconds",
    "gauge",
    "Duration of the latest completed provider poll in seconds.",
    input.polls
      .filter((poll) => poll.lastLatencyMs !== null)
      .map((poll) => `deck_provider_last_poll_latency_seconds${labels(poll)} ${seconds(poll.lastLatencyMs!)}`),
  );
  family(
    "deck_snapshot_age_seconds",
    "gauge",
    "Seconds since deck last successfully read the observed-reality snapshot.",
    input.snapshotAgeMs === null ? [] : [`deck_snapshot_age_seconds ${seconds(input.snapshotAgeMs)}`],
  );
  return `${lines.join("\n")}\n`;
}

function seconds(ms: number): string {
  return String(ms / 1000);
}

/** Escape a label value per the text format: backslash, double quote, and newline. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
