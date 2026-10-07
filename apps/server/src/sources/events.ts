/**
 * Log-event shape and loggers for source failures (REQ-OBS-02, SC-13).
 *
 * The single place a source failure is logged. **Only** the source id, the failure kind,
 * and (optionally) the `SourceFailureCode` are ever emitted — never the credential value,
 * the tokenized remote URL, or the attempted absolute path (`attemptedPath` stays
 * server-internal, see `errors.ts`).
 */

import type { SourceFailureCode } from "./errors.js";
import { logger, type Logger } from "../log/logger.js";

/** The redaction-safe payload logged for any source failure (REQ-OBS-02, SC-13). */
export interface SourceLogEvent {
  /** The declaring source id (safe to log). */
  sourceId: string;
  /** A coarse failure kind for diagnosis, e.g. "clone" | "fetch" | "walk" | "read-local". */
  failureKind: string;
  /** The typed failure code, when the log originates from a `SourceFailure`. */
  code?: SourceFailureCode;
}

/**
 * Canonical failure logger used by the browsing routes (`05-http-routes.md`): logs the
 * event through the injected engine-core logger. Emits nothing beyond `SourceLogEvent`.
 */
export function logSourceFailure(logger: Logger, event: SourceLogEvent): void {
  logger.warn(event, "source.failure");
}

/**
 * Acquisition-side convenience (`02-acquisition-and-caching.md`) where no request logger is
 * threaded: logs the same `SourceLogEvent` via the module's engine-core logger. Same
 * redaction guarantee as `logSourceFailure` — id + kind only.
 */
export function logAcquireFailure(event: SourceLogEvent): void {
  logSourceFailure(logger, event);
}
