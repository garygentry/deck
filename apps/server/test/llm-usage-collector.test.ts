import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OauthResult } from "../../../modules/llm-usage/server/claude/oauth.js";
import type { TranscriptScan } from "../../../modules/llm-usage/server/claude/transcripts.js";
import { AppServerRpcError, AppServerSpawnError, AUTH_REQUIRED_CODE } from "../../../modules/llm-usage/server/codex/app-server.js";
import type { RolloutResult } from "../../../modules/llm-usage/server/codex/rollout.js";
import { LlmUsageCollector, type AppServerClient, type CollectorDeps } from "../../../modules/llm-usage/server/collector.js";
import type { ResolvedLlmUsageConfig } from "../../../modules/llm-usage/server/config.js";
import { standaloneSchedule } from "./util/standalone-scheduler.js";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const MIN = 60_000;

const config = (overrides: Partial<ResolvedLlmUsageConfig> = {}): ResolvedLlmUsageConfig => ({
  thresholds: { warn: 75, danger: 90 },
  idlePauseMs: 5 * MIN,
  claude: {
    credentialsFile: "/secrets/creds.json",
    transcriptsDir: null,
    statusLineCredentialEnv: "INGEST",
    activeMs: 2 * MIN,
    idleMs: 5 * MIN,
  },
  codex: null,
  ...overrides,
});

const oauthBody = (percent: number) => ({
  limits: [
    { kind: "session", group: "session", percent, resets_at: "2026-09-24T15:00:00Z" },
    { kind: "weekly_scoped", group: "weekly", percent: 10, scope: { model: { display_name: "Opus" } } },
  ],
});

function harness(cfg = config(), extra: Partial<CollectorDeps> = {}) {
  const fetchOauth = vi.fn(async (): Promise<OauthResult> => ({ ok: true, body: oauthBody(40), plan: "max" }));
  const watcher = { start: vi.fn(), stop: vi.fn() };
  const collector = new LlmUsageCollector(cfg, {
    schedule: standaloneSchedule,
    fetchOauth,
    createWatcher: () => watcher,
    readRollout: async () => ({ status: "no-data-yet", detail: "no rollout files yet" }),
    ...extra,
  });
  return { collector, fetchOauth, watcher };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("LlmUsageCollector cadence", () => {
  it("keeps the due time a forced refresh fixed when an earlier-armed run arrives after the activity window", async () => {
    // Pre-module sequence (review C1): OAuth at 0s, 130s (refresh) and 430s (130s + active interval).
    const cfg = config({ idlePauseMs: 2000_000, claude: { ...config().claude!, activeMs: 300_000, idleMs: 600_000 } });
    const calls: number[] = [];
    let percent = 40;
    const { collector, fetchOauth } = harness(cfg);
    fetchOauth.mockImplementation(async () => {
      calls.push(Date.now() - NOW);
      return { ok: true, body: oauthBody(percent), plan: "max" };
    });
    await collector.read();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100_000);
    collector.ingestStatusline({}); // active: the next poll moves to 300s
    await vi.advanceTimersByTimeAsync(30_000);
    percent = 55; // the refresh sees usage move, so the session stays active from 130s
    await collector.refresh();
    await vi.advanceTimersByTimeAsync(500_000 - 130_000);
    expect(calls).toEqual([0, 130_000, 430_000]);
    collector.stop();
  });

  it("does not poll until a viewer reads, then polls immediately", async () => {
    const { collector, fetchOauth } = harness();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(fetchOauth).not.toHaveBeenCalled();

    const first = await collector.read();
    expect(first.poll.mode).toBe("idle");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchOauth).toHaveBeenCalledTimes(1);
    const after = await collector.read();
    expect(after.claude?.bars.map((b) => [b.key, b.percent, b.src])).toEqual([
      ["session", 40, "oauth"],
      ["model:Opus", 10, "oauth"],
    ]);
    expect(after.claude?.plan).toBe("max");
    collector.stop();
  });

  it("polls at the idle interval while viewed and pauses without a viewer", async () => {
    const { collector, fetchOauth } = harness();
    await collector.read();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5 * MIN - 1);
    expect(fetchOauth).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    // The idle timer lands exactly at the presence horizon, so it stands down.
    expect(fetchOauth).toHaveBeenCalledTimes(1);
    expect(collector.health().mode).toBe("paused");

    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(fetchOauth).toHaveBeenCalledTimes(1);
    await collector.read(); // a returning viewer wakes it; the last poll is long past
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchOauth).toHaveBeenCalledTimes(2);
    collector.stop();
  });

  it("a statusLine push switches to the active interval without breaching the floor", async () => {
    const { collector, fetchOauth } = harness();
    await collector.read();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    collector.ingestStatusline({ rate_limits: { five_hour: { used_percentage: 55, resets_at: 1_790_000_000 } } });
    expect(collector.health().mode).toBe("active");
    await vi.advanceTimersByTimeAsync(2 * MIN - 30_000 - 1);
    expect(fetchOauth).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchOauth).toHaveBeenCalledTimes(2);

    const response = await collector.read();
    const session = response.claude?.bars.find((b) => b.key === "session");
    expect(session).toMatchObject({ percent: 55, src: "statusLine" });
    expect(response.claude?.bars.find((b) => b.key === "model:Opus")?.src).toBe("oauth");
    collector.stop();
  });

  it("backs off on errors, honouring a longer Retry-After, and keeps the last bars as stale", async () => {
    const { collector, fetchOauth } = harness();
    await collector.read();
    await vi.advanceTimersByTimeAsync(0);
    fetchOauth.mockResolvedValue({ ok: false, kind: "error", detail: "HTTP 429", retryAfterMs: 4 * MIN });

    collector.ingestStatusline({}); // keep it active so the next poll is at the floor
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(fetchOauth).toHaveBeenCalledTimes(2);
    const response = await collector.read();
    expect(response.poll).toMatchObject({ mode: "backoff", consecutiveErrors: 1 });
    expect(response.claude?.sources.find((s) => s.id === "claude.oauth")).toMatchObject({ state: "stale", detail: "HTTP 429" });
    expect(response.claude?.bars.find((b) => b.key === "session")?.percent).toBe(40);

    await vi.advanceTimersByTimeAsync(4 * MIN - 1);
    expect(fetchOauth).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchOauth).toHaveBeenCalledTimes(3);
    collector.stop();
  });

  it("refresh re-reads Codex every 5s but never calls OAuth within the 2-minute floor", async () => {
    const app = { call: vi.fn(async (_method: string) => ({})), close: vi.fn() };
    const { collector, fetchOauth } = harness(
      config({ codex: { codexHome: "/h", command: "codex", rolloutDir: "/h/sessions" } }),
      { createAppServer: () => app },
    );
    await collector.refresh();
    expect(fetchOauth).toHaveBeenCalledTimes(1);
    const codexCalls = () => app.call.mock.calls.filter(([m]) => m === "account/rateLimits/read").length;
    expect(codexCalls()).toBe(1);

    await collector.refresh(); // debounced
    expect(codexCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await collector.refresh(); // Codex again, OAuth still inside its floor
    expect(codexCalls()).toBe(2);
    expect(fetchOauth).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(fetchOauth).toHaveBeenCalledTimes(1); // idle: the next scheduled poll is at +5m
    await collector.refresh();
    expect(fetchOauth).toHaveBeenCalledTimes(2);
    collector.stop();
  });

  it("a refresh during backoff neither calls OAuth nor delays its recovery", async () => {
    const { collector, fetchOauth } = harness();
    fetchOauth.mockResolvedValue({ ok: false, kind: "error", detail: "HTTP 429", retryAfterMs: 0 });
    await collector.read();
    await vi.advanceTimersByTimeAsync(0);
    expect(collector.health().consecutiveErrors).toBe(1);

    await vi.advanceTimersByTimeAsync(MIN);
    await collector.refresh();
    await vi.advanceTimersByTimeAsync(MIN - 1);
    await collector.refresh();
    expect(fetchOauth).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // the backoff poll lands at +2m regardless
    expect(fetchOauth).toHaveBeenCalledTimes(2);
    expect(collector.health().consecutiveErrors).toBe(2);
    collector.stop();
  });

  it("caps a huge Retry-After instead of overflowing the timer", async () => {
    const { collector, fetchOauth } = harness();
    fetchOauth.mockResolvedValue({ ok: false, kind: "error", detail: "HTTP 429", retryAfterMs: 30 * 24 * 60 * MIN });
    await collector.read();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i += 1) {
      await collector.read();
      await vi.advanceTimersByTimeAsync(MIN);
    }
    expect(fetchOauth).toHaveBeenCalledTimes(1); // capped at 1h, not a tight loop
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 55; i += 1) {
      await collector.read();
      await vi.advanceTimersByTimeAsync(MIN);
    }
    expect(fetchOauth).toHaveBeenCalledTimes(2);
    collector.stop();
  });

  it("treats a thrown poll as a failure and backs off instead of looping", async () => {
    const { collector, fetchOauth } = harness();
    fetchOauth.mockRejectedValue(new Error("boom"));
    await collector.read();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchOauth).toHaveBeenCalledTimes(1);
    expect(collector.health()).toMatchObject({ mode: "backoff", consecutiveErrors: 1 });
    collector.stop();
  });
});

describe("LlmUsageCollector source states", () => {
  it("reports unconfigured Claude sources and a not-applicable push", async () => {
    const { collector, fetchOauth } = harness(config({
      claude: { credentialsFile: null, transcriptsDir: null, statusLineCredentialEnv: null, activeMs: 2 * MIN, idleMs: 5 * MIN },
    }));
    const response = await collector.read();
    expect(response.claude?.sources.map((s) => [s.id, s.state])).toEqual([
      ["claude.statusLine", "not-configured"],
      ["claude.oauth", "not-configured"],
      ["claude.transcripts", "not-configured"],
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchOauth).not.toHaveBeenCalled();
    expect(response.codex).toBeNull();
    collector.stop();

    const { collector: other } = harness();
    other.ingestStatusline({ rate_limits_available: false });
    expect((await other.read()).claude?.sources[0]).toMatchObject({ state: "not-applicable" });
    await vi.advanceTimersByTimeAsync(STALE_PUSH_MS);
    other.ingestStatusline({ rate_limits: { five_hour: { utilization: 5 } } });
    await vi.advanceTimersByTimeAsync(STALE_PUSH_MS);
    expect((await other.read()).claude?.sources[0]).toMatchObject({ state: "stale", detail: "no recent push" });
    other.stop();
  });

  it("reports a credential lost after a success as stale, since its bars stay on screen", async () => {
    const { collector, fetchOauth } = harness();
    await collector.refresh();
    fetchOauth.mockResolvedValue({ ok: false, kind: "not-configured", detail: "credentials file unreadable (ENOENT)", retryAfterMs: 0 });
    await vi.advanceTimersByTimeAsync(2 * MIN);
    await collector.refresh();
    const response = await collector.read();
    expect(response.claude?.sources[1]).toMatchObject({ state: "stale", detail: expect.stringContaining("ENOENT") });
    expect(response.claude?.bars.length).toBeGreaterThan(0);
    collector.stop();
  });

  it("maps a credential gap from OAuth to not-configured without backing off", async () => {
    const { collector, fetchOauth } = harness();
    fetchOauth.mockResolvedValue({ ok: false, kind: "not-configured", detail: "sign-in needed", retryAfterMs: 0 });
    await collector.refresh();
    const response = await collector.read();
    expect(response.claude?.sources[1]).toMatchObject({ id: "claude.oauth", state: "not-configured", detail: "sign-in needed" });
    expect(response.poll.consecutiveErrors).toBe(0);
    collector.stop();
  });

  it("includes transcript totals without waiting on a scan", async () => {
    const withDir = config({
      claude: { credentialsFile: null, transcriptsDir: "/t", statusLineCredentialEnv: null, activeMs: 2 * MIN, idleMs: 5 * MIN },
    });
    const totals = { window5h: blank(), window7d: blank(), byModel: {}, files: 3 };
    let scan: TranscriptScan | null = null;
    const transcripts = { latest: () => scan, refresh: async () => scan! };
    const { collector } = harness(withDir, { transcripts });

    expect((await collector.read()).claude?.sources[2]).toMatchObject({ state: "no-data-yet", detail: "first scan in progress" });
    scan = { ok: true, totals, scannedAt: NOW };
    const response = await collector.read();
    expect(response.claude?.transcripts?.files).toBe(3);
    expect(response.claude?.sources[2]).toMatchObject({ id: "claude.transcripts", state: "available" });
    scan = { ok: false, detail: "transcripts dir unreadable (ENOENT)", scannedAt: NOW };
    expect((await collector.read()).claude?.sources[2]).toMatchObject({ state: "error", detail: expect.stringContaining("ENOENT") });
    collector.stop();
  });
});

const STALE_PUSH_MS = 5 * MIN;
const blank = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, messages: 0 });

describe("LlmUsageCollector codex", () => {
  const codexConfig = config({
    claude: null,
    codex: { codexHome: "/data/codex", command: "codex", rolloutDir: "/data/codex/sessions" },
  });

  const limits = (percent: number) => ({
    rateLimits: { limitId: "codex", planType: "plus", primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: 1_790_000_000 } },
    rateLimitsByLimitId: {
      codex: { limitId: "codex", planType: "plus", primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: 1_790_000_000 } },
      "gpt-5-codex": { limitId: "gpt-5-codex", limitName: "GPT-5-Codex", secondary: { usedPercent: 3, windowDurationMins: 10080 } },
    },
    rateLimitResetCredits: { availableCount: 2 },
  });

  function fakeAppServer(respond: (method: string) => unknown) {
    let notify: (method: string) => void = () => {};
    const client = {
      call: vi.fn(async (method: string) => respond(method)),
      close: vi.fn(),
    } satisfies AppServerClient;
    const createAppServer = (onNotify: (method: string) => void) => {
      notify = onNotify;
      return client;
    };
    return { client, createAppServer, push: (method: string) => notify(method) };
  }

  it("does not restart the rollout watcher when a poll settles after stop() (review N2)", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const app = fakeAppServer(async () => {
      await pending; // the Codex call outlives the module's drain
      return limits(20);
    });
    const { collector, watcher } = harness(codexConfig, { createAppServer: app.createAppServer });
    await collector.read(); // a viewer: the first scheduled poll starts and hangs
    await vi.advanceTimersByTimeAsync(0);
    expect(app.client.call).toHaveBeenCalled();

    collector.stop();
    const startsAtStop = watcher.start.mock.calls.length;
    release();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(watcher.start.mock.calls.length).toBe(startsAtStop);
    expect(watcher.stop).toHaveBeenCalled();
  });

  it("serves app-server bars, plan, credits and history", async () => {
    const app = fakeAppServer((method) => method === "account/rateLimits/read"
      ? limits(20)
      : { summary: { lifetimeTokens: 1000 }, dailyUsageBuckets: [{ startDate: "2026-09-23", tokens: 50 }] });
    const { collector, watcher } = harness(codexConfig, { createAppServer: app.createAppServer });
    await collector.refresh();
    expect(watcher.start).toHaveBeenCalled();
    const codex = (await collector.read()).codex!;
    expect(codex.bars.map((b) => [b.key, b.percent, b.src])).toEqual([
      ["codex:primary", 20, "app-server"],
      ["gpt-5-codex:secondary", 3, "app-server"],
    ]);
    expect(codex).toMatchObject({ plan: "plus", resetCredits: 2, history: { lifetimeTokens: 1000, days: [{ date: "2026-09-23", tokens: 50 }] } });
    expect(codex.sources.map((s) => [s.id, s.state])).toEqual([
      ["codex.appServer", "available"],
      ["codex.rollout", "no-data-yet"],
      ["codex.history", "available"],
    ]);
    collector.stop();
    expect(app.client.close).toHaveBeenCalled();
    expect(watcher.stop).toHaveBeenCalled();
  });

  it("lets a newer rollout snapshot override the same bar", async () => {
    const app = fakeAppServer(() => limits(20));
    const rollout: RolloutResult = {
      status: "ok",
      file: { path: "/x/rollout-a.jsonl", mtimeMs: NOW + MIN },
      reading: { at: NOW + MIN, snapshot: { limitId: "codex", primary: { usedPercent: 35, windowDurationMins: 300, resetsAt: 1_790_000_000 } } },
    };
    const { collector } = harness(codexConfig, { createAppServer: app.createAppServer, readRollout: async () => rollout });
    await collector.refresh();
    const codex = (await collector.read()).codex!;
    expect(codex.bars.find((b) => b.key === "codex:primary")).toMatchObject({ percent: 35, src: "rollout" });
    expect(codex.bars.find((b) => b.key === "gpt-5-codex:secondary")?.src).toBe("app-server");
    collector.stop();
  });

  it("maps a missing codex binary to not-configured with the fix", async () => {
    const app = fakeAppServer(() => {
      throw new AppServerSpawnError("codex", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    });
    const { collector } = harness(codexConfig, { createAppServer: app.createAppServer });
    await collector.refresh();
    const codex = (await collector.read()).codex!;
    expect(codex.sources[0]).toMatchObject({
      id: "codex.appServer",
      state: "not-configured",
      detail: expect.stringContaining("set modules.llm-usage.codex.command"),
    });
    expect(codex.sources[2]).toMatchObject({ id: "codex.history", state: "not-configured" });
    collector.stop();
  });

  it("maps a sign-in error to not-configured", async () => {
    const app = fakeAppServer(() => {
      throw new AppServerRpcError("account/rateLimits/read", AUTH_REQUIRED_CODE, "codex account authentication required");
    });
    const { collector } = harness(codexConfig, { createAppServer: app.createAppServer });
    await collector.refresh();
    const codex = (await collector.read()).codex!;
    expect(codex.sources[0]).toMatchObject({ id: "codex.appServer", state: "not-configured", detail: expect.stringContaining("sign-in") });
    expect(codex.bars).toEqual([]);
    collector.stop();
  });

  it("refetches on account/rateLimits/updated and treats it as activity", async () => {
    let percent = 20;
    const app = fakeAppServer((method) => (method === "account/rateLimits/read" ? limits(percent) : {}));
    const { collector } = harness(codexConfig, { createAppServer: app.createAppServer });
    await collector.refresh();
    percent = 60;
    app.push("account/rateLimits/updated");
    await vi.advanceTimersByTimeAsync(0);
    const response = await collector.read();
    expect(response.codex?.bars[0]?.percent).toBe(60);
    expect(response.poll.mode).toBe("active");
    collector.stop();
  });
});
