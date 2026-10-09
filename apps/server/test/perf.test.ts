import { primary } from "@deck/schema/fixtures";
import type { Logger } from "pino";
import { expect, it, vi } from "vitest";

import type { ProviderEnvelope } from "../src/contract/index.js";
import { createApp, type ProviderReader } from "../src/server/app.js";

const WARM_UP_REQUESTS = 20;
const SAMPLE_REQUESTS = 200;

const envelope: ProviderEnvelope<{ up: boolean }> = {
  id: "known",
  kind: "http-health",
  freshness: {
    state: "fresh",
    observedAt: "2026-09-02T00:00:00.000Z",
    ageMs: 0,
    ttlMs: 30_000,
  },
  data: { up: true },
  error: null,
};

it("holds p95 below 50 ms for warm config and provider reads", async () => {
  const providers: ProviderReader = {
    read: (id) => (id === envelope.id ? envelope : undefined),
    count: () => 1,
    listHealth: () => ({}),
    listProviders: () => [],
    setProjections: () => {},
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  const app = createApp({ config: primary.merged, providers, logger });

  for (let index = 0; index < WARM_UP_REQUESTS; index += 1) {
    await app.request("/api/config");
  }

  const samples: number[] = [];
  for (let index = 0; index < SAMPLE_REQUESTS; index += 1) {
    const startedAt = performance.now();
    const path = index % 2 === 0 ? "/api/config" : "/api/providers/known";
    const response = await app.request(path);
    samples.push(performance.now() - startedAt);
    expect(response.status).toBe(200);
  }

  samples.sort((left, right) => left - right);
  const p95 = samples[Math.floor(0.95 * samples.length)];
  expect(p95).toBeLessThan(50);
});
