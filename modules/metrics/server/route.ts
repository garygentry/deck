/**
 * The Prometheus exposition deck serves at `/metrics` for its own internals: hand-rendered
 * text format 0.0.4 from cached, no-I/O registry reads.
 */
import type { ProviderStats } from "@deck/module-sdk";

/** Content type for the Prometheus text exposition format. */
export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4";

/** The exposition path, outside `/api` so it never reaches the API's JSON 404. */
export const METRICS_PATH = "/metrics";

/** The runtime snapshot provider's fixed registry id. */
const SNAPSHOT_PROVIDER_ID = "snapshot";

/** What one scrape reads: the registry's cached stats, the snapshot's content time, and now. */
export interface MetricsSources {
  stats: readonly ProviderStats[];
  /** The last successfully read snapshot's `generatedAt` in epoch ms; null when unknown. */
  snapshotGeneratedAtMs: number | null;
  nowMs: number;
}

/**
 * Answer one request to {@link METRICS_PATH}. Only `GET` (and so `HEAD`) is served; any other
 * method gets the same plain 404 a path deck does not serve gets.
 */
export function metricsResponse(request: Request, { stats, snapshotGeneratedAtMs, nowMs }: MetricsSources): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("404 Not Found", { status: 404, headers: { "content-type": "text/plain; charset=UTF-8" } });
  }
  const body = renderMetrics({
    providerCount: stats.length,
    polls: stats,
    snapshotAgeMs: stats.find((entry) => entry.id === SNAPSHOT_PROVIDER_ID)?.ageMs ?? null,
    snapshotGeneratedAtMs,
    nowMs,
  });
  return new Response(body, { status: 200, headers: { "content-type": METRICS_CONTENT_TYPE } });
}

/** A provider's poll counters, as the exposition labels and samples them. */
export type PollMetrics = Pick<ProviderStats, "id" | "kind" | "successTotal" | "failureTotal" | "lastLatencyMs">;

export interface MetricsInput {
  providerCount: number;
  polls: readonly PollMetrics[];
  /** Age of the cached snapshot read in ms; null when no snapshot provider or no read yet. */
  snapshotAgeMs: number | null;
  /** The last successfully read snapshot's `generatedAt` in epoch ms; null when unknown. */
  snapshotGeneratedAtMs: number | null;
  /** The scrape's time in epoch ms, the base of the content age. */
  nowMs: number;
}

/** Render the exposition text. Metrics without samples still emit their HELP/TYPE lines. */
export function renderMetrics(input: MetricsInput): string {
  const lines: string[] = [];
  const family = (name: string, type: "counter" | "gauge", help: string, samples: string[]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples);
  };
  const labels = (poll: PollMetrics) =>
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
  const generatedAtMs = input.snapshotGeneratedAtMs;
  family(
    "deck_snapshot_generated_age_seconds",
    "gauge",
    "Seconds since the last successfully read observed-reality snapshot was generated (its generatedAt), floored at 0.",
    // Floored like the read age: a producer clock ahead of deck's shows in the raw timestamp.
    generatedAtMs === null ? [] : [`deck_snapshot_generated_age_seconds ${seconds(Math.max(0, input.nowMs - generatedAtMs))}`],
  );
  family(
    "deck_snapshot_generated_timestamp_seconds",
    "gauge",
    "The generatedAt of the last successfully read observed-reality snapshot, as Unix seconds.",
    generatedAtMs === null ? [] : [`deck_snapshot_generated_timestamp_seconds ${seconds(generatedAtMs)}`],
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
