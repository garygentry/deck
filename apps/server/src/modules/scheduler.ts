import { AsyncLocalStorage } from "node:async_hooks";

import type { Cadence, CadenceState, TaskHandle } from "@deck/module-sdk";

/**
 * Marks the async context of a run, so a `stop()` issued from inside that same run (a task
 * stopping itself) never awaits the run it is part of.
 */
const runScope = new AsyncLocalStorage<readonly object[]>();

/** Run `fn` inside `owner`'s run scope (scopes nest: a task's run may poll a provider). */
export function withinRun<T>(owner: object, fn: () => T): T {
  return runScope.run([...(runScope.getStore() ?? []), owner], fn);
}

/** Whether the current async context is inside a run started with `withinRun(owner, …)`. */
export function isWithinRun(owner: object): boolean {
  return runScope.getStore()?.includes(owner) ?? false;
}

/** The largest `setTimeout` delay; anything longer overflows and fires immediately. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

export interface AdaptiveTaskOptions {
  run(): Promise<void>;
  cadence: Cadence;
  now?: () => number;
  /** Called when a run throws or a cadence hook throws; the task keeps going regardless. */
  onError?(error: unknown, phase: "run" | "cadence"): void;
}

export type AdaptiveTask = TaskHandle & { start(): void };

/**
 * Run a task on an adaptive cadence: a self-arming timer whose next run time comes from the
 * cadence hook. A null delay pauses until `wake()`.
 *
 * - After a run, the next run is due at `now + delay`.
 * - `wake()` re-asks the cadence, and can only bring the due time forward, never postpone it.
 * - The due time is absolute: a delay beyond the timer maximum re-arms for the remainder
 *   rather than running early.
 * - When the due time arrives the cadence is asked again; a null answer skips the run.
 * - Runs never overlap; the in-flight guard is set before user code runs, so a synchronous
 *   re-entry joins the same run. A throwing run counts as a failure and never stops the chain.
 * - `stop()` is terminal and resolves once any in-flight run has finished; called from inside
 *   that run, it resolves at once instead of awaiting itself.
 * - Nothing here rejects at the top level: a throwing `onError` or clock is contained.
 */
export function createAdaptiveTask(options: AdaptiveTaskOptions): AdaptiveTask {
  const owner = {};
  const clock = options.now ?? (() => Date.now());
  // A throwing injected clock must not break the chain; fall back to the system clock.
  const now = () => {
    try {
      return clock();
    } catch {
      return Date.now();
    }
  };
  const report = (error: unknown, phase: "run" | "cadence") => {
    try {
      options.onError?.(error, phase);
    } catch {
      // A broken error reporter must not turn a contained failure into an unhandled one.
    }
  };
  const state: Omit<CadenceState, "now"> = { lastRunAt: null, lastOk: null, consecutiveFailures: 0 };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dueAt: number | null = null;
  let inFlight: Promise<void> | null = null;
  let started = false;
  let stopped = false;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    dueAt = null;
  };

  /** The cadence's next delay, or null to pause (a throwing hook pauses, too). */
  const nextDelay = (): number | null => {
    let delay: number | null;
    try {
      delay = options.cadence({ now: now(), ...state });
    } catch (error) {
      report(error, "cadence");
      return null;
    }
    // A non-finite delay (Infinity, NaN) is treated as a pause rather than a near-immediate run.
    return delay === null || !Number.isFinite(delay) ? null : Math.max(0, delay);
  };

  const setTimer = (at: number) => {
    if (timer !== null) clearTimeout(timer);
    dueAt = at;
    timer = setTimeout(onTimer, Math.min(Math.max(0, at - now()), MAX_TIMER_MS));
    (timer as { unref?: () => void }).unref?.();
  };

  function onTimer(): void {
    timer = null;
    const at = dueAt;
    dueAt = null;
    if (stopped || at === null) return;
    // A clamped timer fired before the due time: wait out the remainder.
    if (now() < at) return setTimer(at);
    // Conditions may have changed since arming: a cadence that now pauses wins.
    if (nextDelay() === null) return;
    runOnce().catch(() => {});
  }

  /** Arm from the cadence. `keepEarlier`: an already-armed earlier due time stands. */
  const arm = (keepEarlier: boolean) => {
    if (stopped || !started || inFlight !== null) return;
    const delay = nextDelay();
    if (delay === null) {
      clear();
      return;
    }
    const at = now() + delay;
    if (keepEarlier && dueAt !== null && dueAt <= at) return;
    setTimer(at);
  };

  const runOnce = (): Promise<void> => {
    if (inFlight !== null) return inFlight;
    clear();
    // Publish the guard first: user code only starts in a later microtask.
    inFlight = Promise.resolve()
      .then(() => withinRun(owner, () => options.run()))
      .then(
        () => true,
        (error: unknown) => {
          report(error, "run");
          return false;
        },
      )
      .then((ok) => {
        state.lastRunAt = now();
        state.lastOk = ok;
        state.consecutiveFailures = ok ? 0 : state.consecutiveFailures + 1;
      })
      .finally(() => {
        inFlight = null;
        arm(false);
      });
    return inFlight;
  };

  return {
    start() {
      if (started) return;
      started = true;
      arm(false);
    },
    wake() {
      arm(true);
    },
    runNow() {
      if (stopped) return Promise.resolve();
      return runOnce();
    },
    async stop() {
      stopped = true;
      clear();
      if (isWithinRun(owner)) return;
      await inFlight;
    },
  };
}
