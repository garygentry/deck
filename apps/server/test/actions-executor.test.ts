import { describe, expect, it, vi } from "vitest";

import type {
  AuditEntry,
  AuditListItem,
  AuditOutputSink,
  AuditStore,
} from "../src/actions/audit.js";
import type { ActionRunEvent } from "../src/actions/events.js";
import {
  createActionExecutor,
  type ActionExecutorOptions,
  type ResolvedInvocation,
} from "../src/actions/executor.js";
import { createFakeSpawner, type FakeSpawnerScript } from "./util/fake-spawner.js";

const enc = (s: string) => new TextEncoder().encode(s);

/** A fake AuditStore that captures per-run sink bytes and the appended entries. */
function createFakeAudit() {
  const appends: AuditEntry[] = [];
  const sinks: Array<{ runId: string; chunks: Uint8Array[]; closed: boolean }> = [];
  let onAppend: (() => void) | null = null;

  const store: AuditStore = {
    async append(entry: AuditEntry): Promise<void> {
      appends.push(entry);
      onAppend?.();
    },
    openOutput(runId: string): AuditOutputSink {
      const record = { runId, chunks: [] as Uint8Array[], closed: false };
      sinks.push(record);
      return {
        async write(chunk: Uint8Array): Promise<void> {
          if (record.closed) throw new Error("write after close");
          record.chunks.push(chunk);
        },
        async close(): Promise<number> {
          record.closed = true;
          return record.chunks.reduce((n, c) => n + c.byteLength, 0);
        },
      };
    },
    async list(): Promise<AuditListItem[]> {
      return [];
    },
    async read() {
      return undefined;
    },
  };

  return {
    store,
    appends,
    sinks,
    /** Resolves the next time append() is called. */
    nextAppend(): Promise<void> {
      return new Promise<void>((resolve) => {
        onAppend = () => {
          onAppend = null;
          resolve();
        };
      });
    },
  };
}

function fakeLogger() {
  return { info: vi.fn() } as unknown as ActionExecutorOptions["logger"];
}

function invocation(over: Partial<ResolvedInvocation> = {}): ResolvedInvocation {
  return {
    actionId: "restart-svc",
    runner: "restart", // declared NAME
    executable: "/opt/estate/runners/restart", // resolved path
    params: { host: "db-1" },
    source: "10.0.0.1",
    ...over,
  };
}

async function collect(iterable: AsyncIterable<ActionRunEvent>): Promise<ActionRunEvent[]> {
  const events: ActionRunEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function endEvent(events: ActionRunEvent[]) {
  const end = events.at(-1);
  if (!end || end.type !== "end") throw new Error("no terminal end event");
  return end;
}

function baseOpts(
  script: FakeSpawnerScript | FakeSpawnerScript[],
  over: Partial<ActionExecutorOptions> = {},
): ActionExecutorOptions {
  return {
    spawner: createFakeSpawner(script),
    audit: createFakeAudit().store,
    timeoutMs: 60_000,
    logger: fakeLogger(),
    ...over,
  };
}

describe("createActionExecutor", () => {
  it("emits run first and a terminal end last; exit 0 => succeeded", async () => {
    const audit = createFakeAudit();
    const executor = createActionExecutor(
      baseOpts({ stdout: [enc("done\n")], exitCode: 0 }, { audit: audit.store }),
    );

    const events = await collect(executor.start(invocation()));

    expect(events[0]).toEqual({ type: "run", runId: expect.any(String) });
    const end = endEvent(events);
    expect(end.outcome).toBe("succeeded");
    expect(end.exit).toBe(0);
    expect(end.durationMs).toBeGreaterThanOrEqual(0);

    expect(audit.appends).toHaveLength(1);
    expect(audit.appends[0].outcome).toBe("succeeded");
    expect(audit.appends[0].exitStatus).toBe(0);
    // Audit records the declared NAME, never the resolved path.
    expect(audit.appends[0].runner).toBe("restart");
  });

  it("is incremental: multiple stdout events precede the terminal end", async () => {
    const executor = createActionExecutor(
      baseOpts({
        stdout: [enc("one "), enc("two "), enc("three")],
        exitCode: 0,
        chunkDelayMs: 1,
      }),
    );

    const events = await collect(executor.start(invocation()));
    const stdoutEvents = events.filter((e) => e.type === "stdout");
    expect(stdoutEvents.length).toBeGreaterThan(1);

    const endIndex = events.findIndex((e) => e.type === "end");
    const lastStdoutIndex = events.map((e) => e.type).lastIndexOf("stdout");
    expect(lastStdoutIndex).toBeLessThan(endIndex);

    const text = stdoutEvents.map((e) => (e.type === "stdout" ? e.data : "")).join("");
    expect(text).toBe("one two three");
  });

  it("exit n != 0 => failed with the exit code", async () => {
    const events = await collect(
      createActionExecutor(baseOpts({ exitCode: 3 })).start(invocation()),
    );
    const end = endEvent(events);
    expect(end.outcome).toBe("failed");
    expect(end.exit).toBe(3);
  });

  it("spawn() throwing => error, exit null, exactly one audit append", async () => {
    const audit = createFakeAudit();
    const err = Object.assign(new Error("spawn restart ENOENT"), { code: "ENOENT" });
    const executor = createActionExecutor(
      baseOpts({ throwOnSpawn: err }, { audit: audit.store }),
    );

    const events = await collect(executor.start(invocation()));
    const end = endEvent(events);
    expect(end.outcome).toBe("error");
    expect(end.exit).toBeNull();

    expect(audit.appends).toHaveLength(1);
    expect(audit.appends[0].outcome).toBe("error");
    expect(audit.appends[0].exitStatus).toBeNull();
    expect(audit.appends[0].outputBytes).toBe(0);
  });

  it("times out with a fake clock: child killed, timed-out, exit null, timer cleared", async () => {
    const audit = createFakeAudit();
    const spawner = createFakeSpawner({ stdout: [enc("working")], hang: true });

    let timerCb: (() => void) | null = null;
    const clearTimer = vi.fn();
    let clock = 1_000;

    const executor = createActionExecutor({
      spawner,
      audit: audit.store,
      timeoutMs: 5_000,
      logger: fakeLogger(),
      now: () => clock,
      setTimer: (fn) => {
        timerCb = fn;
        return 42 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer,
    });

    const iterable = executor.start(invocation());
    // drive() runs synchronously up to the first await, so the timer is already armed.
    expect(timerCb).toBeInstanceOf(Function);

    // Advance the fake clock and fire the timeout.
    clock = 7_000;
    timerCb!();

    const events = await collect(iterable);
    const end = endEvent(events);
    expect(end.outcome).toBe("timed-out");
    expect(end.exit).toBeNull();
    expect(end.durationMs).toBe(6_000);

    // Child killed with SIGTERM (local process only), and the timer was cleared (no leak).
    expect(spawner.calls[0].handle?.killSignals).toContain("SIGTERM");
    expect(clearTimer).toHaveBeenCalledWith(42);

    expect(audit.appends).toHaveLength(1);
    expect(audit.appends[0].outcome).toBe("timed-out");
  });

  it("cancel(runId) on a live run returns true and yields cancelled", async () => {
    const spawner = createFakeSpawner({ stdout: [enc("go")], hang: true });
    const executor = createActionExecutor(baseOpts({ hang: true }, { spawner }));

    const iterable = executor.start(invocation());
    const iterator = iterable[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value).toEqual({ type: "run", runId: expect.any(String) });
    const runId = (first.value as { runId: string }).runId;

    expect(executor.cancel(runId)).toBe(true);

    const events: ActionRunEvent[] = [first.value as ActionRunEvent];
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
      events.push(step.value);
    }
    const end = endEvent(events);
    expect(end.outcome).toBe("cancelled");
    expect(end.exit).toBeNull();
    expect(spawner.calls[0].handle?.killSignals).toContain("SIGTERM");
  });

  it("cancelAll() cancels every live run and resolves once each is audited as cancelled (review N1)", async () => {
    const spawner = createFakeSpawner({ stdout: [enc("go")], hang: true });
    const audit = createFakeAudit();
    const executor = createActionExecutor(baseOpts({ hang: true }, { spawner, audit: audit.store }));
    const iterator = executor.start(invocation())[Symbol.asyncIterator]();
    await iterator.next(); // the run event: registered and spawned

    await expect(executor.cancelAll()).resolves.toBe(1);
    expect(audit.appends.map((entry) => entry.outcome)).toEqual(["cancelled"]);
    await expect(executor.cancelAll()).resolves.toBe(0);
  });

  it("escalates to SIGKILL when a cancelled child ignores SIGTERM (review N1)", async () => {
    const spawner = createFakeSpawner({ stdout: [enc("go")], hang: true, ignoreTerm: true });
    const audit = createFakeAudit();
    const executor = createActionExecutor(baseOpts({ hang: true }, { spawner, audit: audit.store, killGraceMs: 20 }));
    const iterator = executor.start(invocation())[Symbol.asyncIterator]();
    await iterator.next();

    await expect(executor.cancelAll()).resolves.toBe(1);
    expect(spawner.calls[0]!.handle?.killSignals).toContain("SIGKILL");
    expect(audit.appends.map((entry) => entry.outcome)).toEqual(["cancelled"]);
  });

  it("records a cancelled run even when its pipes stay open after the child exits (review N1)", async () => {
    const spawner = createFakeSpawner({ stdout: [enc("go")], hang: true, holdStreams: true });
    const audit = createFakeAudit();
    const executor = createActionExecutor(baseOpts({ hang: true }, { spawner, audit: audit.store, pumpDrainMs: 20 }));
    const iterator = executor.start(invocation())[Symbol.asyncIterator]();
    await iterator.next();

    const started = Date.now();
    await expect(executor.cancelAll()).resolves.toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(audit.appends.map((entry) => entry.outcome)).toEqual(["cancelled"]);
  });

  it("cancel of an unknown/finished id returns false", async () => {
    const executor = createActionExecutor(baseOpts({ exitCode: 0 }));
    expect(executor.cancel("no-such-run")).toBe(false);

    // A finished run is removed from the registry.
    const iterable = executor.start(invocation());
    const events = await collect(iterable);
    const runId = (events[0] as { runId: string }).runId;
    expect(executor.cancel(runId)).toBe(false);
  });

  it("disconnect: consumer stops after the first chunk; run still completes and persists", async () => {
    const audit = createFakeAudit();
    const chunks = [enc("a"), enc("b"), enc("c")];
    const executor = createActionExecutor(
      baseOpts({ stdout: chunks, exitCode: 0, chunkDelayMs: 1 }, { audit: audit.store }),
    );

    const appended = audit.nextAppend();
    const iterator = executor.start(invocation())[Symbol.asyncIterator]();

    // Consume only the `run` event and the first stdout chunk, then stop pulling.
    await iterator.next(); // run
    await iterator.next(); // first stdout
    // Deliberately do NOT drain the rest — simulate a client disconnect.

    await appended; // the decoupled drive loop still finishes

    expect(audit.appends).toHaveLength(1);
    expect(audit.appends[0].outcome).toBe("succeeded");

    // The audit sink received ALL chunks byte-exact, independent of the wire consumer.
    const sink = audit.sinks[0];
    expect(sink.closed).toBe(true);
    const sinkBytes = Buffer.concat(sink.chunks.map((c) => Buffer.from(c)));
    expect(sinkBytes.toString("utf8")).toBe("abc");
  });

  it("runs concurrently without global serialization; independent end events", async () => {
    const audit = createFakeAudit();
    const spawner = createFakeSpawner([
      { stdout: [enc("A1 "), enc("A2")], exitCode: 0, chunkDelayMs: 2 },
      { stdout: [enc("B1 "), enc("B2")], exitCode: 5, chunkDelayMs: 2 },
    ]);
    const executor = createActionExecutor(
      baseOpts([], { spawner, audit: audit.store }),
    );

    const [a, b] = await Promise.all([
      collect(executor.start(invocation({ actionId: "a", runner: "ra" }))),
      collect(executor.start(invocation({ actionId: "b", runner: "rb" }))),
    ]);

    const endA = endEvent(a);
    const endB = endEvent(b);
    expect(endA.outcome).toBe("succeeded");
    expect(endA.exit).toBe(0);
    expect(endB.outcome).toBe("failed");
    expect(endB.exit).toBe(5);

    // Two independent runs, two audit entries, distinct runIds.
    expect(audit.appends).toHaveLength(2);
    const runIds = new Set(audit.appends.map((e) => e.runId));
    expect(runIds.size).toBe(2);
    expect(new Set(audit.appends.map((e) => e.runner))).toEqual(new Set(["ra", "rb"]));
  });

  it("sink bytes are byte-exact while wire data is UTF-8 decoded (lossy)", async () => {
    const audit = createFakeAudit();
    // A 3-byte UTF-8 sequence split across two chunks; the sink keeps raw bytes, the wire
    // reassembles the character across the boundary.
    const euro = new TextEncoder().encode("€"); // 0xE2 0x82 0xAC
    const executor = createActionExecutor(
      baseOpts(
        { stdout: [euro.slice(0, 1), euro.slice(1)], exitCode: 0, chunkDelayMs: 1 },
        { audit: audit.store },
      ),
    );

    const events = await collect(executor.start(invocation()));
    const wire = events
      .filter((e) => e.type === "stdout")
      .map((e) => (e.type === "stdout" ? e.data : ""))
      .join("");
    expect(wire).toBe("€");

    const sinkBytes = Buffer.concat(audit.sinks[0].chunks.map((c) => Buffer.from(c)));
    expect([...sinkBytes]).toEqual([0xe2, 0x82, 0xac]);
    expect(audit.appends[0].outputBytes).toBe(3);
  });

  it("swallows a throwing logger (observability never fails a run)", async () => {
    const throwingLogger = {
      info: () => {
        throw new Error("log sink down");
      },
    } as unknown as ActionExecutorOptions["logger"];
    const events = await collect(
      createActionExecutor(baseOpts({ exitCode: 0 }, { logger: throwingLogger })).start(
        invocation(),
      ),
    );
    expect(endEvent(events).outcome).toBe("succeeded");
  });
});
