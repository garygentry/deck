import type { CadenceState } from "@deck/module-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAdaptiveTask, MAX_TIMER_MS } from "../src/modules/scheduler.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createAdaptiveTask", () => {
  // The llm-usage collector keeps its own due time and lets an early run do nothing: it relies
  // on the cadence being asked again once any run settles, and on that answer being the delay.
  it("asks the cadence again after a run that did nothing, and arms at now + that delay", async () => {
    let due = 300;
    const runs: number[] = [];
    const task = createAdaptiveTask({
      run: async () => {
        if (Date.now() < due) return; // arrived early: no work
        runs.push(Date.now());
        due = Date.now() + 1_000;
      },
      cadence: ({ now }) => Math.max(0, due - now),
    });
    task.start();
    due = 500; // moved later after arming: the timer still fires at 300
    await vi.advanceTimersByTimeAsync(300);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(199);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual([500]);
    task.stop();
  });

  it("does nothing until started, then runs on the cadence's delays", async () => {
    const run = vi.fn(async () => {});
    const task = createAdaptiveTask({ run, cadence: ({ lastRunAt }) => (lastRunAt === null ? 0 : 1_000) });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).not.toHaveBeenCalled();
    task.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    task.stop();
  });

  it("feeds the cadence the run history: lastRunAt, lastOk and consecutive failures", async () => {
    const seen: Omit<CadenceState, "now">[] = [];
    let n = 0;
    const task = createAdaptiveTask({
      run: async () => {
        n += 1;
        if (n === 2 || n === 3) throw new Error("boom");
      },
      cadence: ({ now: _now, ...rest }) => {
        // Asked when arming and again when the timer fires; keep one entry per run state.
        if (JSON.stringify(seen.at(-1)) !== JSON.stringify(rest)) seen.push(rest);
        return 100;
      },
    });
    task.start();
    await vi.advanceTimersByTimeAsync(400);
    task.stop();
    expect(seen.slice(0, 5)).toEqual([
      { lastRunAt: null, lastOk: null, consecutiveFailures: 0 },
      { lastRunAt: 100, lastOk: true, consecutiveFailures: 0 },
      { lastRunAt: 200, lastOk: false, consecutiveFailures: 1 },
      { lastRunAt: 300, lastOk: false, consecutiveFailures: 2 },
      { lastRunAt: 400, lastOk: true, consecutiveFailures: 0 },
    ]);
  });

  it("pauses on a null delay and resumes on wake()", async () => {
    const run = vi.fn(async () => {});
    let paused = true;
    const task = createAdaptiveTask({ run, cadence: () => (paused ? null : 50) });
    task.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).not.toHaveBeenCalled();
    paused = false;
    task.wake();
    await vi.advanceTimersByTimeAsync(50);
    expect(run).toHaveBeenCalledTimes(1);
    paused = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    task.stop();
  });

  it("wake() re-evaluates the delay, bringing the next run forward", async () => {
    const run = vi.fn(async () => {});
    let delay = 60_000;
    const task = createAdaptiveTask({ run, cadence: () => delay });
    task.start();
    await vi.advanceTimersByTimeAsync(1_000);
    delay = 10;
    task.wake();
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(1);
    task.stop();
  });

  it("runNow() joins an in-flight run instead of overlapping it", async () => {
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const task = createAdaptiveTask({ run, cadence: () => null });
    task.start();
    const first = task.runNow();
    const second = task.runNow();
    task.wake(); // a wake during a run must not start another
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledTimes(1);
    task.stop();
  });

  it("survives a throwing run and a throwing cadence, reporting both", async () => {
    const onError = vi.fn();
    let calls = 0;
    const task = createAdaptiveTask({
      run: async () => {
        throw new Error("run failed");
      },
      cadence: () => {
        calls += 1;
        if (calls === 3) throw new Error("cadence failed");
        return 10;
      },
      onError,
    });
    task.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "run failed" }), "run");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "cadence failed" }), "cadence");
    // A throwing cadence pauses; wake() resumes.
    const before = onError.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError.mock.calls.length).toBe(before);
    task.wake();
    await vi.advanceTimersByTimeAsync(10);
    expect(onError.mock.calls.length).toBeGreaterThan(before);
    task.stop();
  });

  it("clamps oversized delays to the timer maximum and pauses on non-finite ones", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const task = createAdaptiveTask({ run: async () => {}, cadence: () => 2 ** 40 });
    task.start();
    expect(spy).toHaveBeenLastCalledWith(expect.any(Function), MAX_TIMER_MS);
    task.stop();
    spy.mockClear();
    const infinite = createAdaptiveTask({ run: async () => {}, cadence: () => Number.POSITIVE_INFINITY });
    infinite.start();
    expect(spy).not.toHaveBeenCalled();
    infinite.stop();
    spy.mockRestore();
  });

  it("joins a synchronous re-entrant runNow() from inside the run (C5)", async () => {
    let active = 0;
    let maxActive = 0;
    let nested: Promise<void> | undefined;
    let release!: () => void;
    const task = createAdaptiveTask({
      run: () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        // An event listener calling back into the handle synchronously, mid-run.
        nested ??= task.runNow();
        return new Promise<void>((resolve) => (release = resolve)).finally(() => (active -= 1));
      },
      cadence: () => null,
    });
    task.start();
    const outer = task.runNow();
    await Promise.resolve();
    await Promise.resolve();
    expect(nested).toBe(outer);
    release();
    await outer;
    expect(maxActive).toBe(1);
    task.stop();
  });

  it("does not run early when a delay beyond the timer maximum is clamped (L7)", async () => {
    const run = vi.fn(async () => {});
    const thirtyDays = 30 * 86_400_000;
    const task = createAdaptiveTask({ run, cadence: () => thirtyDays });
    task.start();
    await vi.advanceTimersByTimeAsync(MAX_TIMER_MS + 1_000); // ~24.8 days: the clamp fires
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(thirtyDays - MAX_TIMER_MS - 1_000);
    expect(run).toHaveBeenCalledTimes(1);
    task.stop();
  });

  it("never postpones a due run on wake() (L8)", async () => {
    const run = vi.fn(async () => {});
    const task = createAdaptiveTask({ run, cadence: () => 60_000 });
    task.start();
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      task.wake();
    }
    // Woken every 30s, the 60s cadence still ran at 60s (and is due again at 120s), never pushed back.
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(2);
    task.stop();
  });

  it("stop() resolves only after the in-flight run finishes (L3)", async () => {
    let release!: () => void;
    let finished = false;
    const task = createAdaptiveTask({
      run: () => new Promise<void>((resolve) => (release = resolve)).then(() => void (finished = true)),
      cadence: () => null,
    });
    task.start();
    void task.runNow();
    await Promise.resolve();
    let stopped = false;
    const stopping = task.stop().then(() => void (stopped = true));
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(finished).toBe(true);
  });

  it("lets a run stop its own task without deadlocking (N1)", async () => {
    let selfStop: Promise<void> | undefined;
    const run = vi.fn(async () => {
      selfStop = task.stop();
      await selfStop;
    });
    const task = createAdaptiveTask({ run, cadence: () => 10 });
    task.start();
    await vi.advanceTimersByTimeAsync(10);
    await expect(selfStop).resolves.toBeUndefined();
    await expect(task.stop()).resolves.toBeUndefined(); // the outer stop sees the run finished
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("contains a throwing onError and a throwing clock: no unhandled rejection (N2)", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let calls = 0;
      const task = createAdaptiveTask({
        run: async () => {
          throw new Error("run failed");
        },
        cadence: () => 10,
        onError: () => {
          throw new Error("reporter broke");
        },
        now: () => {
          calls += 1;
          if (calls % 2 === 0) throw new Error("clock broke");
          return Date.now();
        },
      });
      task.start();
      await vi.advanceTimersByTimeAsync(50);
      await task.runNow();
      await task.stop();
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("never runs again after stop(), even via runNow()", async () => {
    const run = vi.fn(async () => {});
    const task = createAdaptiveTask({ run, cadence: () => 10 });
    task.start();
    task.stop();
    await task.runNow();
    task.wake();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).not.toHaveBeenCalled();
  });
});
