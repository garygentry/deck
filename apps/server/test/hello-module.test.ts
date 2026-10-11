import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { ServerModule } from "@deck/module-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isKernelPath, kernelTouches } from "../../../scripts/kernel-touch.js";
import { load } from "../src/config/load.js";
import { BUILTIN_MODULES } from "../src/modules/builtin.js";
import { createModuleHost, startModules } from "../src/modules/host.js";
import { registerAllProviders } from "../src/providers/index.js";
import { listHealth, listProviders, providerCount, read, setProjections, startScheduler, stopScheduler } from "../src/providers/registry.js";
import { createApp, planningRouteTable, RESERVED_ROOT_PATHS } from "../src/server/app.js";
import { buildUiManifest } from "../src/ui/manifest.js";
import { helloModule } from "./fixtures/modules/hello/module.js";
import { captureLogger } from "./util/modules.js";
import { makeConfigDir } from "./util/tmp-config.js";

const REPO_ROOT = resolve(__dirname, "../../..");

/** Everything this fixture module adds to the repo. */
const FIXTURE_FILES = ["apps/server/test/fixtures/modules/hello/module.ts", "apps/server/test/hello-module.test.ts"];

const MODULES: readonly ServerModule<any>[] = [...BUILTIN_MODULES, helloModule];

const cleanups: Array<() => void> = [];
afterEach(() => {
  stopScheduler();
  while (cleanups.length) cleanups.pop()!();
});

/** An estate using every hello contribution: its section and one `hello-feed` instance. */
function estate(greeting = "Hello, deck") {
  const dir = makeConfigDir({
    "00-base.yaml": { schemaVersion: 2, estate: { name: "hello" } },
    "10-overlay.yaml": {
      schemaVersion: 2,
      modules: { hello: { greeting } },
      integrations: [{ id: "greeter", kind: "hello-feed", title: "Greeter", baseUrl: "http://greeter.invalid" }],
    },
  });
  cleanups.push(dir.cleanup);
  return dir.dir;
}

/** Load, plan, register, start and serve the modules exactly as `boot.ts` does. */
async function serve(configDir: string) {
  const result = load({ arg: configDir, modules: MODULES, env: {} });
  if (result.exitClass !== 0) throw new Error(`config did not load: ${JSON.stringify(result.findings)}`);
  const { logger } = captureLogger();
  const sections = (result.config as { modules?: Record<string, unknown> }).modules;
  const host = createModuleHost({
    modules: MODULES,
    sectionOf: (id) => sections?.[id],
    instancesOf: (list) => result.config[list] ?? [],
    env: {},
    builtins: new Set(BUILTIN_MODULES),
    logger,
    manifestProblems: result.moduleProblems,
    kernelRoutes: planningRouteTable(),
    reservedRootPaths: RESERVED_ROOT_PATHS,
  });
  registerAllProviders(result.config, host.kindHandlers());
  await startModules(host);
  startScheduler();
  const providers = { read, count: providerCount, listHealth, listProviders, setProjections };
  const ui = buildUiManifest({ config: result.config, providers, modules: host, capabilities: {} });
  return createApp({ config: result.config, providers, logger, modules: host, ui });
}

describe("a fixture module added beside the built-ins (hello)", () => {
  it("contributes the modules.hello config key", () => {
    expect(load({ arg: estate(), modules: MODULES, env: {} }).exitClass).toBe(0);
    // Without the module the same key is unknown.
    const without = load({ arg: estate(), env: {} });
    expect(without.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "MODULE_UNKNOWN" })]));
  });

  it("contributes a config rule with its own finding code", () => {
    const result = load({ arg: estate("HELLO, DECK"), modules: MODULES, env: {} });
    expect(result.findings).toEqual([
      expect.objectContaining({ code: "HELLO_SHOUTING", severity: "warning", path: "/modules/hello/greeting" }),
    ]);
  });

  it("contributes a provider kind: each hello-feed instance becomes a polled provider", async () => {
    const app = await serve(estate());
    expect(await (await app.request("/api/providers")).json()).toEqual({
      providers: expect.arrayContaining([{ id: "greeter", kind: "hello-feed" }]),
    });
    await vi.waitFor(async () => {
      const envelope = await (await app.request("/api/providers/greeter")).json();
      expect(envelope.data).toEqual({ feed: "greeter", greeting: "Hello, deck" });
    });
  });

  it("contributes a route under /api/m/hello", async () => {
    const app = await serve(estate());
    const response = await app.request("/api/m/hello/greeting");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ greeting: "Hello, deck" });
  });

  it("contributes a health entry, and appears enabled in the UI manifest", async () => {
    const app = await serve(estate());
    const health = await (await app.request("/api/health")).json();
    expect(health.modules.hello).toEqual(expect.objectContaining({ state: "ok", detail: "greeting: Hello, deck" }));
    const ui = await (await app.request("/api/ui")).json();
    expect(ui.modules).toEqual(expect.arrayContaining([expect.objectContaining({ id: "hello", enabled: true })]));
  });

  it("touches no kernel file: kernel-touch counts 0 for everything it adds", () => {
    for (const path of FIXTURE_FILES) expect(existsSync(resolve(REPO_ROOT, path)), path).toBe(true);
    expect(FIXTURE_FILES.filter(isKernelPath)).toEqual([]);
    expect(kernelTouches(FIXTURE_FILES)).toEqual([]);
    expect(BUILTIN_MODULES).not.toContain(helloModule);
  });
});
