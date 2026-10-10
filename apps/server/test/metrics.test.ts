/**
 * The metrics module through the module host: the Prometheus exposition at `/metrics`, the
 * DECK_METRICS_ENABLED switch it owns, its declared root path (never rewritten to the SPA
 * shell), and the kernel no longer naming the feature.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BUILTIN_ROOT_PATHS, defineServerModule, pagePathProblem, type ModuleManifest, type PageDecl, type ProviderStats } from "@deck/module-sdk";
import { primary } from "@deck/schema/fixtures";
import type { Context, Next } from "hono";
import type { Logger } from "pino";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { METRICS_MANIFEST, metricsModule } from "../../../modules/metrics/server/module.js";
import { metricsResponse } from "../../../modules/metrics/server/route.js";
import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { KERNEL_ENV_NAMES } from "../src/modules/context.js";
import { registerAllProviders } from "../src/providers/index.js";
import { listStats, read, register, startScheduler, stopScheduler } from "../src/providers/registry.js";
import { SNAPSHOT_CONTENT, type SnapshotContent } from "../../../modules/snapshot/server/content.js";
import { SNAPSHOT_TIMING, SnapshotProvider } from "../../../modules/snapshot/server/index.js";
import { SNAPSHOT_MANIFEST, snapshotModule } from "../../../modules/snapshot/server/module.js";
import type { SnapshotRevision, SnapshotSource, SnapshotSourceResult } from "../../../modules/snapshot/server/source.js";
import { createApp, planningRouteTable, RESERVED_ROOT_PATHS } from "../src/server/app.js";
import { buildUiManifest } from "../src/ui/manifest.js";
import { uiContributionProblem } from "../src/ui/validate.js";
import { testHost, testModule } from "./util/modules.js";

// Static files pass through; the SPA fallback answers the shell from the dist index.html.
vi.mock("hono/bun", () => ({
  serveStatic: () => async (_context: Context, next: Next) => next(),
}));

/** A web dist directory whose \`index.html\` the SPA fallback serves. */
const webDist = mkdtempSync(join(tmpdir(), "deck-web-dist-"));
writeFileSync(join(webDist, "index.html"), "<!doctype html>index");
afterAll(() => rmSync(webDist, { recursive: true, force: true }));

const stats: ProviderStats[] = [
  { id: "docker", kind: "docker", successTotal: 7, failureTotal: 2, lastLatencyMs: 42, ageMs: 3_000 },
  { id: "snapshot", kind: "snapshot", successTotal: 3, failureTotal: 0, lastLatencyMs: 1_500, ageMs: 12_500 },
  { id: "unpolled", kind: "gatus", successTotal: 0, failureTotal: 0, lastLatencyMs: null, ageMs: null },
];

const providers = { read: () => undefined, count: () => 0, listHealth: () => ({}), listProviders: () => [], setProjections: () => {} };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

const PAGER_PAGE: PageDecl = { id: "page:pager/metrics", path: "/metrics", title: "Metrics", component: "MetricsPage" };

/** The built-in modules plus `extra`, planned as boot plans them. */
function builtinHost(extra: ReturnType<typeof testModule>[], env: Record<string, string> = {}) {
  return testHost([...BUILTIN_MODULES, ...extra], {
    builtins: new Set(BUILTIN_MODULES),
    env,
    kernelRoutes: planningRouteTable(),
    reservedRootPaths: RESERVED_ROOT_PATHS,
  });
}

/** A deck app with the metrics module composed as boot composes it. */
async function harness(
  flag: string | undefined,
  providerStats: readonly ProviderStats[] = stats,
  webDistDir?: string,
  {
    modules = [],
    builtin = [],
    now = () => 0,
  }: { modules?: ReturnType<typeof testModule>[]; builtin?: ReturnType<typeof testModule>[]; now?: () => number } = {},
) {
  const { host } = testHost([metricsModule, ...builtin, ...modules], {
    env: flag === undefined ? {} : { DECK_METRICS_ENABLED: flag },
    builtins: new Set([metricsModule, ...builtin]),
    clock: { now },
    providerStats: () => providerStats,
    kernelRoutes: planningRouteTable(),
    reservedRootPaths: RESERVED_ROOT_PATHS,
  });
  await host.start();
  const app = createApp({
    config: primary.merged,
    providers,
    logger,
    modules: host,
    ...(webDistDir === undefined ? {} : { webDistDir }),
  });
  return { app, host };
}

describe("GET /metrics", () => {
  it("serves a Prometheus exposition body when enabled", async () => {
    const response = await (await harness("true")).app.request("/metrics");
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
    const response = await (await harness("true", [])).app.request("/metrics");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("# TYPE deck_snapshot_age_seconds gauge\n");
    expect(body).not.toMatch(/^deck_snapshot_age_seconds /m);
  });

  it("escapes label values", async () => {
    const response = await (await harness("true", [
      { id: 'a"b\\c', kind: "x", successTotal: 1, failureTotal: 0, lastLatencyMs: 1, ageMs: null },
    ])).app.request("/metrics");
    expect(await response.text()).toContain('deck_provider_poll_success_total{id="a\\"b\\\\c",kind="x"} 1\n');
  });

  it("reads the stats at request time, not at init", async () => {
    const live: ProviderStats[] = [];
    const { app } = await harness("true", live);
    live.push(stats[0]!);
    expect(await (await app.request("/metrics")).text()).toContain("deck_provider_count 1\n");
  });

  it("matches the metrics route, not the SPA index rewrite, when a web dist is configured", async () => {
    const { app } = await harness("true", stats, webDist);
    const response = await app.request("/metrics");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4");
  });

  it("answers HEAD like GET, without a body", async () => {
    const response = await (await harness("true")).app.request("/metrics", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4");
    expect(await response.text()).toBe("");
  });

  it.each(["POST", "PUT", "DELETE"])("answers %s with the plain 404 an unserved path gets", async (method) => {
    const { app } = await harness("true");
    const unserved = await app.request("/no-such-path", { method });
    const response = await app.request("/metrics", { method });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(unserved.headers.get("content-type"));
    expect(await response.text()).toBe(await unserved.text());
  });

  it.each([undefined, "false"])("is not served when DECK_METRICS_ENABLED is %s", async (flag) => {
    const { app, host } = await harness(flag);
    const response = await app.request("/metrics");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("404 Not Found");
    expect(host.health().modules.metrics).toEqual({ state: "disabled", detail: "not enabled: DECK_METRICS_ENABLED is not true" });
  });

  it("is never rewritten to the SPA shell while switched off", async () => {
    const { app, host } = await harness(undefined, stats, webDist);
    expect(host.rootPaths()).toEqual(["/metrics"]);
    const response = await app.request("/metrics");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("404 Not Found");
    expect(await (await app.request("/hosts/gov")).text()).toBe("<!doctype html>index");
  });
});

/** A module offering `snapshot/content`: the snapshot module's stand-in when passed as built-in. */
function contentModule(content: SnapshotContent, id = "snapshot") {
  return testModule({ id, services: { provides: [SNAPSHOT_CONTENT.name] } }, (ctx) => {
    ctx.services.provide(SNAPSHOT_CONTENT, content);
  });
}

const sample = (body: string, name: string) => body.match(new RegExp(`^${name} (.+)$`, "m"))?.[1];

describe("the snapshot content-age gauges", () => {
  const GENERATED_AT = Date.parse("2026-10-01T00:00:00Z");

  it("are computed per scrape from generatedAt and the clock, beside the unchanged read age", async () => {
    let now = GENERATED_AT + 90_500;
    const { app } = await harness("true", stats, undefined, {
      builtin: [contentModule({ generatedAtMs: () => GENERATED_AT })],
      now: () => now,
    });

    const first = await (await app.request("/metrics")).text();
    for (const name of ["deck_snapshot_generated_age_seconds", "deck_snapshot_generated_timestamp_seconds"]) {
      expect(first).toMatch(new RegExp(`^# HELP ${name} .+$`, "m"));
      expect(first).toContain(`# TYPE ${name} gauge\n`);
    }
    expect(sample(first, "deck_snapshot_generated_age_seconds")).toBe("90.5");
    expect(sample(first, "deck_snapshot_generated_timestamp_seconds")).toBe(String(GENERATED_AT / 1000));
    expect(sample(first, "deck_snapshot_age_seconds")).toBe("12.5");

    // Five days on, with the same file still readable: the read age stays put, the content age grows.
    now += 5 * 86_400_000;
    const later = await (await app.request("/metrics")).text();
    expect(sample(later, "deck_snapshot_generated_age_seconds")).toBe("432090.5");
    expect(sample(later, "deck_snapshot_generated_timestamp_seconds")).toBe(String(GENERATED_AT / 1000));
    expect(sample(later, "deck_snapshot_age_seconds")).toBe("12.5");
  });

  it("are absent, HELP/TYPE kept, until a snapshot with a usable generatedAt has been read", async () => {
    let generatedAt: number | null = null;
    const { app } = await harness("true", stats, undefined, {
      builtin: [contentModule({ generatedAtMs: () => generatedAt })],
      now: () => GENERATED_AT + 1_000,
    });

    const before = await (await app.request("/metrics")).text();
    expect(before).toContain("# TYPE deck_snapshot_generated_age_seconds gauge\n");
    expect(before).toContain("# TYPE deck_snapshot_generated_timestamp_seconds gauge\n");
    expect(sample(before, "deck_snapshot_generated_age_seconds")).toBeUndefined();
    expect(sample(before, "deck_snapshot_generated_timestamp_seconds")).toBeUndefined();

    generatedAt = GENERATED_AT;
    const after = await (await app.request("/metrics")).text();
    expect(sample(after, "deck_snapshot_generated_age_seconds")).toBe("1");
  });

  it("are absent when no module offers the snapshot's content", async () => {
    const response = await (await harness("true", [])).app.request("/metrics");
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("# TYPE deck_snapshot_generated_age_seconds gauge\n");
    expect(body).not.toMatch(/^deck_snapshot_generated_(age|timestamp)_seconds /m);
  });

  it("are floored at 0 when generatedAt is ahead of deck's clock; the raw timestamp shows the skew", async () => {
    const { app } = await harness("true", stats, undefined, {
      builtin: [contentModule({ generatedAtMs: () => GENERATED_AT + 30_000 })],
      now: () => GENERATED_AT,
    });
    const body = await (await app.request("/metrics")).text();
    expect(sample(body, "deck_snapshot_generated_age_seconds")).toBe("0");
    expect(sample(body, "deck_snapshot_generated_timestamp_seconds")).toBe(String((GENERATED_AT + 30_000) / 1000));
  });

  it("take only the built-in snapshot module's offer: another module named aaa never shadows it", async () => {
    const shadow = contentModule({ generatedAtMs: () => GENERATED_AT - 86_400_000 }, "aaa");
    const alone = await harness("true", stats, undefined, { modules: [shadow], now: () => GENERATED_AT });
    expect((await (await alone.app.request("/metrics")).text())).not.toMatch(/^deck_snapshot_generated_(age|timestamp)_seconds /m);

    const both = await harness("true", stats, undefined, {
      builtin: [contentModule({ generatedAtMs: () => GENERATED_AT })],
      modules: [contentModule({ generatedAtMs: () => GENERATED_AT - 86_400_000 }, "aaa")],
      now: () => GENERATED_AT + 5_000,
    });
    const body = await (await both.app.request("/metrics")).text();
    expect(sample(body, "deck_snapshot_generated_age_seconds")).toBe("5");
    expect(sample(body, "deck_snapshot_generated_timestamp_seconds")).toBe(String(GENERATED_AT / 1000));
  });

  it.each([
    ["throws", () => { throw new Error("boom"); }],
    ["answers NaN", () => Number.NaN],
    ["answers Infinity", () => Number.POSITIVE_INFINITY],
    ["answers a string", () => "1700000000000" as unknown as number],
  ])("are absent, and the scrape still succeeds, when the offer %s", async (_label, generatedAtMs) => {
    const { app } = await harness("true", stats, undefined, {
      builtin: [contentModule({ generatedAtMs })],
      now: () => GENERATED_AT,
    });
    const response = await app.request("/metrics");
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).not.toMatch(/^deck_snapshot_generated_(age|timestamp)_seconds /m);
    expect(sample(body, "deck_snapshot_age_seconds")).toBe("12.5");
  });

  it("are declared: metrics uses the service the snapshot module provides", () => {
    expect(METRICS_MANIFEST.services).toEqual({ uses: [SNAPSHOT_CONTENT.name] });
    expect(SNAPSHOT_MANIFEST.services).toEqual({ provides: [SNAPSHOT_CONTENT.name] });
  });

  describe("through the snapshot module and the provider registry", () => {
    const dirs: string[] = [];
    const hosts: { stop(): Promise<void> }[] = [];
    afterEach(async () => {
      stopScheduler();
      await Promise.all(hosts.splice(0).map((host) => host.stop()));
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    async function scrapeAfterRead(generatedAt: unknown, now: number): Promise<string> {
      const dir = mkdtempSync(join(tmpdir(), "deck-metrics-"));
      dirs.push(dir);
      const file = join(dir, "snapshot.json");
      const doc: Record<string, unknown> = { schemaVersion: 1, hosts: [] };
      if (generatedAt !== undefined) doc.generatedAt = generatedAt;
      writeFileSync(file, JSON.stringify(doc));
      const { host } = testHost([snapshotModule, metricsModule], {
        env: { DECK_SNAPSHOT_SOURCE: file, DECK_METRICS_ENABLED: "true" },
        clock: { now: () => now },
        providerStats: listStats,
        kernelRoutes: planningRouteTable(),
        reservedRootPaths: RESERVED_ROOT_PATHS,
      });
      hosts.push(host);
      registerAllProviders(primary.merged, host.kindHandlers());
      await host.start();
      startScheduler();
      await vi.waitFor(() => expect(listStats().find((entry) => entry.id === "snapshot")?.successTotal).toBe(1));
      const app = createApp({ config: primary.merged, providers, logger, modules: host });
      return (await app.request("/metrics")).text();
    }

    it("expose the read snapshot's generatedAt", async () => {
      const body = await scrapeAfterRead("2026-10-01T00:00:00Z", GENERATED_AT + 3_600_000);
      expect(sample(body, "deck_snapshot_generated_age_seconds")).toBe("3600");
      expect(sample(body, "deck_snapshot_generated_timestamp_seconds")).toBe(String(GENERATED_AT / 1000));
      expect(sample(body, "deck_snapshot_age_seconds")).toBeDefined();
    });

    it.each([["missing", undefined], ["unparseable", "not-a-date"]])(
      "are absent, with no crash, when the read snapshot's generatedAt is %s",
      async (_label, generatedAt) => {
        const body = await scrapeAfterRead(generatedAt, GENERATED_AT);
        expect(body).not.toMatch(/^deck_snapshot_generated_(age|timestamp)_seconds /m);
        expect(sample(body, "deck_snapshot_age_seconds")).toBeDefined();
      },
    );

    /** A changed read of a snapshot generated at `generatedAt`. */
    const changedRead = (generatedAt: string): SnapshotSourceResult => {
      const text = JSON.stringify({ schemaVersion: 1, generatedAt, hosts: [] });
      return { changed: true, bytes: text.length, text, revision: { sourceKind: "path", token: Symbol(generatedAt) } };
    };

    /**
     * A source answering the queued snapshots at once, then holding every later read until the
     * test settles it, ignoring the abort signal as a slow read would.
     */
    class HeldSource implements SnapshotSource {
      readonly kind = "path";
      private readonly held: Array<(result: SnapshotSourceResult) => void> = [];
      constructor(private readonly immediate: string[] = []) {}
      read(): Promise<SnapshotSourceResult> {
        const next = this.immediate.shift();
        if (next !== undefined) return Promise.resolve(changedRead(next));
        return new Promise((resolve) => this.held.push(resolve));
      }
      accept(_revision: SnapshotRevision): void {}
      /** Settle the oldest held read with a snapshot generated at `generatedAt`. */
      settle(generatedAt: string): void {
        this.held.shift()!(changedRead(generatedAt));
      }
    }

    /** The two gauges as a scrape at `now` reads them through the provider's service answer. */
    async function gauges(provider: SnapshotProvider, now: number) {
      const body = await metricsResponse(new Request("http://deck/metrics"), {
        stats: listStats(),
        snapshotGeneratedAtMs: provider.generatedAtMs(),
        nowMs: now,
      }).text();
      return [sample(body, "deck_snapshot_generated_age_seconds"), sample(body, "deck_snapshot_generated_timestamp_seconds")];
    }

    const A = "2026-10-01T00:00:00Z";
    const B = "2026-10-06T00:00:00Z";
    const served = () => (read("snapshot")!.data as { snapshot: { generatedAt: string } } | null)?.snapshot.generatedAt;

    it("a read that completes after the poll timed out changes neither the served snapshot nor the gauges", async () => {
      const source = new HeldSource([A]);
      const provider = new SnapshotProvider("snapshot", { source, config: primary.merged });
      const handle = register(provider, { ...SNAPSHOT_TIMING, timeoutMs: 20 });

      await handle.runNow();
      expect(served()).toBe(A);
      expect(await gauges(provider, GENERATED_AT + 60_000)).toEqual(["60", String(GENERATED_AT / 1000)]);

      // The second read outlives the registry's timeout, then lands with snapshot B.
      await handle.runNow();
      expect(listStats().find((entry) => entry.id === "snapshot")?.failureTotal).toBe(1);
      source.settle(B);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(served()).toBe(A);
      expect(provider.generatedAtMs()).toBe(GENERATED_AT);
      expect(await gauges(provider, GENERATED_AT + 60_000)).toEqual(["60", String(GENERATED_AT / 1000)]);
    });

    it("a first poll that times out leaves the gauges absent even when its read lands later", async () => {
      const source = new HeldSource();
      const provider = new SnapshotProvider("snapshot", { source, config: primary.merged });
      const handle = register(provider, { ...SNAPSHOT_TIMING, timeoutMs: 20 });

      await handle.runNow();
      source.settle(A);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(read("snapshot")!.data).toBeNull();
      expect(provider.generatedAtMs()).toBeNull();
      expect(await gauges(provider, GENERATED_AT)).toEqual([undefined, undefined]);
    });
  });
});

describe("DECK_METRICS_ENABLED", () => {
  it.each([
    [undefined, false],
    ["true", true],
    ["TRUE", true],
    ["1", true],
    ["false", false],
    ["yes", false],
  ])("DECK_METRICS_ENABLED=%s runs the module: %s", (raw, enabled) => {
    const { host } = testHost([metricsModule], { env: raw === undefined ? {} : { DECK_METRICS_ENABLED: raw } });
    expect(host.plan.find((entry) => entry.id === "metrics")?.enabled).toBe(enabled);
  });

  it("is the metrics module's own setting, not the kernel's", () => {
    expect(METRICS_MANIFEST.enabledBy).toEqual({ env: "DECK_METRICS_ENABLED" });
    expect(METRICS_MANIFEST.env).toEqual(["DECK_METRICS_ENABLED"]);
    expect(KERNEL_ENV_NAMES.has("DECK_METRICS_ENABLED")).toBe(false);
  });

  it("cannot be claimed by another module", () => {
    const squatter = testModule({ id: "squatter", env: ["DECK_METRICS_ENABLED"] });
    const { host } = testHost([metricsModule, squatter], { env: { DECK_METRICS_ENABLED: "true" } });
    expect(host.plan.find((entry) => entry.id === "metrics")?.enabled).toBe(true);
    expect(host.findings).toEqual([
      expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", path: "/modules/squatter", message: expect.stringContaining('env name "DECK_METRICS_ENABLED" is owned by module "metrics"') }),
    ]);
  });

  it("reads as undefined to another module that does not declare it", async () => {
    let seen: string | undefined = "unread";
    const reader = testModule({ id: "reader" }, (ctx) => {
      seen = ctx.env.get("DECK_METRICS_ENABLED");
    });
    const { host } = testHost([metricsModule, reader], { env: { DECK_METRICS_ENABLED: "true" } });
    await host.start();
    expect(seen).toBeUndefined();
  });
});

describe("the /metrics root path", () => {
  it("is declared in the metrics manifest and the module is built in", () => {
    expect(METRICS_MANIFEST.contributes?.routes?.rootPaths).toEqual(["/metrics"]);
    expect(BUILTIN_MODULES).toContain(metricsModule);
  });

  it("is the shared rules' (and the web's) built-in root path list", () => {
    const declared = BUILTIN_MODULES.flatMap(({ manifest }) => manifest.contributes?.routes?.rootPaths ?? []);
    expect([...BUILTIN_ROOT_PATHS].sort()).toEqual([...declared].sort());
  });

  it("is refused to another module, and boot continues", () => {
    const squatter = testModule({ id: "squatter", contributes: { routes: { rootPaths: ["/metrics"] } } });
    const { host } = testHost([metricsModule, squatter], { builtins: new Set([metricsModule]) });
    expect(host.findings).toEqual([
      expect.objectContaining({
        code: "MODULE_MANIFEST_INVALID",
        path: "/modules/squatter",
        message: expect.stringContaining('root path "/metrics" is served by built-in module "metrics"'),
      }),
    ]);
  });

  // A2: a page on a built-in's root path is a manifest error, as one on a kernel path was.
  it("is never a page's: the shared rule rejects it", () => {
    expect(pagePathProblem("/metrics", "page")).toMatch(/reserved root path/);
    expect(uiContributionProblem({ id: "pager", version: "1.0.0", deckApi: "^0.1", contributes: { pages: [PAGER_PAGE] } })).toMatch(/reserved root path/);
  });

  it.each([["on", { DECK_METRICS_ENABLED: "true" }], ["off", {}]])(
    "refuses a module with a page on it while metrics is %s, before its code runs",
    async (_state, env: Record<string, string>) => {
      const init = vi.fn();
      const pager = testModule({ id: "pager", contributes: { pages: [PAGER_PAGE] } }, init);
      const { host } = builtinHost([pager], env);
      expect(host.findings).toEqual([
        expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", path: "/modules/pager", message: expect.stringContaining('path "/metrics" is a reserved root path') }),
      ]);
      await host.start();
      expect(init).not.toHaveBeenCalled();
      const ui = buildUiManifest({ config: primary.merged, providers, modules: host, capabilities: {} });
      expect(ui.pages.map((page) => page.path)).not.toContain("/metrics");
    },
  );
});

// B2: built-in reservations come from snapshotted manifests only, never a live property read.
describe("built-in root paths are read from snapshots", () => {
  const trapModule = () => {
    const counter = { calls: 0 };
    const manifest = { id: "trap", version: "1.0.0", deckApi: "^0.1" } as ModuleManifest;
    Object.defineProperty(manifest, "contributes", {
      enumerable: true,
      get() {
        counter.calls += 1;
        throw new Error("getter ran");
      },
    });
    return { trap: defineServerModule(manifest, () => {}), counter };
  };

  it("a built-in with a throwing contributes getter fails planning loudly, without calling it", () => {
    const { trap, counter } = trapModule();
    expect(() => testHost([...BUILTIN_MODULES, trap], {
      builtins: new Set([...BUILTIN_MODULES, trap]),
      env: { DECK_METRICS_ENABLED: "true" },
      kernelRoutes: planningRouteTable(),
      reservedRootPaths: RESERVED_ROOT_PATHS,
    })).toThrow(expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", moduleId: "trap" }));
    expect(counter.calls).toBe(0);
  });

  it("another module with a throwing contributes getter is refused without calling it, and the rest still plan", () => {
    const { trap, counter } = trapModule();
    const calls = () => counter.calls;
    const pager = testModule({ id: "pager", contributes: { pages: [PAGER_PAGE] } });
    const { host } = testHost([...BUILTIN_MODULES, trap, pager], {
      builtins: new Set(BUILTIN_MODULES),
      env: { DECK_METRICS_ENABLED: "true" },
      kernelRoutes: planningRouteTable(),
      reservedRootPaths: RESERVED_ROOT_PATHS,
    });
    expect(calls()).toBe(0);
    expect(host.findings).toEqual([
      expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", path: "/modules/trap" }),
      expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", path: "/modules/pager", message: expect.stringContaining("reserved root path") }),
    ]);
    expect(host.plan.filter((entry) => entry.enabled).map((entry) => entry.id)).toEqual(
      expect.arrayContaining(BUILTIN_MODULES.map(({ manifest: m }) => m.id).filter((id) => id !== "actions")),
    );
  });
});

// A1: a module's root path never takes a built-in or kernel page, whether the module runs or not.
describe("root paths against built-in and kernel pages", () => {
  const CLAIMS: [string, string, string, string][] = [
    ["an inventory page pattern (/hosts/:name)", "/hosts/gov", "page:inventory/host-detail", 'built-in module "inventory"'],
    ["an inventory page (/hosts)", "/hosts", "page:inventory/hosts", 'built-in module "inventory"'],
    ["a sources page (/docs)", "/docs", "page:sources/docs", 'built-in module "sources"'],
  ];
  for (const enabled of [true, false]) {
    it.each(CLAIMS)(`refuses a claimant ${enabled ? "that runs" : "that is off"} on %s, so the page stays routed`, async (_label, path, pageId, owner) => {
      const init = vi.fn();
      const claimant = testModule(
        { id: "claimant", ...(enabled ? {} : { enabledBy: { config: true } }), contributes: { routes: { rootPaths: [path] } } },
        init,
      );
      const { host } = builtinHost([claimant]);
      expect(host.findings).toEqual([
        expect.objectContaining({ code: "MODULE_MANIFEST_INVALID", path: "/modules/claimant", message: expect.stringContaining(`root path "${path}" would shadow page "${pageId}" of ${owner}`) }),
      ]);
      expect(host.rootPaths()).not.toContain(path);
      await host.start();
      expect(init).not.toHaveBeenCalled();
      const ui = buildUiManifest({ config: primary.merged, providers, modules: host, capabilities: { sources: true } });
      expect(ui.findings.filter((finding) => finding.code === "UI_PAGE_PATH_COLLISION")).toEqual([]);
      expect(ui.pages.map((page) => page.id)).toContain(pageId);
    });
  }

  // B1: a declared root path always owns HTTP, so the resolver never routes a page it covers.
  it.each([["runs", true], ["is off", false]])("a root path owns its path while its module %s: /api/ui and HTTP agree", async (_state, enabled) => {
    const pages = testModule({ id: "aaa", contributes: { pages: [{ id: "page:aaa/x", path: "/x", title: "X", component: "X" }] } });
    const claimant = testModule(
      { id: "mmm", ...(enabled ? {} : { enabledBy: { config: true } }), contributes: { routes: { rootPaths: ["/x"] } } },
      (ctx) => ctx.rootRoute("/x", () => new Response("claimant")),
    );
    const { host } = testHost([pages, claimant]);
    await host.start();
    const ui = buildUiManifest({ config: primary.merged, providers, modules: host, capabilities: {} });
    expect(ui.pages.map((page) => page.id)).not.toContain("page:aaa/x");
    expect(ui.findings).toEqual([expect.objectContaining({ code: "UI_PAGE_PATH_COLLISION", id: "page:aaa/x" })]);
    const app = createApp({ config: primary.merged, providers, logger, modules: host, webDistDir: webDist });
    const response = await app.request("/x");
    expect(response.status).toBe(enabled ? 200 : 404);
    expect(await response.text()).toBe(enabled ? "claimant" : "404 Not Found");
  });
});

describe("kernel files no longer name metrics", () => {
  const KERNEL_FILES = [
    "src/server/boot.ts",
    "src/server/app.ts",
    "src/server/reserved-paths.ts",
    "src/modules/context.ts",
    "src/modules/host.ts",
    "src/ui/validate.ts",
  ];
  it.each(KERNEL_FILES)("%s", (file) => {
    const text = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
    expect(text).not.toMatch(/metrics|METRICS/);
  });

  it("the kernel reserves no root path of its own", () => {
    expect(RESERVED_ROOT_PATHS).toEqual([]);
    expect(planningRouteTable().map((route) => route.path)).not.toContain("/metrics");
  });
});
