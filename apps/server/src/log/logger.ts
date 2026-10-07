import type { MiddlewareHandler } from "hono";
import pino, { type Logger } from "pino";

export type { Logger } from "pino";

import type { ActionOutcome } from "../actions/events.js";
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

export interface ConfigLoadEvent {
  event: "config.load";
  result: "clean" | "findings" | "error";
  counts: { error: number; warning: number; info: number };
  configDir: string;
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

export interface ActionRunLogEvent {
  /** Stable structured-event discriminator (governed actions, 02 §5.10). */
  event: "action.run";
  /** Declared action id. */
  actionId: string;
  /** Declared runner NAME — never the resolved absolute path. */
  runner: string;
  /** Terminal outcome of the run. */
  outcome: ActionOutcome;
  /** Wall-clock run duration in milliseconds. */
  durationMs: number;
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
