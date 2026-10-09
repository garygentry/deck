import type { MiddlewareHandler } from "hono";
import pino, { type Logger } from "pino";

export type { Logger } from "pino";

import type { FreshnessState } from "../contract/index.js";

export interface LoggerOptions {
  level?: string;
  base?: Record<string, unknown>;
}

export interface ServerStartEvent {
  event: "server.start";
  port: number;
  providerCount: number;
  webDist: "present" | "missing";
}

export interface ServerStopEvent {
  event: "server.stop";
  signal: "SIGTERM" | "SIGINT";
  /**
   * `stopping` when the signal arrives; `stopped`/`failed` once shutdown settles; `forced` on
   * a repeat signal; `deadline` when shutdown outlived its overall deadline.
   */
  phase: "stopping" | "stopped" | "failed" | "forced" | "deadline";
  error?: string;
  deadlineMs?: number;
}

export interface ServerStopForcedEvent {
  /** In-flight requests outlived the grace period after the listener closed; their connections were closed. */
  event: "server.stop-forced";
  graceMs: number;
}

export interface ServerStopStageTimeoutEvent {
  /** A shutdown stage outlived its bound; shutdown moved on to the next stage. */
  event: "server.stop-stage-timeout";
  stage: "modules";
  boundMs: number;
}

export interface ConfigLoadEvent {
  event: "config.load";
  result: "clean" | "findings" | "error";
  counts: { error: number; warning: number; info: number };
  configDir: string;
}

export interface ConfigReloadEvent {
  /** The config directory changed and was read again (`ui` hot reload). */
  event: "config.reload";
  /**
   * `applied`: only `ui` changed, and the new UI is served. `unchanged`: nothing to swap.
   * `invalid`: the config does not load; the last good one is kept. `restart-required`: a
   * key outside `ui` changed; the last good config is kept until deck restarts.
   */
  result: "applied" | "unchanged" | "invalid" | "restart-required";
  configDir: string;
  /** The top-level keys that differ from the config deck started with (`restart-required`). */
  changedKeys?: string[];
  /** Why the config does not load (`invalid`). */
  reason?: string;
}

export interface ConfigWatchEvent {
  /** The config directory watch: armed at boot, lost (directory gone or watch failed), re-armed. */
  event: "config.watch";
  state: "armed" | "lost" | "rearmed";
  configDir: string;
  error?: string;
}

export interface ProviderPollEvent {
  event: "provider.poll";
  id: string;
  kind: string;
  ok: boolean;
  latencyMs: number;
  from: FreshnessState;
  to: FreshnessState;
}

export interface SnapshotReadEvent {
  /** Stable structured-event discriminator. */
  event: "snapshot.read";
  /** Sanitized source class; never the configured location. */
  sourceKind: "path" | "url";
  /** High-level read result without document or arbitrary error text. */
  outcome: "clean" | "findings" | "unchanged" | "refused";
  /** Stable sanitized refusal code when outcome is refused. */
  failureClass?: string;
  /** Upstream status only for HTTP status refusals. */
  httpStatus?: number;
  /** Number of validator findings for an accepted changed read. */
  findingsCount: number;
  /** Number of source bytes consumed for this attempt. */
  bytes: number;
  /** Total source/provider attempt duration in milliseconds. */
  durationMs: number;
}

export interface RequestLogEvent {
  event: "request";
  method: string;
  path: string;
  status: number;
  durationMs: number;
}


export interface ModuleInitEvent {
  /** A module's init completed. */
  event: "module.init";
  module: string;
  durationMs: number;
}

export interface ModuleStopEvent {
  /** A module's scheduled work drained (or timed out) and its stop hooks ran. */
  event: "module.stop";
  module: string;
}

export interface ModuleDisabledEvent {
  /** A module is not running: not enabled by config/env, or refused by the host. */
  event: "module.disabled";
  module: string;
  reason: string;
  /** Module-host finding code when the host refused it; absent when simply not enabled. */
  code?: string;
}

export interface RuntimeModulesEvent {
  /**
   * The runtime modules directory was read: which modules' server code was imported, and
   * which failed to load (each also logs `module.disabled`). Imported code runs inside deck
   * with all of its privileges.
   */
  event: "modules.runtime";
  dir: string;
  /** Whether DECK_MODULES_ENABLED is on; when off, no runtime module code is loaded. */
  enabled: boolean;
  loaded: string[];
  failed: string[];
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return pino({
    level: options.level ?? process.env.DECK_LOG_LEVEL ?? "info",
    base: options.base,
  });
}

/** Shared process logger used by runtime modules that are not dependency-injected. */
export const logger = createLogger();

export function requestLogger(log: Logger): MiddlewareHandler {
  return async (context, next) => {
    const startedAt = performance.now();
    try {
      await next();
    } finally {
      const event: RequestLogEvent = {
        event: "request",
        method: context.req.method,
        path: context.req.path,
        status: context.res.status,
        durationMs: performance.now() - startedAt,
      };

      if (event.status >= 500) log.warn(event, "request");
      else log.info(event, "request");
    }
  };
}
