import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { ServerModuleContext } from "@deck/module-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { KERNEL_ENV_NAMES } from "../src/modules/context.js";
import { register, read, startScheduler, stopScheduler } from "../src/providers/registry.js";
import { testHost, testModule } from "./util/modules.js";
import { serverSourceFiles, serverSourceRoots } from "./util/source-roots.js";
import { makeDataDir } from "./util/tmp-data.js";

/** Every `DECK_*` name the server's sources (its own and each module's server half) mention. */
function deckNamesInServerSources(repo?: string): Set<string> {
  const files = serverSourceFiles(repo).filter((file) => file.endsWith(".ts"));
  return new Set(files.flatMap((file) => readFileSync(file, "utf8").match(/DECK_[A-Z0-9_]+/g) ?? []));
}

/** Start a single always-on module and hand back its context. */
async function contextFor(
  manifest: Parameters<typeof testModule>[0],
  options: Parameters<typeof testHost>[1] = {},
  init: (ctx: ServerModuleContext) => void = () => {},
) {
  let captured!: ServerModuleContext;
  const fixture = testHost([testModule(manifest, (ctx) => {
    captured = ctx;
    init(ctx);
  })], options);
  await fixture.host.start();
  return { ctx: captured, ...fixture };
}

afterEach(() => {
  vi.useRealTimers();
  stopScheduler();
});

describe("ctx.logger", () => {
  it("binds the module id to every line and keeps event names open", async () => {
    const { ctx, lines } = await contextFor({ id: "llm-usage" });
    ctx.logger.info({ event: "llm-usage.poll", ok: true }, "polled");
    ctx.logger.warn({ event: "llm-usage.ingest-disabled" });
    ctx.logger.debug({ event: "llm-usage.trace" });
    ctx.logger.error({ event: "llm-usage.bug" });
    const mine = lines.filter((l) => String(l.event).startsWith("llm-usage."));
    expect(mine).toEqual([
      expect.objectContaining({ module: "llm-usage", event: "llm-usage.poll", ok: true, msg: "polled", level: 30 }),
      expect.objectContaining({ module: "llm-usage", event: "llm-usage.ingest-disabled", level: 40 }),
      expect.objectContaining({ module: "llm-usage", event: "llm-usage.trace", level: 20 }),
      expect.objectContaining({ module: "llm-usage", event: "llm-usage.bug", level: 50 }),
    ]);
  });
});

describe("ctx.env", () => {
  const env = { DECK_A: "a", DECK_B: "b", USAGE_TOKEN: "secret", PATH: "/bin" };

  it("reads only declared names, plus names a config pointer resolves to", async () => {
    const { ctx } = await contextFor(
      { id: "x", env: ["DECK_A"], envFromConfig: ["/claude/statusLine/credentialEnv", "/missing/pointer"] },
      { env, sectionOf: () => ({ claude: { statusLine: { credentialEnv: "USAGE_TOKEN" } } }) },
    );
    expect(ctx.env.get("DECK_A")).toBe("a");
    expect(ctx.env.get("USAGE_TOKEN")).toBe("secret");
    expect(ctx.env.get("DECK_B")).toBeUndefined();
    expect(ctx.env.get("PATH")).toBeUndefined();
  });

  it("refuses malformed names and kernel settings through config pointers (L16)", async () => {
    const config = { a: "DECK_CONFIG_DIR", b: "lower_case", c: "DECK_DATA_DIR", d: "MY_TOKEN", e: "DECK_LLM_USAGE_INGEST_TOKEN" };
    const { ctx } = await contextFor(
      { id: "x", envFromConfig: ["/a", "/b", "/c", "/d", "/e"] },
      {
        env: { DECK_CONFIG_DIR: "s", lower_case: "l", DECK_DATA_DIR: "/data", MY_TOKEN: "t", DECK_LLM_USAGE_INGEST_TOKEN: "i" },
        sectionOf: () => config,
      },
    );
    expect(ctx.env.get("DECK_CONFIG_DIR")).toBeUndefined();
    expect(ctx.env.get("lower_case")).toBeUndefined();
    expect(ctx.env.get("DECK_DATA_DIR")).toBeUndefined();
    expect(ctx.env.get("MY_TOKEN")).toBe("t");
    // A DECK_* name the kernel does not read is the operator's credential name to choose.
    expect(ctx.env.get("DECK_LLM_USAGE_INGEST_TOKEN")).toBe("i");
  });

  it("lists every DECK_* setting the server, the entrypoint and the env reference name as a kernel setting or a built-in module's own or shared one", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    // The scan covers the built-in modules' server halves, not only apps/server/src.
    expect(serverSourceRoots().map((dir) => relative(root, dir))).toContain("modules/llm-usage/server");
    const read = deckNamesInServerSources();
    read.delete("DECK_API_VERSION"); // the module API version constant, not an env var
    for (const name of readFileSync(join(root, "docker/entrypoint.sh"), "utf8").match(/DECK_[A-Z0-9_]*[A-Z0-9]\b/g) ?? []) read.add(name);
    // Every setting row of the environment-variables reference: `| \`DECK_X\` | default | … |`.
    const reference = readFileSync(join(root, "docs/reference/environment-variables.md"), "utf8");
    for (const [, name] of reference.matchAll(/^\| `(DECK_[A-Z0-9_]+)` \|/gm)) read.add(name!);
    expect(read.has("DECK_SNAPSHOT_OUT")).toBe(true);
    const owned = new Set(BUILTIN_MODULES.flatMap(({ manifest }) => [...(manifest.env ?? []), ...(manifest.enabledBy?.env === undefined ? [] : [manifest.enabledBy.env])]));
    // A non-secret setting several built-ins read (the sources cache root) is their sharedEnv.
    const shared = new Set(BUILTIN_MODULES.flatMap(({ manifest }) => manifest.sharedEnv ?? []));
    expect([...read].filter((name) => !KERNEL_ENV_NAMES.has(name) && !owned.has(name) && !shared.has(name)).sort()).toEqual([]);
    expect([...shared].filter((name) => KERNEL_ENV_NAMES.has(name) || owned.has(name))).toEqual([]);
    // Kernel settings and module-owned names never overlap (the host refuses such a manifest).
    expect([...owned].filter((name) => KERNEL_ENV_NAMES.has(name))).toEqual([]);
  });

  it("reads DECK_* names from a module's server half (scan self-test)", () => {
    const repo = mkdtempSync(join(tmpdir(), "server-roots-"));
    try {
      const probe = join(repo, "modules/probe/server/module.ts");
      mkdirSync(dirname(probe), { recursive: true });
      writeFileSync(probe, 'export const flag = process.env.DECK_PROBE_ONLY_SETTING;\n');
      expect([...deckNamesInServerSources(repo)]).toEqual(["DECK_PROBE_ONLY_SETTING"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("ignores a pointer whose value is not a non-empty string", async () => {
    const { ctx } = await contextFor(
      { id: "x", envFromConfig: ["/name"] },
      { env: { "": "x", "42": "y" }, sectionOf: () => ({ name: 42 }) },
    );
    expect(ctx.env.get("42")).toBeUndefined();
    expect(ctx.env.get("")).toBeUndefined();
  });
});

describe("ctx.env ownership", () => {
  it("a config pointer cannot unlock a name another module owns", async () => {
    let reader!: ServerModuleContext;
    const { host } = testHost([
      testModule({ id: "owner", env: ["OWNER_SECRET_FILE"] }),
      testModule({ id: "reader", envFromConfig: ["/name"] }, (ctx) => {
        reader = ctx;
      }),
    ], { env: { OWNER_SECRET_FILE: "/secret", MY_TOKEN: "t" }, sectionOf: (id) => (id === "reader" ? { name: "OWNER_SECRET_FILE" } : undefined) });
    await host.start();
    expect(reader.env.get("OWNER_SECRET_FILE")).toBeUndefined();
  });
});

describe("ctx.dataDir", () => {
  it("uses the manifest's dataDir.legacyPath under $DECK_DATA_DIR in place of modules/<id>", async () => {
    const data = makeDataDir();
    try {
      let ctx!: ServerModuleContext;
      const module = testModule({ id: "audit", dataDir: { legacyPath: "audit-v1" } }, (c) => void (ctx = c));
      await testHost([module], { env: { DECK_DATA_DIR: data.dir }, builtins: new Set([module]) }).host.start();
      expect(ctx.dataDir()).toBe(join(data.dir, "audit-v1"));
      expect(existsSync(join(data.dir, "audit-v1"))).toBe(true);
    } finally {
      data.cleanup();
    }
  });

  it("creates $DECK_DATA_DIR/modules/<id> lazily, on first call only", async () => {
    const data = makeDataDir();
    try {
      const { ctx } = await contextFor({ id: "audit" }, { env: { DECK_DATA_DIR: data.dir } });
      const expected = join(data.dir, "modules", "audit");
      expect(existsSync(expected)).toBe(false);
      expect(ctx.dataDir()).toBe(expected);
      expect(existsSync(expected)).toBe(true);
      expect(ctx.dataDir()).toBe(expected);
    } finally {
      data.cleanup();
    }
  });

  it("classifies a directory that cannot be created (L14)", async () => {
    const data = makeDataDir();
    try {
      writeFileSync(join(data.dir, "modules"), "not a directory");
      const { ctx } = await contextFor({ id: "audit" }, { env: { DECK_DATA_DIR: data.dir } });
      expect(() => ctx.dataDir()).toThrow(expect.objectContaining({ name: "ModuleDataDirError", code: "MODULE_DATA_DIR_INVALID", message: expect.stringContaining("cannot create") }));
    } finally {
      data.cleanup();
    }
  });

  it("boots without DECK_DATA_DIR, and throws a classified error only when called", async () => {
    const { ctx } = await contextFor({ id: "audit" });
    expect(() => ctx.dataDir()).toThrow(expect.objectContaining({ code: "MODULE_DATA_DIR_INVALID", message: expect.stringContaining("DECK_DATA_DIR is required") }));
    const relative = await contextFor({ id: "audit" }, { env: { DECK_DATA_DIR: "data" } });
    expect(() => relative.ctx.dataDir()).toThrow("must be absolute");
  });
});

describe("ctx.clock", () => {
  it("is the host's injected clock", async () => {
    const { ctx } = await contextFor({ id: "x" }, { clock: { now: () => 1234 } });
    expect(ctx.clock.now()).toBe(1234);
  });
});

describe("ctx.onStop", () => {
  it("runs hooks in reverse order across modules, awaiting each and isolating failures", async () => {
    const order: string[] = [];
    const { host, lines } = testHost([
      testModule({ id: "a" }, (ctx) => {
        ctx.onStop(() => void order.push("a1"));
        ctx.onStop(async () => {
          await Promise.resolve();
          order.push("a2");
        });
      }),
      testModule({ id: "b", dependsOn: ["a"] }, (ctx) => {
        ctx.onStop(() => {
          throw new Error("teardown broke");
        });
        ctx.onStop(() => void order.push("b2"));
      }),
    ]);
    await host.start();
    await expect(host.stop()).resolves.toBeUndefined();
    expect(order).toEqual(["b2", "a2", "a1"]);
    expect(lines).toContainEqual(expect.objectContaining({ module: "b", event: "b.stop-error", error: "teardown broke", level: 50 }));
  });
});

describe("ctx.health", () => {
  it("reports every module by id: reported, default ok, failing, malformed and disabled", async () => {
    const { host } = testHost([
      testModule({ id: "reported", health: { legacyKey: "reportedLegacy" } }, (ctx) =>
        ctx.health.report(() => ({ state: "degraded", detail: "backing off", data: { mode: "backoff" } }))),
      testModule({ id: "silent" }),
      testModule({ id: "throws" }, (ctx) => ctx.health.report(() => {
        throw new Error("x");
      })),
      testModule({ id: "malformed" }, (ctx) => ctx.health.report(() => ({ state: "green" }) as never)),
      testModule({ id: "off", enabledBy: { config: true } }),
    ]);
    await host.start();
    const snapshot = host.health();
    expect(Object.keys(snapshot.modules)).toEqual(["malformed", "off", "reported", "silent", "throws"]);
    expect(snapshot.modules).toEqual({
      malformed: { state: "error", detail: "Module health unavailable" },
      off: { state: "disabled", detail: "not enabled: no modules.off section" },
      reported: { state: "degraded", detail: "backing off", data: { mode: "backoff" } },
      silent: { state: "ok" },
      throws: { state: "error", detail: "Module health unavailable" },
    });
    expect(snapshot.legacy).toEqual({ reportedLegacy: { mode: "backoff" } });
  });

  it("omits a legacy key while the module reports no data", async () => {
    const { host } = testHost([testModule({ id: "x", health: { legacyKey: "k" } }, (ctx) => ctx.health.report(() => ({ state: "ok" })))]);
    await host.start();
    expect(host.health().legacy).toEqual({});
  });
});

describe("ctx.scheduler", () => {
  it("starts tasks only after every module initialised, and stops them with the host", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    let initialising = true;
    const { host } = testHost([
      testModule({ id: "a" }, (ctx) => {
        ctx.scheduler.schedule({ name: "poll", run, cadence: () => 0 });
      }),
      testModule({ id: "b", dependsOn: ["a"] }, async () => {
        await vi.advanceTimersByTimeAsync(100);
        expect(run).not.toHaveBeenCalled();
        initialising = false;
      }),
    ]);
    await host.start();
    expect(initialising).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await host.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("logs a failing run under the module's own event name and keeps the task alive", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { host, lines } = testHost([testModule({ id: "u" }, (ctx) => {
      ctx.scheduler.schedule({
        name: "poll",
        run: async () => {
          calls += 1;
          throw new Error("upstream 429");
        },
        cadence: ({ consecutiveFailures }) => 1_000 * 2 ** consecutiveFailures,
      });
    })]);
    await host.start();
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
    expect(calls).toBe(3);
    expect(lines).toContainEqual(expect.objectContaining({ module: "u", event: "u.task-error", task: "poll", phase: "run", error: "upstream 429" }));
    await host.stop();
  });
});

describe("ctx.providers.register", () => {
  it("passes timing and cadence through to the registry and returns its handle", async () => {
    const registerProvider = vi.fn(() => ({ wake() {}, async runNow() {}, stop: vi.fn() }));
    const provider = { id: "p", kind: "k", health: async () => ({ ok: true }), fetch: async () => 1 };
    const cadence = () => 5;
    const { host } = testHost([testModule({ id: "m" }, (ctx) => {
      ctx.providers.register(provider, { ttlMs: 10, cadence });
      ctx.providers.register({ ...provider, id: "q" });
    })], { registerProvider });
    await host.start();
    expect(registerProvider).toHaveBeenNthCalledWith(1, provider, { ttlMs: 10 }, cadence);
    expect(registerProvider).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: "q" }), undefined, undefined);
    await host.stop();
    for (const result of registerProvider.mock.results) expect(result.value.stop).toHaveBeenCalled();
  });

  it("polls a registered provider on its adaptive cadence in the real registry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let value = 0;
    let paused = false;
    const fetch = vi.fn(async () => {
      value += 1;
      if (value === 2) throw new Error("flaky");
      return value;
    });
    const failures: number[] = [];
    const handle = register(
      { id: "adaptive", kind: "test", health: async () => ({ ok: true }), fetch },
      { ttlMs: 60_000 },
      ({ lastRunAt, consecutiveFailures }) => {
        failures.push(consecutiveFailures);
        if (paused) return null;
        return lastRunAt === null ? 0 : 1_000;
      },
    );
    expect(fetch).not.toHaveBeenCalled(); // nothing polls before the scheduler starts
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(read("adaptive")).toMatchObject({ data: 1, freshness: { state: "fresh" } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read("adaptive")).toMatchObject({ data: 1, error: { message: "flaky" } });
    expect(failures).toContain(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read("adaptive")).toMatchObject({ data: 3, error: null });

    paused = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    await handle.runNow(); // a forced poll works while paused
    expect(fetch).toHaveBeenCalledTimes(4);
    paused = false;
    handle.wake();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(5);

    handle.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("joins a fixed-interval poll in flight from runNow() (C3)", async () => {
    let release!: (value: string) => void;
    const fetch = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    const handle = register({ id: "blocked", kind: "test", health: async () => ({ ok: true }), fetch });
    startScheduler(); // starts the first poll, which blocks on I/O
    await Promise.resolve();
    let refreshed = false;
    const refresh = handle.runNow().then(() => void (refreshed = true));
    await Promise.resolve();
    expect(refreshed).toBe(false); // still waiting on the in-flight fetch, not resolved early
    release("fresh");
    await refresh;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(read("blocked")).toMatchObject({ data: "fresh" });
  });

  it("makes stop() terminal for fixed-interval providers, even before the scheduler starts (C4)", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => 1);
    const early = register({ id: "early", kind: "test", health: async () => ({ ok: true }), fetch });
    await early.stop();
    startScheduler();
    await vi.advanceTimersByTimeAsync(120_000);
    await early.runNow();
    expect(fetch).not.toHaveBeenCalled();

    const late = register({ id: "late", kind: "test", health: async () => ({ ok: true }), fetch }, { pollIntervalMs: 1_000 });
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await late.stop();
    await late.runNow();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("polls an adaptive provider at once on start, even when its cadence starts long (L10)", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => "first");
    register({ id: "slow-cadence", kind: "test", health: async () => ({ ok: true }), fetch }, undefined, () => 3_600_000);
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(read("slow-cadence")).toMatchObject({ data: "first", freshness: { state: "fresh" } });
  });

  it("lets a provider stop itself from inside its own poll without deadlocking (N1)", async () => {
    let handle!: ReturnType<typeof register>;
    let selfStop: Promise<void> | undefined;
    const fetch = vi.fn(async () => {
      selfStop = handle.stop();
      await selfStop;
      return "last";
    });
    handle = register({ id: "self-stopper", kind: "test", health: async () => ({ ok: true }), fetch });
    await handle.runNow();
    await expect(selfStop).resolves.toBeUndefined();
    await handle.runNow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(read("self-stopper")).toMatchObject({ data: "last" });
  });

  it("refuses a cadence on a static provider instead of ignoring it (L10)", () => {
    expect(() =>
      register({ id: "l", kind: "link", health: async () => ({ ok: true }), fetch: async () => ({}) }, undefined, () => 1_000, { static: true }),
    ).toThrow("static");
  });

  it("takes staticness from the flag, not the kind name", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => "ok");
    register({ id: "named-link", kind: "link", health: async () => ({ ok: true }), fetch }, { pollIntervalMs: 500 });
    register({ id: "pinned", kind: "pin", health: async () => ({ ok: true }), fetch: async () => "fixed" }, undefined, undefined, { static: true });
    startScheduler();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(read("named-link")?.freshness.state).toBe("fresh");
    expect(read("pinned")).toMatchObject({ freshness: { state: "static", observedAt: null }, data: "fixed" });
  });

  it("keeps fixed-interval polling for providers registered without a cadence", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => "ok");
    register({ id: "fixed", kind: "test", health: async () => ({ ok: true }), fetch }, { pollIntervalMs: 500 });
    startScheduler();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
