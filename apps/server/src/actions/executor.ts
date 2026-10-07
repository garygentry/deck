/**
 * The action executor: run registry, spawn → stream → terminal-outcome drive loop,
 * timeout enforcement, cancellation, disconnect decoupling, and output teeing.
 *
 * `ActionExecutor`, `RunHandle`, and `ResolvedInvocation` are the seam types,
 * defined here. The drive loop mirrors the provider registry's
 * `AbortController` + `withTimeout` + `clearTimeout`-in-`finally` idiom
 * (apps/server/src/providers/registry.ts) and always produces exactly one terminal
 * `end` event and exactly one appended `AuditEntry`.
 */
import { randomUUID } from "node:crypto";


import type {
  AuditEntry,
  AuditOutputSink,
  AuditStore,
  AuditTarget,
} from "./audit.js";
import type { ActionOutcome, ActionRunEvent, ActionRunLogEvent, StructuredRunnerInput } from "./events.js";
import { normalizeActionFailure } from "./errors.js";
import type { ResolvedParams } from "./validate.js";
import type { ActionsLogger } from "./runtime.js";
import type { RunnerSpawner, SpawnedRun } from "./spawn.js";
import { settlesWithin } from "../server/settle.js";

/**
 * Starts and cancels runs, owns the run registry, and enforces the timeout. It is
 * gate-agnostic: pre-run refusals are decided in the route before the
 * executor is reached; the executor's job is spawn -> stream -> terminal outcome.
 */
export interface ActionExecutor {
  /**
   * Begin a run for a resolved, validated invocation. Returns an async iterable of wire
   * events — `run` first, `stdout`/`stderr` interleaved, `end` last. The run is
   * registered under its runId and decoupled from the caller's lifecycle: if the consumer
   * stops reading (client disconnect), the child still runs to completion and the audit
   * entry + `.log` are still written.
   */
  start(invocation: ResolvedInvocation): AsyncIterable<ActionRunEvent>;
  /**
   * Cancel an in-flight run by id. Returns true if a live run was found and killed
   * (outcome -> "cancelled"); false for unknown/finished ids (route maps to 404).
   */
  cancel(runId: string): boolean;
  /**
   * Cancel every in-flight run (shutdown). Resolves once each cancelled run has settled:
   * its child is gone, its terminal `end` is emitted and its audit index line (outcome
   * `cancelled`) is appended. Resolves with how many runs were cancelled.
   */
  cancelAll(): Promise<number>;
}

/** Default time a cancelled or timed-out child gets between SIGTERM and SIGKILL. */
export const DEFAULT_KILL_GRACE_MS = 1_000;
/** Default bound on draining a killed child's output pipes once it has exited. */
export const DEFAULT_PUMP_DRAIN_MS = 500;

/** In-memory handle for one in-flight run, held in the executor's registry. */
export interface RunHandle {
  runId: string;
  actionId: string;
  /** Aborts the run (timeout or cancel) via the same AbortController idiom as providers. */
  controller: AbortController;
  /**
   * The spawned child. Undefined until `spawner.spawn()` returns — before then a cancel
   * aborts via `controller`, which the drive loop checks around the spawn call.
   */
  spawned?: SpawnedRun;
  /**
   * Set by `cancel()` so the shared abort path (also used by the timeout) records the
   * `cancelled` outcome rather than `timed-out`. Absent for a timeout.
   */
  cancelReason?: "cancelled";
  /** The run's drive loop; settles after its audit index line is appended. */
  done?: Promise<void>;
}

/** A fully-gated, resolved invocation handed to the executor (all refusals passed). */
export interface ResolvedInvocation {
  actionId: string;
  /** Declared runner NAME (for audit); the executable path is resolved separately. */
  runner: string;
  /** Absolute executable path resolved from the manifest allowlist. */
  executable: string;
  /** Validated parameter values. */
  params: ResolvedParams;
  /** Optional target. */
  target?: AuditTarget;
  /** Request origin string for the audit entry. */
  source: string;
}

/** Injected collaborators for the executor (mirrors the ProviderReader seam). */
export interface ActionExecutorOptions {
  /** Spawns the allowlisted executable (real Bun spawner in prod, fake in tests). */
  spawner: RunnerSpawner;
  /** Two-tier audit store; the executor tees output + appends the terminal entry. */
  audit: AuditStore;
  /** Default max run duration in ms — ActionsRuntime.timeoutMs. */
  timeoutMs: number;
  /** Structured logger for the `action.run` event. */
  logger: Pick<ActionsLogger, "info" | "error">;
  /** Wall clock, injectable so tests assert timeout with a fake clock. Default: Date.now. */
  now?: () => number;
  /** After SIGTERM, how long a cancelled or timed-out child gets before SIGKILL (default 1s). */
  killGraceMs?: number;
  /**
   * Once a killed child has exited, how long its output pipes may still drain (default
   * 500ms). Something it started can hold them open; the run is recorded regardless.
   */
  pumpDrainMs?: number;
  /** Timer factory, injectable for fake-timer tests. Defaults to global setTimeout. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Timer clearer paired with setTimer. Defaults to global clearTimeout. */
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** A single-producer/single-consumer async channel of run events, close-terminated. */
interface EventChannel {
  /** Enqueue an event for the consumer (no-op after close). */
  push(event: ActionRunEvent): void;
  /** Signal end-of-stream; the async iterator completes after draining the buffer. */
  close(): void;
  /** The consumer side; iteration completes after close() and drain. */
  iterable: AsyncIterable<ActionRunEvent>;
}

function createEventChannel(): EventChannel {
  const buffer: ActionRunEvent[] = [];
  let closed = false;
  let wake: (() => void) | null = null;

  const notify = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };

  async function* iterate(): AsyncIterable<ActionRunEvent> {
    for (;;) {
      if (buffer.length > 0) {
        yield buffer.shift()!;
        continue;
      }
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  return {
    push(event) {
      if (closed) return;
      buffer.push(event);
      notify();
    },
    close() {
      closed = true;
      notify();
    },
    iterable: iterate(),
  };
}

/** Compose the single JSON document written to the child's stdin. */
function buildStdin(invocation: ResolvedInvocation): string {
  const input: StructuredRunnerInput = {
    actionId: invocation.actionId,
    params: invocation.params,
    ...(invocation.target === undefined ? {} : { target: invocation.target }),
  };
  return JSON.stringify(input);
}

/**
 * Create the ActionExecutor. Owns an in-memory Map<runId, RunHandle> registry; each run
 * is driven independently so concurrent runs never serialize
 * and a client disconnect never aborts a run.
 */
export function createActionExecutor(opts: ActionExecutorOptions): ActionExecutor {
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
  const registry = new Map<string, RunHandle>();
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const pumpDrainMs = opts.pumpDrainMs ?? DEFAULT_PUMP_DRAIN_MS;

  /** SIGTERM, then SIGKILL if the child has not exited within `killGraceMs`. */
  async function terminate(spawned: SpawnedRun): Promise<void> {
    spawned.kill("SIGTERM");
    if (await settlesWithin(spawned.exited, killGraceMs)) return;
    spawned.kill("SIGKILL");
    await settlesWithin(spawned.exited, killGraceMs);
  }

  function start(invocation: ResolvedInvocation): AsyncIterable<ActionRunEvent> {
    const runId = randomUUID();
    const controller = new AbortController();
    const channel = createEventChannel();

    // Register BEFORE spawning so cancel(runId) can find the run the instant the client
    // learns its runId (the `run` event below).
    const handle: RunHandle = {
      runId,
      actionId: invocation.actionId,
      controller,
      spawned: undefined,
    };
    registry.set(runId, handle);

    // `run` is always the first event (an ordering invariant); it carries the runId
    // used to cancel.
    channel.push({ type: "run", runId });

    // Drive the run independently of the consumer. NOT awaited: the returned iterable is
    // consumed by the route, but the child runs to completion regardless.
    handle.done = drive(runId, handle, invocation, channel).catch(() => {});

    return channel.iterable;
  }

  async function drive(
    runId: string,
    handle: RunHandle,
    invocation: ResolvedInvocation,
    channel: EventChannel,
  ): Promise<void> {
    const startedAtMs = now();
    const timestamp = new Date(startedAtMs).toISOString();

    let outcome: ActionOutcome;
    let exitStatus: number | null = null;
    let outputBytes = 0;
    // Declared outside the try so a failure to open it (EACCES/ENOENT/EMFILE/ENOSPC)
    // still reaches the try's catch and the finally still runs — the terminal `end`
    // event and the audit append must never be skipped, or the client stream hangs.
    let sink: AuditOutputSink | undefined;

    try {
      sink = opts.audit.openOutput(runId); // per-run .log writer

      // A cancel that arrived before the child was spawned already aborted the controller.
      // Honor it here so a cancel-before-spawn never spawns a child only to kill
      // it immediately — the pre-spawn abort check.
      if (handle.controller.signal.aborted) {
        outcome = handle.cancelReason ?? "cancelled";
        outputBytes = await sink.close();
        return; // finally-block emits the terminal `end` + appends the audit entry
      }

      let spawned: SpawnedRun;
      try {
        // The ONLY place a child is created. A synchronous throw here (ENOENT/EACCES/
        // not installed) => outcome "error".
        spawned = opts.spawner.spawn(invocation.executable, buildStdin(invocation));
      } catch (cause) {
        const failure = normalizeActionFailure(cause); // SPAWN_ERROR -> "error"
        outcome = failure.outcome;
        outputBytes = await sink.close();
        return; // finally-block emits `end` + appends audit
      }
      handle.spawned = spawned;

      // Tee both streams to the audit sink AND to the wire channel as chunks arrive
      // TextDecoder default = UTF-8 with lossy replacement.
      const pumps = [
        pump(spawned.stdout, "stdout", sink, channel),
        pump(spawned.stderr, "stderr", sink, channel),
      ];

      // Timeout: mirror the provider registry's AbortController + clearTimeout-in-finally
      // idiom. On expiry, mark the reason then abort; awaitExit rejects and the child is
      // killed.
      let terminationReason: "timed-out" | "cancelled" | null = null;
      const timer = setTimer(() => {
        terminationReason = "timed-out";
        handle.controller.abort();
      }, opts.timeoutMs);

      let killed = false;
      try {
        const code = await awaitExit(spawned.exited, handle.controller.signal);
        outcome = code === 0 ? "succeeded" : "failed";
        exitStatus = code; // present ONLY for succeeded/failed
      } catch {
        // Aborted: timeout OR operator cancel. If cancel() aborted, it recorded the reason
        // on the handle; else timeout.
        outcome = terminationReason ?? handle.cancelReason ?? "cancelled";
        exitStatus = null;
        killed = true;
      } finally {
        clearTimer(timer);
      }
      if (killed) await terminate(spawned);

      // Drain any buffered chunks so the .log is complete even after kill. A killed run's
      // pipes get a bounded drain: something the child started can hold them open.
      const drained = Promise.allSettled(pumps);
      if (killed) await settlesWithin(drained, pumpDrainMs);
      else await drained;
      outputBytes = await sink.close();
    } catch (cause) {
      // Defensive: any unexpected throw normalizes to a safe outcome; never silent.
      outcome = normalizeActionFailure(cause).outcome; // INTERNAL -> "error"
      outputBytes = await safeClose(sink);
    } finally {
      registry.delete(runId);
      const durationMs = now() - startedAtMs;

      // Terminal wire event — ALWAYS emitted so the UI never hangs.
      channel.push({ type: "end", outcome: outcome!, exit: exitStatus, durationMs });
      channel.close();

      // Append exactly one audit index line at the terminal transition.
      const entry: AuditEntry = {
        runId,
        timestamp,
        actionId: invocation.actionId,
        runner: invocation.runner, // NAME, never the resolved path
        params: invocation.params,
        ...(invocation.target === undefined ? {} : { target: invocation.target }),
        source: invocation.source,
        outcome: outcome!,
        exitStatus,
        durationMs,
        outputBytes,
      };
      try {
        await opts.audit.append(entry);
      } catch (cause) {
        // The wire `end` event above already reached the client; an append failure here
        // must never escape as an unhandled rejection out of this fire-and-forget drive
        // loop (it would crash the process). Log it through the existing pino seam
        // instead so the failure stays observable rather than silent.
        try {
          opts.logger.error(
            {
              event: "action.run",
              actionId: entry.actionId,
              runner: entry.runner,
              outcome: entry.outcome,
              audit: "append-failed",
              cause: String(cause),
            },
            "audit append failed",
          );
        } catch {
          // Observability must never itself fail a run.
        }
      } finally {
        logRun(opts.logger, entry);
      }
    }
  }

  function cancel(runId: string): boolean {
    const handle = registry.get(runId);
    if (handle === undefined) return false; // unknown/finished => route maps to 404
    handle.cancelReason = "cancelled"; // recorded so the drive loop maps outcome
    handle.controller.abort(); // awaitExit rejects; drive loop kills the child
    // Belt-and-braces: if the child already exists, kill immediately as well.
    handle.spawned?.kill?.("SIGTERM"); // the runner's local process group only
    return true;
  }

  async function cancelAll(): Promise<number> {
    const cancelled = [...registry.values()].filter((handle) => cancel(handle.runId));
    await Promise.all(cancelled.map((handle) => handle.done));
    return cancelled.length;
  }

  return { start, cancel, cancelAll };
}

/** Read one stream to EOF, teeing each chunk to the sink and the wire channel. */
async function pump(
  stream: AsyncIterable<Uint8Array>,
  kind: "stdout" | "stderr",
  sink: AuditOutputSink,
  channel: EventChannel,
): Promise<void> {
  const decoder = new TextDecoder(); // UTF-8, fatal:false => lossy replacement
  for await (const chunk of stream) {
    await sink.write(chunk); // durable, byte-exact persistence
    // stream:true keeps multi-byte sequences intact across chunk boundaries.
    const data = decoder.decode(chunk, { stream: true });
    if (data.length > 0) channel.push({ type: kind, data });
  }
  const tail = decoder.decode(); // flush any trailing partial sequence
  if (tail.length > 0) channel.push({ type: kind, data: tail });
}

/** Mirror of registry.ts withTimeout(): reject when the run's signal aborts. */
function awaitExit(exited: Promise<number>, signal: AbortSignal): Promise<number> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<number>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    exited
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function abortError(): Error {
  const error = new Error("Action run aborted");
  error.name = "AbortError";
  return error;
}

async function safeClose(sink: AuditOutputSink | undefined): Promise<number> {
  if (sink === undefined) return 0;
  try {
    return await sink.close();
  } catch {
    return 0;
  }
}

/** Emit one `action.run` structured log per terminal transition. */
function logRun(logger: Pick<ActionsLogger, "info">, entry: AuditEntry): void {
  try {
    logger.info(
      {
        event: "action.run",
        actionId: entry.actionId,
        runner: entry.runner,
        outcome: entry.outcome,
        durationMs: entry.durationMs,
      } satisfies ActionRunLogEvent,
      "action run",
    );
  } catch {
    // Observability must never turn a run into a failure (mirrors registry.ts tick()).
  }
}
