import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Finding } from "@deck/schema";

import { formatFindings, formatToolError } from "../cli/findings-format.js";
import { load, type LoaderResult } from "../config/load.js";
import {
  createLogger,
  type ConfigLoadEvent,
  type ServerStartEvent,
} from "../log/logger.js";
import { registerAllProviders } from "../providers/index.js";
import {
  listHealth,
  listMetrics,
  listProviders,
  providerCount,
  read,
  startScheduler,
  stopScheduler,
} from "../providers/registry.js";
import { createAuditStore } from "../actions/audit.js";
import { createActionExecutor } from "../actions/executor.js";
import { resolveActionsRuntime, type ActionsDeps } from "../actions/runtime.js";
import { createBunRunnerSpawner } from "../actions/spawn.js";
import { LlmUsageCollector } from "../llm-usage/collector.js";
import { resolveLlmUsageConfig } from "../llm-usage/config.js";
import type { LlmUsageDeps } from "../llm-usage/routes.js";
import { resolveMetricsRuntime } from "../metrics/runtime.js";
import { resolveSourcesRuntime, type SourcesDeps } from "../sources/runtime.js";
import { createApp, type ProviderReader } from "./app.js";

declare const Bun: {
  serve(options: {
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
  }): { stop(): void | Promise<void> };
};

export interface BootOptions {
  configDir?: string;
  port?: number;
  webDistDir?: string;
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
 * Runtime environment supplies defaults for the config directory, snapshot source,
 * and port. The returned handle stops both scheduler and HTTP server lifecycle.
 */
export async function boot(options: BootOptions = {}): Promise<BootHandle> {
  const startedAtMs = Date.now();
  const result = load({ arg: options.configDir });
  const logger = createLogger();
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

  // Resolve the sources capability once from config + env. Its per-source stores are threaded
  // into registerAllProviders (so registration stays the single register() site) and the same
  // reader is injected into createApp as deps.sources. A misconfiguration (an unusable cache
  // dir) fails fast with the same classified stderr + exit-2 posture as a bad estate config.
  let sourcesRuntime: SourcesDeps;
  try {
    sourcesRuntime = resolveSourcesRuntime(result.config, process.env);
  } catch (cause) {
    process.stderr.write(`${(cause as Error).message}\n`);
    process.exit(2);
  }

  // Read the optional snapshot source exactly once. It is never normalized, logged,
  // or added to DeckConfig/BootOptions; createSnapshotSource owns its one-time conversion.
  const snapshotSource = process.env.DECK_SNAPSHOT_SOURCE;
  // Provider registration and scheduler start can throw on a bad estate (e.g. a
  // duplicate provider id) or an unreadable snapshot source. Fail fast with the
  // same classified-stderr + exit-2 posture as a bad config, rather than letting
  // it surface as an unhandled rejection with a raw stack.
  try {
    registerAllProviders(result.config, {
      ...(snapshotSource === undefined ? {} : { snapshotSource }),
      sourceStores: sourcesRuntime.stores,
    });
    startScheduler();
  } catch (cause) {
    process.stderr.write(`${(cause as Error).message}\n`);
    process.exit(2);
  }
  const providers: ProviderReader = {
    read,
    count: providerCount,
    listHealth,
    listProviders,
    listMetrics,
  };
  // Resolve the opt-in /metrics capability once from env (DECK_METRICS_ENABLED; never throws).
  const metricsRuntime = resolveMetricsRuntime(process.env);

  // Resolve the actions capability once from env. When enabled, build the audit store
  // and executor (real Bun spawner) and inject them; when disabled, omit deps.actions
  // so every action route refuses 403. A misconfiguration (bad DECK_DATA_DIR,
  // DECK_RUNNERS_FILE, or manifest) fails fast with the same classified stderr +
  // exit-2 posture as a bad estate config, instead of an unhandled rejection.
  let actionsRuntime: ReturnType<typeof resolveActionsRuntime>;
  try {
    actionsRuntime = resolveActionsRuntime(process.env);
  } catch (cause) {
    process.stderr.write(`${(cause as Error).message}\n`);
    process.exit(2);
  }
  let actions: ActionsDeps | undefined;
  if (actionsRuntime.enabled) {
    const audit = createAuditStore(actionsRuntime.dataDir, logger);
    const executor = createActionExecutor({
      spawner: createBunRunnerSpawner(),
      audit,
      timeoutMs: actionsRuntime.timeoutMs,
      logger,
    });
    actions = { runtime: actionsRuntime, executor, audit };
  }

  // Resolve the optional llmUsage section once. An absent section leaves the feature off
  // (no collector, no polling, no ingest route); a bad value (e.g. an unparseable
  // duration) fails fast like any other config error. The ingest token is read from the
  // env var the config names, never from the config itself.
  let llmUsage: LlmUsageDeps | undefined;
  try {
    const usageConfig = resolveLlmUsageConfig(result.config);
    if (usageConfig !== null) {
      const tokenEnv = usageConfig.claude?.statusLineCredentialEnv;
      const ingestToken = tokenEnv ? process.env[tokenEnv] || null : null;
      if (tokenEnv && ingestToken === null) {
        logger.warn({ event: "llm-usage.ingest-disabled", credentialEnv: tokenEnv }, "statusLine ingest env var unset; ingest route not registered");
      }
      llmUsage = { collector: new LlmUsageCollector(usageConfig), ingestToken };
    }
  } catch (cause) {
    process.stderr.write(`${(cause as Error).message}\n`);
    process.exit(2);
  }

  const app = createApp({
    config: result.config,
    providers,
    logger,
    ...(actions === undefined ? {} : { actions }),
    sources: sourcesRuntime.reader,
    ...(llmUsage === undefined ? {} : { llmUsage }),
    metricsEnabled: metricsRuntime.enabled,
    ...(options.webDistDir === undefined ? {} : { webDistDir: options.webDistDir }),
    startedAtMs,
  });
  const envPort = Number(process.env.DECK_PORT);
  const port = options.port ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : 8080);
  const server = Bun.serve({ port, fetch: app.fetch });
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
    async stop() {
      stopScheduler();
      llmUsage?.collector.stop();
      await server.stop();
    },
  };
}

function countFindings(findings: readonly Finding[]): ConfigLoadEvent["counts"] {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

if (import.meta.main) {
  // A built web app (vite build → dist) is served as static assets when
  // DECK_WEB_DIST points at it; unset means API-only (dev proxies /api instead).
  const webDistDir = process.env.DECK_WEB_DIST;
  // Any unexpected boot rejection (e.g. Bun.serve failing to bind the port) exits
  // non-zero with a message instead of an unhandled rejection with a raw stack.
  boot(webDistDir ? { webDistDir: resolve(webDistDir) } : {}).catch((cause: unknown) => {
    process.stderr.write(`${(cause as Error)?.message ?? String(cause)}\n`);
    process.exit(1);
  });
}
