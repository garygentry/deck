import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { apiErrorBody, type ServerModule, type UiManifest } from "@deck/module-sdk";
import type { Finding } from "@deck/schema";

import { formatFindings, formatToolError } from "../cli/findings-format.js";
import { load, type LoaderResult } from "../config/load.js";
import {
  createLogger,
  type ConfigLoadEvent,
  type RuntimeModulesEvent,
  type ServerStartEvent,
  type ServerStopForcedEvent,
  type ServerStopStageTimeoutEvent,
} from "../log/logger.js";
import { registerAllProviders } from "../providers/index.js";
import {
  listHealth,
  listProviders,
  providerCount,
  read,
  setProjections,
  startScheduler,
  stopScheduler,
} from "../providers/registry.js";
import { BUILTIN_MODULES } from "../modules/builtin.js";
import { buildUiManifest } from "../ui/manifest.js";
import { createUiReloader, etagOf, type LiveUi, type UiReloader } from "../ui/live.js";
import { collectRuntimePages, runtimePageSources } from "../ui/runtime-pages.js";
import { createModuleHost, startModules, type ModuleHost } from "../modules/host.js";
import { checkPins, loadRuntimeModules, MODULES_ENABLED_ENV, NO_RUNTIME_MODULES, type RuntimeModules } from "../modules/runtime.js";
import { parseBool } from "../config/env.js";
import { settlesWithin } from "./settle.js";
import { FORCE_CLOSE_WAIT_MS, resolveStopTimings, type StopTimings } from "./stop-timings.js";
import { installShutdown, type ShutdownOptions } from "./shutdown.js";
import { createApp, planningRouteTable, RESERVED_ROOT_PATHS, type AppDeps, type ProviderReader } from "./app.js";

declare const Bun: {
  serve(options: {
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
  }): { stop(closeActiveConnections?: boolean): void | Promise<void> };
};

export interface BootOptions {
  configDir?: string;
  port?: number;
  webDistDir?: string;
  /**
   * The server modules to run (default: the built-in modules). Runtime modules from
   * DECK_MODULES_DIR are added to them.
   */
  modules?: readonly ServerModule<any>[];
  /** Shutdown stage bounds; defaults in `stop-timings.ts`. */
  shutdown?: StopTimings;
  /**
   * `ui` hot reload: watch the config directory and swap the UI manifest when only `ui`
   * changes (default on). `false` turns it off; `debounceMs` sets how long the directory must
   * be quiet before it is read again.
   */
  uiReload?: false | { debounceMs?: number };
  /** Bound on importing each runtime module's server entry (default 10 s; tests shorten it). */
  runtimeImportTimeoutMs?: number;
}

/** What a request that arrives once shutdown has begun gets. */
function shuttingDown(): Response {
  return Response.json(apiErrorBody("Server is shutting down", "SHUTTING_DOWN"), {
    status: 503,
    headers: { connection: "close" },
  });
}

export interface BootHandle {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  stop(): Promise<void>;
}

type Exit = (code: 1 | 2) => never;

/** Print an already-classified loader failure and terminate without reclassifying it. */
export function failFast(
  result: LoaderResult,
  exit: Exit = (code) => process.exit(code),
): asserts result is Extract<LoaderResult, { exitClass: 0 }> {
  if (result.exitClass === 0) return;
  const message = result.exitClass === 1
    ? formatFindings(result.findings)
    : formatToolError(result.toolError);
  process.stderr.write(`${message}\n`);
  exit(result.exitClass);
}

/**
 * Load estate configuration, register providers, start polling, and serve Deck.
 * Runtime environment supplies defaults for the config directory and port; modules read
 * the variables they own. The returned handle stops both scheduler and HTTP server lifecycle.
 */
export async function boot(options: BootOptions = {}): Promise<BootHandle> {
  const startedAtMs = Date.now();
  const logger = createLogger();
  // Runtime modules load before config, since their manifests and rules are part of the
  // contract config is validated against. Only a module that would run has its code imported,
  // and one that fails to load is disabled (logged below) while boot goes on.
  let runtime: RuntimeModules = NO_RUNTIME_MODULES;
  try {
    runtime = await loadRuntimeModules({
      env: process.env,
      ...(options.configDir === undefined ? {} : { configDir: options.configDir }),
      ...(options.runtimeImportTimeoutMs === undefined ? {} : { importTimeoutMs: options.runtimeImportTimeoutMs }),
    });
  } catch (cause) {
    process.stderr.write(`${(cause as Error).message}\n`);
    process.exit(2);
  }
  if (runtime.dir !== undefined) {
    const event = {
      event: "modules.runtime",
      dir: runtime.dir,
      enabled: parseBool(process.env[MODULES_ENABLED_ENV], false),
      loaded: [...runtime.loaded],
      failed: [...runtime.loadProblems.keys()],
      rejected: [...runtime.rejected],
    } satisfies RuntimeModulesEvent;
    if (runtime.rejected.length > 0) logger.warn(event, "runtime modules read; some directories left out");
    else logger.info(event, "runtime modules read");
  }
  const serverModules = [...(options.modules ?? BUILTIN_MODULES), ...runtime.modules];
  const stopTimings = resolveStopTimings(options.shutdown);
  const loadOptions = {
    arg: options.configDir,
    boot: true,
    ...(options.modules === undefined && runtime.modules.length === 0 ? {} : { modules: serverModules, runtime }),
  };
  const result = load(loadOptions);
  const configDir = resolve(
    options.configDir ?? process.env.DECK_CONFIG_DIR ?? "config",
  );
  logger.info(
    {
      event: "config.load",
      result: result.exitClass === 0 ? "clean" : result.exitClass === 1 ? "findings" : "error",
      counts: countFindings(result.findings),
      configDir,
    } satisfies ConfigLoadEvent,
    "config loaded",
  );

  failFast(result);
  // What was loaded was decided from the config as read before validation; it must be the
  // config that validated.
  const changed = checkPins(runtime, result.config as Parameters<typeof checkPins>[1]);
  if (changed !== null) {
    process.stderr.write(`${changed}\n`);
    process.exit(2);
  }

  // Plan modules from their manifests against the kernel's planning route table (the one
  // config validation used). Modules that cannot coexist fail fast (classified stderr,
  // exit 2); a module refused on its own (bad manifest, kernel route collision, API skew,
  // missing dependency) is disabled with a logged finding and boot continues. Planning runs
  // no module code: each enabled module's init runs later, in dependency order, so
  // providers it registers start with the rest.
  let modules: ModuleHost;
  try {
    const moduleSections = (result.config as { modules?: Record<string, unknown> }).modules;
    modules = createModuleHost({
      modules: serverModules,
      sectionOf: (id) => moduleSections?.[id],
      instancesOf: (list) => result.config[list] ?? [],
      env: process.env,
      builtins: new Set(BUILTIN_MODULES),
      runtime,
      logger,
      // Modules config validation found broken (a contribution that did not compose, a
      // config rule that failed) are disabled here, before their code runs.
      manifestProblems: result.moduleProblems,
      // The same config-independent table config loading planned with, so boot runs exactly
      // the modules whose sections were validated.
      kernelRoutes: planningRouteTable(),
      reservedRootPaths: RESERVED_ROOT_PATHS,
      drainTimeoutMs: stopTimings.drainTimeoutMs,
      hookTimeoutMs: stopTimings.hookTimeoutMs,
      stageTimeoutMs: stopTimings.modulesMs,
    });
  } catch (cause) {
    process.stderr.write(`${(cause as Error).message}\n`);
    process.exit(2);
  }
  // Providers are registered once modules are planned, since enabled modules' kind handlers
  // turn estate declarations into providers, and before any module init runs. Registration
  // and scheduler start can throw on a bad estate (e.g. a duplicate provider id) or a
  // deployment setting a built-in module cannot start with. Fail fast with the same classified-stderr + exit-2 posture
  // as a bad config, rather than letting it surface as an unhandled rejection with a raw stack.
  try {
    registerAllProviders(result.config, modules.kindHandlers());
  } catch (cause) {
    process.stderr.write(`${(cause as Error).message}\n`);
    process.exit(2);
  }
  const providers: ProviderReader = {
    read,
    count: providerCount,
    listHealth,
    listProviders,
    setProjections,
  };

  const kernelDeps: AppDeps = {
    config: result.config,
    providers,
    logger,
    ...(options.webDistDir === undefined ? {} : { webDistDir: options.webDistDir }),
    startedAtMs,
  };
  await startModules(modules);

  try {
    startScheduler();
  } catch (cause) {
    process.stderr.write(`${(cause as Error).message}\n`);
    process.exit(2);
  }

  // The UI manifest: modules and providers are fixed from here on, and so is the config but
  // for `ui`, which a hot reload may swap (with the manifest resolved from it).
  // Pages built-in modules contribute at runtime: a change to them rebuilds the manifest from
  // the config in force.
  const pageSources = runtimePageSources(modules);
  const buildUi = (config: typeof result.config) =>
    buildUiManifest({ config, providers, modules, capabilities: {}, runtimePages: () => collectRuntimePages(pageSources) });
  let ui: UiManifest;
  try {
    ui = buildUi(result.config);
  } catch (cause) {
    process.stderr.write(`${(cause as Error).message}\n`);
    process.exit(2);
  }
  let reloader: UiReloader | undefined;
  if (options.uiReload !== false) {
    reloader = createUiReloader({
      configDir,
      config: result.config,
      ui,
      load: () => load({ ...loadOptions, arg: configDir }),
      build: buildUi,
      logger,
      ...(options.uiReload?.debounceMs === undefined ? {} : { debounceMs: options.uiReload.debounceMs }),
    });
  }

  // Without hot reload the manifest is fixed but for the pages modules contribute at runtime.
  let fixedUi: LiveUi = { config: result.config, ui, etag: etagOf(ui) };
  const rebuildUi = () => {
    if (reloader !== undefined) {
      reloader.rebuild();
      return;
    }
    try {
      const next = buildUi(result.config);
      fixedUi = { config: result.config, ui: next, etag: etagOf(next) };
    } catch {
      logger.warn({ event: "ui.rebuild", result: "failed" }, "UI manifest rebuild failed; keeping the one served");
    }
  };
  for (const { source } of pageSources) source.subscribe(rebuildUi);

  // Mounting re-checks module routes against the live kernel table (a backstop).
  let app: ReturnType<typeof createApp>;
  try {
    app = createApp({ ...kernelDeps, modules, ui, live: reloader === undefined ? () => fixedUi : reloader.current });
  } catch (cause) {
    process.stderr.write(`${(cause as Error).message}\n`);
    process.exit(2);
  }
  const envPort = Number(process.env.DECK_PORT);
  const port = options.port ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : 8080);
  // Once shutdown begins nothing new reaches the app, including a request on a kept-alive
  // connection the closed listener no longer governs: it gets a 503 and the connection closes.
  let stopping = false;
  const server = Bun.serve({
    port,
    fetch: (request) => (stopping ? shuttingDown() : app.fetch(request)),
  });
  const webDist = options.webDistDir !== undefined && existsSync(options.webDistDir)
    ? "present"
    : "missing";
  const startEvent = {
    event: "server.start",
    port,
    providerCount: providerCount(),
    webDist,
  } satisfies ServerStartEvent;
  if (options.webDistDir !== undefined && webDist === "missing") {
    logger.warn(startEvent, "web dist missing; server started without static assets");
  } else {
    logger.info(startEvent, "server started");
  }

  return {
    server,
    port,
    /**
     * Stop in stages, each bounded (defaults in `stop-timings.ts`):
     * 1. close the listener (no new requests; in-flight ones continue);
     * 2. stop the modules: early stop hooks start at once (cancelling in-flight work), beside
     *    each module's ordered stop (drain, then its stop hooks);
     * 3. stop provider polling;
     * 4. give in-flight requests `graceMs` to finish, then close their connections.
     */
    async stop() {
      stopping = true;
      reloader?.stop();
      const drained = Promise.resolve(server.stop());
      if (!(await settlesWithin(modules.stop(), stopTimings.modulesMs))) {
        logger.warn({ event: "server.stop-stage-timeout", stage: "modules", boundMs: stopTimings.modulesMs } satisfies ServerStopStageTimeoutEvent, "modules still stopping; continuing");
      }
      stopScheduler();
      if (!(await settlesWithin(drained, stopTimings.graceMs))) {
        logger.warn({ event: "server.stop-forced", graceMs: stopTimings.graceMs } satisfies ServerStopForcedEvent, "requests still in flight; closing their connections");
        // Closing is immediate; Bun's promise can stay pending on a response stream that
        // never ends, so it is not awaited past a short bound.
        await settlesWithin(Promise.resolve(server.stop(true)), FORCE_CLOSE_WAIT_MS);
      }
    },
  };
}

function countFindings(findings: readonly Finding[]): ConfigLoadEvent["counts"] {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

export interface MainOptions extends BootOptions {
  /** Overall shutdown deadline after a signal (default 9s). */
  shutdownDeadlineMs?: number;
}

/**
 * Run deck as a process: boot, and stop cleanly on SIGTERM (`docker stop`) or SIGINT. The
 * handler is installed before boot settles, so a signal during startup waits for boot and
 * then stops, all within the shutdown deadline. A boot failure exits 1.
 */
export function main(options: MainOptions = {}): void {
  const { shutdownDeadlineMs, ...bootOptions } = options;
  const booted = boot(bootOptions);
  booted.catch((cause: unknown) => {
    // Any unexpected boot rejection (e.g. Bun.serve failing to bind the port) exits
    // non-zero with a message instead of an unhandled rejection with a raw stack.
    process.stderr.write(`${(cause as Error)?.message ?? String(cause)}\n`);
    process.exit(1);
  });
  const shutdown: ShutdownOptions = {
    logger: createLogger(),
    ...(shutdownDeadlineMs === undefined ? {} : { deadlineMs: shutdownDeadlineMs }),
  };
  installShutdown({ stop: async () => (await booted).stop() }, shutdown);
}

if (import.meta.main) {
  // A built web app (vite build → dist) is served as static assets when
  // DECK_WEB_DIST points at it; unset means API-only (dev proxies /api instead).
  const webDistDir = process.env.DECK_WEB_DIST;
  main(webDistDir ? { webDistDir: resolve(webDistDir) } : {});
}
