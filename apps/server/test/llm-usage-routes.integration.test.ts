/**
 * Integration tests for the LLM usage routes, driven through `app.request()`: the feature-off
 * response, viewer reads, the refresh route, ingest auth / size / JSON gates, the ingest route's
 * absence without a token, and the `/api/health` entry.
 */

import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeckConfig, HealthResponse } from "../src/contract/index.js";
import { LlmUsageCollector } from "../src/llm-usage/collector.js";
import type { LlmUsageResponse } from "../src/llm-usage/types.js";
import type { ResolvedLlmUsageConfig } from "../src/llm-usage/config.js";
import { createLlmUsageModule } from "../src/llm-usage/module.js";
import { bearerMatches, INGEST_MAX_BYTES } from "../src/llm-usage/routes.js";
import { createApp, type AppDeps } from "../src/server/app.js";
import { testHost } from "./util/modules.js";

const TOKEN = "ingest-secret-token";

const usageConfig: ResolvedLlmUsageConfig = {
  thresholds: { warn: 75, danger: 90 },
  idlePauseMs: 300_000,
  claude: { credentialsFile: "/c.json", transcriptsDir: null, statusLineCredentialEnv: "INGEST", activeMs: 120_000, idleMs: 300_000 },
  codex: null,
};
/** The `modules.llm-usage` section `usageConfig` resolves from. */
const usageSection = { claude: { credentialsFile: "/c.json", statusLine: { credentialEnv: "INGEST" } }, thresholds: { warn: 75, danger: 90 } };

const collectors: LlmUsageCollector[] = [];
afterEach(() => {
  while (collectors.length) collectors.pop()?.stop();
});

/**
 * The app with the llm-usage module started through the module host, as boot runs it. The
 * host starts asynchronously, so each request waits for the started app.
 */
function buildApp(llmUsage: "off" | "no-token" | "on") {
  const fetchOauth = vi.fn(async () => ({ ok: true as const, body: { limits: [{ kind: "session", percent: 12 }] }, plan: "pro" }));
  const module = createLlmUsageModule({
    createCollector: (_config, deps) => {
      const collector = new LlmUsageCollector(usageConfig, { ...deps, fetchOauth });
      collectors.push(collector);
      return collector;
    },
  });
  const { host } = testHost([module], {
    sectionOf: () => (llmUsage === "off" ? undefined : usageSection),
    env: llmUsage === "on" ? { INGEST: TOKEN } : {},
  });
  const base: AppDeps = {
    config: {} as DeckConfig,
    providers: { read: () => undefined, count: () => 0, listHealth: () => ({}), listProviders: () => [] },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    modules: host,
  };
  const started = host.start().then(() => createApp(base));
  const app = {
    request: async (...args: Parameters<ReturnType<typeof createApp>["request"]>) => (await started).request(...args),
  } as ReturnType<typeof createApp>;
  return { app, fetchOauth };
}

const ingest = (app: ReturnType<typeof createApp>, body: string, auth: string | null = `Bearer ${TOKEN}`) =>
  app.request("/api/llm-usage/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth === null ? {} : { authorization: auth }) },
    body,
  });

describe("LLM usage routes", () => {
  it("reports enabled:false and has no ingest route when llmUsage is not configured", async () => {
    const { app } = buildApp("off");
    const res = await app.request("/api/llm-usage");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, claude: null, codex: null });
    expect((await app.request("/api/llm-usage/refresh")).status).toBe(200);
    expect((await ingest(app, "{}")).status).toBe(404);
    expect(await (await app.request("/api/health")).json()).not.toHaveProperty("llmUsage");
  });

  it("serves the collector's response and refresh polls upstream", async () => {
    const { app, fetchOauth } = buildApp("on");
    const first = (await (await app.request("/api/llm-usage")).json()) as LlmUsageResponse;
    expect(first).toMatchObject({ enabled: true, thresholds: { warn: 75, danger: 90 } });

    const refreshed = (await (await app.request("/api/llm-usage/refresh")).json()) as LlmUsageResponse;
    expect(fetchOauth).toHaveBeenCalled();
    expect(refreshed.claude?.bars[0]).toMatchObject({ key: "session", percent: 12, src: "oauth" });
  });

  it("accepts an authorized statusLine push", async () => {
    const { app } = buildApp("on");
    const res = await ingest(app, JSON.stringify({ rate_limits: { five_hour: { used_percentage: 81, resets_at: 1_790_000_000 } } }));
    expect(res.status).toBe(204);
    const body = (await (await app.request("/api/llm-usage")).json()) as LlmUsageResponse;
    expect(body.claude?.bars[0]).toMatchObject({ key: "session", percent: 81, severity: "warn", src: "statusLine" });
  });

  it("rejects a missing or wrong bearer with 401 before reading the body", async () => {
    const { app } = buildApp("on");
    for (const auth of [null, "Bearer wrong", `Basic ${TOKEN}`, "Bearer ", TOKEN]) {
      const res = await ingest(app, "{}", auth);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain(TOKEN);
    }
    const oversized = await ingest(app, "x".repeat(INGEST_MAX_BYTES + 1), "Bearer nope");
    expect(oversized.status).toBe(401);
  });

  it("rejects oversized bodies with 413 and bad JSON with 400", async () => {
    const { app } = buildApp("on");
    expect((await ingest(app, `"${"x".repeat(INGEST_MAX_BYTES)}"`)).status).toBe(413);
    const bad = await ingest(app, "{not json");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "BAD_JSON" });
  });

  it("does not register ingest without a token, but still serves reads", async () => {
    const { app } = buildApp("no-token");
    expect((await ingest(app, "{}")).status).toBe(404);
    expect((await app.request("/api/llm-usage")).status).toBe(200);
  });

  it("adds an llmUsage entry to /api/health without degrading it", async () => {
    const { app } = buildApp("on");
    await app.request("/api/llm-usage");
    const health = (await (await app.request("/api/health")).json()) as HealthResponse;
    expect(health.status).toBe("ok");
    expect(health.llmUsage).toMatchObject({ mode: "idle", consecutiveErrors: 0 });
  });
});

describe("bearerMatches", () => {
  it("requires the exact Bearer token", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
    expect(bearerMatches("Bearer ", "")).toBe(false);
  });
});
