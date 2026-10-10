import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleLogger } from "@deck/module-sdk";

import { scopedLogger } from "../src/modules/context.js";
import { PrometheusProvider } from "../../../modules/prometheus/server/index.js";
import { parseSummaryCard, type SummaryQuery } from "../../../modules/prometheus/server/parse-card.js";
import { providerCount, read, stopScheduler } from "../src/providers/registry.js";
import { captureLogger } from "./util/modules.js";
import { processEnv, registerPrometheus } from "./util/register-kinds.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(
  fileURLToPath(new URL(`./fixtures/prometheus/${name}.json`, import.meta.url)),
  "utf8",
));

/** The prometheus module's scoped logger over a captured sink, as the kernel injects it. */
function moduleSink(): { logger: ModuleLogger; lines: Record<string, unknown>[] } {
  const { logger, lines } = captureLogger();
  return { logger: scopedLogger(logger, "prometheus"), lines };
}

describe("parseSummaryCard", () => {
  it.each([null, undefined, 1, "card", [], {}, { summaries: null }, { summaries: {} }])(
    "returns an empty list without throwing for %j",
    (card) => expect(() => parseSummaryCard(card, moduleSink().logger)).not.toThrow(),
  );

  it("keeps only valid known fields in declaration order and keeps the first duplicate id", () => {
    const { logger, lines } = moduleSink();
    const result = parseSummaryCard({ summaries: [
      { id: "first", label: "First", query: "up", extra: "ignored" },
      { id: "bad", label: "Bad", query: "secret-query", warning: 1 },
      { id: "second", label: "Second", query: "load", unit: "%", warning: 70, critical: 90, direction: "above" },
      { id: "first", label: "Duplicate", query: "other" },
      { id: "bare", label: "Bare direction", query: "temperature", direction: "below" },
    ] }, logger);

    expect(result).toEqual([
      { id: "first", label: "First", query: "up" },
      { id: "second", label: "Second", query: "load", unit: "%", warning: 70, critical: 90, direction: "above" },
      { id: "bare", label: "Bare direction", query: "temperature", direction: "below" },
    ]);
    // Drops go to the injected module logger: warn level, tagged with the module id.
    expect(lines.map(({ level, module, event, index, id, reason }) => ({ level, module, event, index, id, reason }))).toEqual([
      { level: 40, module: "prometheus", event: "prometheus.summary.dropped", index: 1, id: "bad", reason: "direction_required" },
      { level: 40, module: "prometheus", event: "prometheus.summary.dropped", index: 3, id: "first", reason: "id_duplicate" },
    ]);
    expect(JSON.stringify(lines)).not.toContain("secret-query");
  });

  it("drops every mistyped field independently and never lets getters or logging throw", () => {
    const down = (): never => { throw new Error("logger down"); };
    const logger: ModuleLogger = { debug: down, info: down, warn: down, error: down };
    const unreadable = Object.defineProperty({}, "id", { get: () => { throw new Error("getter"); } });
    const invalid = [
      null, [], {}, { id: "", label: "x", query: "x" }, { id: "x", label: 1, query: "x" },
      { id: "x", label: "x", query: 1 }, { id: "x", label: "x", query: "x", unit: "" },
      { id: "x", label: "x", query: "x", unit: undefined },
      { id: "x", label: "x", query: "x", warning: "1", direction: "above" },
      { id: "x", label: "x", query: "x", critical: Infinity, direction: "above" },
      { id: "x", label: "x", query: "x", direction: "sideways" }, unreadable,
    ];
    expect(() => parseSummaryCard({ summaries: invalid }, logger)).not.toThrow();
    expect(parseSummaryCard({ summaries: invalid }, logger)).toEqual([]);
  });
});

describe("PrometheusProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    stopScheduler();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.DECK_PROM_TOKEN;
  });

  it("fans out encoded GETs concurrently with one shared signal and preserves order", async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetchStub = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      new Promise<Response>((resolve) => pending.push(resolve)));
    vi.stubGlobal("fetch", fetchStub);
    const summaries = [query("a", "rate(http requests[5m])"), query("b", "up == 1")];
    const controller = new AbortController();
    const resultPromise = new PrometheusProvider("prometheus", { baseUrl: "http://prom/", summaries })
      .fetch({ signal: controller.signal });

    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(fetchStub.mock.calls.map(([url, init]) => [url, init])).toEqual([
      ["http://prom/api/v1/query?query=rate(http%20requests%5B5m%5D)", { method: "GET", headers: {}, signal: controller.signal }],
      ["http://prom/api/v1/query?query=up%20%3D%3D%201", { method: "GET", headers: {}, signal: controller.signal }],
    ]);
    pending[1]!(Response.json(fixture("warn")));
    pending[0]!(Response.json(fixture("healthy")));
    await expect(resultPromise).resolves.toMatchObject({ summaries: [{ id: "a" }, { id: "b" }] });
  });

  it.each([
    ["healthy", query("metric", "q"), 42, "neutral"],
    ["warn", { ...query("metric", "q"), warning: 70, critical: 90, direction: "above" as const }, 75, "warning"],
    ["critical", { ...query("metric", "q"), warning: 70, critical: 90, direction: "above" as const }, 90, "critical"],
    ["no-data", query("metric", "q"), null, "error"],
    ["bad-shape", query("metric", "q"), null, "error"],
  ])("maps the %s fixture", async (name, summary, value, status) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(fixture(name))));
    await expect(provider(summary).fetch()).resolves.toEqual({ summaries: [{ id: "metric", label: "Metric", value, status }] });
  });

  it.each([
    ["above critical inclusive", 90, { warning: 70, critical: 90, direction: "above" }, "critical"],
    ["above warning inclusive", 70, { warning: 70, critical: 90, direction: "above" }, "warning"],
    ["above ok", 69, { warning: 70, critical: 90, direction: "above" }, "ok"],
    ["below critical inclusive", 10, { warning: 20, critical: 10, direction: "below" }, "critical"],
    ["below warning inclusive", 20, { warning: 20, critical: 10, direction: "below" }, "warning"],
    ["below ok", 21, { warning: 20, critical: 10, direction: "below" }, "ok"],
    ["warning only", 5, { warning: 5, direction: "above" }, "warning"],
    ["critical only", 5, { critical: 5, direction: "above" }, "critical"],
  ])("classifies %s", async (_name, value, thresholds, status) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(scalar(value))));
    const summary = { ...query("metric", "q"), ...thresholds } as SummaryQuery;
    await expect(provider(summary).fetch()).resolves.toMatchObject({ summaries: [{ status }] });
  });

  it.each([
    { status: "error", data: { resultType: "scalar", result: [0, "1"] } },
    { status: "success", data: { resultType: "vector", result: [] } },
    { status: "success", data: { resultType: "vector", result: [{ value: [0, "1"] }, { value: [0, "2"] }] } },
    { status: "success", data: { resultType: "string", result: [0, "1"] } },
    { status: "success", data: { resultType: "scalar", result: [0, "NaN"] } },
    { status: "success", data: { resultType: "scalar", result: [0, "Infinity"] } },
    { status: "success", data: { resultType: "scalar", result: [0, ""] } },
  ])("maps unsupported and non-finite bodies to explicit error", async (body) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
    await expect(provider(query("metric", "q")).fetch()).resolves.toMatchObject({ summaries: [{ value: null, status: "error" }] });
  });

  it("isolates per-query failures but rejects only when no query gets a 2xx", async () => {
    const fetchStub = vi.fn()
      .mockRejectedValueOnce(new Error("secret transport detail"))
      .mockResolvedValueOnce(Response.json(scalar(3)));
    vi.stubGlobal("fetch", fetchStub);
    const mixed = new PrometheusProvider("prometheus", { baseUrl: "http://prom", summaries: [query("bad", "bad"), query("good", "good")] });
    await expect(mixed.fetch()).resolves.toEqual({ summaries: [
      { id: "bad", label: "Metric", value: null, status: "error" },
      { id: "good", label: "Metric", value: 3, status: "neutral" },
    ] });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    const unreachable = provider(query("metric", "secret query"));
    await expect(unreachable.fetch()).rejects.toThrowError("Prometheus endpoint unreachable");
    await expect(unreachable.health()).resolves.toEqual({ ok: false, detail: "Prometheus endpoint unreachable" });
  });

  it("does no I/O for zero summaries and resolves credentials inline", async () => {
    const fetchStub = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json(scalar(1)));
    vi.stubGlobal("fetch", fetchStub);
    const empty = new PrometheusProvider("empty", { baseUrl: "http://prom", summaries: [] });
    await expect(empty.fetch()).resolves.toEqual({ summaries: [] });
    expect(fetchStub).not.toHaveBeenCalled();

    const secured = new PrometheusProvider("secured", { baseUrl: "http://prom", credentialEnv: "DECK_PROM_TOKEN", env: processEnv, summaries: [query("metric", "q")] });
    process.env.DECK_PROM_TOKEN = "Bearer super-secret";
    await secured.fetch();
    delete process.env.DECK_PROM_TOKEN;
    await secured.fetch();
    expect(fetchStub.mock.calls.map(([, init]) => init?.headers)).toEqual([{ Authorization: "Bearer super-secret" }, {}]);
    expect(JSON.stringify(secured)).not.toContain("super-secret");
  });

  it("registers through the shared registry", () => {
    registerPrometheus("prometheus", { baseUrl: "http://prom", summaries: [] });
    expect(providerCount()).toBe(1);
    expect(read("prometheus")).toMatchObject({ id: "prometheus", kind: "prometheus" });
  });
});

function query(id: string, expression: string): SummaryQuery {
  return { id, label: "Metric", query: expression };
}

function provider(summary: SummaryQuery): PrometheusProvider {
  return new PrometheusProvider("prometheus", { baseUrl: "http://prom", summaries: [summary] });
}

function scalar(value: number): unknown {
  return { status: "success", data: { resultType: "scalar", result: [1770000000, String(value)] } };
}
