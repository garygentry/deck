import { primary } from "@deck/schema/fixtures";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { ProviderEnvelope } from "../src/contract/index.js";
import { resolveMetricsRuntime } from "../src/metrics/runtime.js";
import type { ProviderPollMetrics } from "../src/providers/registry.js";
import { createApp, type ProviderReader } from "../src/server/app.js";

const snapshotEnvelope: ProviderEnvelope = {
  id: "snapshot",
  kind: "snapshot",
  freshness: {
    state: "fresh",
    observedAt: "2026-09-02T00:00:00.000Z",
    ageMs: 12_500,
    ttlMs: 300_000,
  },
  data: {},
  error: null,
};

const polls: ProviderPollMetrics[] = [
  { id: "docker", kind: "docker", successTotal: 7, failureTotal: 2, lastLatencyMs: 42 },
  { id: "snapshot", kind: "snapshot", successTotal: 3, failureTotal: 0, lastLatencyMs: 1_500 },
  { id: "unpolled", kind: "gatus", successTotal: 0, failureTotal: 0, lastLatencyMs: null },
];

function harness(
  metricsEnabled: boolean | undefined,
  overrides: Partial<ProviderReader> = {},
  webDistDir?: string,
) {
  const providers: ProviderReader = {
    read: (id) => (id === snapshotEnvelope.id ? snapshotEnvelope : undefined),
    count: () => 3,
    listHealth: () => ({}),
    listProviders: () => [],
    listMetrics: () => polls,
    ...overrides,
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  return createApp({
    config: primary.merged,
    providers,
    logger,
    ...(metricsEnabled === undefined ? {} : { metricsEnabled }),
    ...(webDistDir === undefined ? {} : { webDistDir }),
  });
}

describe("GET /metrics", () => {
  it("serves a Prometheus exposition body when enabled", async () => {
    const response = await harness(true).request("/metrics");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4");
    for (const [name, type] of [
      ["deck_provider_count", "gauge"],
      ["deck_provider_poll_success_total", "counter"],
      ["deck_provider_poll_failure_total", "counter"],
      ["deck_provider_last_poll_latency_seconds", "gauge"],
      ["deck_snapshot_age_seconds", "gauge"],
    ]) {
      expect(body).toMatch(new RegExp(`^# HELP ${name} .+$`, "m"));
      expect(body).toContain(`# TYPE ${name} ${type}\n`);
    }
    expect(body).toContain("deck_provider_count 3\n");
    expect(body).toContain('deck_provider_poll_success_total{id="docker",kind="docker"} 7\n');
    expect(body).toContain('deck_provider_poll_failure_total{id="docker",kind="docker"} 2\n');
    expect(body).toContain('deck_provider_last_poll_latency_seconds{id="docker",kind="docker"} 0.042\n');
    expect(body).toContain('deck_provider_last_poll_latency_seconds{id="snapshot",kind="snapshot"} 1.5\n');
    expect(body).not.toContain('deck_provider_last_poll_latency_seconds{id="unpolled"');
    expect(body).toContain("deck_snapshot_age_seconds 12.5\n");
    expect(body.endsWith("\n")).toBe(true);
  });

  it("keeps HELP/TYPE lines but omits the snapshot sample without a snapshot provider", async () => {
    const response = await harness(true, { read: () => undefined, listMetrics: () => [] }).request("/metrics");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("# TYPE deck_snapshot_age_seconds gauge\n");
    expect(body).not.toMatch(/^deck_snapshot_age_seconds /m);
  });

  it("escapes label values", async () => {
    const response = await harness(true, {
      listMetrics: () => [{ id: 'a"b\\c', kind: "x", successTotal: 1, failureTotal: 0, lastLatencyMs: 1 }],
    }).request("/metrics");
    expect(await response.text()).toContain('deck_provider_poll_success_total{id="a\\"b\\\\c",kind="x"} 1\n');
  });

  it("matches the metrics route, not the SPA index rewrite, when a web dist is configured", async () => {
    const response = await harness(true, {}, "/nonexistent-web-dist").request("/metrics");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4");
  });

  it.each([undefined, false])("is not registered when the flag is %s", async (flag) => {
    const response = await harness(flag).request("/metrics");
    expect(response.status).toBe(404);
  });
});

describe("resolveMetricsRuntime", () => {
  it.each([
    [undefined, false],
    ["true", true],
    ["TRUE", true],
    ["1", true],
    ["false", false],
    ["yes", false],
  ])("DECK_METRICS_ENABLED=%s resolves enabled=%s", (raw, enabled) => {
    const env = raw === undefined ? {} : { DECK_METRICS_ENABLED: raw };
    expect(resolveMetricsRuntime(env)).toEqual({ enabled });
  });
});
