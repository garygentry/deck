import type { Logger } from "pino";

import type { ServerStopEvent } from "../log/logger.js";

export const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;
type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

/**
 * Default overall shutdown deadline: under Docker's default 10s stop grace period, so deck
 * exits on its own terms before it would be SIGKILLed.
 */
export const DEFAULT_SHUTDOWN_DEADLINE_MS = 9_000;

/** The slice of `process` shutdown needs; tests pass a fake. */
export interface SignalSource {
  on(signal: ShutdownSignal, listener: () => void): unknown;
}

export interface ShutdownOptions {
  proc?: SignalSource;
  exit?: (code: 0 | 1) => void;
  logger: Pick<Logger, "info" | "warn" | "error">;
  /** Overall bound from the first signal to exit (default {@link DEFAULT_SHUTDOWN_DEADLINE_MS}). */
  deadlineMs?: number;
}

/**
 * Stop deck on SIGTERM (`docker stop`) or SIGINT (Ctrl-C): run `stop()` and exit 0 once it
 * settles, or 1 when it fails. The whole shutdown, including a boot still in progress that
 * `stop()` waits for, is bounded by a deadline: past it deck exits 1 without waiting. A
 * second signal while stopping exits 1 at once.
 */
export function installShutdown(handle: { stop(): Promise<void> }, options: ShutdownOptions): void {
  const proc = options.proc ?? process;
  const exit = options.exit ?? ((code) => process.exit(code));
  const deadlineMs = options.deadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS;
  const { logger } = options;
  let stopping = false;
  let exited = false;
  const log = (level: "info" | "warn" | "error", event: ServerStopEvent, message: string) =>
    logger[level](event, message);
  const finish = (code: 0 | 1) => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  const onSignal = (signal: ShutdownSignal) => {
    if (stopping) {
      log("warn", { event: "server.stop", signal, phase: "forced" }, "second signal; exiting without waiting");
      finish(1);
      return;
    }
    stopping = true;
    log("info", { event: "server.stop", signal, phase: "stopping" }, "stopping");
    const deadline = setTimeout(() => {
      log("error", { event: "server.stop", signal, phase: "deadline", deadlineMs }, "shutdown deadline passed; exiting");
      finish(1);
    }, deadlineMs);
    handle.stop().then(
      () => {
        clearTimeout(deadline);
        log("info", { event: "server.stop", signal, phase: "stopped" }, "stopped");
        finish(0);
      },
      (error: unknown) => {
        clearTimeout(deadline);
        log("error", { event: "server.stop", signal, phase: "failed", error: String(error) }, "stop failed");
        finish(1);
      },
    );
  };
  for (const signal of SHUTDOWN_SIGNALS) proc.on(signal, () => onSignal(signal));
}
